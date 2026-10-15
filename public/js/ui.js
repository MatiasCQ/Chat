import { P, CONFIG } from "./firebase-init.js";
import { onSnapshot } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { watchAuth, loginWithEmail, registerWithEmail, loginWithGoogle, logout, authErrorMessage } from "./auth.js";
import { saveProfile, updateProfile, setManualStatus, startPresence, stopPresence, listUsers, effectiveStatus, markActive, syncDnd } from "./users.js";
import {
  openOrCreateDM, createGroupChat, kickFromGroup, transferGroupOwnership, renameGroup, leaveGroup,
  setSharedNicknames, archiveChat, unarchiveChat, deleteGroup, watchMyChats, splitFriends, peerOf, nameInChat
} from "./chats.js";
import {
  createServer, watchMyServers, saveServerOrder, setupServerDragAndDrop, addCategory, addChannel, updateChannel, deleteChannel,
  createRole, deleteRole, setMemberRole, kickMember, leaveServer, transferOwnership, deleteServer, createInvitation,
  revokeInvitation, acceptInvitation, watchChannels, watchRoles, watchMembers, watchInvitations, getPermissions, visibleChannels
} from "./servers.js";
import {
  sendMessage, sendGif, sendPoll, watchMessages, castVote, removeVote, watchVotes, tallyVotes,
  createTypingNotifier, watchTyping, watchTypingMany, detectMentionQuery, getMentionSuggestions, applyMention,
  extractMentions, splitMentions
} from "./messages.js";
import { searchGifs, getFavoriteGifs, toggleFavoriteGif, isGifFavorite } from "./gifs.js";
import {
  notificationsSupported, enableNotifications, watchMutes, muteContext, unmuteContext, setDnd, isMuteActive,
  shouldNotify, onForegroundMessage, onNotificationClick
} from "./notifications.js";

/* =================== Helpers =================== */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const { STATUS_LABEL } = CONFIG;

const defaultAvatar = (u) => (u?.isGroup ? "img/group-default.png" : "img/avatar.png");
function avatarEl(user, cls = "avatar") {
  const img = el("img", cls);
  img.referrerPolicy = "no-referrer";
  img.alt = "";
  img.src = user?.photoURL || defaultAvatar(user);
  return img;
}
function avatarWithDot(user) {
  const w = el("span", "avatar-wrap");
  w.append(avatarEl(user), el("span", "dot " + (user?.status || "offline")));
  return w;
}
function typingAvatar() {
  const a = el("span", "avatar avatar-typing");
  const d = el("span", "typing-dots"); d.append(el("i"), el("i"), el("i"));
  a.append(d);
  return a;
}
function fmtTime(ts) {
  const d = ts?.toDate?.();
  if (!d) return "";
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString("es", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("es", { day: "2-digit", month: "2-digit", year: "2-digit" });
}
let toastTimer;
function toast(msg) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3500);
}
const errMsg = (e, fb) => (e?.code === "permission-denied" ? "No tienes permiso para esta acción." : e?.message || fb);
function showAlert(msg) { $("alert-text").textContent = msg; openModal("modal-alert"); }
const sendFail = (e, fb) => (e?.code === "rate-limit" ? showAlert(e.message) : toast(errMsg(e, fb)));

/* =================== Estado =================== */
const S = {
  me: null, profile: null,
  users: new Map(), userUnsubs: new Map(), usersDirty: false,
  chats: [], allChats: [], servers: [], mutes: {}, typingMap: {}, typingKey: "", lastChat: new Map(),
  serverId: null, channels: [], roles: [], members: [], invites: [],
  cur: null, ctx: null, renderedIds: null, lastMsgs: [], msgIds: new Set(), firstLoad: true,
  votes: new Map(), voteUnsubs: new Map(), notifier: null,
  mention: null, muteTarget: null, editChannel: null, pending: null, pendingChannel: null,
  unsubs: {}
};
const userOf = (uid) => {
  const u = S.users.get(uid) || { uid, displayName: "Usuario" };
  return uid === S.me?.uid ? u : { ...u, status: effectiveStatus(u) };   // latido viejo => Desconectado
};
const server = () => S.servers.find((s) => s.id === S.serverId);
const myMember = () => S.members.find((m) => m.uid === S.me?.uid);
const perms = () => { const s = server(); return s ? getPermissions(s, myMember(), S.roles, S.me.uid) : { isOwner: false, isAdmin: false, canKick: false, canInvite: false }; };

function trackUsers(uids) {
  for (const uid of uids) {
    if (!uid || S.userUnsubs.has(uid)) continue;
    S.userUnsubs.set(uid, onSnapshot(P.user(uid), (s) => {
      if (!s.exists()) return;
      if (!S.users.has(uid)) S.usersDirty = true;
      S.users.set(uid, { uid, ...s.data() });
      scheduleRender();
    }, () => {}));
  }
}
let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    renderDMList(); renderHeader(); renderMembersPanel();
    if (S.usersDirty && S.cur) { S.usersDirty = false; renderMessages(S.lastMsgs); }
  });
}

/* =================== Popups / modales =================== */
const POPUPS = ["plus-menu", "gif-panel", "mention-menu", "status-menu", "ctx-menu"];
const hidePopups = () => POPUPS.forEach((id) => ($(id).hidden = true));
function openModal(id) { hidePopups(); $(id).hidden = false; }
function closeModal(id) {
  $(id).hidden = true;
  if (id === "modal-server-settings") { S.unsubs.sInv?.(); S.unsubs.sInv = null; S.invites = []; }
}
document.querySelectorAll(".modal").forEach((m) => {
  m.addEventListener("click", (e) => { if (e.target === m) closeModal(m.id); });
  m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(m.id)));
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { hidePopups(); document.querySelectorAll(".modal:not([hidden])").forEach((m) => closeModal(m.id)); }
});
document.addEventListener("click", (e) => {
  const keep = { "plus-menu": "#btn-plus", "gif-panel": "#btn-gif", "status-menu": "#btn-user-status" };
  for (const id of POPUPS) {
    if (id === "mention-menu") continue;
    if ($(id).contains(e.target) || (keep[id] && e.target.closest(keep[id]))) continue;
    $(id).hidden = true;
  }
});
function showCtx(x, y, items) {
  const m = $("ctx-menu");
  m.replaceChildren();
  items.forEach(([label, fn]) => { const b = el("button", "", label); b.type = "button"; b.onclick = () => { m.hidden = true; fn(); }; m.append(b); });
  m.hidden = false;
  m.style.left = Math.min(x, innerWidth - 210) + "px";
  m.style.top = Math.min(y, innerHeight - 40 * items.length - 20) + "px";
}

