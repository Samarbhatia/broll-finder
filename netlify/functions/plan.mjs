// POST /api/plan
// Body: { mode: 'script' | 'topic', script?: string, topic?: string, duration?: number }
// Returns: { title, scenes: [{ title, description, start, archiveQueries, stockQueries }] }
//
// The model only breaks a script into scenes and proposes search queries.
// It never writes the narration: write and fact-check that yourself.
import { env, json, fail, passcodeOk, timedFetch, cleanQueries, getKey } from '../lib/common.mjs';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

const SYSTEM =
  'You help a documentary YouTuber find still images (archive photographs, maps, plans, documents, ' +
  'newspaper pages) to illustrate a narrated video. Reply with a single JSON object and nothing else.';

const QUERY_RULES =
  'archive_queries: 4 to 6 per scene. Short (2 to 6 words), written the way you would search Wikimedia ' +
  'Commons or the Library of Congress: proper nouns, place names, years, names of structures, objects, ' +
  'ships, companies or people, plus the kind of image (photograph, plan, map, newspaper). ' +
  'Never use generic phrases such as "workers looking sad" or "engineer at desk". ' +
  'stock_queries: 1 or 2 per scene, generic visual ideas for a stock-photo site (for example "steel bridge girders", "river fog at dawn").';

function scriptPrompt(script) {
  return (
    `Here is my narration script:\n\n"""\n${script}\n"""\n\n` +
    'Split it, in order, into 6 to 12 scenes that follow its natural sections. For each scene return:\n' +
    '- title: short scene title\n' +
    '- description: one sentence on what the narration covers\n' +
    '- start: the first 8 words of that scene copied EXACTLY from the script\n' +
    `- ${QUERY_RULES}\n\n` +
    'Do not rewrite or correct the script. Return JSON:\n' +
    '{"title":"video title","scenes":[{"title":"","description":"","start":"","archive_queries":[""],"stock_queries":[""]}]}'
  );
}

function topicPrompt(topic, duration) {
  return (
    `I am planning a ${duration}-minute documentary YouTube video about: "${topic}".\n\n` +
    'Give me an OUTLINE of 6 to 10 scenes (not a script). Do not state specific dates, numbers or names ' +
    'unless they are very well documented; keep descriptions as things to research. For each scene return:\n' +
    '- title: short scene title\n' +
    '- description: one sentence on what to cover and which question to research\n' +
    `- ${QUERY_RULES}\n\n` +
    'Return JSON:\n' +
    '{"title":"video title","scenes":[{"title":"","description":"","archive_queries":[""],"stock_queries":[""]}]}'
  );
}

function extractJson(text) {
  const t = String(text || '').replace(/```json|```/gi, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a === -1 || b <= a) throw new Error('Model did not return JSON');
  return JSON.parse(t.slice(a, b + 1));
}

const str = (v, max) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');

function normalizePlan(raw, fallbackTitle) {
  const scenes = (Array.isArray(raw?.scenes) ? raw.scenes : [])
    .map((s, i) => ({
      title: str(s?.title, 90) || `Scene ${i + 1}`,
      description: str(s?.description, 300),
      start: str(s?.start, 200),
      archiveQueries: cleanQueries(s?.archive_queries ?? s?.queries, 6),
      stockQueries: cleanQueries(s?.stock_queries, 2),
    }))
    .filter((s) => s.archiveQueries.length || s.stockQueries.length)
    .slice(0, 14);
  if (!scenes.length) throw new Error('Model returned no usable scenes');
  return { title: str(raw?.title, 120) || fallbackTitle, scenes };
}

async function callGroq(messages, key) {
  if (!key) throw Object.assign(new Error('Add your Groq API key in the API keys box first'), { status: 400 });
  const model = env('GROQ_MODEL') || 'openai/gpt-oss-120b';

  // Try the richest request first; fall back if the model rejects an option.
  const attempts = [
    { response_format: { type: 'json_object' }, reasoning_effort: 'low' },
    { response_format: { type: 'json_object' } },
    {},
  ];
  let lastErr = 'Groq request failed';
  for (const extra of attempts) {
    const res = await timedFetch(
      GROQ_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0.3, max_completion_tokens: 3000, messages, ...extra }),
      },
      25000,
    );
    if (res.ok) {
      const data = await res.json();
      return data?.choices?.[0]?.message?.content || '';
    }
    let detail = '';
    try {
      detail = (await res.json())?.error?.message || '';
    } catch {}
    lastErr = `Groq HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
    if (res.status !== 400) break; // only retry when the request options were rejected
  }
  throw new Error(lastErr);
}

export default async (req) => {
  if (req.method !== 'POST') return fail('Use POST', 405);
  if (!passcodeOk(req)) return fail('Wrong or missing passcode', 401);

  let body;
  try {
    body = await req.json();
  } catch {
    return fail('Body must be JSON');
  }

  let prompt;
  let fallbackTitle;
  if (body.mode === 'script') {
    const script = String(body.script || '').trim();
    if (script.length < 200) return fail('Paste a longer script (at least a few paragraphs)');
    if (script.length > 20000) return fail('Script is too long (limit 20,000 characters)');
    prompt = scriptPrompt(script);
    fallbackTitle = 'My video';
  } else if (body.mode === 'topic') {
    const topic = String(body.topic || '').trim().slice(0, 300);
    if (topic.length < 3) return fail('Enter a topic');
    const duration = Math.min(30, Math.max(3, Number(body.duration) || 10));
    prompt = topicPrompt(topic, duration);
    fallbackTitle = topic;
  } else {
    return fail("mode must be 'script' or 'topic'");
  }

  try {
    const text = await callGroq(
      [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: prompt },
      ],
      getKey(req, 'groq'),
    );
    return json(normalizePlan(extractJson(text), fallbackTitle));
  } catch (e) {
    const status = e.status || (e?.name === 'AbortError' ? 504 : 502);
    return fail(e?.name === 'AbortError' ? 'The AI request timed out. Try again.' : e.message, status);
  }
};

export const config = { path: '/api/plan' };
