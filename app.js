import {auth, loginAccount, logoutAccount, onAuthStateChanged, ownerHeaders, initializeAuth} from "./auth.js?v=20261121-6";
const $=id=>document.getElementById(id);
const API=(window.MOIMO_API_URL||"").replace(/\/$/,"");
const WEEK=["일","월","화","수","목","금","토"];
const pad=n=>String(n).padStart(2,"0");
const today=new Date();
const initialDate=new Date(today.getFullYear(),today.getMonth(),today.getDate());
const iso=d=>[d.getFullYear(),pad(d.getMonth()+1),pad(d.getDate())].join("-");
const fromISO=s=>{const [y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d)};
const format=s=>{const d=fromISO(s);return `${d.getMonth()+1}월 ${d.getDate()}일(${WEEK[d.getDay()]})`};
const dformat=s=>{const d=fromISO(s);return `${d.getMonth()+1}/${d.getDate()} ${WEEK[d.getDay()]}`};
const hhmm=m=>`${pad(Math.floor(m/60))}:${pad(m%60)}`;
const toMin=s=>{const [h,m]=s.split(":").map(Number);return h*60+m};
const randomHash=()=>location.hash.slice(1);
let month=new Date(initialDate.getFullYear(),initialDate.getMonth(),1),rangeStart=null,rangeEnd=null;
let names=Array.from({length:4},()=>({name:"",pin:""})),roomId="",secret="",room=null,links=null,selected="",paintColor="both",painting=false,pending={},saveTimer=null,ws=null,dayIndex=0,manualClose=false;
let view="start",connectionTimer=null, ownerUser=null, ownerRooms=[],accountRegister=false;
const mobile=()=>matchMedia("(max-width:800px)").matches;
function show(id) {
 for(const k of ["start","account","admin","join","create","share","room"])$(k+"-view").classList.toggle("hidden",k!==id);
 $("home-btn").classList.toggle("hidden",id==="start");
 view=id;
}
function msg(text){const el=$("toast");el.textContent=text;el.classList.remove("hidden");clearTimeout(msg.timer);msg.timer=setTimeout(()=>el.classList.add("hidden"),2200)}
function error(text){$("create-error").textContent=text}
function renderMembers(){
 const el=$("member-inputs");el.replaceChildren();
 names.forEach((person,i)=>{
  const row=document.createElement("div");row.className="member-row";
  const name=document.createElement("input");name.placeholder="참석자 "+(i+1);
  name.maxLength=30;name.value=person.name;name.setAttribute("aria-label","참석자 "+(i+1)+" 이름");
  name.addEventListener("input",()=>{person.name=name.value});
  const pin=document.createElement("input");pin.className="pin-input";pin.type="text";
  pin.inputMode="numeric";pin.autocomplete="off";pin.maxLength=4;pin.placeholder="번호 4자리";
  pin.value=person.pin;pin.setAttribute("aria-label","참석자 "+(i+1)+" 전화번호 끝 네 자리");
  pin.addEventListener("input",()=>{pin.value=pin.value.replace(/[^0-9]/g,"").slice(0,4);person.pin=pin.value});
  const remove=document.createElement("button");remove.className="member-remove";
  remove.type="button";remove.textContent="×";remove.setAttribute("aria-label","참석자 삭제");
  remove.addEventListener("click",()=>{if(names.length===1)return msg("최소 1명");names.splice(i,1);renderMembers()});
  row.append(name,pin,remove);el.append(row);
 });
 $("member-count").textContent=names.length+"명";
}
$("add-member").addEventListener("click",()=>{
 if(names.length>=30)return msg("최대 30명");
 names.push({name:"",pin:""});renderMembers();
 $("member-inputs").lastElementChild.querySelector("input")?.focus();
});
function renderCalendar(){
 $("month-label").textContent=`${month.getFullYear()}년 ${month.getMonth()+1}월`;
 const startOffset=new Date(month.getFullYear(),month.getMonth(),1).getDay();
 const count=new Date(month.getFullYear(),month.getMonth()+1,0).getDate();
 let html=WEEK.map(w=>`<div class="calendar-weekday">${w}</div>`).join("");
 html+='<div class="calendar-day outside"></div>'.repeat(startOffset);
 for(let day=1;day<=count;day++){
  const value=iso(new Date(month.getFullYear(),month.getMonth(),day));
  const inRange=rangeStart&&rangeEnd&&value>=rangeStart&&value<=rangeEnd;
  const endPoint=value===rangeStart||value===rangeEnd;
  html+=`<button class="calendar-day ${inRange?"in-range":""} ${endPoint?"endpoint":""}" type="button" data-date="${value}" aria-pressed="${!!(inRange||endPoint)}">${day}</button>`;
 }
 $("calendar").innerHTML=html;
 $("range-label").textContent=rangeStart?(rangeEnd?`${format(rangeStart)} ~ ${format(rangeEnd)}`:`${format(rangeStart)} ~`):"";
}
$("calendar").addEventListener("click",e=>{
 const b=e.target.closest("[data-date]");if(!b)return;
 const picked=b.dataset.date;
 if(!rangeStart||rangeEnd){rangeStart=picked;rangeEnd=null}
 else if(picked<rangeStart){rangeEnd=rangeStart;rangeStart=picked}
 else rangeEnd=picked;
 renderCalendar();
});
$("month-prev").addEventListener("click",()=>{month=new Date(month.getFullYear(),month.getMonth()-1,1);renderCalendar()});
$("month-next").addEventListener("click",()=>{month=new Date(month.getFullYear(),month.getMonth()+1,1);renderCalendar()});
function setupTimes(){
 const from=$("time-from"),to=$("time-to");
 for(let h=0;h<=24;h++){
  const option=document.createElement("option");option.value=hhmm(h*60);option.textContent=hhmm(h*60);
  if(h<24)from.appendChild(option.cloneNode(true));if(h>0)to.appendChild(option);
 }
 from.value="06:00";to.value="24:00";
}
function configFromForm(){
 const title=$("title").value.trim(),ownerName=$("owner-participant-name").value.trim(),participants=names.map(p=>({name:p.name.trim(),pin:p.pin}));
 const value=Number($("unit").value),unitMinutes=$("unit-type").value==="hours"?value*60:value;
 const startTime=$("time-from").value,endTime=$("time-to").value;
 if(!title){error("모임 이름을 입력하세요.");return null}
 if(!ownerName || ownerName.length>30){error("팀장 본인의 이름을 입력하세요.");return null}
 if(participants.some(p=>!p.name||!/^\d{4}$/.test(p.pin))||new Set([ownerName,...participants.map(p=>p.name)]).size!==participants.length+1){error("팀장과 다른 참석자의 이름은 중복되지 않아야 하며, 전화번호 끝 4자리를 정확히 입력해야 합니다.");return null}
 if(!rangeStart||!rangeEnd){error("시작 날짜와 종료 날짜를 선택하세요.");return null}
 const dayCount=Math.round((fromISO(rangeEnd)-fromISO(rangeStart))/86400000)+1;
 if(dayCount>31){error("날짜는 최대 31일까지 선택할 수 있습니다.");return null}
 if(!Number.isInteger(unitMinutes)||unitMinutes<5||unitMinutes>720){error("시간 단위를 5분~12시간 사이로 입력하세요.");return null}
 const duration=toMin(endTime)-toMin(startTime);
 if(duration<=0||Math.ceil(duration/unitMinutes)>96||dayCount*Math.ceil(duration/unitMinutes)>1500){error("하루 시간 범위를 확인하세요.");return null}
 return {title,ownerName,participants,startDate:rangeStart,endDate:rangeEnd,unitMinutes,startTime,endTime};
}
async function request(path,{method="GET",data=null,key=secret,owner=false}={}){
 if(!API)throw Error("서버 연결 설정이 필요합니다.");
 const headers={"content-type":"application/json"};
 if(key) headers.authorization="Bearer "+key;
 if(owner) Object.assign(headers,ownerHeaders());
 const res=await fetch(API+path,{method,headers,...(data!==null?{body:JSON.stringify(data)}:{})});
 const answer=await res.json().catch(()=>({}));
 if(!res.ok)throw Error(answer.error||"요청 실패");
 return answer;
}
function makeURL(id,key){
 const url=new URL("./",location.href);url.hash=new URLSearchParams({r:id,k:key}).toString();return url.href;
}
function sharedURL(id){
 const url=new URL("./",location.href);url.hash="r="+encodeURIComponent(id);return url.href;
}
async function copy(value){try{await navigator.clipboard.writeText(value);msg("복사됨")}catch{window.prompt("링크 복사",value)}}
function renderShareRows(target){
 const el=$(target);el.replaceChildren();
 const row=document.createElement("div");row.className="share-row";
 const name=document.createElement("strong");name.textContent="모임 참여 링크";
 const button=document.createElement("button");button.type="button";button.textContent="모임 링크 복사하기";
 button.addEventListener("click",()=>copy(sharedURL(roomId)));
 row.append(name,button);el.append(row);
}
async function loadMyRooms(){
 if(!ownerUser){ownerRooms=[];renderMyRooms();return}
 try{
  const data=await request("/api/my/rooms",{owner:true,key:null});
  ownerRooms=data.rooms||[];renderMyRooms();
 }catch(e){$("saved-meetings").classList.remove("hidden");$("saved-meetings-list").textContent=e.message}
}
function renderMyRooms(){
 const section=$("saved-meetings"),list=$("saved-meetings-list");
 section.classList.toggle("hidden",!ownerUser);list.replaceChildren();
 if(!ownerUser)return;
 if(!ownerRooms.length){
  const note=document.createElement("p");note.className="subhead";note.textContent="생성한 모임이 없습니다.";
  list.append(note);return;
 }
 for(const entry of ownerRooms){
  const row=document.createElement("div");row.className="saved-room";
  const main=document.createElement("button");main.className="saved-room-open";main.type="button";
  const title=document.createElement("strong");title.textContent=entry.title;
  const subtitle=document.createElement("span");subtitle.textContent=entry.startDate+" ~ "+entry.endDate+(entry.expiresAt?" · "+new Date(entry.expiresAt).toLocaleDateString("ko-KR")+" 자동 삭제":"");
  main.append(title,subtitle);
  main.addEventListener("click",()=>enterManagedRoom(entry));
  const del=document.createElement("button");del.type="button";del.className="small-button delete-button";del.textContent="삭제";
  del.addEventListener("click",()=>deleteManagedRoom(entry));
  const copyButton=document.createElement("button");copyButton.type="button";copyButton.className="small-button copy-meeting";copyButton.textContent="모임 링크 복사하기";
  copyButton.addEventListener("click",()=>copy(sharedURL(entry.roomId)));
  row.append(main,copyButton,del);list.append(row);
 }
}
async function enterManagedRoom(entry){
 roomId=entry.roomId;secret=entry.managerToken;links=null;
 history.replaceState(null,"","#"+new URLSearchParams({r:roomId,k:secret}));
 await openRoom();
}
async function deleteManagedRoom(entry){
 if(!confirm("‘"+entry.title+"’ 모임과 모든 시간표를 영구 삭제할까요?"))return;
 if(!confirm("삭제하면 복구할 수 없습니다. 정말 삭제할까요?"))return;
 try{
  await request("/api/rooms/"+entry.roomId,{method:"DELETE",owner:!!ownerUser,key:entry.managerToken});
  if(entry.roomId===roomId)goHome();
  await loadMyRooms();msg("모임 삭제 완료");
 }catch(e){msg(e.message)}
}
async function showJoin(id){
 roomId=id;secret="";room=null;selected="";links=null;
 try{
  const info=await request("/api/rooms/"+roomId+"/public",{key:null});
  $("join-room-title").textContent=info.title;
  const select=$("join-name");select.replaceChildren();
  const empty=document.createElement("option");empty.value="";empty.textContent="이름 선택";select.append(empty);
  for(const person of info.participants){
   const opt=document.createElement("option");opt.value=person;opt.textContent=person;select.append(opt);
  }
  $("join-pin").value="";$("join-error").textContent="";show("join");
 }catch(e){show("start");msg(e.message);history.replaceState(null,"",location.pathname)}
}
$("join-pin").addEventListener("input",e=>{e.target.value=e.target.value.replace(/[^0-9]/g,"").slice(0,4)});
$("join-submit").addEventListener("click",async()=>{
 const name=$("join-name").value,pin=$("join-pin").value;
 $("join-error").textContent="";
 if(!name||!/^\d{4}$/.test(pin))return $("join-error").textContent="이름과 번호 4자리를 확인하세요.";
 const button=$("join-submit");button.disabled=true;
 try{
  const answer=await request("/api/rooms/"+roomId+"/join",{method:"POST",data:{name,pin},key:null});
  secret=answer.token;
  // Participant authentication is intentionally not persisted between visits.
  await openRoom();
 }catch(e){$("join-error").textContent=e.message}finally{button.disabled=false}
});
$("create-open").addEventListener("click",()=>{
 if(!ownerUser){show("account");return msg("팀장 로그인 후 모임을 만들 수 있습니다.")}
 show("create");renderMembers();renderCalendar()
});
function goHome(){
 history.replaceState(null,"",location.pathname);
 if(ws){manualClose=true;ws.close();ws=null}
 room=null;roomId="";secret="";links=null;show("start");renderMyRooms();
}
$("home-btn").addEventListener("click",goHome);

