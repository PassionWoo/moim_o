import { DurableObject } from "cloudflare:workers";

const FRONT_ORIGIN = "https://passionwoo.github.io";
const MAX_BODY = 100000;
const MAX_MEMBERS = 30;
const MAX_DAYS = 31;
const MAX_SLOTS_PER_DAY = 96;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}
function fail(message, status = 400) { return json({ error: message }, status); }
function cleanName(value, max = 30) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").slice(0, max) : "";
}
function token() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hash(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, "0")).join("");
}
function minutes(value) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-4]):[0-5]\d$/.test(value)) return -1;
  const [h, m] = value.split(":").map(Number);
  return h === 24 && m ? -1 : h * 60 + m;
}
function makeDates(startDate, endDate) {
  if (typeof startDate !== "string" || typeof endDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return null;
  const a = Date.parse(startDate + "T00:00:00Z"), b = Date.parse(endDate + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b) || new Date(a).toISOString().slice(0,10) !== startDate ||
      new Date(b).toISOString().slice(0,10) !== endDate || b < a || (b-a)/86400000 >= MAX_DAYS) return null;
  return Array.from({ length: Math.round((b-a)/86400000)+1 }, (_, i) => new Date(a + i*86400000).toISOString().slice(0,10));
}
function validateNew(data) {
  if (!data || typeof data !== "object") return null;
  const title = cleanName(data.title, 80);
  const names = data.participants;
  if (!title || !Array.isArray(names) || names.length < 1 || names.length > MAX_MEMBERS ||
      names.some(n => !cleanName(n) || n.trim().length > 30)) return null;
  const members = names.map(n => cleanName(n));
  if (new Set(members).size !== members.length) return null;
  const dates = makeDates(data.startDate, data.endDate);
  const begin = minutes(data.startTime), end = minutes(data.endTime);
  const step = data.unitMinutes;
  if (!dates || begin < 0 || end <= begin || end > 1440 || !Number.isInteger(step) ||
      step < 5 || step > 720 || Math.ceil((end - begin) / step) > MAX_SLOTS_PER_DAY) return null;
  if (dates.length * Math.ceil((end-begin)/step) > 1500) return null;
  return { title, dates, startTime: data.startTime, endTime: data.endTime,
    unitMinutes: step, participants: members };
}
function allowedOrigin(request) {
  const origin = request.headers.get("Origin");
  if (!origin) return null;
  if (origin === FRONT_ORIGIN || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;
  return false;
}
function corsHeaders(origin) {
  return origin ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "vary": "Origin" } : {};
}
function authToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{40,64})$/.exec(request.headers.get("Authorization") || "");
  return match ? match[1] : null;
}
async function parseBody(request) {
  if (Number(request.headers.get("content-length") || 0) > MAX_BODY) return null;
  try { const body = await request.text(); return body.length <= MAX_BODY ? JSON.parse(body) : null; }
  catch { return null; }
}
export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request);
    if (origin === false) return fail("허용되지 않은 접속입니다.", 403);
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, app: "Moim_O" }, 200, cors);
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const raw = await parseBody(request);
      const checked = validateNew(raw);
      if (!checked) return json({ error: "모임 정보를 확인해 주세요. (최대 30명·31일·하루 96칸)" }, 400, cors);
      const gate = env.ROOMS.get(env.ROOMS.idFromName("__moimo_creation_gate"));
      const gateRes = await gate.fetch(new Request("https://internal/rate", {
        method: "POST", body: JSON.stringify({ ip: request.headers.get("CF-Connecting-IP") || "local" })
      }));
      if (!gateRes.ok) return json({ error: "모임 생성이 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요." }, 429, cors);
      const roomId = token().slice(0, 16);
      const managerToken = token(), viewerToken = token();
      const participants = checked.participants.map((name, i) => ({ id: "p"+(i+1), name, token: token() }));
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const result = await stub.fetch(new Request("https://internal/init", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { title: checked.title, dates: checked.dates,
          startTime: checked.startTime, endTime: checked.endTime, unitMinutes: checked.unitMinutes },
          managerHash: await hash(managerToken), viewerHash: await hash(viewerToken),
          participants: await Promise.all(participants.map(async p => ({ id:p.id, name:p.name, tokenHash: await hash(p.token) }))) })
      }));
      if (!result.ok) return json({ error: "모임 생성에 실패했습니다." }, 500, cors);
      return json({ roomId, managerToken, viewerToken, participants }, 201, cors);
    }
    const match = /^\/api\/rooms\/([A-Za-z0-9_-]{12,24})(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return json({ error: "주소를 찾을 수 없습니다." }, 404, cors);
    const stub = env.ROOMS.get(env.ROOMS.idFromName(match[1]));
    const routed = await stub.fetch(request);
    if (routed.status === 101) return routed;
    const headers = new Headers(routed.headers);
    for (const [k,v] of Object.entries(cors)) headers.set(k,v);
    headers.set("cache-control","no-store");
    return new Response(routed.body, { status:routed.status, headers });
  }
};

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, config TEXT NOT NULL, manager_hash TEXT NOT NULL, viewer_hash TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, slots TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, hits INTEGER NOT NULL)");
  }
  meta() { return [...this.sql.exec("SELECT * FROM meta WHERE id=1")][0] || null; }
  people() { return [...this.sql.exec("SELECT * FROM people ORDER BY rowid")]; }
  async identify(value) {
    if (!value) return null;
    const h = await hash(value), m = this.meta();
    if (!m) return null;
    if (h === m.manager_hash) return { role:"manager" };
    if (h === m.viewer_hash) return { role:"viewer" };
    const p = [...this.sql.exec("SELECT id FROM people WHERE token_hash=?",h)][0];
    return p ? { role:"participant", participantId:p.id } : null;
  }
  snapshot(a) {
    const m = this.meta();
    return { config:JSON.parse(m.config), role:a.role, participantId:a.participantId || null,
      participants:this.people().map(p=>({ id:p.id, name:p.name, slots:JSON.parse(p.slots) })) };
  }
  broadcast(data) {
    const message = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      if (!ws.deserializeAttachment()?.authorized) continue;
      try { ws.send(message); } catch {}
    }
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/rate" && request.method === "POST") {
      const body = await parseBody(request);
      const ip = String(body?.ip || "local").slice(0, 120);
      const now = Date.now();
      for (const [id, window, cap] of [
        ["ipm:"+ip,Math.floor(now/60000),6],
        ["ipd:"+ip,Math.floor(now/86400000),60],
        ["allm",Math.floor(now/60000),60],
        ["alld",Math.floor(now/86400000),500]
      ]) {
        const row = [...this.sql.exec("SELECT window,hits FROM limits WHERE key=?",id)][0];
        if (row && row.window === window && row.hits >= cap) return fail("요청 제한",429);
      }
      for (const [id, window] of [
        ["ipm:"+ip,Math.floor(now/60000)],["ipd:"+ip,Math.floor(now/86400000)],
        ["allm",Math.floor(now/60000)],["alld",Math.floor(now/86400000)]
      ]) this.sql.exec("INSERT INTO limits(key,window,hits) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,hits=CASE WHEN limits.window=excluded.window THEN limits.hits+1 ELSE 1 END",id,window);
      return json({ok:true});
    }
    if (path === "/init" && request.method === "POST") {
      if (this.meta()) return fail("이미 존재합니다.",409);
      const b = await parseBody(request);
      if (!b?.config || !b.managerHash || !b.viewerHash || !Array.isArray(b.participants)) return fail("잘못된 입력");
      this.sql.exec("INSERT INTO meta(id,config,manager_hash,viewer_hash) VALUES(1,?,?,?)",JSON.stringify(b.config),b.managerHash,b.viewerHash);
      for (const p of b.participants) this.sql.exec("INSERT INTO people(id,name,token_hash,slots) VALUES(?,?,?,?)",p.id,p.name,p.tokenHash,"{}");
      return json({ok:true},201);
    }
    if (!this.meta()) return fail("모임을 찾을 수 없습니다.",404);
    if (path.endsWith("/live") && request.headers.get("Upgrade")?.toLowerCase()==="websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ authorized:false });
      return new Response(null,{ status:101, webSocket:client });
    }
    const auth = await this.identify(authToken(request));
    if (!auth) return fail("참여 링크가 올바르지 않습니다.",401);
    if (request.method==="GET" && /^\/api\/rooms\/[\w-]+$/.test(path)) return json(this.snapshot(auth));
    if (request.method==="PUT" && path.endsWith("/slots")) {
      if (auth.role!=="participant") return fail("본인 일정만 수정할 수 있습니다.",403);
      const body=await parseBody(request), changes=body?.changes;
      if (!changes || typeof changes!=="object" || Array.isArray(changes) || Object.keys(changes).length>200) return fail("잘못된 시간표");
      const cfg=JSON.parse(this.meta().config), n=Math.ceil((minutes(cfg.endTime)-minutes(cfg.startTime))/cfg.unitMinutes);
      for(const [k,v] of Object.entries(changes)) {
        const match=/^d(\d+)s(\d+)$/.exec(k);
        if(!match || Number(match[1])>=cfg.dates.length || Number(match[2])>=n || !["both","online",null].includes(v)) return fail("잘못된 시간표");
      }
      const participant=[...this.sql.exec("SELECT slots FROM people WHERE id=?",auth.participantId)][0];
      const slots=JSON.parse(participant.slots);
      for(const [k,v] of Object.entries(changes)) { if(v===null)delete slots[k]; else slots[k]=v; }
      this.sql.exec("UPDATE people SET slots=? WHERE id=?",JSON.stringify(slots),auth.participantId);
      this.broadcast({type:"update",participantId:auth.participantId,changes});
      return json({ok:true});
    }
    const reissue=/^\/api\/rooms\/[\w-]+\/reissue\/(p\d+|viewer)$/.exec(path);
    if (request.method==="POST" && reissue) {
      if(auth.role!=="manager") return fail("팀장만 가능합니다.",403);
      const fresh=token(),h=await hash(fresh),id=reissue[1];
      if(id==="viewer") this.sql.exec("UPDATE meta SET viewer_hash=? WHERE id=1",h);
      else {
        const p=[...this.sql.exec("SELECT id FROM people WHERE id=?",id)][0];
        if(!p)return fail("참석자를 찾을 수 없습니다.",404);
        this.sql.exec("UPDATE people SET token_hash=? WHERE id=?",h,id);
      }
      for(const ws of this.ctx.getWebSockets()) {
        const a=ws.deserializeAttachment();
        if(a?.authorized && (id==="viewer"&&a.role==="viewer" || a.participantId===id)) try{ws.close(4001,"참여 링크 변경")}catch{}
      }
      return json({token:fresh,participantId:id});
    }
    return fail("요청을 찾을 수 없습니다.",404);
  }
  async webSocketMessage(ws, message) {
    let body; try {body=JSON.parse(typeof message==="string"?message:"");}catch{ws.close(1008,"잘못된 요청");return;}
    if(body.type==="auth" && !ws.deserializeAttachment()?.authorized) {
      const auth=await this.identify(body.token);
      if(!auth) {ws.close(1008,"인증 실패");return;}
      ws.serializeAttachment({authorized:true,...auth});
      ws.send(JSON.stringify({type:"snapshot",data:this.snapshot(auth)}));
      return;
    }
    if(!ws.deserializeAttachment()?.authorized){ws.close(1008,"인증 필요");return;}
    if(body.type==="ping")ws.send(JSON.stringify({type:"pong"}));
  }
  webSocketClose(ws, code, reason) { try{ws.close(code>=1000&&code<=4999?code:1000,reason||"")}catch{} }
}
