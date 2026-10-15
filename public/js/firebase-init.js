import { initializeApp } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js";
import { getAuth, GoogleAuthProvider } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js";
import { getFirestore, collection, doc } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js";
import { getMessaging, isSupported } from "https://www.gstatic.com/firebasejs/13.0.0/firebase-messaging.js";

export const firebaseConfig = {
  apiKey: "AIzaSyAbExjrymCzPOQi53XDQlWP3gAsEdLI9ak",
  authDomain: "chasqui-2be72.firebaseapp.com",
  projectId: "chasqui-2be72",
  storageBucket: "chasqui-2be72.firebasestorage.app",
  messagingSenderId: "829269373652",
  appId: "1:829269373652:web:49ba46426e70b14f01c141",
  measurementId: "G-PJ31PH6772"
};

export const VAPID_KEY = "BMCkDC3VLPHlaBARkJP1NK7n56cQ3p0nlwnNJLgk2jXTWaWeKNg2JDXup02TSR3vjNuLQCSAVKrgXRkR6sQuA5I";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const googleProvider = new GoogleAuthProvider();
export const messaging = (await isSupported()) ? getMessaging(app) : null;

/* ---------- Constantes globales ---------- */
export const CONFIG = Object.freeze({
  SW_PATH: "/firebase-messaging-sw.js",
  STATUS: Object.freeze({ ONLINE: "online", IDLE: "idle", DND: "dnd", OFFLINE: "offline" }),
  STATUS_LABEL: Object.freeze({ online: "En línea", idle: "Inactivo", dnd: "No molestar", offline: "Desconectado" }),
  HEARTBEAT_MS: 20_000,        // "signo de vida" periódico (actualiza lastSeen)
  OFFLINE_AFTER_MS: 90_000,    // sin heartbeat > 90 s => Desconectado (tolera throttling de pestañas ocultas)
  IDLE_AFTER_MS: 300_000,      // 5 min sin interacción => Inactivo
  SPAM: Object.freeze({ MAX: 6, WINDOW_MS: 10_000 }),
  TYPING_TTL_MS: 3_000,
  TYPING_THROTTLE_MS: 2_000,
  SHORT_DESC_MAX: 30,
  MUTE_OPTIONS: Object.freeze([
    { label: "15 minutos", minutes: 15 },
    { label: "30 minutos", minutes: 30 },
    { label: "45 minutos", minutes: 45 },
    { label: "1 hora", minutes: 60 },
    { label: "1.5 horas", minutes: 90 },
    { label: "2 horas", minutes: 120 },
    { label: "Hasta que lo reactive", minutes: null }
  ]),
  GIF: Object.freeze({
    apiKey: "hp7mYp49b29P5wF1O78mS3W6kM3k5m5X",   // https://developers.giphy.com
    searchUrl: "https://api.giphy.com/v1/gifs/search",
    trendingUrl: "https://api.giphy.com/v1/gifs/trending",
    limit: 24,
    favoritesKey: "chasqui_gif_favorites"
  })
});

/* ---------- Referencias centralizadas de Firestore ---------- */
export const P = {
  // users
  users: () => collection(db, "users"),
  user: (u) => doc(db, "users", u),
  tokens: (u) => collection(db, "users", u, "tokens"),
  token: (u, t) => doc(db, "users", u, "tokens", t),
  mutes: (u) => collection(db, "users", u, "mutes"),          // id = chatId | serverId
  mute: (u, id) => doc(db, "users", u, "mutes", id),          // {until, messages, mentions}
  archivedAll: (u) => collection(db, "users", u, "archived"),
  archived: (u, c) => doc(db, "users", u, "archived", c),     // {archivedAt}
  prefs: (u, name) => doc(db, "users", u, "prefs", name),     // prefs/serverOrder {order:[]}
  // chats (MD y grupos)
  chats: () => collection(db, "chats"),
  chat: (c) => doc(db, "chats", c),
  chatMessages: (c) => collection(db, "chats", c, "messages"),
  chatMessage: (c, m) => doc(db, "chats", c, "messages", m),
  chatVotes: (c, m) => collection(db, "chats", c, "messages", m, "votes"),
  chatVote: (c, m, u) => doc(db, "chats", c, "messages", m, "votes", u),
  chatTypingAll: (c) => collection(db, "chats", c, "typing"),
  chatTyping: (c, u) => doc(db, "chats", c, "typing", u),
  // servers
  servers: () => collection(db, "servers"),
  server: (s) => doc(db, "servers", s),
  members: (s) => collection(db, "servers", s, "members"),
  member: (s, u) => doc(db, "servers", s, "members", u),
  roles: (s) => collection(db, "servers", s, "roles"),
  role: (s, r) => doc(db, "servers", s, "roles", r),
  channels: (s) => collection(db, "servers", s, "channels"),
  channel: (s, c) => doc(db, "servers", s, "channels", c),
  channelMessages: (s, c) => collection(db, "servers", s, "channels", c, "messages"),
  channelMessage: (s, c, m) => doc(db, "servers", s, "channels", c, "messages", m),
  channelVotes: (s, c, m) => collection(db, "servers", s, "channels", c, "messages", m, "votes"),
  channelVote: (s, c, m, u) => doc(db, "servers", s, "channels", c, "messages", m, "votes", u),
  channelTypingAll: (s, c) => collection(db, "servers", s, "channels", c, "typing"),
  channelTyping: (s, c, u) => doc(db, "servers", s, "channels", c, "typing", u),
  invitations: (s) => collection(db, "servers", s, "invitations"),
  invitation: (s, i) => doc(db, "servers", s, "invitations", i)
};