let adminSecret="";
function adminRequest(path,{method="GET",data=null}={}){
 const password=$("admin-key").value.trim()||adminSecret;
 if(!password)throw Error("관리자 비밀키를 입력하세요.");
 adminSecret=password;
 return fetch(API+path,{method,headers:{"content-type":"application/json","X-Moimo-Admin":password},
  ...(data!==null?{body:JSON.stringify(data)}:{})}).then(async r=>{
    const b=await r.json().catch(()=>({}));
    if(!r.ok)throw Error(b.error||"관리자 요청 실패");
    return b;
  });
}
function rowButton(text,fn,cls="small-button"){
 const el=document.createElement("button");el.type="button";el.className=cls;el.textContent=text;el.addEventListener("click",fn);return el;
}
function clearAdminSecret(){
 adminSecret="";$("admin-key").value="";$("admin-dashboard").classList.add("hidden");
}
function adminNote(message){$("admin-status").textContent=message}
// Administrator view is intentionally not advertised in the public interface.
// Its URL is only an entry point; Cloudflare checks the admin secret on every API call.


async function loadAdmin(){
 adminNote("");
 try{
  const [rooms,accounts]=await Promise.all([
    adminRequest("/api/admin/rooms"),adminRequest("/api/admin/accounts")
  ]);
  $("admin-dashboard").classList.remove("hidden");
  $("admin-stats").textContent="활성 모임 "+rooms.total+"개 · 등록된 팀장 "+accounts.total+"명";
  const list=$("admin-rooms");list.replaceChildren();
  if(!rooms.rooms.length)list.textContent="현재 등록된 모임이 없습니다. 과거 생성된 모임은 자동 목록 등록 전일 수 있습니다.";
  for(const m of rooms.rooms){
   const row=document.createElement("div");row.className="saved-room";
   const label=document.createElement("div");label.className="admin-row-info";
   const heading=document.createElement("strong");heading.textContent=m.title||"모임";
   const detail=document.createElement("span");
   detail.textContent="팀장: "+m.owner+" · 참가자 "+m.participantCount+"명 · 만료 "+(m.expiresAt?new Date(m.expiresAt).toLocaleString("ko-KR"):"미확인");
   label.append(heading,detail);
   row.append(label,
      rowButton("상세보기",()=>viewAdminRoom(m.roomId)),
      rowButton("삭제",()=>deleteAdminRoom(m),"small-button delete-button"));
   list.append(row);
  }
  const users=$("admin-accounts");users.replaceChildren();
  if(!accounts.accounts.length)users.textContent="등록된 계정 목록이 없습니다. 기존 계정은 아래에서 아이디로 조회할 수 있습니다.";
  for(const u of accounts.accounts){
   const row=document.createElement("div");row.className="saved-room";
   const label=document.createElement("strong");label.textContent=u.username;
   label.className="admin-row-info";
   row.append(label,
     rowButton("계정 삭제",()=>deleteAdminAccount(u.username),"small-button delete-button"));
   users.append(row);
  }
 }catch(e){adminNote(e.message);$("admin-dashboard").classList.add("hidden")}
}
$("admin-connect").addEventListener("click",loadAdmin);
$("admin-refresh").addEventListener("click",loadAdmin);
$("admin-key").addEventListener("keydown",e=>{if(e.key==="Enter")loadAdmin()});
$("admin-find").addEventListener("click",async()=>{
 const name=$("admin-lookup").value.trim(),panel=$("admin-inspection");
 panel.replaceChildren();
 if(!name)return;
 try{
  const found=await adminRequest("/api/admin/account/find",{method:"POST",data:{username:name}});
  const row=document.createElement("div");row.className="saved-room";
  const label=document.createElement("strong");label.textContent="확인된 계정: "+found.username;
  row.append(label,
    rowButton("계정 삭제",()=>deleteAdminAccount(found.username),"small-button delete-button"));
  panel.append(row);
  await loadAdmin();
 }catch(e){panel.textContent=e.message}
});
async function viewAdminRoom(id){
 try{
  const d=await adminRequest("/api/admin/rooms/"+encodeURIComponent(id));
  const panel=$("admin-inspection");panel.replaceChildren();
  const h=document.createElement("h2");h.textContent=d.title+" · 참가자 일정 현황";
  panel.append(h);
  for(const member of d.participants){
   const p=document.createElement("p");
   const selected=Object.keys(member.slots||{}).length;
   p.textContent=member.name+" · 선택한 시간 "+selected+"칸";
   panel.append(p);
  }
  panel.scrollIntoView({behavior:"smooth",block:"nearest"});
 }catch(e){adminNote(e.message)}
}
async function deleteAdminRoom(m){
 if(!confirm("운영자 권한으로 ‘"+m.title+"’ 모임을 삭제합니까? 모든 참가자 일정과 링크가 삭제됩니다."))return;
 if(prompt("삭제를 확정하려면 모임 이름을 정확히 입력하세요.")!==m.title)return;
 try{
  await adminRequest("/api/admin/rooms/"+encodeURIComponent(m.roomId),{method:"DELETE"});
  await loadAdmin();msg("모임이 삭제되었습니다.");
 }catch(e){adminNote(e.message)}
}
async function deleteAdminAccount(username){
 if(!confirm("‘"+username+"’ 계정과 그 계정의 모든 모임을 삭제합니까?"))return;
 if(prompt("모든 소유 모임과 계정이 영구 삭제됩니다. 계정 아이디를 정확히 입력하세요.")!==username)return;
 try{
  const result=await adminRequest("/api/admin/accounts/"+encodeURIComponent(username),{method:"DELETE"});
  await loadAdmin();msg("계정 및 소유 모임 "+result.deletedRooms+"개 삭제 완료");
 }catch(e){adminNote(e.message)}
}

