import { sunoHeaders, extractClips, normalizeClip, readBody, SUNO_API } from './_suno.js';

// POST { token, workspaceId, type, page, expected }
//   -> { clips, page, totalPages, total, expected, via, debug }
//
// Pagination model shown to the user: 20 songs per page, PREV/NEXT walks pages.
// Suno's own paging is inconsistent per endpoint (some ignore `page`, some are
// cursor-based, v2 playlist returns metadata only), so the server collects the
// workspace's full list by trying several paging strategies and keeping the
// most complete result, caches it briefly, then slices out the page of 20.
const PAGE_SIZE = 20;
const cache = new Map();
const CACHE_MS = 10 * 60 * 1000;

export default async function handler(req, res) {
  try {
    const body = await readBody(req);
    const { token, workspaceId, type } = body;
    const wantPage = Math.max(0, Number(body.page || 0));
    const expected = Number(body.expected || 0) || null;
    if (!token) { res.status(400).json({ error: 'Set token dulu di bagian Kantong Token.' }); return; }

    const cacheKey = `v5:${type || 'all'}:${workspaceId || 'all'}:${token.slice(-12)}`;
    let entry = cache.get(cacheKey);
    let debug = [];
    if (!entry || Date.now() - entry.at > CACHE_MS) {
      const headers = sunoHeaders(token);
      const attempts = [];
      const MAX_PAGES = 20;
      const MAX_SONGS = 800;

      async function fetchJson(url, opts = {}) {
        const r = await fetch(url, { headers, ...opts });
        const data = await r.json().catch(() => null);
        return { status: r.status, data };
      }
      function mergeInto(seen, out, clips) {
        let added = 0;
        for (const c of clips) if (c && !seen.has(c.id)) { seen.add(c.id); out.push(c); added++; }
        return added;
      }
      // Strategy: page a GET endpoint (page numbers from firstPage upward).
      async function getPages(label, buildUrl, firstPage) {
        const seen = new Set(); const out = [];
        for (let i = 0; i < MAX_PAGES; i++) {
          const p = firstPage + i;
          let status, data;
          try { ({ status, data } = await fetchJson(buildUrl(p))); }
          catch (e) { attempts.push(`${label} p${p} -> ${e.message}`); break; }
          const clips = extractClips(data).map(normalizeClip).filter(Boolean);
          const added = mergeInto(seen, out, clips);
          attempts.push(`${label} p${p} -> HTTP ${status}, ${clips.length} lagu (${added} baru)`);
          if (!added || out.length >= MAX_SONGS) break;
        }
        return out;
      }
      // Strategy: single GET, no paging params.
      async function getOnce(label, url) {
        try {
          const { status, data } = await fetchJson(url);
          const clips = extractClips(data).map(normalizeClip).filter(Boolean);
          attempts.push(`${label} -> HTTP ${status}, ${clips.length} lagu`);
          return clips;
        } catch (e) { attempts.push(`${label} -> ${e.message}`); return []; }
      }
      // Strategy: POST /api/feed/v3 paged by { page: n } body.
      async function feedV3Pages(label, filters) {
        const seen = new Set(); const out = [];
        for (let i = 0; i < MAX_PAGES; i++) {
          let status, data;
          try {
            ({ status, data } = await fetchJson(`${SUNO_API}/api/feed/v3`, {
              method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
              body: JSON.stringify({ page: i, filters }),
            }));
          } catch (e) { attempts.push(`${label} p${i} -> ${e.message}`); break; }
          const clips = extractClips(data).map(normalizeClip).filter(Boolean);
          const added = mergeInto(seen, out, clips);
          attempts.push(`${label} p${i} -> HTTP ${status}, ${clips.length} lagu (${added} baru)`);
          if (!added || (data && data.has_more === false) || out.length >= MAX_SONGS) break;
        }
        return out;
      }
      // Strategy: POST /api/feed/v3 paged by cursor.
      async function feedV3Cursor(label, filters) {
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
          const added = mergeInto(seen, out, clips);
          attempts.push(`${label} -> HTTP ${status}, ${clips.length} lagu (${added} baru)`);
          cursor = data && (data.next_cursor || data.cursor || data.nextCursor || (data.meta && data.meta.next_cursor) || (data.pagination && data.pagination.next_cursor));
          if (!added || !cursor || (data && data.has_more === false) || out.length >= MAX_SONGS) break;
        }
        return out;
      }

      const PL_FILTER = { disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'False' }, playlist: { presence: 'True', playlistId: workspaceId } };
      let strategies = [];
      if (!workspaceId || workspaceId === 'all' || type === 'all') {
        strategies = [
          ['feed/v3-page', () => feedV3Pages('feed/v3-page', { disliked: 'False', trashed: 'False' })],
          ['library', () => getPages('library', p => `${SUNO_API}/api/library?page=${p}&page_size=50`, 1)],
          ['feed/v3-cursor', () => feedV3Cursor('feed/v3-cursor', { disliked: 'False', trashed: 'False' })],
          ['feed/v2', () => getPages('feed/v2', p => `${SUNO_API}/api/feed/v2?page=${p}`, 0)],
        ];
      } else if (type === 'playlist') {
        strategies = [
          ['playlist-v1-pages', () => getPages('playlist', p => `${SUNO_API}/api/playlist/${workspaceId}?page=${p}&page_size=50`, 1)],
          ['feed/v3-page-playlist', () => feedV3Pages('feed/v3-page-pl', PL_FILTER)],
          ['playlist-v2-tracks', () => getOnce('playlist/v2-tracks', `${SUNO_API}/api/playlist/v2/${workspaceId}/tracks`)],
          ['playlist-v1-pages0', () => getPages('playlist0', p => `${SUNO_API}/api/playlist/${workspaceId}?page=${p}&page_size=50`, 0)],
          ['feed/v3-cursor-playlist', () => feedV3Cursor('feed/v3-cursor-pl', PL_FILTER)],
          ['playlist-clips', () => getPages('playlist/clips', p => `${SUNO_API}/api/playlist/${workspaceId}/clips?page=${p}&page_size=50`, 1)],
          ['playlist-noparam', () => getOnce('playlist-noparam', `${SUNO_API}/api/playlist/${workspaceId}`)],
        ];
      } else {
        const projFilters = [
          { disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'True', projectId: workspaceId } },
          { disliked: 'False', trashed: 'False', project: { presence: 'True', projectId: workspaceId } },
          { disliked: 'False', trashed: 'False', fromStudioProject: { presence: 'True', studioProjectId: workspaceId } },
        ];
        strategies = [
          ['project-get', () => getOnce('project', `${SUNO_API}/api/project/${workspaceId}`)],
          ['feed/v3-page-project', () => feedV3Pages('feed/v3-page-pr', projFilters[0])],
          ['feed/v3-page-project2', () => feedV3Pages('feed/v3-page-pr2', projFilters[1])],
          ['feed/v3-page-project3', () => feedV3Pages('feed/v3-page-pr3', projFilters[2])],
          ['project-clips', () => getPages('project/clips', p => `${SUNO_API}/api/project/${workspaceId}/clips?page=${p}&page_size=50`, 1)],
          ['feed/v3-cursor-project', () => feedV3Cursor('feed/v3-cursor-pr', projFilters[0])],
        ];
      }

      // Run strategies in order; keep the most complete list (union as backstop).
      let best = []; let via = null;
      const unionSeen = new Set(); const union = [];
      for (const [label, fn] of strategies) {
        const got = await fn();
        if (got.length > best.length) { best = got; via = label; }
        mergeInto(unionSeen, union, got);
        attempts.push(`== ${label}: ${got.length} lagu (terbaik sejauh ini: ${best.length})`);
        if (expected && best.length >= expected) break;
        if (!expected && best.length >= MAX_SONGS) break;
      }
      const clips = union.length > best.length ? union : best;
      if (union.length > best.length) via = (via || '') + '+gabungan';
      debug = attempts;
      entry = { at: Date.now(), clips, via };
      if (clips.length) cache.set(cacheKey, entry);
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
