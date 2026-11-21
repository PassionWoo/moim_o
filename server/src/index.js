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
      names.some(p => !p || typeof p !== "object" || !cleanName(p.name) ||
        p.name.trim().length > 30 || !/^[0-9]{4}$/.test(p.pin || ""))) return null;
  const members = names.map(p => ({ name:cleanName(p.name), pin:p.pin }))
    .sort((a,b)=>a.name.localeCompare(b.name,"ko"));
  if (new Set(members.map(p=>p.name)).size !== members.length) return null;
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
  return origin ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, authorization, x-firebase-token", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "vary": "Origin" } : {};
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

const FIREBASE_PROJECT = "team-schedule-45f53";
const FIREBASE_JWK = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let signingKeys = [], keysExpire = 0;
function decodeBase64Url(str) {
  if (typeof str !== "string" || !/^[A-Za-z0-9_-]+$/.test(str)) throw Error("bad encoding");
  const base = str.replace(/-/g,"+").replace(/_/g,"/");
  return Uint8Array.from(atob(base+"=".repeat((4-base.length%4)%4)),c=>c.charCodeAt(0));
}
function decodePart(v) {return JSON.parse(new TextDecoder().decode(decodeBase64Url(v)));}
async function getSigningKey(kid) {
  if (!signingKeys.length || keysExpire < Date.now() || !signingKeys.some(k=>k.kid===kid)) {
    const response=await fetch(FIREBASE_JWK);
    if (!response.ok) throw Error("verification unavailable");
    signingKeys=(await response.json()).keys||[];
    keysExpire=Date.now()+45*60*1000;
  }
  return signingKeys.find(k=>k.kid===kid);
}
async function verifiedOwner(request) {
  const value=request.headers.get("X-Firebase-Token")||"";
  if (value.length<100 || value.length>10000) return null;
  try {
    const bits=value.split(".");
    if(bits.length!==3) return null;
    const h=decodePart(bits[0]), c=decodePart(bits[1]);
    const now=Math.floor(Date.now()/1000);
    if(h.alg!=="RS256" || !h.kid || c.aud!==FIREBASE_PROJECT ||
       c.iss!=="https://securetoken.google.com/"+FIREBASE_PROJECT ||
       typeof c.sub!=="string" || !c.sub || c.sub.length>128 ||
       !Number.isFinite(c.exp) || c.exp<=now || !Number.isFinite(c.iat) || c.iat>now+60 ||
       !Number.isFinite(c.auth_time) || c.firebase?.sign_in_provider!=="google.com") return null;
    const jwk=await getSigningKey(h.kid);
    if(!jwk) return null;
    const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
    const good=await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,decodeBase64Url(bits[2]),
      new TextEncoder().encode(bits[0]+"."+bits[1]));
    return good ? c.sub : null;
  }catch{return null;}
}
function accountStub(env,uid){return env.ROOMS.get(env.ROOMS.idFromName("__moimo_user_"+uid));}
async function internalRequest(stub,path,data=null) {
  return stub.fetch(new Request("https://internal/"+path,{
    method:data===null?"GET":"POST",
    headers:{"content-type":"application/json"},
    ...(data===null?{}:{body:JSON.stringify(data)})
  }));
}
function corsResponse(response,cors){
  const headers=new Headers(response.headers);
  for(const [k,v] of Object.entries(cors)) headers.set(k,v);
  headers.set("cache-control","no-store");
  return new Response(response.body,{status:response.status,headers});
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request);
    if (origin === false) return fail("허용되지 않은 접속입니다.", 403);
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, app: "Moim_O" }, 200, cors);

    if (url.pathname === "/api/my/rooms" && request.method === "GET") {
      const uid=await verifiedOwner(request);
      if(!uid) return json({error:"구글 로그인이 필요합니다."},401,cors);
      return corsResponse(await internalRequest(accountStub(env,uid),"account/list"),cors);
    }
    if (url.pathname === "/api/my/claim" && request.method === "POST") {
      const uid=await verifiedOwner(request);
      if(!uid) return json({error:"구글 로그인이 필요합니다."},401,cors);
      const input=await parseBody(request);
      if(!input || !/^[\w-]{12,24}$/.test(input.roomId||"") ||
         !/^[\w-]{40,64}$/.test(input.managerToken||"")) return json({error:"관리 링크를 확인해 주세요."},400,cors);
      const stub=env.ROOMS.get(env.ROOMS.idFromName(input.roomId));
      const result=await internalRequest(stub,"owner/claim",{uid,managerToken:input.managerToken});
      if(!result.ok) return corsResponse(result,cors);
      const info=await result.json();
      const entry={roomId:input.roomId, title:info.title, startDate:info.startDate,
        endDate:info.endDate, managerToken:input.managerToken};
      const added=await internalRequest(accountStub(env,uid),"account/add",entry);
      if(!added.ok) return json({error:"모임 계정 연결을 저장하지 못했습니다."},500,cors);
      return json({ok:true},200,cors);
    }
    const deletion=/^\/api\/rooms\/([\w-]{12,24})$/.exec(url.pathname);
    if (request.method === "DELETE" && deletion) {
      const uid=await verifiedOwner(request), managerToken=authToken(request);
      if(!uid && !managerToken) return json({error:"팀장 인증이 필요합니다."},401,cors);
      const stub=env.ROOMS.get(env.ROOMS.idFromName(deletion[1]));
      const result=await internalRequest(stub,"owner/delete",{uid,managerToken});
      if(!result.ok) return corsResponse(result,cors);
      const data=await result.json();
      if(data.ownerUid) await internalRequest(accountStub(env,data.ownerUid),"account/remove",{roomId:deletion[1]});
      return json({ok:true},200,cors);
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const uid=await verifiedOwner(request);
      if(!uid) return json({error:"모임 생성은 구글 로그인이 필요합니다."},401,cors);
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
      const participants = await Promise.all(checked.participants.map(async (p,i)=>{
        const salt=token().slice(0,16), id="p"+(i+1);
        return {id,name:p.name,pinSalt:salt,pinHash:await hash(salt+":"+p.pin)};
      }));
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const result = await stub.fetch(new Request("https://internal/init", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { title: checked.title, dates: checked.dates,
          startTime: checked.startTime, endTime: checked.endTime, unitMinutes: checked.unitMinutes },
          managerHash: await hash(managerToken), viewerHash: await hash(viewerToken),
          ownerUid:uid,
          participants:participants.map(p=>({id:p.id,name:p.name,pinSalt:p.pinSalt,pinHash:p.pinHash})) })
      }));
      if (!result.ok) return json({ error: "모임 생성에 실패했습니다." }, 500, cors);
      const entry={roomId,title:checked.title,startDate:checked.dates[0],endDate:checked.dates.at(-1),managerToken};
      const record=await internalRequest(accountStub(env,uid),"account/add",entry);
      if(!record.ok) return json({error:"모임은 생성되었지만 내 모임 저장에 실패했습니다.",roomId,managerToken},500,cors);
      return json({roomId,managerToken,participants:participants.map(p=>({id:p.id,name:p.name}))},201,cors);
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
    this.sql.exec("CREATE TABLE IF NOT EXISTS user_rooms (room_id TEXT PRIMARY KEY, details TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS deleted_rooms (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, participant_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    const metaCols=[...this.sql.exec("PRAGMA table_info(meta)")];
    if(!metaCols.some(c=>c.name==="owner_uid")) this.sql.exec("ALTER TABLE meta ADD COLUMN owner_uid TEXT");
    const peopleCols=[...this.sql.exec("PRAGMA table_info(people)")];
    if(!peopleCols.some(c=>c.name==="pin_hash")) this.sql.exec("ALTER TABLE people ADD COLUMN pin_hash TEXT");
    if(!peopleCols.some(c=>c.name==="pin_salt")) this.sql.exec("ALTER TABLE people ADD COLUMN pin_salt TEXT");
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
    if (p) return {role:"participant",participantId:p.id};
    const session=[...this.sql.exec("SELECT participant_id,expires_at FROM sessions WHERE token_hash=?",h)][0];
    return session && session.expires_at>Date.now() ? {role:"participant",participantId:session.participant_id} : null;
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

    if (path === "/account/list" && request.method === "GET") {
      const rooms=[...this.sql.exec("SELECT details FROM user_rooms ORDER BY rowid DESC")].map(row=>JSON.parse(row.details));
      return json({rooms});
    }
    if (path === "/account/add" && request.method === "POST") {
      const b=await parseBody(request);
      if(!b || !/^[\w-]{12,24}$/.test(b.roomId||"") ||
         !/^[\w-]{40,64}$/.test(b.managerToken||"")) return fail("잘못된 모임");
      this.sql.exec("INSERT INTO user_rooms(room_id,details) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET details=excluded.details",
        b.roomId,JSON.stringify(b));
      return json({ok:true});
    }
    if (path === "/account/remove" && request.method === "POST") {
      const b=await parseBody(request);
      if(!b?.roomId) return fail("잘못된 모임");
      this.sql.exec("DELETE FROM user_rooms WHERE room_id=?",b.roomId);
      return json({ok:true});
    }
    if (path === "/owner/claim" && request.method === "POST") {
      const b=await parseBody(request),m=this.meta();
      if(!m) return fail("모임 없음",404);
      if(!b?.uid || typeof b.managerToken!=="string" ||
         await hash(b.managerToken)!==m.manager_hash) return fail("팀장 링크가 올바르지 않습니다.",403);
      if(m.owner_uid && m.owner_uid!==b.uid) return fail("다른 계정에 연결된 모임입니다.",403);
      if(!m.owner_uid)this.sql.exec("UPDATE meta SET owner_uid=? WHERE id=1",b.uid);
      const cfg=JSON.parse(m.config);
      return json({ok:true,title:cfg.title,startDate:cfg.dates[0],endDate:cfg.dates.at(-1)});
    }
    if (path === "/owner/delete" && request.method === "POST") {
      const b=await parseBody(request), m=this.meta();
      if(!m) return fail("모임을 찾을 수 없습니다.",404);
      if(m.owner_uid ? b?.uid!==m.owner_uid :
        (!b?.managerToken || await hash(b.managerToken)!==m.manager_hash)) return fail("모임 삭제 권한이 없습니다.",403);
      this.sql.exec("INSERT OR REPLACE INTO deleted_rooms(id,at) VALUES(1,?)",Date.now());
      this.sql.exec("DELETE FROM people");
      this.sql.exec("DELETE FROM sessions");
      this.sql.exec("DELETE FROM meta");
      for(const socket of this.ctx.getWebSockets()) try{socket.close(4002,"모임이 삭제되었습니다.")}catch{}
      return json({ok:true,ownerUid:m.owner_uid||null});
    }

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
      if (this.meta() || [...this.sql.exec("SELECT id FROM deleted_rooms WHERE id=1")].length) return fail("이미 존재하거나 삭제된 모임입니다.",409);
      const b = await parseBody(request);
      if (!b?.config || !b.managerHash || !b.viewerHash || !Array.isArray(b.participants)) return fail("잘못된 입력");
      this.sql.exec("INSERT INTO meta(id,config,manager_hash,viewer_hash,owner_uid) VALUES(1,?,?,?,?)",
        JSON.stringify(b.config),b.managerHash,b.viewerHash,b.ownerUid||null);
      for(const p of b.participants) this.sql.exec(
        "INSERT INTO people(id,name,token_hash,slots,pin_hash,pin_salt) VALUES(?,?,?,?,?,?)",
        p.id,p.name,p.tokenHash||"","{}",p.pinHash||null,p.pinSalt||null);
      return json({ok:true},201);
    }
    if (!this.meta()) return fail("모임을 찾을 수 없습니다.",404);

    if (path.endsWith("/public") && request.method === "GET") {
      const cfg=JSON.parse(this.meta().config);
      return json({title:cfg.title,dates:cfg.dates,participants:this.people().map(p=>p.name)});
    }
    if (path.endsWith("/join") && request.method === "POST") {
      const b=await parseBody(request);
      const name=cleanName(b?.name), pin=b?.pin, ip=request.headers.get("CF-Connecting-IP")||"unknown";
      if(!name || !/^[0-9]{4}$/.test(pin||""))return fail("이름과 번호 4자리를 확인하세요.");
      const bucket=Math.floor(Date.now()/900000);
      for(const [key,cap] of [["login:ip:"+ip,12],["login:name:"+name,8]]) {
        const item=[...this.sql.exec("SELECT window,hits FROM limits WHERE key=?",key)][0];
        if(item?.window===bucket && item.hits>=cap) return fail("입력 횟수가 초과되었습니다. 잠시 후 다시 시도하세요.",429);
      }
      const p=[...this.sql.exec("SELECT id,pin_hash,pin_salt FROM people WHERE name=?",name)][0];
      const okay=!!p?.pin_hash && await hash(p.pin_salt+":"+pin)===p.pin_hash;
      if(!okay){
        for(const key of ["login:ip:"+ip,"login:name:"+name])
          this.sql.exec("INSERT INTO limits(key,window,hits) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,hits=CASE WHEN limits.window=excluded.window THEN limits.hits+1 ELSE 1 END",
            key,bucket);
        return fail("이름이나 번호가 일치하지 않습니다.",401);
      }
      const session=token(),expires=Date.now()+7*24*3600*1000;
      this.sql.exec("INSERT INTO sessions(token_hash,participant_id,expires_at) VALUES(?,?,?)",await hash(session),p.id,expires);
      return json({token:session,participantId:p.id,name,expiresAt:expires});
    }

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