$("google-login").addEventListener("click",()=>show("account"));
$("google-logout").addEventListener("click",async()=>{await logoutAccount();goHome()});
function updateAccountMode(register){
 accountRegister=register;
 $("auth-login-mode").classList.toggle("selected",!register);
 $("auth-register-mode").classList.toggle("selected",register);
 $("account-submit").textContent=register?"회원가입":"로그인";
 $("account-password").autocomplete=register?"new-password":"current-password";
 $("account-error").textContent="";
}
$("auth-login-mode").addEventListener("click",()=>updateAccountMode(false));
$("auth-register-mode").addEventListener("click",()=>updateAccountMode(true));
$("account-submit").addEventListener("click",async()=>{
 const username=$("account-username").value.trim(),password=$("account-password").value;
 const button=$("account-submit");$("account-error").textContent="";
 if(username.length<3||password.length<8){$("account-error").textContent="아이디는 3자 이상, 비밀번호는 8자 이상 입력하세요.";return}
 button.disabled=true;
 try{
   await loginAccount(username,password,accountRegister);
    $("account-password").value="";
    goHome();
  }
 catch(e){$("account-error").textContent=e.message}finally{button.disabled=false}
});
for(const id of ["account-username","account-password"])
 $(id).addEventListener("keydown",e=>{if(e.key==="Enter")$("account-submit").click()});
