import { auth, googleProvider } from "./firebase-init.js";
import {
  signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, signOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";

export const loginWithEmail = (email, password) => signInWithEmailAndPassword(auth, email, password);
export const registerWithEmail = (email, password) => createUserWithEmailAndPassword(auth, email, password);
export const loginWithGoogle = () => signInWithPopup(auth, googleProvider);
export const logout = () => signOut(auth);

// ui.js se suscribe aquí (evita dependencia circular auth.js <-> ui.js)
export const watchAuth = (cb) => onAuthStateChanged(auth, cb);

const MESSAGES = {
  "auth/invalid-credential": "Correo o contraseña incorrectos.",
  "auth/invalid-email": "Correo inválido.",
  "auth/user-not-found": "Usuario no encontrado.",
  "auth/wrong-password": "Contraseña incorrecta.",
  "auth/email-already-in-use": "Ese correo ya está registrado.",
  "auth/weak-password": "La contraseña debe tener al menos 6 caracteres.",
  "auth/too-many-requests": "Demasiados intentos. Intenta más tarde.",
  "auth/network-request-failed": "Error de red.",
  "auth/popup-closed-by-user": "",
  "auth/cancelled-popup-request": ""
};
export const authErrorMessage = (e) => MESSAGES[e?.code] ?? "No se pudo completar la acción.";
