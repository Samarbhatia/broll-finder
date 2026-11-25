import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// lib.js is a browser script, so load it the way a browser does.
const sandbox = { TextEncoder, self: {} };
vm.runInNewContext(readFileSync(new URL('../public/lib.js', import.meta.url), 'utf8'), sandbox);
const L = sandbox.self.BrollLib;
let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log('ok  ', name); };

// ---- fetch stub
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, headers: opts.headers || {}, body: opts.body });
  const j = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
  if (u.includes('api.groq.com')) {
    return j({ choices: [{ message: { content: JSON.stringify({ title: 'Quebec Bridge', scenes: [
      { title: 'Intro', description: 'd', start: 'The Quebec Bridge was meant', archive_queries: ['Quebec Bridge 1907', 'Quebec Bridge'], stock_queries: ['steel bridge'] },
      { title: 'Collapse', description: 'd', start: 'On August 29 1907', archive_queries: ['Quebec Bridge collapse'], stock_queries: [] } ] }) } }] });
  }
  if (u.includes('commons.wikimedia.org')) {
    return j({ query: { pages: [{ pageid: 1, title: 'File:Qb.jpg', imageinfo: [{ mime: 'image/jpeg', thumburl: 'https://upload.wikimedia.org/t.jpg', url: 'https://upload.wikimedia.org/o.jpg', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Qb.jpg', extmetadata: { LicenseShortName: { value: 'Public domain' }, ImageDescription: { value: 'The Quebec Bridge in 1907' }, Artist: { value: '<a href="x">Someone</a>' } } }] }] } });
  }
  if (u.includes('loc.gov')) return j({ results: [] });
  if (u.includes('api.pexels.com')) {
    assert.equal(opts.headers.Authorization, 'PEXELSKEY');
    return j({ photos: [{ id: 5, alt: 'bridge', photographer: 'P', url: 'https://www.pexels.com/photo/5', src: { medium: 'https://images.pexels.com/m.jpg', large2x: 'https://images.pexels.com/l.jpg' } }] });
  }
  if (u.includes('pixabay.com/api')) {
    assert.ok(u.includes('key=PIXKEY'));
    return j({ hits: [{ id: 9, tags: 'bridge', user: 'U', pageURL: 'https://pixabay.com/p/9', webformatURL: 'https://pixabay.com/w.jpg', largeImageURL: 'https://pixabay.com/l.jpg' }] });
  }
  if (u.startsWith('https://upload.wikimedia.org/')) return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/jpeg' } });
  return j({ error: 'unexpected ' + u }, 500);
};

const plan = (await import('../netlify/functions/plan.mjs')).default;
const search = (await import('../netlify/functions/search.mjs')).default;
const asset = (await import('../netlify/functions/asset.mjs')).default;
const { getKey } = await import('../netlify/lib/common.mjs');

const post = (path, body, headers = {}) => new Request('http://x' + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const script = 'The Quebec Bridge was meant to be the longest cantilever bridge in the world. '.repeat(5);

await t('getKey prefers header, falls back to env, rejects junk', () => {
  process.env.PEXELS_API_KEY = 'ENVKEY';
  assert.equal(getKey(new Request('http://x', { headers: { 'x-pexels-key': 'abc123' } }), 'pexels'), 'abc123');
  assert.equal(getKey(new Request('http://x'), 'pexels'), 'ENVKEY');
  assert.equal(getKey(new Request('http://x', { headers: { 'x-pexels-key': 'a b' } }), 'pexels'), 'ENVKEY');
  delete process.env.PEXELS_API_KEY;
  assert.equal(getKey(new Request('http://x'), 'pexels'), '');
});

await t('plan: no Groq key gives a friendly 400', async () => {
  const r = await plan(post('/api/plan', { mode: 'script', script }));
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /Groq/);
});

await t('plan: uses the visitor key and returns scenes', async () => {
  calls.length = 0;
  const r = await plan(post('/api/plan', { mode: 'script', script }, { 'x-groq-key': 'gsk_test' }));
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.scenes.length, 2);
  assert.equal(d.scenes[0].archiveQueries.length, 2);
  assert.equal(calls[0].headers.authorization, 'Bearer gsk_test');
});

await t('search: no stock keys means Pexels/Pixabay are skipped silently', async () => {
  calls.length = 0;
  const r = await search(post('/api/search', { queries: ['Quebec Bridge'], stockQueries: ['bridge'] }));
  const d = await r.json();
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].status, 'ok');
  assert.equal(d.items[0].author, 'Someone');
  assert.ok(!calls.some((c) => c.url.includes('pexels') || c.url.includes('pixabay')));
});

await t('search: visitor Pexels and Pixabay keys are used', async () => {
  const r = await search(post('/api/search', { queries: ['Quebec Bridge'], stockQueries: ['bridge'] }, { 'x-pexels-key': 'PEXELSKEY', 'x-pixabay-key': 'PIXKEY' }));
  const d = await r.json();
  assert.deepEqual(d.items.map((i) => i.source).sort(), ['Pexels', 'Pixabay', 'Wikimedia Commons']);
  assert.deepEqual(d.errors, []);
});

await t('search: keys never appear in the response body', async () => {
  const r = await search(post('/api/search', { queries: ['Quebec Bridge'], stockQueries: ['bridge'] }, { 'x-pexels-key': 'PEXELSKEY', 'x-pixabay-key': 'PIXKEY' }));
  const s = await r.text();
  assert.ok(!s.includes('PEXELSKEY') && !s.includes('PIXKEY'));
});

await t('asset: allow-listed host works, others refused', async () => {
  const ok = await asset(new Request('http://x/api/asset?url=' + encodeURIComponent('https://upload.wikimedia.org/o.jpg')));
  assert.equal(ok.status, 200);
  assert.equal((await ok.arrayBuffer()).byteLength, 3);
  const bad = await asset(new Request('http://x/api/asset?url=' + encodeURIComponent('https://evil.example/o.jpg')));
  assert.ok(bad.status >= 400);
  const internal = await asset(new Request('http://x/api/asset?url=' + encodeURIComponent('http://169.254.169.254/')));
  assert.ok(internal.status >= 400);
});

await t('passcode is enforced when set', async () => {
  process.env.APP_PASSCODE = 'secret';
  assert.equal((await search(post('/api/search', { queries: ['a b'] }))).status, 401);
  assert.equal((await search(post('/api/search', { queries: ['a b'] }, { 'x-passcode': 'secret' }))).status, 200);
  delete process.env.APP_PASSCODE;
});

await t('lib: splitScenes aligns on scene starts', () => {
  const text = 'Alpha beta gamma delta one. Epsilon zeta eta theta two. Iota kappa lambda mu three.';
  const r = L.splitScenes(text, [{ start: 'Alpha beta gamma delta' }, { start: 'Epsilon zeta eta theta' }, { start: 'Iota kappa lambda mu' }]);
  assert.equal(r.aligned, true);
  assert.equal(r.parts[1], 'Epsilon zeta eta theta two.');
  const f = L.splitScenes(text, [{ start: 'nope' }, { start: 'nada' }]);
  assert.equal(f.aligned, false);
  assert.equal(f.parts.length, 2);
});

await t('coverage: off-topic Commons hits are dropped', async () => {
  const { coverage } = await import('../netlify/lib/sources.mjs');
  assert.ok(coverage('Quebec Bridge collapse 1907', 'Quebec Bridge after the collapse 1907') >= 0.6);
  assert.ok(coverage('Quebec Bridge', 'Quebec-00769 - Nicolet Sector lighthouse') < 0.6);
  assert.ok(coverage('Quebec Bridge', 'Howrah Bridge - Calcutta') < 0.6);
});

await t('commons: retries once after HTTP 429', async () => {
  const real = globalThis.fetch; let n = 0;
  globalThis.fetch = async (u, o) => (String(u).includes('commons.wikimedia.org') && n++ === 0 ? new Response('', { status: 429, headers: { 'retry-after': '0' } }) : real(u, o));
  const { searchCommons } = await import('../netlify/lib/sources.mjs');
  const r = await searchCommons('Quebec Bridge');
  globalThis.fetch = real;
  assert.equal(r.length, 1);
});

await t('lib: estimateImages and slug', () => {
  assert.equal(L.estimateImages(1500), 110); // 10 min at 150 wpm, 5.5 s each
  assert.equal(L.slug('Québec Bridge, 1907!'), 'quebec-bridge-1907');
});

await t('lib: ZIP is valid (unzip -t) with unicode names and exact bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'zt-'));
  const img = new Uint8Array(70000).map((_, i) => (i * 31) & 255);
  const bytes = L.buildZip([
    { name: 'scene-01-intro/01-pont-québec.jpg', data: img },
    { name: 'credits.txt', data: 'héllo' },
  ]);
  const p = join(dir, 't.zip');
  writeFileSync(p, bytes);
  const out = execFileSync('unzip', ['-t', p]).toString();
  assert.match(out, /No errors detected/);
  const back = execFileSync('unzip', ['-p', p, 'credits.txt']).toString();
  assert.equal(back, 'héllo');
});

console.log(`\n${pass} tests passed`);
