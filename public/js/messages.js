import { db, P, CONFIG } from "./firebase-init.js";
import {
  doc, setDoc, deleteDoc, writeBatch, query, orderBy, limitToLast, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";

/* ctx = { kind:"chat", chatId } | { kind:"channel", serverId, channelId } */
const R = (ctx) => ctx.kind === "chat"
  ? { col: () => P.chatMessages(ctx.chatId), votes: (m) => P.chatVotes(ctx.chatId, m), vote: (m, u) => P.chatVote(ctx.chatId, m, u),
      typingAll: () => P.chatTypingAll(ctx.chatId), typing: (u) => P.chatTyping(ctx.chatId, u) }
  : { col: () => P.channelMessages(ctx.serverId, ctx.channelId), votes: (m) => P.channelVotes(ctx.serverId, ctx.channelId, m),
      vote: (m, u) => P.channelVote(ctx.serverId, ctx.channelId, m, u),
      typingAll: () => P.channelTypingAll(ctx.serverId, ctx.channelId), typing: (u) => P.channelTyping(ctx.serverId, ctx.channelId, u) };

const mapDocs = (cb) => (s) => cb(s.docs.map((d) => ({ id: d.id, ...d.data() })));

/* ---------- Anti-spam local: máx. CONFIG.SPAM.MAX mensajes por ventana, por usuario ---------- */
const sentLog = new Map();   // uid -> [timestamps]
function checkRate(uid) {
  const { MAX, WINDOW_MS } = CONFIG.SPAM, now = Date.now();
  const arr = (sentLog.get(uid) || []).filter((t) => now - t < WINDOW_MS);
  if (arr.length >= MAX) {
    sentLog.set(uid, arr);
    const e = new Error("Vas demasiado rápido, no hagas spam"); e.code = "rate-limit"; throw e;
  }
  arr.push(now); sentLog.set(uid, arr);
}

/* ---------- Envío (type: text | gif | poll, exigido por las reglas) ---------- */
async function post(ctx, uid, body, preview) {
  checkRate(uid);
  const ref = doc(R(ctx).col());
  const batch = writeBatch(db);
  batch.set(ref, { senderId: uid, createdAt: serverTimestamp(), mentions: [], ...body });
  if (ctx.kind === "chat") {
    batch.update(P.chat(ctx.chatId), { lastMessage: preview.slice(0, 200), lastMessageAt: serverTimestamp(), lastSenderId: uid, lastMessageId: ref.id });
  }
  await batch.commit();
  return ref.id;
}

export function sendMessage(ctx, uid, text, mentions = []) {
  text = text.trim();
  if (!text) return Promise.resolve();
  if (text.length > 4000) throw new Error("Mensaje demasiado largo.");
  return post(ctx, uid, { type: "text", text, mentions: mentions.slice(0, 20) }, text);
}

export function sendGif(ctx, uid, gifUrl, title = "") {
  if (!/^https:\/\//.test(gifUrl)) throw new Error("URL de GIF inválida.");
  return post(ctx, uid, { type: "gif", gifUrl, text: title }, "GIF");
}

export function sendPoll(ctx, uid, question, options) {
  const opts = options.map((o) => o.trim()).filter(Boolean).slice(0, 10);
  question = question.trim();
  if (!question || opts.length < 2) throw new Error("La encuesta necesita pregunta y al menos 2 opciones.");
  return post(ctx, uid, {
    type: "poll",
    poll: { question: question.slice(0, 200), options: opts.map((t, i) => ({ id: "o" + i, text: t.slice(0, 100) })) }
  }, "📊 " + question);
}

/* ---------- Escucha en tiempo real ---------- */
export const watchMessages = (ctx, cb, err) =>
  onSnapshot(query(R(ctx).col(), orderBy("createdAt", "asc"), limitToLast(100)), mapDocs(cb), err);

/* ---------- Encuestas: un voto por usuario (doc votes/{uid}) ---------- */
export const castVote = (ctx, messageId, uid, optionId) =>
  setDoc(R(ctx).vote(messageId, uid), { optionId, votedAt: serverTimestamp() });
export const removeVote = (ctx, messageId, uid) => deleteDoc(R(ctx).vote(messageId, uid));
export const watchVotes = (ctx, messageId, cb, err) =>
  onSnapshot(R(ctx).votes(messageId), (s) => cb(s.docs.map((d) => ({ uid: d.id, optionId: d.data().optionId }))), err);

export function tallyVotes(options, votes, myUid) {
  const counts = Object.fromEntries(options.map((o) => [o.id, 0]));
  votes.forEach((v) => { if (v.optionId in counts) counts[v.optionId]++; });
  return { counts, total: votes.length, mine: votes.find((v) => v.uid === myUid)?.optionId ?? null };
}

/* ---------- "Escribiendo..." ---------- */
// Emisor: llamar ping() en cada tecla; se limpia solo a los 3 s de inactividad o con stop() (al enviar).
export function createTypingNotifier(ctx, uid) {
  let timer = null, last = 0, active = false;
  const stop = async () => {
    clearTimeout(timer); timer = null;
    if (!active) return;
    active = false; last = 0;
    try { await deleteDoc(R(ctx).typing(uid)); } catch (_) {}
  };
  const ping = () => {
    const now = Date.now();
    if (now - last > CONFIG.TYPING_THROTTLE_MS) {
      last = now; active = true;
      setDoc(R(ctx).typing(uid), { uid, at: serverTimestamp() }).catch(() => {});
    }
    clearTimeout(timer);
    timer = setTimeout(stop, CONFIG.TYPING_TTL_MS);
  };
  return { ping, stop };
}

// Receptor: cb(uids[]) sin incluirme y sin señales vencidas (re-evalúa cada segundo)
export function watchTyping(ctx, myUid, cb) {
  let docs = [], lastKey = "";
  const emit = () => {
    const now = Date.now();
    const uids = docs.filter((d) => d.uid !== myUid && d.at && now - d.at < CONFIG.TYPING_TTL_MS + 2000).map((d) => d.uid);
    const key = uids.join(",");
    if (key !== lastKey) { lastKey = key; cb(uids); }
  };
  const unsub = onSnapshot(R(ctx).typingAll(), (s) => {
    docs = s.docs.map((d) => ({ uid: d.id, at: d.data().at?.toMillis?.() ?? null }));
    emit();
  }, () => {});
  const iv = setInterval(emit, 1000);
  return () => { unsub(); clearInterval(iv); };
}

// Para el avatar con "..." en la barra lateral: escucha varios chats. cb({ [chatId]: uids[] })
export function watchTypingMany(chatIds, myUid, cb) {
  const state = {};
  const unsubs = chatIds.map((id) => watchTyping({ kind: "chat", chatId: id }, myUid, (uids) => {
    if (uids.length) state[id] = uids; else delete state[id];
    cb({ ...state });
  }));
  return () => unsubs.forEach((u) => u());
}

/* ---------- Menciones con @ ---------- */
// members: [{ uid, displayName, nickname }]
const nameOf = (m) => m.nickname || m.displayName || "";

// Devuelve { query, start } si el cursor está justo después de "@texto"
export function detectMentionQuery(value, caret) {
  const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
  return m ? { query: m[2], start: caret - m[2].length - 1 } : null;
}
export function getMentionSuggestions(q, members, max = 8) {
  const s = q.toLowerCase();
  const hit = (m) => [m.displayName, m.nickname].some((n) => n && n.toLowerCase().includes(s));
  return members.filter(hit)
    .sort((a, b) => Number(nameOf(b).toLowerCase().startsWith(s)) - Number(nameOf(a).toLowerCase().startsWith(s)))
    .slice(0, max);
}
export function applyMention(value, caret, start, member) {
  const ins = "@" + nameOf(member) + " ";
  return { value: value.slice(0, start) + ins + value.slice(caret), caret: start + ins.length };
}
export function extractMentions(text, members) {
  const t = text.toLowerCase();
  return members.filter((m) => [m.displayName, m.nickname].some((n) => n && t.includes("@" + n.toLowerCase()))).map((m) => m.uid);
}
// Parte el texto en trozos para pintar menciones sin innerHTML: [{text}|{text,uid}]
export function splitMentions(text, members) {
  const names = [...new Set(members.flatMap((m) => [m.displayName, m.nickname]).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!names.length) return [{ text }];
  const re = new RegExp("@(" + names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "gi");
  const parts = []; let i = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > i) parts.push({ text: text.slice(i, m.index) });
    const who = members.find((x) => [x.displayName, x.nickname].some((n) => n && n.toLowerCase() === m[1].toLowerCase()));
    parts.push({ text: m[0], uid: who?.uid });
    i = m.index + m[0].length;
  }
  if (i < text.length) parts.push({ text: text.slice(i) });
  return parts;
}