/* =================== Login =================== */
function authBusy(b) { ["btn-login", "btn-register", "btn-google"].forEach((id) => ($(id).disabled = b)); }
async function runAuth(fn) {
  $("auth-error").textContent = ""; authBusy(true);
  try { await fn(); } catch (e) { $("auth-error").textContent = authErrorMessage(e); } finally { authBusy(false); }
}
$("auth-form").addEventListener("submit", (e) => { e.preventDefault(); runAuth(() => loginWithEmail($("auth-email").value.trim(), $("auth-password").value)); });
$("btn-register").addEventListener("click", () => { if ($("auth-form").reportValidity()) runAuth(() => registerWithEmail($("auth-email").value.trim(), $("auth-password").value)); });
$("btn-google").addEventListener("click", () => runAuth(loginWithGoogle));
$("btn-logout").addEventListener("click", async () => { if (S.me) await stopPresence(S.me.uid); logout(); });

watchAuth(async (user) => {
  if (!user) return endSession();
  if (S.me?.uid === user.uid) return;
  S.me = user;
  try { await saveProfile(user); } catch (e) { console.error(e); toast("No se pudo guardar tu perfil"); }
  startSession(user);
});

function startSession(user) {
  $("view-auth").hidden = true; $("view-app").hidden = false;
  startPresence(user.uid);
  const q = new URLSearchParams(location.search);
  if (q.get("target")) S.pending = { kind: q.get("kind"), targetId: q.get("target"), channelId: q.get("channel") };
  S.unsubs.me = onSnapshot(P.user(user.uid), (s) => {
    if (!s.exists()) return;
    S.profile = { uid: user.uid, ...s.data() };
    S.users.set(user.uid, S.profile);
    setDnd(S.profile.status === "dnd"); syncDnd(S.profile.status === "dnd");
    renderMe(); scheduleRender();
  }, console.error);
  S.unsubs.chats = watchMyChats(user.uid, onChats, console.error);
  S.unsubs.servers = watchMyServers(user.uid, onServers, console.error);
  S.unsubs.mutes = watchMutes(user.uid, (m) => { S.mutes = m; updateMuteButton(); renderDMList(); });
  const b = $("btn-notif"); b.hidden = true;
  if (notificationsSupported()) {
    if (Notification.permission === "granted") enableNotifications(user.uid).catch(console.error);
    else if (Notification.permission === "default") b.hidden = false;
  }
}

function endSession() {
  stopPresence();
  Object.values(S.unsubs).forEach((u) => u?.()); S.unsubs = {};
  closeContext(); stopServerWatch();
  S.userUnsubs.forEach((u) => u()); S.userUnsubs.clear(); S.users.clear();
  Object.assign(S, { me: null, profile: null, chats: [], allChats: [], archivedIds: new Set(), servers: [], serverId: null, cur: null, ctx: null, mutes: {}, typingMap: {}, typingKey: "", lastChat: new Map() });
  $("dm-list").replaceChildren(); $("server-list").replaceChildren(); $("channel-list").replaceChildren();
  $("conversation").hidden = true; $("empty-state").hidden = false;
  hidePopups(); document.querySelectorAll(".modal").forEach((m) => (m.hidden = true));
  showHomeUI();
  $("auth-password").value = "";
  $("view-app").hidden = true; $("view-auth").hidden = false;
}

/* =================== Perfil / estado =================== */
function renderMe() {
  const p = S.profile; if (!p) return;
  const img = avatarEl(p); img.id = "me-photo";
  $("me-photo").replaceWith(img);
  $("me-name").textContent = p.displayName;
  $("me-status-text").textContent = STATUS_LABEL[p.status] || "En línea";
  $("me-status-dot").className = "dot " + (p.status || "online");
}
$("btn-user-status").addEventListener("click", () => {
  const m = $("status-menu"), r = $("btn-user-status").getBoundingClientRect();
  const open = m.hidden; hidePopups(); m.hidden = !open;
  m.style.left = r.left + "px"; m.style.bottom = innerHeight - r.top + 6 + "px";
});
$("status-menu").querySelectorAll("[data-status]").forEach((b) => b.addEventListener("click", async () => {
  $("status-menu").hidden = true;
  try { await setManualStatus(S.me.uid, b.dataset.status); } catch (e) { toast(errMsg(e, "No se pudo cambiar el estado")); }
}));

$("btn-profile").addEventListener("click", () => {
  const p = S.profile || {};
  $("profile-name").value = p.displayName || ""; $("profile-short").value = p.shortDescription || ""; $("profile-long").value = p.customDescription || "";
  $("profile-short-count").textContent = `${$("profile-short").value.length}/${CONFIG.SHORT_DESC_MAX}`;
  openModal("modal-profile");
});
$("profile-short").addEventListener("input", () => ($("profile-short-count").textContent = `${$("profile-short").value.length}/${CONFIG.SHORT_DESC_MAX}`));
$("btn-profile-save").addEventListener("click", async () => {
  try {
    await updateProfile(S.me.uid, { displayName: $("profile-name").value, shortDescription: $("profile-short").value, customDescription: $("profile-long").value });
    closeModal("modal-profile"); toast("Perfil actualizado");
  } catch (e) { toast(errMsg(e, "No se pudo guardar")); }
});

/* =================== Notificaciones =================== */
$("btn-notif").addEventListener("click", async () => {
  try {
    const t = await enableNotifications(S.me.uid);
    if (t) { $("btn-notif").hidden = true; toast("Notificaciones activadas"); } else toast("Permiso denegado");
  } catch (e) { console.error(e); toast("No se pudieron activar las notificaciones"); }
});
function localNotify(d) {
  if (!shouldNotify(d)) return;
  if (document.hasFocus()) return toast(`${d.title}: ${d.body}`);
  if (Notification?.permission === "granted") {
    const n = new Notification(d.title, { body: d.body, tag: d.targetId, icon: "/img/icon-192.png" });
    n.onclick = () => { window.focus(); handleTarget(d); n.close(); };
  }
}
onForegroundMessage((p) => {
  const n = p.notification || {}, d = p.data || {};
  if (shouldNotify(d)) toast(`${n.title || d.title || "Nuevo mensaje"}${n.body ? ": " + n.body : ""}`);
});
onNotificationClick((d) => handleTarget(d));

function handleTarget(d) {
  if (!d?.targetId || !S.me) return true;
  if (d.kind === "channel") {
    const s = S.servers.find((x) => x.id === d.targetId); if (!s) return false;
    S.pendingChannel = d.channelId || null; selectServer(s.id, true); onServerData(); return true;
  }
  const c = S.allChats.find((x) => x.id === d.targetId); if (!c) return false;
  showHome(); openChat(c); return true;
}
function tryPending() {
  if (S.pending && handleTarget(S.pending)) { S.pending = null; history.replaceState(null, "", location.pathname); }
}

