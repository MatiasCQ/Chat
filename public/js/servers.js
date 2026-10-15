import { db, P } from "./firebase-init.js";
import {
  doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc, onSnapshot, query, where,
  writeBatch, serverTimestamp, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

const slug = (s) => s.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 100);

/* ---------- Servidores ---------- */
export async function createServer(uid, name) {
  name = name.trim().slice(0, 100);
  if (!name) throw new Error("Nombre requerido.");
  const ref = doc(P.servers());
  const batch = writeBatch(db);
  batch.set(ref, { name, ownerId: uid, members: [uid], categories: ["TEXTO"], createdAt: serverTimestamp() });
  batch.set(P.member(ref.id, uid), { uid, roleId: null, joinedAt: serverTimestamp() });
  await batch.commit();
  await addChannel(ref.id, "general", "TEXTO", null); // requiere que el dueño ya sea miembro (reglas)
  return ref.id;
}

export function applyOrder(servers, order) {
  const idx = new Map(order.map((id, i) => [id, i]));
  return [...servers].sort((a, b) => (idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9));
}

export function watchMyServers(uid, cb, onError) {
  let servers = [], order = [];
  const emit = () => cb(applyOrder(servers, order));
  const u1 = onSnapshot(query(P.servers(), where("members", "array-contains", uid)), (s) => {
    servers = s.docs.map((d) => ({ id: d.id, ...d.data() })); emit();
  }, onError);
  const u2 = onSnapshot(P.prefs(uid, "serverOrder"), (s) => {
    order = s.exists() ? s.data().order || [] : []; emit();
  }, onError);
  return () => { u1(); u2(); };
}

export const saveServerOrder = (uid, ids) => setDoc(P.prefs(uid, "serverOrder"), { order: ids, updatedAt: serverTimestamp() });
export const renameServer = (serverId, name) => updateDoc(P.server(serverId), { name: name.trim().slice(0, 100) });
export const addCategory = (serverId, name) => updateDoc(P.server(serverId), { categories: arrayUnion(name.trim().toUpperCase().slice(0, 50)) });
export const transferOwnership = (serverId, newOwnerId) => updateDoc(P.server(serverId), { ownerId: newOwnerId });
// Nota: Firestore no borra subcolecciones; limpieza en cascada requiere Cloud Functions (Blaze).
export const deleteServer = (serverId) => deleteDoc(P.server(serverId));

/* ---------- Canales ---------- */
// rolesAllowed: null = todos | array de roleIds
export const addChannel = (serverId, name, category, rolesAllowed = null) =>
  addDoc(P.channels(serverId), { name: slug(name), category, rolesAllowed });
export const updateChannel = (serverId, channelId, { name, rolesAllowed }) =>
  updateDoc(P.channel(serverId, channelId), { name: slug(name), rolesAllowed });
export const deleteChannel = (serverId, channelId) => deleteDoc(P.channel(serverId, channelId));

/* ---------- Roles ---------- */
export function createRole(serverId, name, perms = {}) {
  return addDoc(P.roles(serverId), {
    name: name.trim().slice(0, 50),
    permissions: { isAdmin: !!perms.isAdmin, canKick: !!perms.canKick, canInvite: !!perms.canInvite }
  });
}
export async function deleteRole(serverId, roleId) {
  const batch = writeBatch(db);
  (await getDocs(query(P.members(serverId), where("roleId", "==", roleId)))).forEach((d) => batch.update(d.ref, { roleId: null }));
  (await getDocs(query(P.channels(serverId), where("rolesAllowed", "array-contains", roleId)))).forEach((d) => batch.update(d.ref, { rolesAllowed: arrayRemove(roleId) }));
  batch.delete(P.role(serverId, roleId));
  await batch.commit();
}
export const setMemberRole = (serverId, uid, roleId) => updateDoc(P.member(serverId, uid), { roleId: roleId || null });

