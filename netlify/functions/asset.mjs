// GET /api/asset?url=<https url>
// Streams an image from an allow-listed host so the browser can put it in the ZIP
// (most image CDNs do not send CORS headers). Not an open proxy.
import { fail, passcodeOk, timedFetch } from '../lib/common.mjs';

const ALLOWED_HOSTS = new Set([
  'upload.wikimedia.org',
  'tile.loc.gov',
  'www.loc.gov',
  'images.pexels.com',
  'cdn.pixabay.com',
  'pixabay.com',
]);

// Netlify's synchronous response limit is 6 MB; stay under it.
const MAX_BYTES = 4.5 * 1024 * 1024;

export default async (req) => {
  if (req.method !== 'GET') return fail('Use GET', 405);
  if (!passcodeOk(req)) return fail('Wrong or missing passcode', 401);

  const raw = new URL(req.url).searchParams.get('url');
  let target;
  try {
    target = new URL(raw);
  } catch {
    return fail('Invalid url');
  }
  if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
    return fail('Host not allowed', 403);
  }

  let upstream;
  try {
    upstream = await timedFetch(target.href, { redirect: 'follow' }, 15000);
  } catch (e) {
    return fail(e?.name === 'AbortError' ? 'Upstream timed out' : 'Upstream fetch failed', 502);
  }
  if (!upstream.ok) return fail(`Upstream HTTP ${upstream.status}`, 502);

  // A redirect must not lead somewhere outside the allow-list.
  try {
    if (upstream.url && !ALLOWED_HOSTS.has(new URL(upstream.url).hostname)) return fail('Redirect not allowed', 403);
  } catch {
    return fail('Bad upstream url', 502);
  }

  const type = upstream.headers.get('content-type') || '';
  if (!/^image\//i.test(type)) return fail('Not an image', 415);
  const declared = Number(upstream.headers.get('content-length') || 0);
  if (declared > MAX_BYTES) return fail('Image too large to bundle', 413);

  const buf = await upstream.arrayBuffer();
  if (buf.byteLength > MAX_BYTES) return fail('Image too large to bundle', 413);

  return new Response(buf, {
    status: 200,
    headers: { 'content-type': type, 'cache-control': 'private, max-age=3600' },
  });
};

export const config = { path: '/api/asset' };