/* =================== Chats / MDs =================== */
function onChats(visible, all, archivedIds = new Set()) {
  const me = S.me.uid;
  all.forEach((c) => {
    const prev = S.lastChat.get(c.id);
    const open = S.cur?.kind === "chat" && S.cur.id === c.id && document.hasFocus();
    if (prev !== undefined && c.lastMessageId && c.lastMessageId !== prev && c.lastSenderId !== me && !open && !(S.cur?.id === c.id)) {
      const sender = userOf(c.lastSenderId);
      const mention = new RegExp("@(" + [S.profile?.displayName].filter(Boolean).join("|") + ")", "i").test(c.lastMessage) ? "1" : "0";
      localNotify({ title: c.type === "group" ? `${c.name} · ${nameInChat(c, sender)}` : nameInChat(c, sender), body: c.lastMessage, targetId: c.id, kind: c.type, mention });
    }
  });
  S.lastChat = new Map(all.map((c) => [c.id, c.lastMessageId || ""]));
  S.chats = visible; S.allChats = all; S.archivedIds = archivedIds;
  trackUsers(all.flatMap((c) => c.participants));

  const key = all.map((c) => c.id).sort().join(",");
  if (key !== S.typingKey) {
    S.typingKey = key; S.unsubs.typingMany?.();
    S.unsubs.typingMany = watchTypingMany(all.map((c) => c.id), me, (map) => { S.typingMap = map; renderDMList(); });
  }
  if (S.cur?.kind === "chat") {
    const c = all.find((x) => x.id === S.cur.id);
    if (!c || !c.participants.includes(me)) { closeConversation(); toast("Ya no formas parte de este chat"); }
    else { S.cur.chat = c; renderHeader(); renderMembersPanel(); }
  }
  renderDMList(); renderGroupManage(); renderArchived(); tryPending();
}

function renderDMList() {
  if (!S.me) return;
  const ul = $("dm-list"); ul.replaceChildren();
  if (!S.chats.length) { ul.append(el("li", "muted", "Aún no tienes MDs. Usa «Añadir amigos».")); return; }
  for (const chat of S.chats) {
    const isOpen = S.cur?.kind === "chat" && S.cur.id === chat.id;
    const li = el("li", "dm-item" + (isOpen ? " active" : ""));
    let name, av;
    if (chat.type === "dm") { const p = userOf(peerOf(chat, S.me.uid)); name = nameInChat(chat, p); av = avatarWithDot(p); }
    else { name = chat.name; av = avatarEl({ photoURL: chat.photoURL, isGroup: true }); }
    if (!isOpen && S.typingMap[chat.id]) av = typingAvatar();        // "..." animado si escriben en otra sala
    const info = el("div", "info");
    info.append(el("div", "name", (isMuteActive(chat.id) ? "🔕 " : "") + name),
      el("div", "last", chat.lastMessage ? (chat.lastSenderId === S.me.uid ? "Tú: " : "") + chat.lastMessage : "Sin mensajes"));
    li.append(av, info);
    const owner = chat.type === "group" && chat.ownerId === S.me.uid;
    const menu = (x, y) => showCtx(x, y, [
      ...(chat.type === "dm" ? [["Cambiar Apodos", () => openNickname(chat)]] : []),
      ...(owner ? [["Cambiar Nombre del Grupo", () => openRename(chat)]] : []),
      ["Archivar MD", () => doArchive(chat)],
      ["Silenciar…", () => openMute(chat.id, name)],
      ...(owner ? [["Eliminar Grupo", () => doDeleteGroup(chat)]] : [])
    ]);
    let lp = null;
    li.addEventListener("click", () => { if (li.dataset.lp) { delete li.dataset.lp; return; } openChat(chat); });
    li.addEventListener("contextmenu", (e) => { e.preventDefault(); menu(e.clientX, e.clientY); });
    li.addEventListener("touchstart", (e) => { const t = e.touches[0]; lp = setTimeout(() => { li.dataset.lp = "1"; menu(t.clientX, t.clientY); }, 500); }, { passive: true });
    ["touchend", "touchmove", "touchcancel"].forEach((ev) => li.addEventListener(ev, () => clearTimeout(lp), { passive: true }));
    ul.append(li);
  }
}
async function doArchive(chat) {
  try { await archiveChat(S.me.uid, chat.id); if (S.cur?.id === chat.id) closeConversation(); toast("MD archivado (vuelve al llegar un mensaje nuevo)"); }
  catch (e) { toast(errMsg(e, "No se pudo archivar")); }
}

// --- Chats archivados ---
$("btn-archived").addEventListener("click", () => { openModal("modal-archived"); renderArchived(); });
function renderArchived() {
  if ($("modal-archived").hidden) return;
  const ul = $("archived-list"); ul.replaceChildren();
  const list = S.allChats.filter((c) => S.archivedIds?.has(c.id));
  if (!list.length) return ul.append(el("li", "muted", "No tienes chats archivados."));
  list.forEach((c) => {
    const row = el("li", "list-row"); let av, name, desc;
    if (c.type === "dm") { const p = userOf(peerOf(c, S.me.uid)); av = avatarEl(p); name = nameInChat(c, p); desc = p.shortDescription || "Sin descripción"; }
    else { av = avatarEl({ photoURL: c.photoURL, isGroup: true }); name = c.name; desc = `${c.participants.length} participantes`; }
    const b = el("button", "", "Desarchivar"); b.type = "button";
    b.onclick = () => unarchiveChat(S.me.uid, c.id).then(() => toast("Chat desarchivado")).catch((e) => toast(errMsg(e, "No se pudo desarchivar")));
    row.append(av, el("span", "name", name), el("span", "desc", "| " + desc), b);
    ul.append(row);
  });
}

// --- Renombrar / eliminar grupo (solo dueño) ---
function openRename(chat) { S.renameChat = chat; $("rename-input").value = chat.name || ""; openModal("modal-rename-group"); $("rename-input").focus(); }
$("btn-rename-save").addEventListener("click", async () => {
  const n = $("rename-input").value.trim(); if (!n) return toast("El nombre no puede estar vacío");
  try { await renameGroup(S.renameChat.id, n); closeModal("modal-rename-group"); toast("Nombre actualizado"); }
  catch (e) { toast(errMsg(e, "No se pudo renombrar")); }
});
async function doDeleteGroup(chat) {
  if (!confirm(`¿Eliminar el grupo «${chat.name}» para todos? Esta acción no se puede deshacer.`)) return;
  try { await deleteGroup(chat.id); toast("Grupo eliminado"); } catch (e) { toast(errMsg(e, "No se pudo eliminar el grupo")); }
}

