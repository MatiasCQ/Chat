import { db, P } from "./firebase-init.js";
import {
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, writeBatch, onSnapshot, query, where,
  serverTimestamp, arrayUnion, arrayRemove, deleteField
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

/* ---------- Utilidades ---------- */
export const getDMId = (a, b) => [a, b].sort().join("_");
export const peerOf = (chat, myUid) => chat.participants.find((u) => u !== myUid);
export const isGroup = (chat) => chat.type === "group";

// Nombre a mostrar dentro de un chat: apodo exclusivo de ESE MD > nombre de usuario global
export const nameInChat = (chat, user) =>
  chat?.nicknames?.[user.uid] || user.displayName || user.email?.split("@")[0] || "Usuario";

/* ---------- MD individual ---------- */
export async function openOrCreateDM(myUid, otherUid) {
  const id = getDMId(myUid, otherUid);
  const ref = P.chat(id);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      type: "dm",
      participants: [myUid, otherUid],
      nicknames: {},
      lastMessage: "",
      lastMessageAt: serverTimestamp(),
      lastSenderId: ""
    });
  }
  await deleteDoc(P.archived(myUid, id)).catch(() => {}); // desarchivar para mí al abrirlo
  return id;
}

/* ---------- MD grupal ---------- */
export async function createGroupChat(creatorUid, memberUids, name) {
  const participants = [...new Set([creatorUid, ...memberUids])];
  if (participants.length < 2) throw new Error("Selecciona al menos un participante.");
  const ref = doc(P.chats());
  await setDoc(ref, {
    type: "group",
    name: (name || "Grupo nuevo").trim().slice(0, 100),
    ownerId: creatorUid,
    participants,
    nicknames: {},
    lastMessage: "",
    lastMessageAt: serverTimestamp(),
    lastSenderId: ""
  });
  return ref.id;
}

// Solo el dueño (reglas): expulsar, transferir, renombrar, añadir
export const kickFromGroup = (chatId, uid) => updateDoc(P.chat(chatId), { participants: arrayRemove(uid) });
export const addToGroup = (chatId, uids) => updateDoc(P.chat(chatId), { participants: arrayUnion(...uids) });
export const transferGroupOwnership = (chatId, newOwnerId) => updateDoc(P.chat(chatId), { ownerId: newOwnerId });
export const renameGroup = (chatId, name) => updateDoc(P.chat(chatId), { name: name.trim().slice(0, 100) });
// Solo el dueño: borra mensajes y el chat para todos
export async function deleteGroup(chatId) {
  const s = await getDocs(P.chatMessages(chatId));
  for (let i = 0; i < s.docs.length; i += 400) {
    const b = writeBatch(db);
    s.docs.slice(i, i + 400).forEach((d) => b.delete(d.ref));
    await b.commit();
  }
  await deleteDoc(P.chat(chatId));
}
// Un miembro que no es dueño se va
export const leaveGroup = (chatId, uid) => updateDoc(P.chat(chatId), { participants: arrayRemove(uid) });

/* ---------- Apodos exclusivos del MD (visibles para ambos) ----------
   values = { [uid]: "texto" } -> texto vacío borra chats/{id}.nicknames.{uid} y vuelve el nombre global */
export function setSharedNicknames(chatId, values) {
  const upd = {};
  for (const [uid, v] of Object.entries(values)) {
    const n = (v || "").trim().slice(0, 32);
    upd[`nicknames.${uid}`] = n ? n : deleteField();
  }
  return updateDoc(P.chat(chatId), upd);
}

/* ---------- Archivar ---------- */
// Se oculta hasta que llegue un mensaje posterior (lastMessageAt > archivedAt)
export const archiveChat = (uid, chatId) => setDoc(P.archived(uid, chatId), { archivedAt: serverTimestamp() });
export const unarchiveChat = (uid, chatId) => deleteDoc(P.archived(uid, chatId));

/* ---------- Lista de chats en tiempo real ---------- */
// cb(visibles, todos, archivedIds:Set). "todos" incluye archivados.
export function watchMyChats(uid, cb, onError) {
  let chats = [];
  let archived = new Map();
  const ts = (c) => c.lastMessageAt?.toMillis?.() ?? Number.MAX_SAFE_INTEGER;

  const emit = () => {
    const all = [...chats].sort((a, b) => ts(b) - ts(a));
    const visible = all.filter((c) => {
      const a = archived.get(c.id);
      if (!a) return true;
      const at = a.archivedAt?.toMillis?.() ?? Date.now();
      return ts(c) > at;
    });
    cb(visible, all, new Set(archived.keys()));
  };

  const u1 = onSnapshot(query(P.chats(), where("participants", "array-contains", uid)), (s) => {
    chats = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    emit();
  }, onError);
  const u2 = onSnapshot(P.archivedAll(uid), (s) => {
    archived = new Map(s.docs.map((d) => [d.id, d.data()]));
    emit();
  }, onError);
  return () => { u1(); u2(); };
}

/* ---------- Popup "Añadir amigos": TODOS los usuarios, A->Z; primero los no añadidos, luego los amigos ---------- */
export function splitFriends(myUid, allUsers, allChats) {
  const inDM = new Set(allChats.filter((c) => c.type === "dm").map((c) => peerOf(c, myUid)));
  const az = (a, b) => (a.displayName || "").localeCompare(b.displayName || "", "es", { sensitivity: "base" });
  const others = allUsers.filter((u) => u.uid !== myUid);
  return {
    candidates: others.filter((u) => !inDM.has(u.uid)).sort(az),
    friends: others.filter((u) => inDM.has(u.uid)).sort(az)
  };
}
