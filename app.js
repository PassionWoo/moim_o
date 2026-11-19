import { initializeApp } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-app.js';
import { getAuth, signInWithEmailAndPassword, signOut, onAuthStateChanged } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-auth.js';
import { getFirestore, doc, onSnapshot, setDoc } from 'https://www.gstatic.com/firebasejs/12.6.0/firebase-firestore.js';

const MEMBERS=[
{id:'kimdeok',name:'김덕중',email:'member01@team-plan.example.com'},
{id:'kimwon',name:'김원일',email:'member02@team-plan.example.com'},
{id:'kimjeong',name:'김정님',email:'member03@team-plan.example.com'},
{id:'wooseong',name:'우성민',email:'member04@team-plan.example.com'},
{id:'leeun',name:'이은정',email:'member05@team-plan.example.com'},
{id:'cheonyun',name:'천윤호',email:'member06@team-plan.example.com'}];
const DAYS=['20 금','21 토','22 일','23 월','24 화','25 수'];
const TIMES=['오전 6–9','오전 9–12','낮 12–3','오후 3–6','오후 6–9','오후 9–12'];
const $=id=>document.getElementById(id);
const schedules=Object.fromEntries(MEMBERS.map(m=>[m.id,{}]));
let auth,db,me=null,tab='',day=0,brush='both',painting=false,changed=false,saveQueue=Promise.resolve(),unsubs=[];
const mobile=()=>matchMedia('(max-width:800px)').matches;
const key=(d,t)=>'d'+d+'s'+t;
const label=v=>v==='both'?'온라인·오프라인':v==='online'?'온라인만':'';
function status(s){$('panel-status').textContent=s}
function error(s){$('login-error').textContent=s}
function renderTabs(){
 $('member-tabs').innerHTML=MEMBERS.map(m=>`<button type="button" class="tab ${tab===m.id?'is-active':''}" data-tab="${m.id}">${m.name}</button>`).join('')+
 `<button type="button" class="tab dashboard-tab ${tab==='dashboard'?'is-active':''}" data-tab="dashboard">종합 대시보드</button>`;
}
function render(){
 renderTabs();
 const owner=me&&tab===me.id,dashboard=tab==='dashboard';
 $('panel-title').textContent=dashboard?'종합 대시보드':(MEMBERS.find(m=>m.id===tab)?.name||'');
 $('brush-tools').classList.toggle('hidden',!owner);
 $('legend').classList.toggle('hidden',!dashboard);
 status(owner?'':dashboard?'':'보기 전용');
 document.querySelectorAll('[data-brush]').forEach(b=>{b.classList.toggle('active',b.dataset.brush===brush);b.setAttribute('aria-pressed',String(b.dataset.brush===brush));});
 calendar();
}
function calendar(){
 const useDays=mobile()?[day]:[0,1,2,3,4,5];
 $('day-picker').classList.toggle('hidden',!mobile());
 $('day-picker').innerHTML=`<button type="button" data-step="-1" ${day===0?'disabled':''}>‹</button><strong>11월 ${DAYS[day]}요일</strong><button type="button" data-step="1" ${day===5?'disabled':''}>›</button>`;
 const head='<thead><tr><th>시간</th>'+useDays.map(d=>'<th>'+DAYS[d]+'</th>').join('')+'</tr></thead>';
 const body=TIMES.map((time,t)=>'<tr><th>'+time+'</th>'+useDays.map(d=>{
   const k=key(d,t);
   if(tab==='dashboard'){
     const chips=MEMBERS.map(m=>{const v=schedules[m.id][k];return v==='both'||v==='online'?'<span class="chip '+v+'" title="'+m.name+' '+label(v)+'">'+m.name.slice(0,2)+'</span>':'';}).join('');
     return '<td><div class="dashboard-cell">'+(chips||'<span class="empty">—</span>')+'</div></td>';
   }
   const v=schedules[tab]?.[k],own=me?.id===tab;
   return '<td><button type="button" data-slot="'+k+'" class="slot '+(v||'')+(own?'':' readonly')+'" '+(own?'':'disabled')+' aria-label="'+DAYS[d]+' '+time+' '+(label(v)||'선택 안 함')+'"><span>'+(v?'✓':'＋')+'</span></button></td>';
 }).join('')+'</tr>').join('');
 $('calendar-container').innerHTML='<table class="calendar '+(tab==='dashboard'?'is-dashboard':'')+'">'+head+'<tbody>'+body+'</tbody></table>';
}
function paint(x,y){
 if(!painting||!me||tab!==me.id)return;
 const cell=document.elementFromPoint(x,y)?.closest('[data-slot]');
 if(!cell||cell.disabled||!$('calendar-container').contains(cell))return;
 const k=cell.dataset.slot,v=brush==='erase'?'':brush;
 if((schedules[me.id][k]||'')===v)return;
 if(v)schedules[me.id][k]=v;else delete schedules[me.id][k];
 changed=true;
 cell.classList.remove('both','online');if(v)cell.classList.add(v);
 cell.querySelector('span').textContent=v?'✓':'＋';
}
function flush(){
 if(!painting)return;
 painting=false;
 if(!changed||!me)return;
 const uid=me.id;
 const data={slots:{...schedules[uid]}};
 status('저장 중…');
 saveQueue=saveQueue.catch(()=>{}).then(()=>setDoc(doc(db,'nov2026_schedules',uid),data));
 saveQueue.then(()=>{if(tab===uid)status('저장됨 ✓')}).catch(()=>{if(tab===uid)status('저장 실패');});
}
$('calendar-container').addEventListener('pointerdown',e=>{
 if(!me||tab!==me.id||!e.target.closest('.slot:not(.readonly)')||(e.pointerType==='mouse'&&e.button!==0))return;
 painting=true;changed=false;paint(e.clientX,e.clientY);e.preventDefault();
});
document.addEventListener('pointermove',e=>{if(painting){paint(e.clientX,e.clientY);e.preventDefault()}},{passive:false});
document.addEventListener('pointerup',flush);
document.addEventListener('pointercancel',flush);
window.addEventListener('blur',flush);
$('member-tabs').addEventListener('click',e=>{const b=e.target.closest('[data-tab]');if(!b||!me)return;flush();tab=b.dataset.tab;render()});
$('brush-tools').addEventListener('click',e=>{const b=e.target.closest('[data-brush]');if(!b)return;brush=b.dataset.brush;render()});
$('day-picker').addEventListener('click',e=>{const b=e.target.closest('[data-step]');if(!b)return;day=Math.max(0,Math.min(5,day+Number(b.dataset.step)));calendar()});
$('pin-input').addEventListener('input',e=>{e.target.value=e.target.value.replace(/\D/g,'').slice(0,4)});
$('login-form').addEventListener('submit',async e=>{
 e.preventDefault();
 if(!auth)return;
 const selected=MEMBERS.find(m=>m.id===$('name-select').value),pin=$('pin-input').value;
 if(!selected||!/^\d{4}$/.test(pin)){error('이름과 번호 4자리를 확인하세요.');return;}
 $('login-button').disabled=true;error('');
 try{await signInWithEmailAndPassword(auth,selected.email,'GATHER-'+pin+'-2026!')}
 catch(ex){error('이름 또는 번호가 맞지 않습니다.')}
 finally{$('login-button').disabled=false;$('pin-input').value=''}
});
$('logout-button').addEventListener('click',async()=>{if(auth)await signOut(auth)});
let wasMobile=mobile();window.addEventListener('resize',()=>{if(wasMobile!==mobile()){wasMobile=mobile();if(me)calendar()}});
const cfg=window.FIREBASE_CONFIG;
if(!cfg?.apiKey||!cfg?.appId||!cfg?.projectId||Object.values(cfg).some(v=>typeof v==='string'&&v.includes('YOUR_'))){
 error('관리자가 연결 설정을 완료해야 합니다.');
 $('login-button').disabled=true;
}else{
 try{
  const app=initializeApp(cfg);auth=getAuth(app);db=getFirestore(app);
  onAuthStateChanged(auth,user=>{
   unsubs.forEach(f=>f());unsubs=[];
   me=MEMBERS.find(m=>m.email===user?.email)||null;
   for(const m of MEMBERS)schedules[m.id]={};
   if(user&&!me){signOut(auth);return;}
   $('login-screen').classList.toggle('hidden',!!me);
   $('app-screen').classList.toggle('hidden',!me);
   if(!me)return;
   tab=me.id;day=0;render();error('');
   for(const m of MEMBERS){
    unsubs.push(onSnapshot(doc(db,'nov2026_schedules',m.id),snapshot=>{
     if(!(painting&&m.id===me.id)){
       schedules[m.id]=snapshot.exists()?snapshot.data().slots||{}:{};
       if(tab===m.id||tab==='dashboard')calendar();
     }
    },err=>{status(err.code==='permission-denied'?'접근 권한 설정 필요':'연결 확인 필요')}));
   }
  });
 }catch(e){error('연결 설정을 확인하세요.')}
}