// --- Añadir amigos: todos los usuarios A->Z (no añadidos primero, luego "Amigo") ---
$("btn-add-friends").addEventListener("click", async () => {
  openModal("modal-add-friends"); $("friends-filter").value = "";
  const ul = $("friends-list"); ul.replaceChildren(el("li", "muted", "Cargando..."));
  try {
    const all = await listUsers();
    all.forEach((u) => S.users.has(u.uid) || S.users.set(u.uid, u));
    S.friendCands = splitFriends(S.me.uid, all, S.allChats);
    renderFriends();
  } catch (e) { ul.replaceChildren(el("li", "error", errMsg(e, "No se pudo cargar"))); }
});
$("friends-filter").addEventListener("input", renderFriends);
function renderFriends() {
  const ul = $("friends-list"), f = $("friends-filter").value.trim().toLowerCase();
  ul.replaceChildren();
  const { candidates = [], friends = [] } = S.friendCands || {};
  const ok = (u) => !f || (u.displayName || "").toLowerCase().includes(f);
  const rows = [...candidates.filter(ok).map((u) => [u, false]), ...friends.filter(ok).map((u) => [u, true])];
  if (!rows.length) return ul.append(el("li", "muted", "No hay usuarios."));
  rows.forEach(([u, isFriend]) => {
    const row = el("li", "list-row");
    const b = el("button", isFriend ? "secondary" : "", isFriend ? "Amigo" : "Añadir"); b.type = "button";
    if (isFriend) b.disabled = true;
    else b.onclick = async () => {
      try { const id = await openOrCreateDM(S.me.uid, u.uid); closeModal("modal-add-friends"); showHome(); await waitChat(id); }
      catch (e) { toast(errMsg(e, "No se pudo crear el MD")); }
    };
    row.append(avatarEl(u), el("span", "name", u.displayName), el("span", "desc", "| " + (u.shortDescription || "Sin descripción")), b);
    ul.append(row);
  });
}
async function waitChat(id) {            // el chat llega por el listener; esperar brevemente
  for (let i = 0; i < 20; i++) { const c = S.allChats.find((x) => x.id === id); if (c) return openChat(c); await new Promise((r) => setTimeout(r, 150)); }
}

// --- Crear grupo ---
$("btn-create-group").addEventListener("click", async () => {
  openModal("modal-create-group"); $("group-name").value = "";
  const ul = $("group-candidates"); ul.replaceChildren(el("li", "muted", "Cargando..."));
  try {
    const all = (await listUsers()).filter((u) => u.uid !== S.me.uid);
    ul.replaceChildren();
    all.forEach((u) => {
      const li = el("li", "list-row"), cb = el("input"); cb.type = "checkbox"; cb.value = u.uid;
      li.append(cb, avatarEl(u), el("span", "name", u.displayName)); ul.append(li);
    });
  } catch (e) { ul.replaceChildren(el("li", "error", errMsg(e, "No se pudo cargar"))); }
});
$("btn-group-create").addEventListener("click", async () => {
  const uids = [...$("group-candidates").querySelectorAll("input:checked")].map((c) => c.value);
  if (!uids.length) return toast("Selecciona al menos un participante");
  try { const id = await createGroupChat(S.me.uid, uids, $("group-name").value); closeModal("modal-create-group"); showHome(); await waitChat(id); }
  catch (e) { toast(errMsg(e, "No se pudo crear el grupo")); }
});

// --- Gestionar grupo ---
$("btn-group-manage").addEventListener("click", () => { $("group-rename").value = S.cur?.chat?.name || ""; openModal("modal-group-manage"); renderGroupManage(); });
function renderGroupManage() {
  if ($("modal-group-manage").hidden || S.cur?.kind !== "chat") return;
  const chat = S.cur.chat, owner = chat.ownerId === S.me.uid, ul = $("group-members");
  ul.replaceChildren();
  $("group-rename").disabled = !owner; $("btn-group-save").hidden = !owner; $("btn-group-leave").hidden = owner;
  chat.participants.forEach((uid) => {
    const u = userOf(uid), row = el("li", "list-row");
    row.append(avatarEl(u), el("span", "name", u.displayName + (uid === chat.ownerId ? " 👑" : "")), el("span", "desc"));
    if (owner && uid !== S.me.uid) {
      const k = el("button", "danger", "Expulsar"), t = el("button", "secondary", "Hacer dueño");
      k.onclick = () => kickFromGroup(chat.id, uid).catch((e) => toast(errMsg(e, "No se pudo expulsar")));
      t.onclick = () => transferGroupOwnership(chat.id, uid).then(() => toast("Propiedad transferida")).catch((e) => toast(errMsg(e, "No se pudo transferir")));
      row.append(t, k);
    }
    ul.append(row);
  });
}
$("btn-group-save").addEventListener("click", async () => {
  try { await renameGroup(S.cur.chat.id, $("group-rename").value); toast("Grupo actualizado"); } catch (e) { toast(errMsg(e, "No se pudo guardar")); }
});
$("btn-group-leave").addEventListener("click", async () => {
  if (!confirm("¿Salir del grupo?")) return;
  try { await leaveGroup(S.cur.chat.id, S.me.uid); closeModal("modal-group-manage"); closeConversation(); } catch (e) { toast(errMsg(e, "No se pudo salir")); }
});

// --- Apodo compartido (MD) ---
function openNickname(chat) {
  S.nickChat = chat;
  const box = $("nick-rows"); box.replaceChildren();
  chat.participants.forEach((uid) => {
    const u = userOf(uid), row = el("div", "nick-row"), inp = el("input");
    inp.type = "text"; inp.maxLength = 32; inp.dataset.uid = uid; inp.placeholder = "Sin apodo"; inp.value = chat.nicknames?.[uid] || "";
    row.append(el("span", "nick-name", `${u.displayName}${uid === S.me.uid ? " (tú)" : ""}:`), inp);
    box.append(row);
  });
  openModal("modal-nickname");
}
$("btn-nickname").addEventListener("click", () => S.cur?.chat && openNickname(S.cur.chat));
$("btn-nick-save").addEventListener("click", async () => {
  const values = {};
  $("nick-rows").querySelectorAll("input").forEach((i) => (values[i.dataset.uid] = i.value));
  try { await setSharedNicknames(S.nickChat.id, values); closeModal("modal-nickname"); toast("Apodos actualizados"); }
  catch (e) { toast(errMsg(e, "No se pudo guardar los apodos")); }
});
$("btn-archive").addEventListener("click", () => S.cur?.chat && doArchive(S.cur.chat));

/* =================== Silenciar =================== */
function openMute(id, label) {
  S.muteTarget = { id, label };
  const m = S.mutes[id], active = isMuteActive(id);
  $("mute-messages").checked = active ? !!m.messages : true;
  $("mute-mentions").checked = active ? !!m.mentions : false;
  $("btn-unmute").hidden = !active;
  openModal("modal-mute");
}
$("btn-mute").addEventListener("click", () => {
  if (!S.cur) return;
  const id = S.cur.kind === "chat" ? S.cur.id : S.serverId;
  openMute(id, S.cur.kind === "chat" ? "" : server()?.name);
});
$("btn-mute-save").addEventListener("click", async () => {
  const v = document.querySelector('input[name="mute-duration"]:checked').value;
  const messages = $("mute-messages").checked, mentions = $("mute-mentions").checked;
  if (!messages && !mentions) return toast("Elige qué silenciar: mensajes y/o menciones");
  try { await muteContext(S.me.uid, S.muteTarget.id, { minutes: v === "forever" ? null : Number(v), messages, mentions }); closeModal("modal-mute"); toast("Silenciado"); }
  catch (e) { toast(errMsg(e, "No se pudo silenciar")); }
});
$("btn-unmute").addEventListener("click", async () => {
  try { await unmuteContext(S.me.uid, S.muteTarget.id); closeModal("modal-mute"); toast("Notificaciones reactivadas"); } catch (e) { toast(errMsg(e, "Error")); }
});
function updateMuteButton() {
  if (!S.cur) return;
  const id = S.cur.kind === "chat" ? S.cur.id : S.serverId;
  $("btn-mute").textContent = isMuteActive(id) ? "🔕" : "🔔";
  $("btn-mute").title = isMuteActive(id) ? "Silenciado (clic para cambiar)" : "Silenciar notificaciones";
}
setInterval(() => { updateMuteButton(); scheduleRender(); }, 30_000);   // refresca silencios que vencen

