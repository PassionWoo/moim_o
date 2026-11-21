import { initializeApp } from "https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut, getIdToken
} from "https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js";

const app = initializeApp({
  apiKey: "AIzaSyAF30OtZmyNPvozwa0TbCMllVDJM8s5SPg",
  authDomain: "team-schedule-45f53.firebaseapp.com",
  projectId: "team-schedule-45f53",
  appId: "1:502726059616:web:6ec6c3f18d475da7be4505"
});
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
provider.setCustomParameters({prompt:"select_account"});

export { auth, onAuthStateChanged };
export const loginGoogle = () => signInWithPopup(auth, provider);
export const logoutGoogle = () => signOut(auth);
export async function ownerIdToken() {
  const user=auth.currentUser;
  if (!user) throw Error("구글 로그인이 필요합니다.");
  return getIdToken(user);
}
