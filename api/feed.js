import { sunoHeaders, extractClips, normalizeClip, readBody, SUNO_API } from './_suno.js';

// POST { token, workspaceId, type, page } -> { clips: [...], page, via, debug }
// Suno has moved these endpoints around, so each list type uses a waterfall:
// try each candidate in order and keep the first one that returns songs.
export default async function handler(req, res) {
  try {
    const body = await readBody(req);
    const { token, workspaceId, type } = body;
    const page = Number(body.page || 0);
    if (!token) { res.status(400).json({ error: 'Set token dulu di bagian Kantong Token.' }); return; }

    const headers = sunoHeaders(token);
    const page1 = page + 1; // playlist/library endpoints are 1-based
    let attempts = [];

    async function tryGet(url) {
      try {
        const r = await fetch(url, { headers });
        const data = await r.json().catch(() => null);
        const clips = extractClips(data).map(normalizeClip).filter(Boolean);
        attempts.push(`${url.replace(SUNO_API, '')} -> HTTP ${r.status}, ${clips.length} lagu`);
        return clips.length ? clips : null;
      } catch (e) { attempts.push(`${url.replace(SUNO_API, '')} -> ${e.message}`); return null; }
    }
    async function tryFeedV3(filters) {
      try {
        const r = await fetch(`${SUNO_API}/api/feed/v3`, {
          method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 50, cursor: null, filters }),
        });
        const data = await r.json().catch(() => null);
        const clips = extractClips(data).map(normalizeClip).filter(Boolean);
        attempts.push(`/api/feed/v3 -> HTTP ${r.status}, ${clips.length} lagu`);
        return clips.length ? clips : null;
      } catch (e) { attempts.push(`/api/feed/v3 -> ${e.message}`); return null; }
    }

    let clips = null; let via = null;
    const run = async (label, fn) => { if (!clips) { const c = await fn(); if (c) { clips = c; via = label; } } };

    if (!workspaceId || workspaceId === 'all' || type === 'all') {
      await run('library', () => tryGet(`${SUNO_API}/api/library?page=${page1}&page_size=50`));
      await run('feed/v3', () => tryFeedV3({ disliked: 'False', trashed: 'False' }));
      await run('feed/v2', () => tryGet(`${SUNO_API}/api/feed/v2?page=${page}`));
      await run('feed', () => tryGet(`${SUNO_API}/api/feed/?page=${page}`));
    } else if (type === 'playlist') {
      await run('playlist/v2', () => tryGet(`${SUNO_API}/api/playlist/v2/${workspaceId}?page=${page1}&page_size=50`));
      await run('playlist', () => tryGet(`${SUNO_API}/api/playlist/${workspaceId}?page=${page1}&page_size=50`));
      await run('playlist/clips', () => tryGet(`${SUNO_API}/api/playlist/${workspaceId}/clips?page=${page1}&page_size=50`));
      await run('feed/v3-playlist', () => tryFeedV3({ disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'False' }, playlist: { presence: 'True', playlistId: workspaceId } }));
    } else {
      await run('project', () => tryGet(`${SUNO_API}/api/project/${workspaceId}`));
      await run('project/clips', () => tryGet(`${SUNO_API}/api/project/${workspaceId}/clips?page=${page1}&page_size=50`));
      await run('feed/v3-project', () => tryFeedV3({ disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'True' }, project: { presence: 'True', projectId: workspaceId } }));
      await run('library', () => tryGet(`${SUNO_API}/api/library?page=${page1}&page_size=50`));
    }

    if (!clips) {
      res.status(200).json({ clips: [], page, debug: attempts, message: 'Semua endpoint Suno balas kosong buat pilihan ini. Detail: ' + attempts.join(' | ') });
      return;
    }
    res.status(200).json({ clips, page, via, debug: attempts });
  } catch (e) {
    res.status(502).json({ error: `Gagal: ${e.message}` });
  }
}