/* =================== Servidores =================== */
setupServerDragAndDrop($("server-list"), (ids) => saveServerOrder(S.me.uid, ids).catch((e) => toast(errMsg(e, "No se pudo guardar el orden"))));
$("btn-home").addEventListener("click", showHome);
$("btn-add-server").addEventListener("click", () => { $("server-name").value = ""; $("invite-code").value = ""; openModal("modal-server"); });
$("btn-server-create").addEventListener("click", async () => {
  try { const id = await createServer(S.me.uid, $("server-name").value); closeModal("modal-server"); await waitServer(id); }
  catch (e) { toast(errMsg(e, "No se pudo crear el servidor")); }
});
$("btn-server-join").addEventListener("click", async () => {
  try { const id = await acceptInvitation($("invite-code").value, S.me.uid); closeModal("modal-server"); await waitServer(id); }
  catch (e) { toast(errMsg(e, "No se pudo unir al servidor")); }
});
async function waitServer(id) { for (let i = 0; i < 20; i++) { if (S.servers.some((s) => s.id === id)) return selectServer(id); await new Promise((r) => setTimeout(r, 150)); } }

function onServers(list) {
  S.servers = list;
  if (S.serverId && !list.some((s) => s.id === S.serverId)) { showHome(); toast("Ya no estás en ese servidor"); }
  renderRail();
  if (S.serverId) { $("sidebar-title").textContent = server()?.name || ""; onServerData(); }
  tryPending();
}
function renderRail() {
  const ul = $("server-list");
  if (ul.querySelector(".dragging")) return;
  ul.replaceChildren();
  S.servers.forEach((s) => {
    const d = el("div", "server-item" + (s.id === S.serverId ? " active" : ""), (s.name[0] || "?").toUpperCase());
    d.dataset.id = s.id; d.draggable = true; d.title = s.name;
    d.addEventListener("click", () => selectServer(s.id));
    d.addEventListener("contextmenu", (e) => { e.preventDefault(); showCtx(e.clientX, e.clientY, [["Silenciar…", () => openMute(s.id, s.name)], ["Ajustes del servidor", () => { selectServer(s.id); setTimeout(openServerSettings, 300); }]]); });
    ul.append(d);
  });
  $("btn-home").classList.toggle("active", !S.serverId);
}
function showHomeUI() {
  $("sidebar-dm").hidden = false; $("sidebar-server").hidden = true;
  $("sidebar-title").textContent = "Mensajes directos"; $("btn-server-settings").hidden = true;
  $("btn-home").classList.toggle("active", true);
}
function showHome() {
  stopServerWatch(); if (S.cur?.kind === "channel") closeConversation();
  S.serverId = null; showHomeUI(); renderRail(); renderDMList();
}
function stopServerWatch() { ["sCh", "sRoles", "sMem", "sInv"].forEach((k) => { S.unsubs[k]?.(); S.unsubs[k] = null; }); S.channels = []; S.roles = []; S.members = []; S.invites = []; }
function selectServer(id, keep) {
  if (S.serverId === id) return;
  stopServerWatch(); if (!keep) closeConversation(); else if (S.cur?.kind === "channel") closeConversation();
  S.serverId = id;
  $("sidebar-dm").hidden = true; $("sidebar-server").hidden = false; $("btn-server-settings").hidden = false;
  $("sidebar-title").textContent = server()?.name || "";
  S.unsubs.sCh = watchChannels(id, (l) => { S.channels = l; onServerData(); }, console.error);
  S.unsubs.sRoles = watchRoles(id, (l) => { S.roles = l; onServerData(); }, console.error);
  S.unsubs.sMem = watchMembers(id, (l) => { S.members = l; trackUsers(l.map((m) => m.uid)); onServerData(); }, console.error);
  renderRail(); $("channel-list").replaceChildren();
}
function onServerData() {
  if (!S.serverId) return;
  renderChannels(); renderMembersPanel(); refreshSettings();
  const vis = visibleChannels(S.channels, myMember(), perms());
  if (S.pendingChannel) { const c = vis.find((x) => x.id === S.pendingChannel); if (c) { S.pendingChannel = null; openChannel(c); } }
  if (S.cur?.kind === "channel") {
    const c = vis.find((x) => x.id === S.cur.id);
    if (!c) { if (S.channels.length || S.members.length) { closeConversation(); } } else { S.cur.channel = c; renderHeader(); }
  }
}
function renderChannels() {
  const box = $("channel-list"); box.replaceChildren();
  const s = server(); if (!s) return;
  const vis = visibleChannels(S.channels, myMember(), perms());
  const cats = [...(s.categories || []), ...new Set(vis.map((c) => c.category).filter((c) => !(s.categories || []).includes(c)))];
  cats.forEach((cat) => {
    const list = vis.filter((c) => c.category === cat); if (!list.length) return;
    box.append(el("div", "channel-cat", cat));
    list.forEach((ch) => {
      const d = el("div", "channel-item" + (S.cur?.kind === "channel" && S.cur.id === ch.id ? " active" : ""), ch.name);
      d.addEventListener("click", () => openChannel(ch)); box.append(d);
    });
  });
  if (!vis.length) box.append(el("p", "muted", "No hay canales visibles."));
}