/* ---------- Miembros ---------- */
export async function kickMember(server, uid) {
  if (uid === server.ownerId) throw new Error("No puedes expulsar al dueño.");
  const batch = writeBatch(db);
  batch.delete(P.member(server.id, uid));
  batch.update(P.server(server.id), { members: arrayRemove(uid) });
  await batch.commit();
}
export async function leaveServer(server, uid) {
  if (uid === server.ownerId) throw new Error("El dueño debe transferir la propiedad o eliminar el servidor.");
  return kickMember({ ...server, ownerId: null }, uid);
}

/* ---------- Invitaciones de un solo uso ---------- */
// Código = "serverId:inviteId"
export async function createInvitation(server, uid) {
  const ref = await addDoc(P.invitations(server.id), { createdBy: uid, serverName: server.name, used: false, createdAt: serverTimestamp() });
  return `${server.id}:${ref.id}`;
}
export const revokeInvitation = (serverId, inviteId) => deleteDoc(P.invitation(serverId, inviteId));

export async function acceptInvitation(code, uid) {
  const [serverId, inviteId] = code.trim().split(":");
  if (!serverId || !inviteId) throw new Error("Código inválido.");
  const invSnap = await getDoc(P.invitation(serverId, inviteId));
  if (!invSnap.exists() || invSnap.data().used) throw new Error("La invitación ya fue usada o no existe.");

  const batch = writeBatch(db);
  batch.update(P.invitation(serverId, inviteId), { used: true, usedBy: uid, usedAt: serverTimestamp() });
  batch.set(P.member(serverId, uid), { uid, roleId: null, inviteId, joinedAt: serverTimestamp() });
  batch.update(P.server(serverId), { members: arrayUnion(uid) });
  await batch.commit();
  return serverId;
}

/* ---------- Escuchas de un servidor ---------- */
const mapDocs = (cb) => (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() })));
export const watchChannels = (sid, cb, err) => onSnapshot(P.channels(sid), mapDocs(cb), err);
export const watchRoles = (sid, cb, err) => onSnapshot(P.roles(sid), mapDocs(cb), err);
export const watchMembers = (sid, cb, err) => onSnapshot(P.members(sid), mapDocs(cb), err);
export const watchInvitations = (sid, cb, err) => onSnapshot(P.invitations(sid), mapDocs(cb), err); // solo con canInvite

/* ---------- Permisos para la UI (las reglas son la autoridad real) ---------- */
export function getPermissions(server, member, roles, uid) {
  const owner = server.ownerId === uid;
  const p = roles.find((r) => r.id === member?.roleId)?.permissions || {};
  const isAdmin = owner || !!p.isAdmin;
  return { isOwner: owner, isAdmin, canKick: isAdmin || !!p.canKick, canInvite: isAdmin || !!p.canInvite };
}
export function visibleChannels(channels, member, perms) {
  return channels.filter((c) => perms.isAdmin || c.rolesAllowed == null || c.rolesAllowed.includes(member?.roleId));
}

/* ---------- Drag & Drop vertical del rail ---------- */
// Cada elemento: <div class="server-item" data-id="..." draggable="true">
export function setupServerDragAndDrop(container, onOrderChange) {
  if (container.dataset.dnd) return;
  container.dataset.dnd = "1";
  let dragged = null;

  container.addEventListener("dragstart", (e) => {
    const it = e.target.closest(".server-item");
    if (!it) return;
    dragged = it;
    it.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", it.dataset.id);
  });
  container.addEventListener("dragover", (e) => {
    e.preventDefault();
    const over = e.target.closest(".server-item");
    if (!dragged || !over || over === dragged) return;
    const r = over.getBoundingClientRect();
    container.insertBefore(dragged, e.clientY - r.top - r.height / 2 > 0 ? over.nextSibling : over);
  });
  container.addEventListener("dragend", () => {
    if (!dragged) return;
    dragged.classList.remove("dragging");
    dragged = null;
    onOrderChange([...container.querySelectorAll(".server-item")].map((el) => el.dataset.id));
  });
}
