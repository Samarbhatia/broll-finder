// POST /api/search
// Body: { queries: string[], stockQueries?: string[],
//         sources?: { commons, loc, pexels, pixabay }, photos?: bool, videos?: bool }
// Returns: { items: [...], errors: [{ source, message }] }
import { json, fail, passcodeOk, cleanQueries, getKey } from '../lib/common.mjs';
import { searchCommons, searchLoc, searchPexels, searchPixabay } from '../lib/sources.mjs';

export default async (req) => {
  if (req.method !== 'POST') return fail('Use POST', 405);
  if (!passcodeOk(req)) return fail('Wrong or missing passcode', 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return fail('Body must be JSON');
  }

  const queries = cleanQueries(body.queries, 6);
  const stockQueries = cleanQueries(body.stockQueries?.length ? body.stockQueries : body.queries, 3);
  if (!queries.length) return fail('Give at least one search query');

  const want = { commons: true, loc: true, pexels: true, pixabay: true, ...(body.sources || {}) };
  const photos = body.photos !== false;
  const videos = body.videos === true;

  const pexelsKey = getKey(req, 'pexels');
  const pixabayKey = getKey(req, 'pixabay');

  const jobs = [];
  const add = (source, promise) => jobs.push(promise.then((items) => ({ source, items })).catch((e) => ({ source, error: e?.name === 'AbortError' ? 'timed out' : e.message })));

  for (const q of queries) {
    if (photos && want.commons) add('Wikimedia Commons', searchCommons(q, 4));
    if (photos && want.loc) add('Library of Congress', searchLoc(q, 3));
  }
  for (const q of stockQueries) {
    if (want.pexels && pexelsKey) add('Pexels', searchPexels(q, { photos, videos, key: pexelsKey }, 2));
    if (want.pixabay && pixabayKey) add('Pixabay', searchPixabay(q, { photos, videos, key: pixabayKey }, 2));
  }

  const results = await Promise.all(jobs);

  const seen = new Set();
  const seenUrls = new Set();
  const items = [];
  for (const r of results) {
    for (const it of r.items || []) {
      if (seen.has(it.id) || seenUrls.has(it.download)) continue;
      seen.add(it.id);
      seenUrls.add(it.download);
      items.push(it);
    }
  }

  // Report each failing source once (not once per query).
  const errors = [];
  const reported = new Set();
  for (const r of results) {
    if (r.error && !reported.has(r.source)) {
      reported.add(r.source);
      errors.push({ source: r.source, message: r.error });
    }
  }

  return json({ items, errors });
};

export const config = { path: '/api/search' };
