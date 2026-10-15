import { P, CONFIG, messaging, VAPID_KEY } from "./firebase-init.js";
import { getToken } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging.js";
import { setDoc, deleteDoc, onSnapshot, serverTimestamp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

let state = { uid: null, dnd: false, mutes: {} }; // espejo local de lo que usa el Service Worker

export const notificationsSupported = () => !!messaging && "Notification" in window && "serviceWorker" in navigator;

/* ---------- Permiso + token FCM ---------- */
export async function enableNotifications(uid) {
  if (!notificationsSupported()) throw new Error("Notificaciones no soportadas");
  const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") return null;
  const reg = await navigator.serviceWorker.register(CONFIG.SW_PATH);
  await navigator.serviceWorker.ready;
  const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: reg });
  if (!token) return null;
  await setDoc(P.token(uid, token), { token, platform: navigator.platform || "web", createdAt: serverTimestamp() }, { merge: true });
  await syncToServiceWorker();
  return token;
}

/* ---------- Sincronía con el Service Worker (DND + silencios) ---------- */
export async function syncToServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.getRegistration(CONFIG.SW_PATH);
    (reg?.active || navigator.serviceWorker.controller)?.postMessage({ type: "settings", uid: state.uid, dnd: state.dnd, mutes: state.mutes });
  } catch (_) {}
}

export function setDnd(flag) {
  if (state.dnd === flag) return;
  state.dnd = flag;
  syncToServiceWorker();
}

/* ---------- Silencios: users/{uid}/mutes/{serverId|chatId} = { until:ms|null, messages, mentions } ---------- */
export function muteContext(uid, id, { minutes = null, messages = true, mentions = false } = {}) {
  return setDoc(P.mute(uid, id), {
    until: minutes == null ? null : Date.now() + minutes * 60_000,   // null = hasta que lo reactive
    messages: !!messages,   // silencia mensajes normales
    mentions: !!mentions,   // silencia menciones
    createdAt: serverTimestamp()
  });
}
export const unmuteContext = (uid, id) => deleteDoc(P.mute(uid, id));

export function watchMutes(uid, cb) {
  state.uid = uid;
  return onSnapshot(P.mutes(uid), (s) => {
    state.mutes = Object.fromEntries(s.docs.map((d) => [d.id, d.data()]));
    cb(state.mutes);
    syncToServiceWorker();
  }, console.error);
}

export function isMuteActive(id) {
  const m = state.mutes[id];
  return !!m && (m.until == null || m.until > Date.now());
}

// ¿Debe avisarse al usuario? data = { targetId, mention:"1"|"0" }
export function shouldNotify(data) {
  if (state.dnd) return false;
  const m = state.mutes[data.targetId];
  if (!m || (m.until != null && m.until <= Date.now())) return true;
  return data.mention === "1" ? !m.mentions : !m.messages;
}

/* ---------- Eventos desde el Service Worker ---------- */
export function onForegroundMessage(cb) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "fcm-foreground") cb(e.data.payload); });
}
export function onNotificationClick(cb) {
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (e) => { if (e.data?.type === "notification-click") cb(e.data.data); });
}
