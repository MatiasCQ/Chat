import { P, CONFIG } from "./firebase-init.js";
import {
  getDoc, setDoc, updateDoc, getDocs, query, where, limit, serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const { STATUS } = CONFIG;
let hbTimer = null, activeUid = null, onStatusChange = null;
let currentStatus = STATUS.ONLINE, dnd = false, lastActivity = Date.now();

// Estado visible de un usuario: si su último latido es viejo => "offline" (cubre cierre de pestaña/pérdida de red)
export function effectiveStatus(u) {
  if (!u) return STATUS.OFFLINE;
  const t = u.lastSeen?.toMillis?.();
  if (t && Date.now() - t > CONFIG.OFFLINE_AFTER_MS) return STATUS.OFFLINE;
  return u.status || STATUS.OFFLINE;
}
// Mantiene sincronizado "No molestar" (puede venir de otro dispositivo)
export const syncDnd = (v) => { dnd = !!v; };

/* ---------- Perfil ---------- */
export async function saveProfile(user) {
  const ref = P.user(user.uid);
  const snap = await getDoc(ref);
  const old = snap.exists() ? snap.data() : null;
  const status = old?.status === STATUS.DND ? STATUS.DND : STATUS.ONLINE; // respeta "No molestar"

  const data = {
    displayName: old?.displayName || user.displayName || user.email.split("@")[0],
    email: user.email.toLowerCase(),
    photoURL: user.photoURL || old?.photoURL || "",
    status,
    lastSeen: serverTimestamp()
  };
  if (!old) Object.assign(data, { shortDescription: "", customDescription: "", createdAt: serverTimestamp() });

  await setDoc(ref, data, { merge: true });
  currentStatus = status; dnd = status === STATUS.DND;
  return status;
}

// Ajustes globales: SOLO nombre de usuario (displayName) y descripciones
export function updateProfile(uid, { displayName = "", shortDescription = "", customDescription = "" }) {
  displayName = displayName.trim().slice(0, 32);
  if (!displayName) throw new Error("El nombre de usuario no puede estar vacío.");
  return updateDoc(P.user(uid), {
    displayName,
    shortDescription: shortDescription.trim().slice(0, CONFIG.SHORT_DESC_MAX),
    customDescription: customDescription.trim().slice(0, 2000)
  });
}

/* ---------- Estados / presencia ---------- */
async function writeStatus(uid, status) {
  currentStatus = status;
  await updateDoc(P.user(uid), { status, lastSeen: serverTimestamp() });
}

// Manual: solo "online" o "dnd". "idle" es exclusivamente automático.
export async function setManualStatus(uid, status) {
  if (status !== STATUS.ONLINE && status !== STATUS.DND) throw new Error("Estado no permitido");
  dnd = status === STATUS.DND; lastActivity = Date.now();
  await writeStatus(uid, status);
}

const desired = () => dnd ? STATUS.DND
  : (document.hidden || Date.now() - lastActivity > CONFIG.IDLE_AFTER_MS) ? STATUS.IDLE : STATUS.ONLINE;

// Escribe el estado deseado + lastSeen (latido). Nunca pisa "dnd".
async function beat() {
  if (!activeUid) return;
  const next = desired();
  try { await writeStatus(activeUid, next); onStatusChange?.(next); } catch (e) { console.error(e); }
}

// Signo de vida instantáneo: clic, tecla, cambio de canal, volver a la pestaña. Solo escribe si el estado cambia.
export function markActive() {
  lastActivity = Date.now();
  if (activeUid && desired() !== currentStatus) beat();
}
const onVisibility = () => { if (document.hidden) beat(); else markActive(); };
const onFocus = () => markActive();

export function startPresence(uid, onChange) {
  stopPresence();
  activeUid = uid; onStatusChange = onChange; lastActivity = Date.now();
  hbTimer = setInterval(beat, CONFIG.HEARTBEAT_MS);
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  ["pointerdown", "keydown", "input"].forEach((ev) => document.addEventListener(ev, markActive, { passive: true, capture: true }));
}

// Cerrar sesión / pestaña NO escribe "offline": otros dispositivos siguen latiendo; el resto lo decide effectiveStatus().
export function stopPresence() {
  if (hbTimer) clearInterval(hbTimer); hbTimer = null; activeUid = null;
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("focus", onFocus);
  ["pointerdown", "keydown", "input"].forEach((ev) => document.removeEventListener(ev, markActive, { capture: true }));
}
export const getCurrentStatus = () => currentStatus;

/* ---------- Consultas ---------- */
export async function getUser(uid) {
  const s = await getDoc(P.user(uid));
  return s.exists() ? { uid: s.id, ...s.data() } : null;
}

export async function findUserByEmail(email) {
  const s = await getDocs(query(P.users(), where("email", "==", email.trim().toLowerCase()), limit(1)));
  return s.empty ? null : { uid: s.docs[0].id, ...s.docs[0].data() };
}

// Para el popup "Añadir amigos" (ui/chats filtran los que ya están en tus MDs)
export async function listUsers(max = 200) {
  const s = await getDocs(query(P.users(), limit(max)));
  return s.docs.map((d) => ({ uid: d.id, ...d.data() }));
}
