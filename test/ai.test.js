import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGemini, normalizeAi, RateLimiter, buildPrompt, systemInstruction } from '../src/ai.js';

const lead = {
  company: 'Ledgerly',
  signals: [{ label: 'Raised pre-seed/seed' }],
  amount: { display: '$4.5M' },
  round: 'Seed',
  role: '',
  articles: [{ title: 'Ledgerly raises $4.5M seed', source: 'Wire', published: '2026-11-02T00:00:00Z', summary: 'Austin fintech.' }],
};

const answer = (obj) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }] });
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const noWait = { sleepImpl: async () => {}, limiter: new RateLimiter(0) };

test('sends a schema-constrained request with the key in a header', async () => {
  let seen;
  const fetchImpl = async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return json(200, answer({ is_lead: true, company: 'Ledgerly', icp_fit: 12, confidence: 2, signal_type: 'funding', likely_needs: ['a', 'b', 'c', 'd'] }));
  };
  const g = createGemini({ apiKey: 'k123', model: 'gemini-test', fetchImpl, ...noWait });
  const r = await g.enrich(lead, { offer: 'RevOps automation' });
  assert.match(seen.url, /models\/gemini-test:generateContent$/);
  assert.equal(seen.init.headers['x-goog-api-key'], 'k123');
  assert.doesNotMatch(seen.url, /k123/);
  assert.equal(seen.body.generationConfig.responseMimeType, 'application/json');
  assert.ok(seen.body.generationConfig.responseSchema.properties.outreach_angle);
  assert.match(seen.body.systemInstruction.parts[0].text, /RevOps automation/);
  assert.match(seen.body.contents[0].parts[0].text, /HEADLINE: Ledgerly raises/);
  assert.equal(r.icp_fit, 10, 'clamped');
  assert.equal(r.confidence, 1, 'clamped');
  assert.equal(r.likely_needs.length, 3);
});

test('retries 429 using the retry delay Gemini asks for', async () => {
  const waits = [];
  let n = 0;
  const fetchImpl = async () =>
    ++n === 1
      ? json(429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'slow down', details: [{ retryDelay: '7s' }] } })
      : json(200, answer({ is_lead: true, company: 'X', icp_fit: 5, confidence: 0.5 }));
  const g = createGemini({ apiKey: 'k', fetchImpl, sleepImpl: async (ms) => waits.push(ms), limiter: new RateLimiter(0) });
  await g.enrich(lead);
  assert.equal(n, 2);
  assert.deepEqual(waits, [7500]);
});

test('daily quota fails fast with a clear message', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return json(429, { error: { code: 429, message: 'quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } });
  };
  const g = createGemini({ apiKey: 'k', fetchImpl, ...noWait });
  await assert.rejects(g.enrich(lead), (err) => err.daily && /daily quota/.test(err.message));
  assert.equal(n, 1);
});

test('400 errors are not retried; invalid JSON is', async () => {
  let n = 0;
  const bad = createGemini({ apiKey: 'k', fetchImpl: async () => (n++, json(400, { error: { code: 400, status: 'INVALID_ARGUMENT', message: 'API key not valid' } })), ...noWait });
  await assert.rejects(bad.enrich(lead), /400 INVALID_ARGUMENT: API key not valid/);
  assert.equal(n, 1);

  let m = 0;
  const flaky = createGemini({
    apiKey: 'k',
    fetchImpl: async () => (++m === 1 ? json(200, { candidates: [{ content: { parts: [{ text: 'not json' }] } }] }) : json(200, answer({ company: 'Y' }))),
    ...noWait,
  });
  assert.equal((await flaky.enrich(lead)).company, 'Y');
});

test('switches to the fallback model when the main one is overloaded or out of quota', async () => {
  const urls = [];
  const switched = [];
  const fetchImpl = async (url) => {
    urls.push(url);
    return /main:/.test(url)
      ? json(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'high demand' } })
      : json(200, answer({ company: 'Z' }));
  };
  const g = createGemini({ apiKey: 'k', model: 'main', fallbackModel: 'lite', retries: 1, fetchImpl, onFallback: (a, b) => switched.push([a, b]), ...noWait });
  assert.equal((await g.enrich(lead)).company, 'Z');
  assert.equal(g.model, 'lite');
  assert.deepEqual(switched, [['main', 'lite']]);
  assert.equal(urls.filter((u) => /main:/.test(u)).length, 2, 'retried the main model first');
  await g.enrich(lead);
  assert.ok(/lite:/.test(urls.at(-1)), 'stays on the fallback');
});

test('requires an API key', () => {
  assert.throws(() => createGemini({ apiKey: '' }), /GEMINI_API_KEY is not set/);
});

test('normalizeAi fills defaults', () => {
  const r = normalizeAi({ is_lead: false, signal_type: 'weird', icp_fit: 'x' });
  assert.equal(r.is_lead, false);
  assert.equal(r.signal_type, 'other');
  assert.equal(r.icp_fit, 5);
  assert.deepEqual(r.investors, []);
});

test('prompt contains the hints and the seller context', () => {
  assert.match(buildPrompt(lead), /company="Ledgerly".*amount=\$4\.5M.*round=Seed/);
  assert.match(systemInstruction({ offer: '', icp: '' }), /not given/);
});

test('rate limiter spaces calls', async () => {
  let t = 0;
  const waits = [];
  const rl = new RateLimiter(60, { nowImpl: () => t, sleepImpl: async (ms) => waits.push(ms) });
  await rl.acquire();
  await rl.acquire();
  await rl.acquire();
  assert.deepEqual(waits, [1000, 2000]);
});
