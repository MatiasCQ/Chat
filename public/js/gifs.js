import { CONFIG } from "./firebase-init.js";

const { apiKey, searchUrl, trendingUrl, limit, favoritesKey } = CONFIG.GIF;

/* ---------- Giphy ---------- */
// Sin texto -> tendencias. Requiere tu propia API key en CONFIG.GIF.apiKey (https://developers.giphy.com)
export async function searchGifs(text = "") {
  if (!apiKey || apiKey.startsWith("TU_")) throw new Error("Configura CONFIG.GIF.apiKey en firebase-init.js");
  const params = new URLSearchParams({ api_key: apiKey, limit: String(limit), rating: "g" });
  if (text.trim()) params.set("q", text.trim());
  const res = await fetch((text.trim() ? searchUrl : trendingUrl) + "?" + params);
  if (!res.ok) throw new Error("Giphy respondió " + res.status);
  const { data } = await res.json();
  return data.map((g) => ({
    id: g.id,
    title: g.title || "",
    url: g.images.fixed_height.url,          // se envía al chat
    preview: g.images.fixed_width.url         // miniatura del panel
  }));
}

/* ---------- Favoritos (localStorage) ---------- */
export function getFavoriteGifs() {
  try { return JSON.parse(localStorage.getItem(favoritesKey)) || []; } catch (_) { return []; }
}
function saveFavorites(list) {
  try { localStorage.setItem(favoritesKey, JSON.stringify(list.slice(-200))); } catch (_) {}
}
export const isGifFavorite = (id) => getFavoriteGifs().some((f) => f.id === id);

// true = añadido, false = quitado
export function toggleFavoriteGif(gif) {
  const favs = getFavoriteGifs();
  const i = favs.findIndex((f) => f.id === gif.id);
  if (i > -1) favs.splice(i, 1); else favs.push({ id: gif.id, title: gif.title, url: gif.url, preview: gif.preview });
  saveFavorites(favs);
  return i === -1;
}