async function importEarlierRooms(){
 const keys=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).filter(k=>k?.startsWith("moimo-manager-"));
 for(const key of keys){
  try {
   const item=JSON.parse(localStorage.getItem(key)||"null");
   const id=item?.roomId || key.slice("moimo-manager-".length);
   if(!item?.managerToken||!/^[-_A-Za-z0-9]{12,24}$/.test(id))continue;
   await request("/api/my/claim",{method:"POST",owner:true,key:null,data:{
    roomId:id,managerToken:item.managerToken
   }});
  }catch{}
 }
}
onAuthStateChanged(auth,async user=>{
 ownerUser=user;
 $("google-login").classList.toggle("hidden",!!user);
 $("owner-info").classList.toggle("hidden",!user);
 $("owner-name").textContent=user?.username||"";
 if(user){await importEarlierRooms();await loadMyRooms()}
 else{ownerRooms=[];renderMyRooms()}
});
$("create-submit").addEventListener("click",async()=>{
 error("");const config=configFromForm();if(!config)return;
 const button=$("create-submit");button.disabled=true;button.textContent="생성 중…";
 try{
  const result=await request("/api/rooms",{method:"POST",data:config,key:null,owner:true});
  roomId=result.roomId;secret=result.managerToken;links=result;
  localStorage.setItem("moimo-manager-"+roomId,JSON.stringify({roomId,managerToken:secret}));
  $("share-name").textContent=config.title;
  renderShareRows("share-list");
  history.replaceState(null,"","#"+new URLSearchParams({r:roomId,k:secret}));
  show("share");await loadMyRooms();
 }catch(e){error(e.message)}finally{button.disabled=false;button.textContent="모임 만들기"}
});
$("share-dashboard").addEventListener("click",()=>openRoom());
$("copy-current").addEventListener("click",()=>copy(sharedURL(roomId)));
$("room-delete").addEventListener("click",()=>deleteManagedRoom({roomId,title:room?.config?.title||"모임",managerToken:secret}));
const clone=o=>JSON.parse(JSON.stringify(o));
function slotLabel(min){const h=Math.floor(min/60),m=min%60;return `${pad(h)}:${pad(m)}`}
function getSlotCount(){return Math.ceil((toMin(room.config.endTime)-toMin(room.config.startTime))/room.config.unitMinutes)}
function allowedToEdit(){return !!room?.participantId && (room.role==="participant" || room.role==="manager") && selected===room.participantId}
function renderTabs(){
 const nav=$("tabs");nav.replaceChildren();
 for(const m of room.participants){
  const button=document.createElement("button");button.className="tab"+(selected===m.id?" active":"");
  button.textContent=m.name;button.addEventListener("click",()=>{selected=m.id;renderRoom()});nav.appendChild(button);
 }
 const dash=document.createElement("button");dash.className="tab dashboard"+(selected==="dashboard"?" active":"");
 dash.textContent="종합 대시보드";dash.addEventListener("click",()=>{selected="dashboard";renderRoom()});nav.appendChild(dash);
}
function renderRoom(){
 if(!room)return;
 $("room-name").textContent=room.config.title;
 $("room-subtitle").textContent=`${format(room.config.dates[0])} ~ ${format(room.config.dates.at(-1))}`;
 renderTabs();
 const m=room.participants.find(p=>p.id===selected);
 $("tab-name").textContent=selected==="dashboard"?"종합 대시보드":m?.name||"";
 $("brushes").classList.toggle("hidden",!allowedToEdit());
 $("legend").classList.toggle("hidden",selected!=="dashboard");
 $("manager-panel").classList.toggle("hidden",room.role!=="manager");
 if(room.role==="manager")renderShareRows("manager-links");
 document.querySelectorAll("[data-brush]").forEach(btn=>btn.classList.toggle("selected",btn.dataset.brush===paintColor));
 $("day-controls").classList.toggle("hidden",!mobile());
 renderSlots();
}
function renderSlots(){
 if(!room)return;
 const days=room.config.dates;
 dayIndex=Math.max(0,Math.min(days.length-1,dayIndex));
 $("day-label").textContent=format(days[dayIndex]);
 $("day-prev").disabled=dayIndex===0;
 $("day-next").disabled=dayIndex===days.length-1;
 const visible=mobile()?[dayIndex]:days.map((_,i)=>i);
 const count=getSlotCount();
 const head='<thead><tr><th>시간</th>'+visible.map(i=>'<th>'+dformat(days[i])+'</th>').join('')+'</tr></thead>';
 let body="";
 for(let t=0;t<count;t++){
  const a=toMin(room.config.startTime)+t*room.config.unitMinutes;
  const b=Math.min(toMin(room.config.endTime),a+room.config.unitMinutes);
  body+='<tr><th>'+slotLabel(a)+'–'+slotLabel(b)+'</th>';
  for(const d of visible){
   const key='d'+d+'s'+t;
   if(selected==="dashboard"){
    const chips=room.participants.map(p=>{
     const v=p.slots[key];return v?'<span class="chip '+v+'" title="'+escapeHTML(p.name)+'">'+escapeHTML(p.name)+'</span>':'';
    }).join('');
    body+='<td><div class="dashboard-cell">'+(chips||'<span class="empty">—</span>')+'</div></td>';
   }else{
    const p=room.participants.find(m=>m.id===selected),v=p?.slots[key]||"";
    const readonly=!allowedToEdit();
    body+='<td><button class="slot '+v+(readonly?' readonly':'')+'" data-key="'+key+'" '+(readonly?'disabled':'')+' type="button" aria-label="'+escapeHTML(dformat(days[d])+' '+slotLabel(a)+'~'+slotLabel(b))+'">'+(v?'✓':'＋')+'</button></td>';
   }
  }
  body+='</tr>';
 }
 $("table-wrap").innerHTML='<table class="schedule" style="min-width:'+Math.max(400,135+visible.length*150)+'px"><caption class="hidden">모임 시간표</caption>'+head+'<tbody>'+body+'</tbody></table>';
}
function escapeHTML(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function paintAt(x,y){
 if(!painting||!allowedToEdit())return;
 const cell=document.elementFromPoint(x,y)?.closest(".slot[data-key]");
 if(!cell||!$("table-wrap").contains(cell)||cell.disabled)return;
 const k=cell.dataset.key,v=paintColor==="erase"?null:paintColor;
 const p=room.participants.find(p=>p.id===room.participantId);
 if(!p||((p.slots[k]||null)===v))return;
 if(v===null)delete p.slots[k];else p.slots[k]=v;
 pending[k]=v;cell.classList.remove("both","online");if(v)cell.classList.add(v);
 cell.textContent=v?'✓':'＋';
}
$("table-wrap").addEventListener("pointerdown",e=>{
 if(!allowedToEdit()||(e.pointerType==="mouse"&&e.button!==0)||!e.target.closest(".slot:not(.readonly)"))return;
 painting=true;paintAt(e.clientX,e.clientY);e.preventDefault();
});
document.addEventListener("pointermove",e=>{if(painting){paintAt(e.clientX,e.clientY);e.preventDefault()}},{passive:false});
document.addEventListener("pointerup",()=>{if(!painting)return;painting=false;savePending()});
document.addEventListener("pointercancel",()=>{if(!painting)return;painting=false;savePending()});
let saving=Promise.resolve();
function savePending(){
 const changes={...pending};pending={};
 if(!Object.keys(changes).length)return;
 $("status").textContent="저장 중…";
 saving=saving.catch(()=>{}).then(()=>request(`/api/rooms/${roomId}/slots`,{method:"PUT",data:{changes}}));
 saving.then(()=>{$("status").textContent="저장됨 ✓"}).catch(e=>{$("status").textContent="저장 실패";msg(e.message);reloadRoom()});
}
$("brushes").addEventListener("click",e=>{const b=e.target.closest("[data-brush]");if(!b)return;paintColor=b.dataset.brush;renderRoom()});
$("day-prev").addEventListener("click",()=>{dayIndex--;renderSlots()});
$("day-next").addEventListener("click",()=>{dayIndex++;renderSlots()});
let prevMobile=mobile();window.addEventListener("resize",()=>{if(mobile()!==prevMobile){prevMobile=mobile();if(room)renderRoom()}});
async function reloadRoom(){
 try{room=await request("/api/rooms/"+roomId);renderRoom()}catch(e){msg(e.message)}
}
function websocket(){
 if(!API||!roomId||!secret)return;
 if(ws) {manualClose=true;ws.close();}
 manualClose=false;
 const url=API.replace(/^http/,"ws")+`/api/rooms/${roomId}/live`;
 try{
  ws=new WebSocket(url);
  ws.onopen=()=>ws.send(JSON.stringify({type:"auth",token:secret}));
  ws.onmessage=e=>{
   try{
    const data=JSON.parse(e.data);
    if(data.type==="snapshot"){
     room=data.data;
     if(!selected)selected=room.participantId || "dashboard";
     renderRoom();$("status").textContent="연결됨";
    }else if(data.type==="update"&&room){
     const p=room.participants.find(p=>p.id===data.participantId);
     if(p){
      for(const [k,v] of Object.entries(data.changes)){if(v===null)delete p.slots[k];else p.slots[k]=v}
      if(!painting)renderSlots();
     }
    }
   }catch{}
  };
  ws.onclose=()=>{if(manualClose)return;$("status").textContent="재연결 중…";clearTimeout(connectionTimer);connectionTimer=setTimeout(()=>{if(view==="room")websocket()},3000)};
  ws.onerror=()=>{$("status").textContent="연결 확인 필요"};
 }catch{$("status").textContent="연결 확인 필요"}
}
async function openRoom(){
 if(!roomId||!secret)return;
 show("room");selected="";dayIndex=0;
 $("status").textContent="연결 중…";
 try{room=await request("/api/rooms/"+roomId);selected=room.participantId || "dashboard";renderRoom();websocket()}
 catch(e){msg(e.message);$("status").textContent=e.message}
}
async function setup(){
 renderMembers();renderCalendar();setupTimes();show("start");
 initializeAuth();
 if(new URLSearchParams(location.search).get("admin")==="1"){
  show("admin");return;
 }
 const params=new URLSearchParams(randomHash()),r=params.get("r"),k=params.get("k");
 if(r&&/^[a-zA-Z0-9_-]{12,24}$/.test(r)){
  if(k && /^[a-zA-Z0-9_-]{40,64}$/.test(k)){
    roomId=r;secret=k;
    await openRoom();
  }else{
    // Even after refreshing the same shared link, always require name and PIN.
    localStorage.removeItem("moimo-session-"+r);
    await showJoin(r);
  }
 }
 if(!API){document.querySelector("#start-view").insertAdjacentHTML("beforeend",'<p class="error">서버 연결 설정이 필요합니다.</p>')}
}
setup();
