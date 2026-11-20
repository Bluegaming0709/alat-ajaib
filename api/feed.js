import { sunoHeaders, extractClips, normalizeClip, readBody, SUNO_API } from './_suno.js';

// POST { token, workspaceId, type, page } -> { clips, page, totalPages, total, via }
// Pagination model: 20 songs per page, PREV/NEXT walks the pages.
// Suno itself caps every list endpoint at ~20 per page and its page/cursor
// behaviour is inconsistent, so the server first collects the workspace's
// FULL song list (paging Suno internally, with a short in-memory cache),
// then slices out the requested page of 20. NEXT therefore always advances.
const PAGE_SIZE = 20;
const cache = new Map(); // key -> { at, clips, via }
const CACHE_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  try {
    const body = await readBody(req);
    const { token, workspaceId, type } = body;
    const wantPage = Math.max(0, Number(body.page || 0));
    if (!token) { res.status(400).json({ error: 'Set token dulu di bagian Kantong Token.' }); return; }

    const cacheKey = `${type || 'all'}:${workspaceId || 'all'}:${token.slice(-12)}`;
    let entry = cache.get(cacheKey);
    let debug = [];
    if (!entry || Date.now() - entry.at > CACHE_MS) {
      const headers = sunoHeaders(token);
      const attempts = [];
      const MAX_PAGES = 30;
      const MAX_SONGS = 600;

      async function fetchJson(url, opts = {}) {
        const r = await fetch(url, { headers, ...opts });
        const data = await r.json().catch(() => null);
        return { status: r.status, data };
      }
      async function aggregateGet(label, buildUrl, firstPage) {
        const seen = new Set(); const out = [];
        for (let i = 0; i < MAX_PAGES; i++) {
          const url = buildUrl(firstPage + i);
          let status, data;
          try { ({ status, data } = await fetchJson(url)); }
          catch (e) { attempts.push(`${label} p${firstPage + i} -> ${e.message}`); break; }
          const clips = extractClips(data).map(normalizeClip).filter(Boolean);
          let added = 0;
          for (const c of clips) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); added++; }
          attempts.push(`${label} p${firstPage + i} -> HTTP ${status}, ${clips.length} lagu (${added} baru)`);
          if (!added || out.length >= MAX_SONGS) break;
        }
        return out;
      }
      async function aggregateFeedV3(label, filters) {
        const seen = new Set(); const out = [];
        let cursor = null;
        for (let i = 0; i < MAX_PAGES; i++) {
          let status, data;
          try {
            ({ status, data } = await fetchJson(`${SUNO_API}/api/feed/v3`, {
              method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ limit: 50, cursor, filters }),
            }));
          } catch (e) { attempts.push(`${label} -> ${e.message}`); break; }
          const clips = extractClips(data).map(normalizeClip).filter(Boolean);
          let added = 0;
          for (const c of clips) if (!seen.has(c.id)) { seen.add(c.id); out.push(c); added++; }
          attempts.push(`${label} -> HTTP ${status}, ${clips.length} lagu (${added} baru)`);
          cursor = data && (data.next_cursor || data.cursor || data.nextCursor || (data.meta && data.meta.next_cursor) || (data.pagination && data.pagination.next_cursor));
          if (!added || !cursor || out.length >= MAX_SONGS) break;
        }
        return out;
      }

      let clips = []; let via = null;
      const run = async (label, fn) => { if (!clips.length) { const c = await fn(); if (c && c.length) { clips = c; via = label; } } };

      if (!workspaceId || workspaceId === 'all' || type === 'all') {
        await run('library', () => aggregateGet('library', p => `${SUNO_API}/api/library?page=${p}&page_size=50`, 1));
        await run('feed/v3', () => aggregateFeedV3('feed/v3', { disliked: 'False', trashed: 'False' }));
        await run('feed/v2', () => aggregateGet('feed/v2', p => `${SUNO_API}/api/feed/v2?page=${p}`, 0));
      } else if (type === 'playlist') {
        await run('playlist/v2', () => aggregateGet('playlist/v2', p => `${SUNO_API}/api/playlist/v2/${workspaceId}?page=${p}&page_size=50`, 1));
        await run('playlist', () => aggregateGet('playlist', p => `${SUNO_API}/api/playlist/${workspaceId}?page=${p}&page_size=50`, 1));
        await run('playlist/clips', () => aggregateGet('playlist/clips', p => `${SUNO_API}/api/playlist/${workspaceId}/clips?page=${p}&page_size=50`, 1));
        await run('feed/v3-playlist', () => aggregateFeedV3('feed/v3-playlist', { disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'False' }, playlist: { presence: 'True', playlistId: workspaceId } }));
      } else {
        await run('project', () => aggregateGet('project', p => `${SUNO_API}/api/project/${workspaceId}`, 1));
        await run('project/clips', () => aggregateGet('project/clips', p => `${SUNO_API}/api/project/${workspaceId}/clips?page=${p}&page_size=50`, 1));
        await run('feed/v3-project', () => aggregateFeedV3('feed/v3-project', { disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'True' }, project: { presence: 'True', projectId: workspaceId } }));
      }

      debug = attempts;
      entry = { at: Date.now(), clips, via };
      if (clips.length) cache.set(cacheKey, entry);
    }

    const all = entry.clips || [];
    if (!all.length) {
      res.status(200).json({ clips: [], page: 0, totalPages: 1, total: 0, debug, message: 'Semua endpoint Suno balas kosong buat pilihan ini. Detail: ' + debug.join(' | ') });
      return;
    }
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const page = Math.min(wantPage, totalPages - 1);
    const slice = all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    res.status(200).json({ clips: slice, page, totalPages, total: all.length, via: entry.via, debug });
  } catch (e) {
    res.status(502).json({ error: `Gagal: ${e.message}` });
  }
}
