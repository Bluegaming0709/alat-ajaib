import { sunoHeaders, extractClips, normalizeClip, readBody, SUNO_API } from './_suno.js';

// POST { token, workspaceId, type, page } -> { clips: [...], complete: true, total, via, debug }
// Suno caps every list endpoint at ~20 songs per page, so instead of paging
// from the browser we pull ALL pages server-side until Suno runs out of songs.
export default async function handler(req, res) {
  try {
    const body = await readBody(req);
    const { token, workspaceId, type } = body;
    if (!token) { res.status(400).json({ error: 'Set token dulu di bagian Kantong Token.' }); return; }

    const headers = sunoHeaders(token);
    const attempts = [];
    const MAX_PAGES = 12;
    const MAX_SONGS = 600;

    async function fetchJson(url, opts = {}) {
      const r = await fetch(url, { headers, ...opts });
      const data = await r.json().catch(() => null);
      return { status: r.status, data };
    }

    // Page through a GET endpoint (1-based or 0-based) until it stops giving new songs.
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

    // feed/v3 pages by cursor instead of page number.
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

    if (!clips.length) {
      res.status(200).json({ clips: [], complete: true, total: 0, debug: attempts, message: 'Semua endpoint Suno balas kosong buat pilihan ini. Detail: ' + attempts.join(' | ') });
      return;
    }
    res.status(200).json({ clips, complete: true, total: clips.length, via, debug: attempts });
  } catch (e) {
    res.status(502).json({ error: `Gagal: ${e.message}` });
  }
}
