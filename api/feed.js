import { sunoHeaders, extractClips, normalizeClip, readBody, SUNO_API } from './_suno.js';

// POST { token, workspaceId, type, page, expected }
//   -> { clips, page, totalPages, total, expected, via, debug }
//
// User-facing pagination: 20 songs per page, PREV/NEXT walks the pages.
// v7 lessons from live testing:
//  - NEVER merge results across strategies: a feed strategy whose filter
//    Suno ignores returns songs from OTHER workspaces and pollutes the list.
//    One strategy wins, whole and untouched.
//  - A page that answers with an HTTP error (429 rate-limit / 5xx) is NOT
//    the end of the list. Retry with backoff; only a clean 200 with zero
//    new songs ends paging. Bursts of page requests get paced.
//  - Try one huge page_size first (Suno's library accepts page_size=99999):
//    a single request beats twenty paged ones.
const PAGE_SIZE = 20;
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

export default async function handler(req, res) {
  try {
    const body = await readBody(req);
    const { token, workspaceId, type } = body;
    const wantPage = Math.max(0, Number(body.page || 0));
    const expected = Number(body.expected || 0) || null;
    if (!token) { res.status(400).json({ error: 'Set token dulu di bagian Kantong Token.' }); return; }

    const cacheKey = `v7:${type || 'all'}:${workspaceId || 'all'}:${token.slice(-12)}`;
    let entry = cache.get(cacheKey);
    let debug = [];
    if (!entry || Date.now() - entry.at > CACHE_MS) {
      const headers = sunoHeaders(token);
      const attempts = [];
      const MAX_PAGES = 25;
      const MAX_SONGS = 800;

      async function fetchJson(url, opts = {}) {
        const r = await fetch(url, { headers, ...opts });
        const data = await r.json().catch(() => null);
        return { status: r.status, data };
      }
      // Fetch one page; on 429/5xx retry with backoff. Returns {status, data, clips}.
      async function fetchPage(label, p, makeRequest) {
        let last = { status: 0, data: null, clips: [] };
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const { status, data } = await makeRequest();
            const clips = extractClips(data).map(normalizeClip).filter(Boolean);
            last = { status, data, clips };
            if (status === 429 || status >= 500) {
              attempts.push(`${label} p${p} -> HTTP ${status} (percobaan ${attempt + 1})`);
              await sleep(800 * (attempt + 1));
              continue;
            }
            return last;
          } catch (e) {
            attempts.push(`${label} p${p} -> ${e.message} (percobaan ${attempt + 1})`);
            await sleep(800 * (attempt + 1));
          }
        }
        return last;
      }
      function mergeInto(seen, out, clips) {
        let added = 0;
        for (const c of clips) if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); added++; }
        return added;
      }
      async function getPages(label, buildUrl, firstPage) {
        const seen = new Set(); const out = [];
        for (let i = 0; i < MAX_PAGES; i++) {
          const p = firstPage + i;
          if (i > 0) await sleep(200);
          const { status, clips } = await fetchPage(label, p, () => fetchJson(buildUrl(p)));
          const added = mergeInto(seen, out, clips);
          attempts.push(`${label} p${p} -> HTTP ${status}, ${clips.length} lagu (${added} baru)`);
          if (status !== 200) break;              // error after retries: stop, don't fake completeness
          if (!added) break;                      // clean empty/repeat page: real end
          if (expected && out.length >= expected) break;
          if (out.length >= MAX_SONGS) break;
        }
        return out;
      }
      async function getOnce(label, url) {
        const { status, data, clips } = await fetchPage(label, '-', () => fetchJson(url));
        attempts.push(`${label} -> HTTP ${status}, ${clips.length} lagu; keys: ${data && typeof data === 'object' ? Object.keys(data).join(',') : '-'}`);
        return clips;
      }
      async function feedV3Pages(label, filters) {
        const seen = new Set(); const out = [];
        for (let i = 0; i < MAX_PAGES; i++) {
          if (i > 0) await sleep(200);
          const { status, data, clips } = await fetchPage(label, i, () => fetchJson(`${SUNO_API}/api/feed/v3`, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ page: i, filters }),
          }));
          const added = mergeInto(seen, out, clips);
          attempts.push(`${label} p${i} -> HTTP ${status}, ${clips.length} lagu (${added} baru), has_more=${data ? data.has_more : '?'}`);
          if (status !== 200 || !added || (data && data.has_more === false)) break;
          if (expected && out.length >= expected) break;
          if (out.length >= MAX_SONGS) break;
        }
        return out;
      }
      async function feedV3Cursor(label, filters) {
        const seen = new Set(); const out = [];
        let cursor = null;
        for (let i = 0; i < MAX_PAGES; i++) {
          if (i > 0) await sleep(200);
          const { status, data, clips } = await fetchPage(label, i, () => fetchJson(`${SUNO_API}/api/feed/v3`, {
            method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ limit: 50, cursor, filters }),
          }));
          const added = mergeInto(seen, out, clips);
          cursor = data && (data.next_cursor || data.cursor || data.nextCursor || (data.meta && data.meta.next_cursor) || (data.pagination && data.pagination.next_cursor));
          attempts.push(`${label} #${i} -> HTTP ${status}, ${clips.length} lagu (${added} baru), cursor=${cursor ? 'ada' : 'tidak'}, has_more=${data ? data.has_more : '?'}`);
          if (status !== 200 || !added || !cursor || (data && data.has_more === false)) break;
          if (expected && out.length >= expected) break;
          if (out.length >= MAX_SONGS) break;
        }
        return out;
      }

      const PL_FILTER = { disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'False' }, playlist: { presence: 'True', playlistId: workspaceId } };
      // Tier 1: membership endpoints (playlist/project/library) — their songs
      // belong to the workspace by construction. Tier 2: feed queries — only
      // trusted when tier 1 found nothing, or when they reach the workspace's
      // known total exactly (a feed whose filter was ignored returns an
      // unrelated slice of the library and must never win otherwise).
      let tier1 = []; let tier2 = [];
      if (!workspaceId || workspaceId === 'all' || type === 'all') {
        tier1 = [
          ['library-bulk', () => getOnce('library-bulk', `${SUNO_API}/api/library?page=1&page_size=99999`)],
          ['library-pages', () => getPages('library', p => `${SUNO_API}/api/library?page=${p}&page_size=50`, 1)],
        ];
        tier2 = [
          ['feed/v3-page', () => feedV3Pages('feed/v3-page', { disliked: 'False', trashed: 'False' })],
          ['feed/v3-cursor', () => feedV3Cursor('feed/v3-cursor', { disliked: 'False', trashed: 'False' })],
        ];
      } else if (type === 'playlist') {
        tier1 = [
          ['playlist-bulk', () => getOnce('playlist-bulk', `${SUNO_API}/api/playlist/${workspaceId}?page=1&page_size=99999`)],
          ['playlist-pages', () => getPages('playlist', p => `${SUNO_API}/api/playlist/${workspaceId}?page=${p}&page_size=50`, 1)],
          ['playlist-pages0', () => getPages('playlist0', p => `${SUNO_API}/api/playlist/${workspaceId}?page=${p}&page_size=50`, 0)],
          ['playlist-clips', () => getPages('playlist/clips', p => `${SUNO_API}/api/playlist/${workspaceId}/clips?page=${p}&page_size=50`, 1)],
        ];
        tier2 = [
          ['feed/v3-page-playlist', () => feedV3Pages('feed/v3-page-pl', PL_FILTER)],
          ['feed/v3-cursor-playlist', () => feedV3Cursor('feed/v3-cursor-pl', PL_FILTER)],
        ];
      } else {
        const projFilters = [
          { disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'True', projectId: workspaceId } },
          { disliked: 'False', trashed: 'False', project: { presence: 'True', projectId: workspaceId } },
        ];
        tier1 = [
          ['project-bulk', () => getOnce('project-bulk', `${SUNO_API}/api/project/${workspaceId}`)],
          ['project-clips', () => getPages('project/clips', p => `${SUNO_API}/api/project/${workspaceId}/clips?page=${p}&page_size=50`, 1)],
        ];
        tier2 = [
          ['feed/v3-page-project', () => feedV3Pages('feed/v3-page-pr', projFilters[0])],
          ['feed/v3-page-project2', () => feedV3Pages('feed/v3-page-pr2', projFilters[1])],
          ['feed/v3-cursor-project', () => feedV3Cursor('feed/v3-cursor-pr', projFilters[0])],
        ];
      }

      async function runTier(strategies) {
        let best = []; let via = null;
        for (const [label, fn] of strategies) {
          const got = await fn();
          attempts.push(`== ${label}: ${got.length} lagu`);
          if (got.length > best.length) { best = got; via = label; }
          if (expected && best.length >= expected) break;
        }
        return { best, via };
      }
      const t1 = await runTier(tier1);
      let best = t1.best; let via = t1.via;
      if (!(expected && best.length >= expected) && best.length < MAX_SONGS) {
        const t2 = await runTier(tier2);
        const feedWins = best.length === 0 || (expected && t2.best.length >= expected && t2.best.length > best.length);
        if (feedWins && t2.best.length) { best = t2.best; via = t2.via; }
      }
      debug = attempts;
      entry = { at: Date.now(), clips: best, via };
      if (best.length) cache.set(cacheKey, entry);
    }

    const all = entry.clips || [];
    if (!all.length) {
      res.status(200).json({ clips: [], page: 0, totalPages: 1, total: 0, expected, debug, message: 'Semua endpoint Suno balas kosong buat pilihan ini. Detail: ' + debug.join(' | ') });
      return;
    }
    const totalPages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
    const page = Math.min(wantPage, totalPages - 1);
    const slice = all.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
    res.status(200).json({ clips: slice, page, totalPages, total: all.length, expected, via: entry.via, debug });
  } catch (e) {
    res.status(502).json({ error: `Gagal: ${e.message}` });
  }
}
