/* Service Worker de notificaciones (FCM Web Push, sin SDK).
   Recibe la configuración (DND, silencios) desde la página vía postMessage y la guarda en IndexedDB. */
const DB_NAME = "chasqui-sw", STORE = "kv";

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbGet(k) {
  const d = await idb();
  return new Promise((res, rej) => {
    const q = d.transaction(STORE).objectStore(STORE).get(k);
    q.onsuccess = () => res(q.result);
    q.onerror = () => rej(q.error);
  });
}
async function idbSet(k, v) {
  const d = await idb();
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, "readwrite");
    t.objectStore(STORE).put(v, k);
    t.oncomplete = () => res();
    t.onerror = () => rej(t.error);
  });
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

// settings: { type:"settings", uid, dnd:boolean, mutes:{ [chatId|serverId]: {until:number|null, messages:boolean, mentions:boolean} } }
self.addEventListener("message", (event) => {
  const m = event.data || {};
  if (m.type === "settings") {
    event.waitUntil(idbSet("settings", { uid: m.uid || null, dnd: !!m.dnd, mutes: m.mutes || {} }));
  }
});

function isSuppressed(s, d) {
  if (s.dnd) return true;
  if (s.uid && d.senderId && d.senderId === s.uid) return true;
  const mute = s.mutes && s.mutes[d.targetId];
  if (!mute) return false;
  if (mute.until != null && mute.until <= Date.now()) return false;
  return d.mention === "1" ? !!mute.mentions : !!mute.messages;
}

// Chrome exige mostrar algo por cada push: se muestra una notificación silenciosa y se cierra al instante.
async function swallow() {
  await self.registration.showNotification("Chasqui", { tag: "swallow", silent: true });
  const list = await self.registration.getNotifications({ tag: "swallow" });
  list.forEach((n) => n.close());
}

/* payload esperado:
   { notification:{title,body,icon}, data:{ kind:"dm|group|channel", targetId, channelId, senderId, mention:"1|0" } } */
self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let p = {};
    try { p = event.data ? event.data.json() : {}; } catch (_) {}
    const n = p.notification || {}, d = p.data || {};

    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const focused = wins.find((c) => c.focused);
    if (focused) { focused.postMessage({ type: "fcm-foreground", payload: p }); return; }

    const settings = (await idbGet("settings").catch(() => null)) || { uid: null, dnd: false, mutes: {} };
    if (isSuppressed(settings, d)) { await swallow(); return; }

    await self.registration.showNotification(n.title || d.title || "Nuevo mensaje", {
      body: n.body || d.body || "",
      icon: n.icon || "/img/icon-192.png",
      tag: d.targetId ? d.targetId + (d.channelId || "") : undefined,
      renotify: !!d.targetId,
      data: d
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const d = event.notification.data || {};
  const qs = new URLSearchParams();
  if (d.kind) qs.set("kind", d.kind);
  if (d.targetId) qs.set("target", d.targetId);
  if (d.channelId) qs.set("channel", d.channelId);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins[0]) {
      await wins[0].focus();
      wins[0].postMessage({ type: "notification-click", data: d });
    } else {
      await self.clients.openWindow("/" + (qs.toString() ? "?" + qs : ""));
    }
  })());
});
