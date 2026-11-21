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
let names=["","","",""],roomId="",secret="",room=null,links=null,selected="",paintColor="both",painting=false,pending={},saveTimer=null,ws=null,dayIndex=0,manualClose=false;
let view="start",connectionTimer=null;
const mobile=()=>matchMedia("(max-width:800px)").matches;
function show(id) {
 for(const k of ["start","create","share","room"])$(k+"-view").classList.toggle("hidden",k!==id);
 $("home-btn").classList.toggle("hidden",id==="start");
 view=id;
}
function msg(text){const el=$("toast");el.textContent=text;el.classList.remove("hidden");clearTimeout(msg.timer);msg.timer=setTimeout(()=>el.classList.add("hidden"),2200)}
function error(text){$("create-error").textContent=text}
function renderMembers(){
 const el=$("member-inputs");
 const focused=el.contains(document.activeElement)?Number(document.activeElement.dataset.member):null;
 const pos=focused!=null&&document.activeElement.selectionStart!=null?document.activeElement.selectionStart:null;
 el.innerHTML=names.map((name,i)=>`<div class="member-row"><input data-member="${i}" aria-label="참석자 ${i+1}" maxlength="30" placeholder="참석자 ${i+1}" value=""><button type="button" class="member-remove" data-remove="${i}" aria-label="참석자 삭제">×</button></div>`).join("");
 el.querySelectorAll("[data-member]").forEach((input,i)=>input.value=names[i]);
 $("member-count").textContent=names.length+"명";
 if(focused!=null&&el.querySelector(`[data-member="${focused}"]`)){const input=el.querySelector(`[data-member="${focused}"]`);input.focus();if(pos!=null)input.setSelectionRange(pos,pos)}
}
$("member-inputs").addEventListener("input",e=>{const i=e.target.dataset.member;if(i!=null)names[Number(i)]=e.target.value});
$("member-inputs").addEventListener("click",e=>{const b=e.target.closest("[data-remove]");if(!b)return;if(names.length===1){msg("최소 1명");return}names.splice(Number(b.dataset.remove),1);renderMembers()});
$("add-member").addEventListener("click",()=>{if(names.length>=30){msg("최대 30명");return}names.push("");renderMembers();$("member-inputs").lastElementChild.querySelector("input").focus()});
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
 const title=$("title").value.trim(),participants=names.map(n=>n.trim());
 const value=Number($("unit").value),unitMinutes=$("unit-type").value==="hours"?value*60:value;
 const startTime=$("time-from").value,endTime=$("time-to").value;
 if(!title){error("모임 이름을 입력하세요.");return null}
 if(participants.some(n=>!n)||new Set(participants).size!==participants.length){error("참석자 이름을 확인하세요.");return null}
 if(!rangeStart||!rangeEnd){error("시작 날짜와 종료 날짜를 선택하세요.");return null}
 const dayCount=Math.round((fromISO(rangeEnd)-fromISO(rangeStart))/86400000)+1;
 if(dayCount>31){error("날짜는 최대 31일까지 선택할 수 있습니다.");return null}
 if(!Number.isInteger(unitMinutes)||unitMinutes<5||unitMinutes>720){error("시간 단위를 5분~12시간 사이로 입력하세요.");return null}
 const duration=toMin(endTime)-toMin(startTime);
 if(duration<=0||Math.ceil(duration/unitMinutes)>96||dayCount*Math.ceil(duration/unitMinutes)>1500){error("하루 시간 범위를 확인하세요.");return null}
 return {title,participants,startDate:rangeStart,endDate:rangeEnd,unitMinutes,startTime,endTime};
}
async function request(path,{method="GET",data=null,key=secret}={}){
 if(!API)throw Error("서버 연결 설정이 필요합니다.");
 const res=await fetch(API+path,{method,headers:{"content-type":"application/json",...(key?{"authorization":"Bearer "+key}:{})},...(data?{body:JSON.stringify(data)}:{})});
 const answer=await res.json().catch(()=>({}));
 if(!res.ok)throw Error(answer.error||"요청 실패");
 return answer;
}
function makeURL(id,key){
 const url=new URL("./",location.href);url.hash=new URLSearchParams({r:id,k:key}).toString();return url.href;
}
async function copy(value){try{await navigator.clipboard.writeText(value);msg("복사됨")}catch{window.prompt("링크 복사",value)}}
function shareRow(name,url,reissueId){
 const row=document.createElement("div");row.className="share-row";
 const label=document.createElement("strong");label.textContent=name;
 const button=document.createElement("button");button.type="button";button.textContent="복사";button.addEventListener("click",()=>copy(url));
 row.append(label,button);
 if(reissueId){
  const again=document.createElement("button");again.type="button";again.textContent="재발급";
  again.addEventListener("click",async()=>{if(!confirm("기존 링크는 사용할 수 없게 됩니다. 계속할까요?"))return;
    again.disabled=true;
    try{const r=await request(`/api/rooms/${roomId}/reissue/${reissueId}`,{method:"POST"});
      if(reissueId==="viewer")links.viewerToken=r.token;
      else links.participants.find(p=>p.id===reissueId).token=r.token;
      renderShareRows("manager-links",true);msg("새 링크 발급 완료");
    }catch(e){msg(e.message)}finally{again.disabled=false}
  });
  row.appendChild(again);
 }
 return row;
}
function renderShareRows(target,manager=false){
 const el=$(target);el.replaceChildren();
 if(!links)return;
 el.appendChild(shareRow("대시보드",makeURL(roomId,links.viewerToken),manager?"viewer":null));
 for(const p of links.participants)el.appendChild(shareRow(p.name,makeURL(roomId,p.token),manager?p.id:null));
}
$("create-open").addEventListener("click",()=>{show("create");renderMembers();renderCalendar()});
$("home-btn").addEventListener("click",()=>{location.hash="";if(ws){manualClose=true;ws.close();ws=null}room=null;roomId="";secret="";links=null;show("start")});
$("create-submit").addEventListener("click",async()=>{
 error("");const config=configFromForm();if(!config)return;
 const button=$("create-submit");button.disabled=true;button.textContent="생성 중…";
 try{
  const result=await request("/api/rooms",{method:"POST",data:config,key:null});
  roomId=result.roomId;secret=result.managerToken;links=result;
  localStorage.setItem("moimo-manager-"+roomId,JSON.stringify(result));
  $("share-name").textContent=config.title;
  renderShareRows("share-list");
  history.replaceState(null,"","#"+new URLSearchParams({r:roomId,k:secret}).toString());
  show("share");
 }catch(e){error(e.message)}finally{button.disabled=false;button.textContent="모임 만들기"}
});
$("share-dashboard").addEventListener("click",()=>openRoom());
$("copy-current").addEventListener("click",()=>copy(makeURL(roomId,secret)));
const clone=o=>JSON.parse(JSON.stringify(o));
function slotLabel(min){const h=Math.floor(min/60),m=min%60;return `${pad(h)}:${pad(m)}`}
function getSlotCount(){return Math.ceil((toMin(room.config.endTime)-toMin(room.config.startTime))/room.config.unitMinutes)}
function allowedToEdit(){return room?.role==="participant"&&selected===room.participantId}
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
 if(room.role==="manager")renderShareRows("manager-links",true);
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
     const v=p.slots[key];return v?'<span class="chip '+v+'" title="'+escapeHTML(p.name)+'">'+escapeHTML(p.name.slice(0,2))+'</span>':'';
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
     if(!selected)selected=room.role==="participant"?room.participantId:"dashboard";
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
 try{room=await request("/api/rooms/"+roomId);selected=room.role==="participant"?room.participantId:"dashboard";renderRoom();websocket()}
 catch(e){msg(e.message);$("status").textContent=e.message}
}
function setup(){
 renderMembers();renderCalendar();setupTimes();
 const params=new URLSearchParams(randomHash()),r=params.get("r"),k=params.get("k");
 if(r&&k&&/^[a-zA-Z0-9_-]{12,24}$/.test(r)&&/^[a-zA-Z0-9_-]{40,64}$/.test(k)){
  roomId=r;secret=k;
  try{const stored=JSON.parse(localStorage.getItem("moimo-manager-"+r)||"null");if(stored?.managerToken===k)links=stored}catch{}
  openRoom();
 }else show("start");
 if(!API){document.querySelector("#start-view").insertAdjacentHTML("beforeend",'<p class="error">서버 연결 설정이 필요합니다.</p>')}
}
setup();
