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
  return origin ? { "access-control-allow-origin": origin, "access-control-allow-headers": "content-type, authorization, x-moimo-user, x-moimo-session, x-moimo-admin", "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS", "vary": "Origin" } : {};
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


const ROOM_LIFETIME_MS=60*24*60*60*1000;
function catalogStub(env){return env.ROOMS.get(env.ROOMS.idFromName("__moimo_catalog_v1"))}
async function verifiedAdmin(request,env){
  const expected=env.MOIMO_ADMIN_KEY;
  const given=request.headers.get("X-Moimo-Admin")||"";
  if(typeof expected!=="string"||expected.length<32||given.length<32||given.length>512)return false;
  return await hash(expected)===await hash(given);
}
function recoveryUsername(code){
  if(typeof code!=="string")return "";
  const match=/^MOIMO:([\p{L}\p{N}_.-]{3,24}):([A-Za-z0-9_-]{40,64})$/u.exec(code);
  return match?usernameOf(match[1]):"";
}

function usernameOf(value) {
  if(typeof value!=="string")return "";
  const name=value.trim().normalize("NFKC").toLowerCase();
  return name.length>=3 && name.length<=24 && /^[\p{L}\p{N}_.-]+$/u.test(name)?name:"";
}
function passwordAllowed(value){return typeof value==="string"&&value.length>=8&&value.length<=128}
async function passwordHash(password,salt){
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",salt:new TextEncoder().encode(salt),iterations:80000,hash:"SHA-256"},key,256);
  return Array.from(new Uint8Array(bits),x=>x.toString(16).padStart(2,"0")).join("");
}
function accountStub(env,uid){return env.ROOMS.get(env.ROOMS.idFromName("__moimo_user_"+uid));}
async function internalRequest(stub,path,data=null,extra={}){
  return stub.fetch(new Request("https://internal/"+path,{
    method:data===null?"GET":"POST",headers:{"content-type":"application/json",...extra},
    ...(data===null?{}:{body:JSON.stringify(data)})
  }));
}
function corsResponse(response,cors){
  const headers=new Headers(response.headers);
  for(const [k,v] of Object.entries(cors))headers.set(k,v);
  headers.set("cache-control","no-store");
  return new Response(response.body,{status:response.status,headers});
}
async function verifiedOwner(request,env){
  const username=usernameOf(request.headers.get("X-Moimo-User"));
  const session=request.headers.get("X-Moimo-Session")||"";
  if(!username||!/^[A-Za-z0-9_-]{40,64}$/.test(session))return null;
  const result=await internalRequest(accountStub(env,"acct:"+username),"account/validate",{session});
  return result.ok?"acct:"+username:null;
}
async function creationLimit(env,request){
 const stub=env.ROOMS.get(env.ROOMS.idFromName("__moimo_creation_gate"));
 const response=await internalRequest(stub,"rate",{ip:request.headers.get("CF-Connecting-IP")||"local"});
 return response.ok;
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request);
    if (origin === false) return fail("허용되지 않은 접속입니다.", 403);
    const cors = corsHeaders(origin);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    if (url.pathname === "/api/health" && request.method === "GET") return json({ ok: true, app: "Moim_O" }, 200, cors);


    if(url.pathname==="/api/account/recover" && request.method==="POST"){
      const b=await parseBody(request), username=recoveryUsername(b?.recoveryCode);
      if(!username||!passwordAllowed(b?.newPassword))
        return json({error:"복구 코드와 새 비밀번호를 확인하세요."},400,cors);
      if(!await creationLimit(env,request))
        return json({error:"복구 요청이 너무 많습니다."},429,cors);
      return corsResponse(await internalRequest(accountStub(env,"acct:"+username),"account/recover",b),cors);
    }
    if(url.pathname==="/api/account/recovery/rotate" && request.method==="POST"){
      const uid=await verifiedOwner(request,env);
      if(!uid)return json({error:"로그인이 필요합니다."},401,cors);
      return corsResponse(await internalRequest(accountStub(env,uid),"account/recovery/rotate",{}),cors);
    }
    if(url.pathname==="/api/account/password" && request.method==="POST"){
      const uid=await verifiedOwner(request,env),b=await parseBody(request);
      if(!uid)return json({error:"로그인이 필요합니다."},401,cors);
      return corsResponse(await internalRequest(accountStub(env,uid),"account/password",b),cors);
    }
    if(url.pathname.startsWith("/api/admin/")){
      if(typeof env.MOIMO_ADMIN_KEY!=="string"||env.MOIMO_ADMIN_KEY.length<32)
        return json({error:"Cloudflare에 MOIMO_ADMIN_KEY 비밀키를 등록해야 합니다."},503,cors);
      if(!await verifiedAdmin(request,env))return json({error:"최고관리자 인증 실패"},403,cors);
      if(url.pathname==="/api/admin/rooms"&&request.method==="GET")
        return corsResponse(await internalRequest(catalogStub(env),"catalog/rooms"),cors);
      if(url.pathname==="/api/admin/accounts"&&request.method==="GET")
        return corsResponse(await internalRequest(catalogStub(env),"catalog/accounts"),cors);
      const roomPath=/^\/api\/admin\/rooms\/([A-Za-z0-9_-]{12,24})$/.exec(url.pathname);
      if(roomPath){
        const stub=env.ROOMS.get(env.ROOMS.idFromName(roomPath[1]));
        if(request.method==="GET")return corsResponse(
          await internalRequest(stub,"admin/room",{roomId:roomPath[1]}),cors);
        if(request.method==="DELETE")return corsResponse(
          await internalRequest(stub,"admin/delete",{roomId:roomPath[1]}),cors);
      }
      if(url.pathname==="/api/admin/account/find"&&request.method==="POST"){
        const b=await parseBody(request), username=usernameOf(b?.username);
        if(!username)return json({error:"아이디를 확인하세요."},400,cors);
        const stub=accountStub(env,"acct:"+username);
        const result=await internalRequest(stub,"account/admin-status");
        if(result.ok)await internalRequest(catalogStub(env),"catalog/account-add",{username});
        return corsResponse(result,cors);
      }
      if(url.pathname==="/api/admin/account/reset-code"&&request.method==="POST"){
        const b=await parseBody(request),username=usernameOf(b?.username);
        if(!username)return json({error:"아이디를 확인하세요."},400,cors);
        return corsResponse(await internalRequest(accountStub(env,"acct:"+username),
          "account/admin-reset-code",{}),cors);
      }
      const delAccount=/^\/api\/admin\/accounts\/([\p{L}\p{N}_.-]{3,24})$/u.exec(url.pathname);
      if(delAccount && request.method==="DELETE"){
        const username=usernameOf(delAccount[1]);
        if(!username)return json({error:"아이디를 확인하세요."},400,cors);
        const stub=accountStub(env,"acct:"+username);
        const begin=await internalRequest(stub,"account/begin-delete",{});
        if(!begin.ok)return corsResponse(begin,cors);
        const details=await begin.json();
        let deleted=0;
        for(const entry of details.rooms){
          if(!entry.roomId)continue;
          const member=env.ROOMS.get(env.ROOMS.idFromName(entry.roomId));
          const result=await internalRequest(member,"admin/delete",
            {roomId:entry.roomId,expectedOwner:"acct:"+username});
          if(!result.ok && result.status!==404)
            return json({error:"일부 모임 삭제에 실패했습니다. 다시 실행하면 이어서 처리합니다.",deleted},500,cors);
          await internalRequest(catalogStub(env),"catalog/room-remove",{roomId:entry.roomId});
          deleted++;
        }
        const finished=await internalRequest(stub,"account/final-delete",{});
        if(!finished.ok)return corsResponse(finished,cors);
        await internalRequest(catalogStub(env),"catalog/account-remove",{username});
        return json({ok:true,deletedRooms:deleted},200,cors);
      }
      return json({error:"최고관리자 메뉴를 찾을 수 없습니다."},404,cors);
    }

    if (url.pathname === "/api/account/register" && request.method === "POST" ||
        url.pathname === "/api/account/login" && request.method === "POST") {
      const input=await parseBody(request);
      const username=usernameOf(input?.username),password=input?.password;
      if(!username||!passwordAllowed(password))return json({error:"아이디는 3~24자, 비밀번호는 8자 이상이어야 합니다."},400,cors);
      if(url.pathname.endsWith("/register") && !await creationLimit(env,request))
        return json({error:"가입 시도가 너무 많습니다. 잠시 후 다시 시도하세요."},429,cors);
      const action=url.pathname.endsWith("/register")?"register":"login";
      const result=await internalRequest(accountStub(env,"acct:"+username),"account/"+action,{username,password});
      if(result.ok)await internalRequest(catalogStub(env),"catalog/account-add",{username});
      return corsResponse(result,cors);
    }
    if(url.pathname === "/api/account/me" && request.method === "GET"){
      const uid=await verifiedOwner(request,env);
      return uid?json({username:uid.slice(5)},200,cors):json({error:"로그인이 필요합니다."},401,cors);
    }
    if(url.pathname === "/api/account/logout" && request.method === "POST"){
      const uid=await verifiedOwner(request,env);
      if(!uid)return json({ok:true},200,cors);
      const response=await internalRequest(accountStub(env,uid),"account/logout",{session:request.headers.get("X-Moimo-Session")});
      return corsResponse(response,cors);
    }


    if (url.pathname === "/api/my/rooms" && request.method === "GET") {
      const uid=await verifiedOwner(request,env);
      if(!uid) return json({error:"로그인이 필요합니다."},401,cors);
      return corsResponse(await internalRequest(accountStub(env,uid),"account/list"),cors);
    }
    if (url.pathname === "/api/my/claim" && request.method === "POST") {
      const uid=await verifiedOwner(request,env);
      if(!uid) return json({error:"로그인이 필요합니다."},401,cors);
      const input=await parseBody(request);
      if(!input || !/^[\w-]{12,24}$/.test(input.roomId||"") ||
         !/^[\w-]{40,64}$/.test(input.managerToken||"")) return json({error:"관리 링크를 확인해 주세요."},400,cors);
      const stub=env.ROOMS.get(env.ROOMS.idFromName(input.roomId));
      const result=await internalRequest(stub,"owner/claim",{uid,managerToken:input.managerToken,roomId:input.roomId});
      if(!result.ok) return corsResponse(result,cors);
      const info=await result.json();
      const entry={roomId:input.roomId, title:info.title, startDate:info.startDate,
        endDate:info.endDate, managerToken:input.managerToken, expiresAt:info.expiresAt};
      const added=await internalRequest(accountStub(env,uid),"account/add",entry);
      if(!added.ok) return json({error:"모임 계정 연결을 저장하지 못했습니다."},500,cors);
      const detail=await internalRequest(stub,"admin/room",{});
      if(detail.ok){
        const d=await detail.json();
        await internalRequest(catalogStub(env),"catalog/room-add",
          {roomId:entry.roomId,owner:uid.slice(5),title:d.title,startDate:d.startDate,
           endDate:d.endDate,expiresAt:d.expiresAt,participantCount:d.participants.length});
      }
      return json({ok:true},200,cors);
    }
    const deletion=/^\/api\/rooms\/([\w-]{12,24})$/.exec(url.pathname);
    if (request.method === "DELETE" && deletion) {
      const uid=await verifiedOwner(request,env), managerToken=authToken(request);
      if(!uid && !managerToken) return json({error:"팀장 인증이 필요합니다."},401,cors);
      const stub=env.ROOMS.get(env.ROOMS.idFromName(deletion[1]));
      const result=await internalRequest(stub,"owner/delete",{uid,managerToken});
      if(!result.ok) return corsResponse(result,cors);
      return json({ok:true},200,cors);
    }

    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const uid=await verifiedOwner(request,env);
      if(!uid) return json({error:"모임 생성은 로그인이 필요합니다."},401,cors);
      const raw = await parseBody(request);
      const checked = validateNew(raw);
      if (!checked) return json({ error: "모임 정보를 확인해 주세요. (최대 30명·31일·하루 96칸)" }, 400, cors);
      if(!await creationLimit(env,request))return json({error:"모임 생성이 잠시 제한되었습니다. 잠시 후 다시 시도해 주세요."},429,cors);
      const roomId = token().slice(0, 16);
      const managerToken = token(), viewerToken = token();
      const participants = await Promise.all(checked.participants.map(async (p,i)=>{
        const salt=token().slice(0,16), id="p"+(i+1);
        return {id,name:p.name,pinSalt:salt,pinHash:await hash(salt+":"+p.pin)};
      }));
      const stub = env.ROOMS.get(env.ROOMS.idFromName(roomId));
      const result = await stub.fetch(new Request("https://internal/init", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: { roomId, title: checked.title, dates: checked.dates,
          startTime: checked.startTime, endTime: checked.endTime, unitMinutes: checked.unitMinutes },
          managerHash: await hash(managerToken), viewerHash: await hash(viewerToken),
          ownerUid:uid,
          participants:participants.map(p=>({id:p.id,name:p.name,pinSalt:p.pinSalt,pinHash:p.pinHash})) })
      }));
      if (!result.ok) return json({ error: "모임 생성에 실패했습니다." }, 500, cors);
      const entry={roomId,title:checked.title,startDate:checked.dates[0],endDate:checked.dates.at(-1),managerToken,expiresAt:Date.now()+ROOM_LIFETIME_MS};
      const record=await internalRequest(accountStub(env,uid),"account/add",entry);
      if(!record.ok) return json({error:"모임은 생성되었지만 내 모임 저장에 실패했습니다.",roomId,managerToken},500,cors);
      await internalRequest(catalogStub(env),"catalog/room-add",{
        roomId,owner:uid.slice(5),title:checked.title,startDate:checked.dates[0],
        endDate:checked.dates.at(-1),expiresAt:entry.expiresAt,participantCount:participants.length
      });
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
    this.env = env;
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY, config TEXT NOT NULL, manager_hash TEXT NOT NULL, viewer_hash TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS people (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL, slots TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, hits INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS user_rooms (room_id TEXT PRIMARY KEY, details TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS catalog_rooms (room_id TEXT PRIMARY KEY, details TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS catalog_accounts (username TEXT PRIMARY KEY, created_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS accounts (username TEXT PRIMARY KEY, salt TEXT NOT NULL, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS account_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS recovery_codes (code_hash TEXT PRIMARY KEY, issued_at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS deleted_rooms (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS sessions (token_hash TEXT PRIMARY KEY, participant_id TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    const metaCols=[...this.sql.exec("PRAGMA table_info(meta)")];
    if(!metaCols.some(c=>c.name==="owner_uid")) this.sql.exec("ALTER TABLE meta ADD COLUMN owner_uid TEXT");
    if(!metaCols.some(c=>c.name==="created_at")) this.sql.exec("ALTER TABLE meta ADD COLUMN created_at INTEGER");
    if(!metaCols.some(c=>c.name==="expires_at")) this.sql.exec("ALTER TABLE meta ADD COLUMN expires_at INTEGER");
    const peopleCols=[...this.sql.exec("PRAGMA table_info(people)")];
    if(!peopleCols.some(c=>c.name==="pin_hash")) this.sql.exec("ALTER TABLE people ADD COLUMN pin_hash TEXT");
    if(!peopleCols.some(c=>c.name==="pin_salt")) this.sql.exec("ALTER TABLE people ADD COLUMN pin_salt TEXT");
  }
  meta() { return [...this.sql.exec("SELECT * FROM meta WHERE id=1")][0] || null; }
  async expireIfNeeded() {
    const m=this.meta();
    if(!m)return false;
    if(!m.expires_at){
      // Pre-migration rooms lack creation timestamps; start their retention clock on first access.
      const created=Date.now(),expires=created+ROOM_LIFETIME_MS;
      this.sql.exec("UPDATE meta SET created_at=?,expires_at=? WHERE id=1",created,expires);
      await this.ctx.storage.setAlarm(expires);
      return false;
    }
    if(m.expires_at<=Date.now()){await this.destroyRoom(m);return true}
    if(await this.ctx.storage.getAlarm()===null)await this.ctx.storage.setAlarm(m.expires_at);
    return false;
  }
  async destroyRoom(m) {
    for(const ws of this.ctx.getWebSockets())try{ws.close(4002,"모임 만료 또는 삭제")}catch{}
    if(m.owner_uid){
      try{
        const identifier=JSON.parse(m.config).roomId;
        if(identifier){
          await internalRequest(accountStub(this.env,m.owner_uid),"account/remove",{roomId:identifier});
          await internalRequest(catalogStub(this.env),"catalog/room-remove",{roomId:identifier});
        }
      }catch{}
    }
    await this.ctx.storage.deleteAlarm();
    // Clear the complete SQLite-backed Durable Object storage, not just hide the room.
    await this.ctx.storage.deleteAll();
  }
  async alarm() {
    const m=this.meta();
    if(!m)return;
    if(m.expires_at && m.expires_at>Date.now()){
      await this.ctx.storage.setAlarm(m.expires_at);return;
    }
    await this.destroyRoom(m);
  }
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



    if(path==="/catalog/rooms"&&request.method==="GET"){
      const rows=[...this.sql.exec("SELECT details FROM catalog_rooms ORDER BY rowid DESC")].map(x=>JSON.parse(x.details));
      const rooms=rows.filter(r=>!r.expiresAt||r.expiresAt>Date.now());
      for(const r of rows)if(r.expiresAt&&r.expiresAt<=Date.now())
        this.sql.exec("DELETE FROM catalog_rooms WHERE room_id=?",r.roomId);
      return json({rooms,total:rooms.length});
    }
    if(path==="/catalog/accounts"&&request.method==="GET"){
      const accounts=[...this.sql.exec("SELECT username,created_at FROM catalog_accounts ORDER BY created_at DESC")]
        .map(r=>({username:r.username,createdAt:r.created_at}));
      return json({accounts,total:accounts.length});
    }
    if(path==="/catalog/room-add"&&request.method==="POST"){
      const b=await parseBody(request);
      if(!/^[\w-]{12,24}$/.test(b?.roomId||"")||!usernameOf(b?.owner))return fail("잘못된 모임");
      const entry={roomId:b.roomId,owner:b.owner,title:cleanName(b.title,80),
        startDate:b.startDate,endDate:b.endDate,expiresAt:b.expiresAt,
        participantCount:Number(b.participantCount)||0};
      this.sql.exec("INSERT INTO catalog_rooms(room_id,details) VALUES(?,?) ON CONFLICT(room_id) DO UPDATE SET details=excluded.details",
        b.roomId,JSON.stringify(entry));
      return json({ok:true});
    }
    if(path==="/catalog/room-remove"&&request.method==="POST"){
      const b=await parseBody(request);
      if(!/^[\w-]{12,24}$/.test(b?.roomId||""))return fail("잘못된 모임");
      this.sql.exec("DELETE FROM catalog_rooms WHERE room_id=?",b.roomId);
      return json({ok:true});
    }
    if(path==="/catalog/account-add"&&request.method==="POST"){
      const b=await parseBody(request),username=usernameOf(b?.username);
      if(!username)return fail("잘못된 계정");
      this.sql.exec("INSERT OR IGNORE INTO catalog_accounts(username,created_at) VALUES(?,?)",username,Date.now());
      return json({ok:true});
    }
    if(path==="/catalog/account-remove"&&request.method==="POST"){
      const b=await parseBody(request),username=usernameOf(b?.username);
      if(!username)return fail("잘못된 계정");
      this.sql.exec("DELETE FROM catalog_accounts WHERE username=?",username);
      return json({ok:true});
    }
    if(path==="/account/admin-status"&&request.method==="GET"){
      const row=[...this.sql.exec("SELECT username,created_at FROM accounts LIMIT 1")][0];
      return row?json({username:row.username,createdAt:row.created_at}):fail("계정을 찾을 수 없습니다.",404);
    }
    if(path==="/account/recovery/rotate"&&request.method==="POST" ||
       path==="/account/admin-reset-code"&&request.method==="POST"){
      const row=[...this.sql.exec("SELECT username FROM accounts LIMIT 1")][0];
      if(!row)return fail("계정을 찾을 수 없습니다.",404);
      const code=token(),combined="MOIMO:"+row.username+":"+code;
      this.sql.exec("DELETE FROM recovery_codes");
      this.sql.exec("INSERT INTO recovery_codes(code_hash,issued_at) VALUES(?,?)",await hash(combined),Date.now());
      return json({recoveryCode:combined,username:row.username});
    }
    if(path==="/account/recover"&&request.method==="POST"){
      const b=await parseBody(request);
      const username=recoveryUsername(b?.recoveryCode);
      if(!username||!passwordAllowed(b?.newPassword))return fail("복구 코드 또는 비밀번호를 확인하세요.",400);
      const row=[...this.sql.exec("SELECT username FROM accounts LIMIT 1")][0];
      if(!row||row.username!==username)return fail("복구 정보를 확인하세요.",401);
      const code=[...this.sql.exec("SELECT issued_at FROM recovery_codes WHERE code_hash=?",await hash(b.recoveryCode))][0];
      if(!code)return fail("복구 코드를 확인하세요.",401);
      const salt=token(),digest=await passwordHash(b.newPassword,salt);
      this.sql.exec("UPDATE accounts SET salt=?,password_hash=? WHERE username=?",salt,digest,username);
      this.sql.exec("DELETE FROM recovery_codes");
      this.sql.exec("DELETE FROM account_sessions");
      return json({ok:true});
    }
    if(path==="/account/password"&&request.method==="POST"){
      const b=await parseBody(request),row=[...this.sql.exec("SELECT username,salt,password_hash FROM accounts LIMIT 1")][0];
      if(!row||!passwordAllowed(b?.currentPassword)||!passwordAllowed(b?.newPassword))
        return fail("비밀번호를 확인하세요.",400);
      if(await passwordHash(b.currentPassword,row.salt)!==row.password_hash)
        return fail("기존 비밀번호가 일치하지 않습니다.",403);
      const salt=token(),digest=await passwordHash(b.newPassword,salt);
      this.sql.exec("UPDATE accounts SET salt=?,password_hash=? WHERE username=?",salt,digest,row.username);
      this.sql.exec("DELETE FROM recovery_codes");
      this.sql.exec("DELETE FROM account_sessions");
      return json({ok:true});
    }
    if(path==="/account/begin-delete"&&request.method==="POST"){
      const row=[...this.sql.exec("SELECT username FROM accounts LIMIT 1")][0];
      if(!row)return fail("계정을 찾을 수 없습니다.",404);
      const rooms=[...this.sql.exec("SELECT details FROM user_rooms")].map(x=>JSON.parse(x.details));
      return json({username:row.username,rooms});
    }
    if(path==="/account/final-delete"&&request.method==="POST"){
      const row=[...this.sql.exec("SELECT username FROM accounts LIMIT 1")][0];
      if(!row)return fail("계정 없음",404);
      this.sql.exec("DELETE FROM accounts");
      this.sql.exec("DELETE FROM account_sessions");
      this.sql.exec("DELETE FROM recovery_codes");
      this.sql.exec("DELETE FROM user_rooms");
      return json({ok:true});
    }
    if(path==="/admin/room"&&request.method==="POST"){
      if(await this.expireIfNeeded()||!this.meta())return fail("모임을 찾을 수 없습니다.",404);
      const m=this.meta(),cfg=JSON.parse(m.config);
      return json({roomId:cfg.roomId||null,title:cfg.title,owner:(m.owner_uid||"").replace(/^acct:/,""),
        startDate:cfg.dates[0],endDate:cfg.dates.at(-1),expiresAt:m.expires_at||null,
        participants:this.people().map(p=>({name:p.name,slots:JSON.parse(p.slots)}))});
    }
    if(path==="/admin/delete"&&request.method==="POST"){
      const b=await parseBody(request),m=this.meta();
      if(!m)return fail("모임을 찾을 수 없습니다.",404);
      if(b?.expectedOwner&&m.owner_uid!==b.expectedOwner)return fail("다른 팀장이 소유한 모임입니다.",403);
      await this.destroyRoom(m);
      return json({ok:true});
    }

    if(path === "/account/register" && request.method === "POST"){
      const b=await parseBody(request);
      if(!usernameOf(b?.username)||!passwordAllowed(b?.password))return fail("아이디나 비밀번호가 올바르지 않습니다.");
      if([...this.sql.exec("SELECT username FROM accounts LIMIT 1")].length)return fail("이미 사용 중인 아이디입니다.",409);
      const salt=token(),digest=await passwordHash(b.password,salt);
      this.sql.exec("INSERT INTO accounts(username,salt,password_hash,created_at) VALUES(?,?,?,?)",b.username,salt,digest,Date.now());
      const session=token();
      this.sql.exec("INSERT INTO account_sessions(token_hash,expires_at) VALUES(?,?)",await hash(session),Date.now()+30*86400000);
      return json({username:b.username,session},201);
    }
    if(path === "/account/login" && request.method === "POST"){
      const b=await parseBody(request), bucket=Math.floor(Date.now()/900000),k="failed-logins";
      if(!passwordAllowed(b?.password))return fail("아이디 또는 비밀번호가 올바르지 않습니다.",401);
      const attempt=[...this.sql.exec("SELECT window,hits FROM limits WHERE key=?",k)][0];
      if(attempt?.window===bucket&&attempt.hits>=8)return fail("로그인 시도가 너무 많습니다. 15분 뒤에 다시 시도하세요.",429);
      const row=[...this.sql.exec("SELECT username,salt,password_hash FROM accounts LIMIT 1")][0];
      const good=row && await passwordHash(b.password,row.salt)===row.password_hash;
      if(!good){
        this.sql.exec("INSERT INTO limits(key,window,hits) VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,hits=CASE WHEN limits.window=excluded.window THEN limits.hits+1 ELSE 1 END",k,bucket);
        return fail("아이디 또는 비밀번호가 올바르지 않습니다.",401);
      }
      this.sql.exec("DELETE FROM limits WHERE key=?",k);
      const session=token();
      this.sql.exec("DELETE FROM account_sessions WHERE expires_at<?",Date.now());
      this.sql.exec("INSERT INTO account_sessions(token_hash,expires_at) VALUES(?,?)",await hash(session),Date.now()+30*86400000);
      return json({username:row.username,session});
    }
    if(path === "/account/validate" && request.method === "POST"){
      const b=await parseBody(request);
      if(!/^[\w-]{40,64}$/.test(b?.session||""))return fail("세션 만료",401);
      const row=[...this.sql.exec("SELECT expires_at FROM account_sessions WHERE token_hash=?",await hash(b.session))][0];
      return row&&row.expires_at>Date.now()?json({ok:true}):fail("세션 만료",401);
    }
    if(path === "/account/logout" && request.method === "POST"){
      const b=await parseBody(request);
      if(/^[\w-]{40,64}$/.test(b?.session||""))this.sql.exec("DELETE FROM account_sessions WHERE token_hash=?",await hash(b.session));
      return json({ok:true});
    }

    if (path === "/account/list" && request.method === "GET") {
      const all=[...this.sql.exec("SELECT details FROM user_rooms ORDER BY rowid DESC")].map(row=>JSON.parse(row.details));
      const rooms=all.filter(r=>!r.expiresAt||r.expiresAt>Date.now());
      for(const r of all)if(r.expiresAt&&r.expiresAt<=Date.now())this.sql.exec("DELETE FROM user_rooms WHERE room_id=?",r.roomId);
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
      if(m.owner_uid && m.owner_uid!==b.uid && m.owner_uid.startsWith("acct:")) return fail("다른 계정에 연결된 모임입니다.",403);
      if(m.owner_uid!==b.uid)this.sql.exec("UPDATE meta SET owner_uid=? WHERE id=1",b.uid);
      const cfg=JSON.parse(m.config);
      if(!cfg.roomId && b.roomId){
        cfg.roomId=b.roomId;
        this.sql.exec("UPDATE meta SET config=? WHERE id=1",JSON.stringify(cfg));
      }
      return json({ok:true,title:cfg.title,startDate:cfg.dates[0],endDate:cfg.dates.at(-1),expiresAt:m.expires_at||Date.now()+ROOM_LIFETIME_MS});
    }
    if (path === "/owner/delete" && request.method === "POST") {
      const b=await parseBody(request), m=this.meta();
      if(!m) return fail("모임을 찾을 수 없습니다.",404);
      if(m.owner_uid ? b?.uid!==m.owner_uid :
        (!b?.managerToken || await hash(b.managerToken)!==m.manager_hash)) return fail("모임 삭제 권한이 없습니다.",403);
      await this.destroyRoom(m);
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
      const created=Date.now(), expires=created+ROOM_LIFETIME_MS;
      this.sql.exec("INSERT INTO meta(id,config,manager_hash,viewer_hash,owner_uid,created_at,expires_at) VALUES(1,?,?,?,?,?,?)",
        JSON.stringify(b.config),b.managerHash,b.viewerHash,b.ownerUid||null,created,expires);
      await this.ctx.storage.setAlarm(expires);
      for(const p of b.participants) this.sql.exec(
        "INSERT INTO people(id,name,token_hash,slots,pin_hash,pin_salt) VALUES(?,?,?,?,?,?)",
        p.id,p.name,p.tokenHash||"","{}",p.pinHash||null,p.pinSalt||null);
      return json({ok:true},201);
    }
    if (await this.expireIfNeeded()) return fail("모임이 60일 보관 기간 만료로 삭제되었습니다.",410);
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
