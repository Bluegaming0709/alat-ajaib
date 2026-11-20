// Shared helpers for Suno API access (server-side, no CORS issues)
export const SUNO_API = 'https://studio-api-prod.suno.com';
export const KEYS_API = 'https://madhouse-suno-downloader.vercel.app/api/keys';

export function sunoHeaders(token) {
  const h = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Origin': 'https://suno.com',
    'Referer': 'https://suno.com/',
    'Accept': 'application/json, text/plain, */*',
    // Suno's current web API expects these two headers on library/feed calls;
    // without them those endpoints can answer 200 with an empty result.
    'browser-token': Buffer.from(JSON.stringify({ timestamp: Date.now() })).toString('base64'),
    'device-id': globalThis.crypto.randomUUID(),
  };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export function parseSongId(input) {
  if (!input) return null;
  const s = String(input).trim();
  const uuid = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  return uuid ? uuid[0] : null;
}

export async function fetchClip(id, token) {
  const r = await fetch(`${SUNO_API}/api/clip/${id}`, { headers: sunoHeaders(token) });
  if (!r.ok) throw new Error(`Suno clip API error ${r.status}`);
  return r.json();
}

export function normalizeClip(c) {
  if (!c || !c.id) return null;
  return {
    id: c.id,
    title: c.title || 'Tanpa Judul',
    image_url: c.image_url || `https://cdn1.suno.ai/image_${c.id}.jpeg`,
    duration: (c.metadata && c.metadata.duration) || c.duration || null,
    status: c.status || 'complete',
    created_at: c.created_at || null,
  };
}

function unwrapClip(item) {
  if (!item || typeof item !== 'object') return null;
  // Playlist responses nest the song: { clip: {...} } / { song: {...} }
  const inner = item.clip || item.song || item.track || null;
  if (inner && inner.id) return inner;
  return item.id ? item : null;
}

export function extractClips(data) {
  if (!data) return [];
  let arr = null;
  if (Array.isArray(data)) arr = data;
  else {
    for (const k of ['clips', 'playlist_clips', 'project_clips', 'items', 'results', 'songs', 'tracks', 'data']) {
      if (Array.isArray(data[k])) { arr = data[k]; break; }
    }
    if (!arr && data.project) arr = extractClips(data.project);
    if (!arr && data.playlist) arr = extractClips(data.playlist);
    if (!arr && data.data && typeof data.data === 'object') arr = extractClips(data.data);
  }
  if (!arr) return [];
  const seen = new Set(); const out = [];
  for (const it of arr) {
    const c = unwrapClip(it);
    if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); }
  }
  return out;
}

export function extractList(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  for (const k of ['projects', 'playlists', 'items', 'results', 'data']) {
    if (Array.isArray(data[k])) return data[k];
  }
  return [];
}

export async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch { return {}; } }
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
}
