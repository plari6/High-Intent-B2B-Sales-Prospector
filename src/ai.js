/**
 * Gemini enrichment over plain REST (no SDK), so tests can inject fetch.
 * Turns a flagged headline into a structured lead: company, round, why now,
 * likely pains and a first-line outreach angle, plus a 0-10 fit score
 * against what you sell (SENDER_OFFER) and who you sell to (TARGET_ICP).
 */

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SIGNAL_TYPES = ['funding', 'leadership', 'hiring', 'expansion', 'launch', 'mna', 'other', 'none'];

export const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    is_lead: { type: 'BOOLEAN', description: 'true if ONE identifiable operating company shows a buying signal' },
    company: { type: 'STRING', description: 'The company with the buying signal (not the investor, not the publisher)' },
    company_website: { type: 'STRING', description: 'Only if the text states it, else empty' },
    industry: { type: 'STRING' },
    location: { type: 'STRING', description: 'City/country if stated, else empty' },
    signal_type: { type: 'STRING', enum: SIGNAL_TYPES },
    funding_round: { type: 'STRING', description: 'e.g. Seed, Series A; empty if none' },
    amount: { type: 'STRING', description: 'e.g. $12M; empty if none' },
    investors: { type: 'ARRAY', items: { type: 'STRING' } },
    person_name: { type: 'STRING', description: 'New executive or founder named, else empty' },
    person_role: { type: 'STRING' },
    summary: { type: 'STRING', description: 'One plain sentence: what happened' },
    why_now: { type: 'STRING', description: 'Why this company is likely to buy in the next 90 days' },
    likely_needs: { type: 'ARRAY', items: { type: 'STRING' }, description: 'Max 3 short needs' },
    outreach_angle: { type: 'STRING', description: 'One-sentence opener referencing the news, no pitch, no greeting' },
    icp_fit: { type: 'INTEGER', description: '0-10 fit with the seller offer and ICP' },
    confidence: { type: 'NUMBER', description: '0-1 confidence in the extraction' },
  },
  required: ['is_lead', 'company', 'signal_type', 'summary', 'why_now', 'likely_needs', 'outreach_angle', 'icp_fit', 'confidence'],
  propertyOrdering: [
    'is_lead', 'company', 'company_website', 'industry', 'location', 'signal_type', 'funding_round', 'amount',
    'investors', 'person_name', 'person_role', 'summary', 'why_now', 'likely_needs', 'outreach_angle', 'icp_fit', 'confidence',
  ],
};

export function systemInstruction({ offer, icp }) {
  return `You are a B2B sales research analyst. You read one tech news item and decide whether it shows a company that is likely to buy products or services soon (a "buying signal": fresh funding, a new executive, a hiring push, expansion, a launch, an acquisition).

Rules:
- The lead is the OPERATING COMPANY with the signal. Never the investor, VC fund, publisher or a person.
- is_lead = false for: VC funds raising their own fund, market reports or roundups covering many companies, opinion pieces, layoffs or shutdowns, and news with no identifiable company.
- Use ONLY facts in the text. Never invent websites, amounts, investors or names. Leave a field empty when unknown.
- why_now: one sentence on the business reason they will spend money now.
- likely_needs: up to 3 short, concrete needs that follow from the signal.
- outreach_angle: one natural sentence (max 30 words) a rep could open a cold email to the company's leader with. Speak to them directly ("you", "your team"), never about them in the third person. Reference one specific fact from the news, then the challenge it creates. No greeting, no pitch, no hype. Do not start with "I", "Noticed", "Noticing", "Saw", "Congrats" or "Congratulations".
- icp_fit (0-10): how well this company fits the seller below. 8-10 = clear fit and timing, 5-7 = plausible, 0-4 = poor fit (e.g. a mega-corporation for a small agency, or an unrelated industry).

SELLER OFFER: ${offer || '(not given: score fit for a B2B services/automation agency selling to startups and scale-ups)'}
TARGET ICP: ${icp || '(not given: venture-backed startups and SMBs, 5-500 employees)'}`;
}

export function buildPrompt(lead) {
  const a = lead.articles[0];
  const lines = [
    `HEADLINE: ${a.title}`,
    `SOURCE: ${a.source}${a.published ? ` (${a.published.slice(0, 10)})` : ''}`,
    `TEXT: ${(a.summary || '').slice(0, 1200) || '(no summary)'}`,
  ];
  for (const extra of lead.articles.slice(1, 3)) lines.push(`OTHER HEADLINE ABOUT IT: ${extra.title}`);
  lines.push(
    '',
    `RULE-BASED HINTS (may be wrong): company="${lead.company || '?'}", signals=${lead.signals.map((s) => s.label).join(', ')}${lead.amount ? `, amount=${lead.amount.display}` : ''}${lead.round ? `, round=${lead.round}` : ''}${lead.role ? `, role=${lead.role}` : ''}`,
  );
  return lines.join('\n');
}

/** Spaces requests to stay under the per-minute quota; shared by all workers. */
export class RateLimiter {
  constructor(rpm, { sleepImpl = sleep, nowImpl = Date.now } = {}) {
    this.interval = rpm > 0 ? 60000 / rpm : 0;
    this.next = 0;
    this.sleep = sleepImpl;
    this.now = nowImpl;
  }

