const API=(window.MOIMO_API_URL||"").replace(/\/$/,"");
const SESSION_KEY="moimo-owner-v1";
export const auth={currentUser:null};
const listeners=new Set();
function emit(){for(const cb of listeners)cb(auth.currentUser)}
function setSession(value){
 if(value){localStorage.setItem(SESSION_KEY,JSON.stringify(value));auth.currentUser={username:value.username}}
 else{localStorage.removeItem(SESSION_KEY);auth.currentUser=null}
 emit();
}
function stored(){
 try{
  const data=JSON.parse(localStorage.getItem(SESSION_KEY)||"null");
  return data?.username&&data?.session?data:null;
 }catch{return null}
}
export function ownerHeaders(){
 const data=stored();
 if(!data)throw Error("팀장 로그인이 필요합니다.");
 return {"X-Moimo-User":data.username,"X-Moimo-Session":data.session};
}
export function onAuthStateChanged(_auth,cb){
 listeners.add(cb);cb(auth.currentUser);
 return ()=>listeners.delete(cb);
}
export async function initializeAuth(){
 const session=stored();
 if(!session){setSession(null);return}
 try{
  const res=await fetch(API+"/api/account/me",{headers:ownerHeaders()});
  if(!res.ok)throw Error("세션 만료");
  auth.currentUser={username:session.username};emit();
 }catch{setSession(null)}
}
export async function loginAccount(username,password,register=false){
 const response=await fetch(API+"/api/account/"+(register?"register":"login"),{
  method:"POST",headers:{"content-type":"application/json"},
  body:JSON.stringify({username,password})
 });
 const answer=await response.json().catch(()=>({}));
 if(!response.ok)throw Error(answer.error||"로그인할 수 없습니다.");
 setSession({username:answer.username,session:answer.session});
 return answer;
}
export async function logoutAccount(){
 try{
  const data=stored();
  if(data)await fetch(API+"/api/account/logout",{method:"POST",headers:ownerHeaders()});
 }catch{}
 setSession(null);
}
