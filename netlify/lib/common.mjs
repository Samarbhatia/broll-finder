// Shared helpers for all Netlify Functions.
import { createHash, timingSafeEqual } from 'node:crypto';

export const UA = 'BrollFinder/1.0 (personal research tool)';

export function env(name) {
  const fromNetlify = globalThis.Netlify?.env?.get?.(name);
  return fromNetlify ?? process.env[name] ?? '';
}

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function fail(message, status = 400) {
  return json({ error: message }, status);
}

function safeEqual(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

// If APP_PASSCODE is set, every request must send it in the x-passcode header.
// This keeps strangers from spending your Groq/Pexels/Pixabay quota.
export function passcodeOk(req) {
  const needed = env('APP_PASSCODE');
  if (!needed) return true;
  return safeEqual(req.headers.get('x-passcode') || '', needed);
}

// Bring-your-own-key: the visitor's key arrives in a request header (never in a URL,
// never stored or logged). If the site owner set an environment variable, that is
// used only when the visitor sent nothing.
const KEY_HEADERS = { groq: 'x-groq-key', pexels: 'x-pexels-key', pixabay: 'x-pixabay-key' };
const KEY_ENV = { groq: 'GROQ_API_KEY', pexels: 'PEXELS_API_KEY', pixabay: 'PIXABAY_API_KEY' };

export function getKey(req, name) {
  const sent = (req.headers.get(KEY_HEADERS[name]) || '').trim();
  // Keys are short ASCII tokens; refuse anything else instead of forwarding it.
  if (sent && sent.length <= 200 && /^[\x21-\x7e]+$/.test(sent)) return sent;
  return env(KEY_ENV[name]);
}

export async function timedFetch(url, opts = {}, ms = 7000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, {
      ...opts,
      signal: ctl.signal,
      headers: { 'user-agent': UA, ...(opts.headers || {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

const ENTITIES = { '&amp;': '&', '&quot;': '"', '&#39;': "'", '&#039;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ' };

// Remove HTML tags and decode a few entities. Output is plain text and is only
// ever rendered with textContent on the client.
export function stripTags(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|quot|#0?39|lt|gt|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export function shortHash(str) {
  return createHash('sha1').update(String(str)).digest('hex').slice(0, 12);
}

export function cleanQueries(list, max, maxLen = 160) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const q of list) {
    if (typeof q !== 'string') continue;
    const t = q.replace(/\s+/g, ' ').trim().slice(0, maxLen);
    if (t.length < 2 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}