  async acquire() {
    if (!this.interval) return;
    const now = this.now();
    const at = Math.max(now, this.next);
    this.next = at + this.interval;
    if (at > now) await this.sleep(at - now);
  }

  pauseFor(ms) {
    this.next = Math.max(this.next, this.now() + ms);
  }
}

export class GeminiError extends Error {
  constructor(message, { status, retryable = false, daily = false, retryDelayMs = 0 } = {}) {
    super(message);
    this.name = 'GeminiError';
    Object.assign(this, { status, retryable, daily, retryDelayMs });
  }
}

export function createGemini({
  apiKey,
  model = 'gemini-flash-latest',
  fallbackModel = '',
  timeoutMs = 60000,
  rpm = 14,
  retries = 3,
  fetchImpl = fetch,
  sleepImpl = sleep,
  limiter = new RateLimiter(rpm, { sleepImpl }),
  onFallback = () => {},
} = {}) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set. Add it to .env or run with --no-ai.');
  let current = model;

  async function generate(body) {
    for (let attempt = 0; ; attempt++) {
      await limiter.acquire();
      const used = current;
      try {
        return await call(body, used);
      } catch (err) {
        if (used !== current) {
          attempt = -1; // another request already switched to the fallback model: retry on it
          continue;
        }
        // Quotas and overload are per model: switch to the fallback model once, for the rest of the run.
        const giveUp = err.daily || !err.retryable || attempt >= retries;
        if (giveUp && fallbackModel && current !== fallbackModel && (err.daily || err.status === 429 || err.status >= 500 || /timed out/.test(err.message))) {
          onFallback(current, fallbackModel, err);
          current = fallbackModel;
          api.model = current;
          attempt = -1;
          continue;
        }
        if (giveUp) throw err;
        const wait = err.retryDelayMs ? Math.min(err.retryDelayMs + 500, 65000) : 2000 * 2 ** attempt;
        limiter.pauseFor(wait);
        await sleepImpl(wait);
      }
    }
  }

  async function call(body, modelName) {
    let res;
    try {
      res = await fetchImpl(`${API}/${encodeURIComponent(modelName)}:generateContent`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new GeminiError(`Gemini network error: ${err.name === 'TimeoutError' ? 'timed out' : err.message}`, { retryable: true });
    }
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw toError(res.status, payload);
    const candidate = payload.candidates?.[0];
    const text = (candidate?.content?.parts || []).map((p) => p.text || '').join('');
    if (!text) {
      const why = candidate?.finishReason || payload.promptFeedback?.blockReason || 'empty answer';
      throw new GeminiError(`Gemini returned no text (${why})`, { retryable: why === 'empty answer' });
    }
    return parseJson(text);
  }

  const api = {
    model: current,
    async enrich(lead, { offer = '', icp = '' } = {}) {
      const result = await generate({
        systemInstruction: { parts: [{ text: systemInstruction({ offer, icp }) }] },
        contents: [{ role: 'user', parts: [{ text: buildPrompt(lead) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA },
      });
      return normalizeAi(result);
    },
    /** Tiny request used by `doctor` to prove the key and model work. */
    async ping() {
      return generate({
        contents: [{ role: 'user', parts: [{ text: 'Reply with {"ok":true}' }] }],
        generationConfig: { responseMimeType: 'application/json' },
      });
    },
  };
  return api;
}

function toError(status, payload) {
  const e = payload.error || {};
  const details = e.details || [];
  const delay = details.find((d) => d.retryDelay)?.retryDelay;
  const daily = details.flatMap((d) => d.violations || []).some((v) => /PerDay/i.test(v.quotaId || ''));
  const message = `Gemini ${status}${e.status ? ` ${e.status}` : ''}: ${e.message || 'request failed'}`;
  return new GeminiError(
    daily ? 'Gemini daily quota used up. AI answers are cached, so run again tomorrow or use --no-ai.' : message,
    { status, daily, retryable: status === 429 || status >= 500, retryDelayMs: delay ? Math.ceil(parseFloat(delay) * 1000) : 0 },
  );
}

export function parseJson(text) {
  const trimmed = String(text).trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new GeminiError('Gemini returned invalid JSON', { retryable: true });
  }
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');

/** Coerces the model answer into a predictable shape. */
export function normalizeAi(r = {}) {
  const fit = Number.parseInt(r.icp_fit, 10);
  const conf = Number(r.confidence);
  return {
    is_lead: r.is_lead !== false,
    company: str(r.company),
    company_website: str(r.company_website),
    industry: str(r.industry),
    location: str(r.location),
    signal_type: SIGNAL_TYPES.includes(r.signal_type) ? r.signal_type : 'other',
    funding_round: str(r.funding_round),
    amount: str(r.amount),
    investors: Array.isArray(r.investors) ? r.investors.map(str).filter(Boolean).slice(0, 6) : [],
    person_name: str(r.person_name),
    person_role: str(r.person_role),
    summary: str(r.summary),
    why_now: str(r.why_now),
    likely_needs: Array.isArray(r.likely_needs) ? r.likely_needs.map(str).filter(Boolean).slice(0, 3) : [],
    outreach_angle: str(r.outreach_angle),
    icp_fit: Number.isFinite(fit) ? Math.max(0, Math.min(10, fit)) : 5,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.5,
  };
}