/* ---- Ajustes del servidor ---- */
$("btn-server-settings").addEventListener("click", openServerSettings);
function openServerSettings() {
  if (!S.serverId) return;
  openModal("modal-server-settings"); $("invite-output").value = "";
  if (perms().canInvite && !S.unsubs.sInv) S.unsubs.sInv = watchInvitations(S.serverId, (l) => { S.invites = l; refreshSettings(); }, () => {});
  showTab(perms().isAdmin ? "ss-channels" : "ss-members"); refreshSettings();
}
function showTab(id) {
  document.querySelectorAll("#modal-server-settings .tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === id));
  document.querySelectorAll("#modal-server-settings .tab-panel").forEach((p) => (p.hidden = p.id !== id));
}
document.querySelectorAll("#modal-server-settings .tab").forEach((t) => t.addEventListener("click", () => showTab(t.dataset.tab)));

function refreshSettings() {
  if ($("modal-server-settings").hidden || !server()) return;
  const s = server(), p = perms(), me = S.me.uid;
  $("ss-title").textContent = s.name;
  const tabs = { "ss-channels": p.isAdmin, "ss-roles": p.isAdmin, "ss-members": true, "ss-invites": p.canInvite };
  Object.entries(tabs).forEach(([id, ok]) => { document.querySelector(`[data-tab="${id}"]`).hidden = !ok; });
  $("btn-server-leave").hidden = p.isOwner; $("btn-server-delete").hidden = !p.isOwner;

  // Canales
  const sel = $("channel-category"), prev = sel.value; sel.replaceChildren();
  (s.categories || []).forEach((c) => sel.append(new Option(c, c))); if (prev) sel.value = prev;
  const cl = $("settings-channels"); cl.replaceChildren();
  S.channels.forEach((ch) => {
    const row = el("li", "list-row"), edit = el("button", "secondary", "Permisos"), del = el("button", "danger", "Eliminar");
    edit.onclick = () => openChannelPerms(ch);
    del.onclick = () => confirm(`¿Eliminar #${ch.name}?`) && deleteChannel(s.id, ch.id).catch((e) => toast(errMsg(e, "Error")));
    row.append(el("span", "name", "# " + ch.name), el("span", "desc", `${ch.category}${ch.rolesAllowed ? " · restringido" : ""}`), edit, del); cl.append(row);
  });
  // Roles
  const rl = $("settings-roles"); rl.replaceChildren();
  S.roles.forEach((r) => {
    const row = el("li", "list-row"), del = el("button", "danger", "Eliminar"), pm = r.permissions || {};
    del.onclick = () => deleteRole(s.id, r.id).catch((e) => toast(errMsg(e, "Error")));
    row.append(el("span", "name", r.name), el("span", "desc", [pm.isAdmin && "Admin", pm.canKick && "Expulsar", pm.canInvite && "Invitar"].filter(Boolean).join(", ") || "Sin permisos"), del); rl.append(row);
  });
  // Miembros
  const ml = $("settings-members"); ml.replaceChildren();
  S.members.forEach((m) => {
    const u = userOf(m.uid), row = el("li", "list-row");
    row.append(avatarEl(u), el("span", "name", u.displayName + (m.uid === s.ownerId ? " 👑" : "")));
    if (p.isAdmin && m.uid !== s.ownerId) {
      const rs = el("select"); rs.append(new Option("Sin rol", "")); S.roles.forEach((r) => rs.append(new Option(r.name, r.id))); rs.value = m.roleId || "";
      rs.style.width = "auto"; rs.onchange = () => setMemberRole(s.id, m.uid, rs.value).catch((e) => toast(errMsg(e, "Error")));
      row.append(rs);
    }
    if (p.canKick && m.uid !== s.ownerId && m.uid !== me) { const k = el("button", "danger", "Expulsar"); k.onclick = () => confirm("¿Expulsar?") && kickMember(s, m.uid).catch((e) => toast(errMsg(e, "Error"))); row.append(k); }
    if (p.isOwner && m.uid !== me) { const t = el("button", "secondary", "Hacer dueño"); t.onclick = () => confirm("¿Transferir la propiedad?") && transferOwnership(s.id, m.uid).catch((e) => toast(errMsg(e, "Error"))); row.append(t); }
    ml.append(row);
  });
  // Invitaciones
  const il = $("settings-invites"); il.replaceChildren();
  S.invites.forEach((i) => {
    const row = el("li", "list-row"), del = el("button", "secondary", "Revocar");
    del.onclick = () => revokeInvitation(s.id, i.id).catch((e) => toast(errMsg(e, "Error")));
    row.append(el("span", "name", i.id.slice(0, 8) + "…"), el("span", "desc", i.used ? "Usada" : "Disponible"), del); il.append(row);
  });
}
$("btn-cat-add").addEventListener("click", async () => { const v = $("cat-name").value.trim(); if (!v) return; try { await addCategory(S.serverId, v); $("cat-name").value = ""; } catch (e) { toast(errMsg(e, "Error")); } });
$("btn-channel-add").addEventListener("click", async () => {
  const n = $("channel-name").value.trim(), c = $("channel-category").value; if (!n || !c) return toast("Nombre y categoría requeridos");
  try { await addChannel(S.serverId, n, c, null); $("channel-name").value = ""; } catch (e) { toast(errMsg(e, "Error")); }
});
$("btn-role-add").addEventListener("click", async () => {
  const n = $("role-name").value.trim(); if (!n) return;
  try { await createRole(S.serverId, n, { isAdmin: $("perm-isAdmin").checked, canKick: $("perm-canKick").checked, canInvite: $("perm-canInvite").checked }); $("role-name").value = ""; } catch (e) { toast(errMsg(e, "Error")); }
});
$("btn-invite-create").addEventListener("click", async () => {
  try { const code = await createInvitation(server(), S.me.uid); $("invite-output").value = code; navigator.clipboard?.writeText(code).catch(() => {}); toast("Invitación copiada (un solo uso)"); } catch (e) { toast(errMsg(e, "Error")); }
});
$("btn-server-leave").addEventListener("click", async () => { if (!confirm("¿Salir del servidor?")) return; try { await leaveServer(server(), S.me.uid); closeModal("modal-server-settings"); } catch (e) { toast(errMsg(e, "Error")); } });
$("btn-server-delete").addEventListener("click", async () => { if (!confirm("¿Eliminar el servidor definitivamente?")) return; try { await deleteServer(S.serverId); closeModal("modal-server-settings"); } catch (e) { toast(errMsg(e, "Error")); } });

// Permisos de canal: "Todos" o checklist de roles
function openChannelPerms(ch) {
  S.editChannel = ch;
  $("ch-edit-name").value = ch.name; $("ch-all").checked = ch.rolesAllowed == null;
  const box = $("ch-roles"); box.replaceChildren();
  S.roles.forEach((r) => {
    const l = el("label"), cb = el("input"); cb.type = "checkbox"; cb.value = r.id; cb.checked = (ch.rolesAllowed || []).includes(r.id);
    l.append(cb, document.createTextNode(r.name)); box.append(l);
  });
  box.classList.toggle("disabled", $("ch-all").checked);
  $("modal-channel").hidden = false;
}
$("ch-all").addEventListener("change", () => $("ch-roles").classList.toggle("disabled", $("ch-all").checked));
$("btn-channel-save").addEventListener("click", async () => {
  const rolesAllowed = $("ch-all").checked ? null : [...$("ch-roles").querySelectorAll("input:checked")].map((c) => c.value);
  try { await updateChannel(S.serverId, S.editChannel.id, { name: $("ch-edit-name").value || S.editChannel.name, rolesAllowed }); closeModal("modal-channel"); } catch (e) { toast(errMsg(e, "Error")); }
});

/* =================== Conversación =================== */
function openChat(chat) { openContext({ kind: "chat", id: chat.id, chat }); }
function openChannel(channel) { openContext({ kind: "channel", id: channel.id, channel }); }

function openContext(cur) {
  closeContext();
  S.cur = cur;
  S.ctx = cur.kind === "chat" ? { kind: "chat", chatId: cur.id } : { kind: "channel", serverId: S.serverId, channelId: cur.id };
  S.firstLoad = true; S.lastMsgs = []; S.msgIds = new Set(); S.renderedIds = null;
  $("empty-state").hidden = true; $("conversation").hidden = false; $("messages").replaceChildren();
  S.unsubs.msgs = watchMessages(S.ctx, onMessages, (e) => { console.error(e); toast("No se pueden leer los mensajes"); });
  S.unsubs.typing = watchTyping(S.ctx, S.me.uid, renderTyping);
  S.notifier = createTypingNotifier(S.ctx, S.me.uid);
  markActive();
  if (cur.kind === "chat" && cur.chat.type === "dm" && innerWidth > 800) $("members-panel").hidden = false;   // perfil del destinatario visible por defecto
  renderHeader(); renderMembersPanel(); renderDMList(); renderChannels(); updateMuteButton();
  $("message-input").focus();
}
function closeContext() {
  S.unsubs.msgs?.(); S.unsubs.typing?.(); S.unsubs.msgs = S.unsubs.typing = null;
  S.notifier?.stop(); S.notifier = null;
  S.voteUnsubs.forEach((u) => u()); S.voteUnsubs.clear(); S.votes.clear();
  $("typing-indicator").hidden = true; $("members-panel").hidden = true; hidePopups();
}
function closeConversation() {
  closeContext(); S.cur = null; S.ctx = null;
  $("conversation").hidden = true; $("empty-state").hidden = false;
  if (S.me) { renderDMList(); renderChannels(); }
}
$("btn-back").addEventListener("click", closeConversation);
$("btn-members-toggle").addEventListener("click", () => { $("members-panel").hidden = !$("members-panel").hidden; renderMembersPanel(); });

function renderHeader() {
  const c = S.cur; if (!c || !S.me) return;
  const show = (id, v) => ($(id).hidden = !v);
  if (c.kind === "chat") {
    const chat = c.chat;
    if (chat.type === "dm") {
      const p = userOf(peerOf(chat, S.me.uid));
      $("conv-icon").textContent = "@"; $("conv-name").textContent = nameInChat(chat, p);
      $("conv-sub").textContent = p.shortDescription || STATUS_LABEL[p.status || "offline"];
    } else {
      $("conv-icon").textContent = "👥"; $("conv-name").textContent = chat.name; $("conv-sub").textContent = `${chat.participants.length} participantes`;
    }
    show("btn-nickname", chat.type === "dm"); show("btn-group-manage", chat.type === "group"); show("btn-archive", true); show("btn-members-toggle", true);
  } else {
    $("conv-icon").textContent = "#"; $("conv-name").textContent = c.channel.name; $("conv-sub").textContent = server()?.name || "";
    show("btn-nickname", false); show("btn-group-manage", false); show("btn-archive", false); show("btn-members-toggle", true);
  }
}
function memberUids() {
  if (!S.cur) return [];
  if (S.cur.kind === "channel") return S.members.map((m) => m.uid);
  return S.cur.chat.participants;
}
const memberObjs = () => memberUids().map((u) => { const x = userOf(u); return { uid: u, displayName: x.displayName, nickname: S.cur.kind === "chat" ? S.cur.chat.nicknames?.[u] : undefined }; });
function renderMembersPanel() {
  const ul = $("members-list"); if ($("members-panel").hidden || !S.cur) return;
  ul.replaceChildren();
  const chat = S.cur.kind === "chat" ? S.cur.chat : null;
  if (chat?.type === "dm") {                         // Perfil global del destinatario (ignora el apodo del MD)
    $("members-label").textContent = "Perfil";
    const u = userOf(peerOf(chat, S.me.uid)), li = el("li", "profile-card");
    const row = el("div", "profile-name-row");
    row.append(el("strong", "", u.displayName || "Usuario"), el("span", "desc", u.shortDescription ? "| " + u.shortDescription : ""));
    li.append(avatarWithDot(u), row, el("p", "profile-long", u.customDescription || "Sin descripción."));
    ul.append(li); return;
  }
  $("members-label").textContent = "Miembros";
  memberUids().forEach((uid) => {
    const u = userOf(uid), li = el("li", "member-item"); li.append(avatarWithDot(u), el("span", "", u.displayName)); ul.append(li);
  });
}

/* ---- Mensajes ---- */
function onMessages(msgs) {
  if (!S.firstLoad) {
    msgs.filter((m) => !S.msgIds.has(m.id) && m.senderId !== S.me.uid && m.createdAt && !document.hasFocus()).forEach((m) => {
      const u = userOf(m.senderId);
      localNotify({
        title: S.cur.kind === "chat" ? nameInChat(S.cur.chat, u) : `#${S.cur.channel.name} · ${u.displayName}`,
        body: m.type === "text" ? m.text : m.type === "gif" ? "GIF" : "Encuesta",
        targetId: S.cur.kind === "chat" ? S.cur.id : S.serverId, kind: S.cur.kind === "chat" ? S.cur.chat.type : "channel",
        channelId: S.cur.kind === "channel" ? S.cur.id : "", mention: (m.mentions || []).includes(S.me.uid) ? "1" : "0"
      });
    });
  }
  msgs.forEach((m) => S.msgIds.add(m.id)); S.firstLoad = false; S.lastMsgs = msgs;
  renderMessages(msgs);
}
function renderMessages(msgs) {
  const box = $("messages"), near = box.scrollHeight - box.scrollTop - box.clientHeight < 90 || !box.childElementCount;
  box.replaceChildren();
  const objs = memberObjs();
  msgs.forEach((m) => {
    const u = userOf(m.senderId), row = el("div", "msg-row"), body = el("div", "msg-body"), head = el("div", "msg-head");
    head.append(el("span", "username", S.cur.kind === "chat" ? nameInChat(S.cur.chat, u) : u.displayName), el("span", "timestamp", fmtTime(m.createdAt)));
    body.append(head);
    if (m.type === "gif") { const g = el("img", "msg-gif"); g.src = m.gifUrl; g.loading = "lazy"; g.alt = m.text || "GIF"; body.append(g); }
    else if (m.type === "poll") { const p = el("div", "poll"); p.dataset.id = m.id; body.append(p); }
    else {
      const t = el("div", "msg-text");
      splitMentions(m.text || "", objs).forEach((part) => part.uid ? t.append(el("span", "mention", part.text)) : t.append(document.createTextNode(part.text)));
      body.append(t);
    }
    if (S.renderedIds && !S.renderedIds.has(m.id)) row.classList.add("msg-new");   // animación solo en mensajes nuevos
    row.append(avatarEl(u, "msg-avatar"), body); box.append(row);
  });
  S.renderedIds = new Set(msgs.map((m) => m.id));
  msgs.filter((m) => m.type === "poll" && !S.voteUnsubs.has(m.id)).forEach((m) =>
    S.voteUnsubs.set(m.id, watchVotes(S.ctx, m.id, (v) => { S.votes.set(m.id, v); renderPolls(); }, () => {})));
  renderPolls();
  if (near) box.scrollTop = box.scrollHeight;
}
function renderPolls() {
  document.querySelectorAll(".poll[data-id]").forEach((div) => {
    const m = S.lastMsgs.find((x) => x.id === div.dataset.id); if (!m) return;
    const t = tallyVotes(m.poll.options, S.votes.get(m.id) || [], S.me.uid);
    div.replaceChildren(el("h4", "", "📊 " + m.poll.question));
    m.poll.options.forEach((o) => {
      const b = el("button", "poll-option" + (t.mine === o.id ? " voted" : "")), pct = t.total ? Math.round((100 * t.counts[o.id]) / t.total) : 0;
      b.type = "button";
      const bar = el("div", "bar"); bar.style.width = pct + "%";
      const sp = el("span"); sp.append(el("b", "", o.text), el("small", "", `${t.counts[o.id]} (${pct}%)`));
      b.append(bar, sp);
      b.onclick = () => (t.mine === o.id ? removeVote : castVote)(S.ctx, m.id, S.me.uid, o.id).catch((e) => toast(errMsg(e, "No se pudo votar")));
      div.append(b);
    });
    div.append(el("small", "muted", `${t.total} voto(s)`));
  });
}
function renderTyping(uids) {
  const box = $("typing-indicator");
  if (!uids.length) { box.hidden = true; return; }
  const nm = (u) => (S.cur?.kind === "chat" ? nameInChat(S.cur.chat, userOf(u)) : userOf(u).displayName) || "Usuario";
  const n = uids.map(nm);
  $("typing-text").textContent =
    n.length === 1 ? `${n[0]} está escribiendo...` :
    n.length === 2 ? `${n[0]} y ${n[1]} están escribiendo...` :
    n.length === 3 ? `${n[0]}, ${n[1]} y ${n[2]} están escribiendo...` :
    "Varias personas están escribiendo...";
  box.hidden = false;
}

/* ---- Composer: enviar, typing, menciones ---- */
const input = $("message-input");
$("message-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim(); if (!text || !S.ctx) return;
  input.value = ""; $("mention-menu").hidden = true; S.notifier?.stop();
  try { await sendMessage(S.ctx, S.me.uid, text, extractMentions(text, memberObjs())); }
  catch (err) { console.error(err); input.value = text; sendFail(err, "No se pudo enviar el mensaje"); }
});
input.addEventListener("input", () => { input.value ? S.notifier?.ping() : S.notifier?.stop(); updateMention(); });
input.addEventListener("keydown", (e) => {
  const mm = S.mention; if ($("mention-menu").hidden || !mm) return;
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); mm.index = (mm.index + (e.key === "ArrowDown" ? 1 : -1) + mm.items.length) % mm.items.length; renderMention(); }
  else if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pickMention(mm.index); }
  else if (e.key === "Escape") { $("mention-menu").hidden = true; }
});
function updateMention() {
  const q = detectMentionQuery(input.value, input.selectionStart ?? input.value.length);
  const items = q ? getMentionSuggestions(q.query, memberObjs().filter((m) => m.uid !== S.me.uid)) : [];
  if (!q || !items.length) { $("mention-menu").hidden = true; S.mention = null; return; }
  S.mention = { start: q.start, items, index: 0 }; renderMention(); $("mention-menu").hidden = false;
}
function renderMention() {
  const ul = $("mention-menu"); ul.replaceChildren();
  S.mention.items.forEach((m, i) => {
    const li = el("li", i === S.mention.index ? "active" : ""); li.append(avatarEl(userOf(m.uid)), el("span", "", m.nickname || m.displayName));
    li.addEventListener("mousedown", (e) => { e.preventDefault(); pickMention(i); }); ul.append(li);
  });
}
function pickMention(i) {
  const mm = S.mention; if (!mm) return;
  const r = applyMention(input.value, input.selectionStart, mm.start, mm.items[i]);
  input.value = r.value; input.setSelectionRange(r.caret, r.caret); $("mention-menu").hidden = true; S.mention = null; input.focus();
}

/* ---- Botón "+" y encuestas ---- */
$("btn-plus").addEventListener("click", () => { const o = $("plus-menu").hidden; hidePopups(); $("plus-menu").hidden = !o; });
$("btn-create-poll").addEventListener("click", () => {
  $("plus-menu").hidden = true; $("poll-question").value = "";
  const box = $("poll-options"); box.replaceChildren();
  for (let i = 1; i <= 2; i++) { const o = el("input", "poll-opt"); o.placeholder = "Opción " + i; o.maxLength = 100; box.append(o); }
  openModal("modal-poll");
});
$("btn-poll-add-option").addEventListener("click", () => {
  const box = $("poll-options"); if (box.children.length >= 10) return;
  const o = el("input", "poll-opt"); o.placeholder = "Opción " + (box.children.length + 1); o.maxLength = 100; box.append(o);
});
$("btn-poll-create").addEventListener("click", async () => {
  try { await sendPoll(S.ctx, S.me.uid, $("poll-question").value, [...document.querySelectorAll(".poll-opt")].map((i) => i.value)); closeModal("modal-poll"); }
  catch (e) { sendFail(e, "No se pudo crear la encuesta"); }
});

/* ---- GIFs ---- */
let gifTab = "search", gifTimer;
$("btn-gif").addEventListener("click", () => { const o = $("gif-panel").hidden; hidePopups(); $("gif-panel").hidden = !o; if (o) loadGifs(); });
$("gif-tab-search").addEventListener("click", () => setGifTab("search"));
$("gif-tab-fav").addEventListener("click", () => setGifTab("fav"));
$("gif-query").addEventListener("input", () => { clearTimeout(gifTimer); gifTimer = setTimeout(() => { if (gifTab === "search") loadGifs(); }, 400); });
function setGifTab(t) { gifTab = t; $("gif-tab-search").classList.toggle("active", t === "search"); $("gif-tab-fav").classList.toggle("active", t === "fav"); $("gif-query").hidden = t === "fav"; loadGifs(); }
async function loadGifs() {
  const grid = $("gif-grid"); grid.replaceChildren(el("p", "muted", "Cargando..."));
  let list;
  try { list = gifTab === "fav" ? getFavoriteGifs() : await searchGifs($("gif-query").value); }
  catch (e) { grid.replaceChildren(el("p", "error", e.message)); return; }
  grid.replaceChildren();
  if (!list.length) grid.append(el("p", "muted", gifTab === "fav" ? "Aún no tienes favoritos (usa la ★)." : "Sin resultados."));
  list.forEach((g) => {
    const cell = el("div", "gif-cell"), img = el("img"), star = el("button", "gif-star" + (isGifFavorite(g.id) ? " on" : ""), "★");
    img.src = g.preview || g.url; img.loading = "lazy"; img.alt = g.title || "GIF"; star.type = "button";
    img.onclick = async () => { try { await sendGif(S.ctx, S.me.uid, g.url, g.title); $("gif-panel").hidden = true; } catch (e) { sendFail(e, "No se pudo enviar el GIF"); } };
    star.onclick = (e) => { e.stopPropagation(); toggleFavoriteGif(g); gifTab === "fav" ? loadGifs() : star.classList.toggle("on"); };
    cell.append(img, star); grid.append(cell);
  });
}
