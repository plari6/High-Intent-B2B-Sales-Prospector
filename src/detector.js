import { SIGNALS, NOISE_PATTERNS, DISTRESS_PATTERNS, ROLE } from './signals.js';

const SUMMARY_WINDOW = 600; // only the start of the summary is about the headline company
const SUMMARY_FACTOR = 0.6; // a match in the summary counts less than one in the headline
const TITLE_ONLY = new Set(['product_launch', 'acquisition', 'exec_departure']); // too noisy in body text

/**
 * Finds buying signals in one article.
 * Returns { hits: [{ id, category, label, weight, why, angle, field, phrase }], noise, distress }.
 */
export function detectSignals(article, { signals = SIGNALS } = {}) {
  const title = article.title || '';
  const summary = (article.summary || '').slice(0, SUMMARY_WINDOW);
  const hits = [];

  for (const signal of signals) {
    const fields = TITLE_ONLY.has(signal.id) ? [['title', title]] : [['title', title], ['summary', summary]];
    for (const [field, text] of fields) {
      const phrase = firstMatch(signal.patterns, text);
      if (!phrase) continue;
      hits.push({
        id: signal.id,
        category: signal.category,
        label: signal.label,
        weight: Math.round(signal.weight * (field === 'title' ? 1 : SUMMARY_FACTOR)),
        why: signal.why,
        angle: signal.angle,
        field,
        phrase: phrase.trim(),
      });
      break; // a title hit beats a summary hit for the same signal
    }
  }

  const kept = pruneOverlaps(hits);
  const cats = new Set(kept.map((h) => h.category));
  return {
    hits: kept,
    noise: NOISE_PATTERNS.some((re) => re.test(title)),
    distress: DISTRESS_PATTERNS.some((re) => re.test(title) || re.test(summary.slice(0, 300))),
    company: extractCompany(title),
    // Only report facts that belong to a detected signal ("CEO Dana said..." in a funding story is not a new CEO).
    amount: cats.has('funding') || cats.has('mna') || cats.has('keyword') ? extractAmount(title) || extractAmount(summary) : null,
    round: cats.has('funding') || cats.has('keyword') ? extractRound(title) || extractRound(summary) : '',
    role: cats.has('leadership') || cats.has('keyword') ? extractRole(title) || extractRole(summary) : '',
  };
}

function firstMatch(patterns, text) {
  if (!text) return '';
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return '';
}

/** A specific funding round makes the generic "funding" hit redundant, and so on. */
function pruneOverlaps(hits) {
  const ids = new Set(hits.map((h) => h.id));
  const specificFunding = ['funding_seed', 'funding_early', 'funding_growth'].some((id) => ids.has(id));
  // Keep only the strongest specific round (e.g. "seed" mentioned in a Series B story).
  const roundHits = hits.filter((h) => ['funding_seed', 'funding_early', 'funding_growth'].includes(h.id));
  const bestRound = roundHits.sort((a, b) => fieldRank(a) - fieldRank(b) || b.weight - a.weight)[0];
  return hits.filter((h) => {
    if (h.id === 'funding' && specificFunding) return false;
    if (roundHits.includes(h) && h !== bestRound) return false;
    if (h.id === 'product_launch' && ids.has('stealth_launch')) return false;
    if (h.id === 'exec_departure' && ids.has('exec_hire')) return false;
    if (h.id === 'hiring_spree' && ids.has('exec_hire') && /^is\s+hiring$/i.test(h.phrase)) return false; // "is hiring a new CEO"
    return true;
  });
}

const fieldRank = (h) => (h.field === 'title' ? 0 : 1);

// ---------------------------------------------------------------- extraction

const LEAD_VERBS = [
  'raises', 'raised', 'secures', 'secured', 'lands', 'landed', 'closes', 'closed', 'bags', 'nabs', 'snags', 'banks',
  'scores', 'picks up', 'collects', 'attracts', 'grabs', 'rakes in', 'pulls in', 'gets', 'receives', 'nets',
  'announces', 'completes', 'wins', 'hires', 'appoints', 'names', 'taps', 'welcomes', 'promotes', 'adds', 'brings on',
  'launches', 'unveils', 'debuts', 'introduces', 'rolls out', 'emerges', 'comes out', 'exits stealth', 'expands',
  'opens', 'enters', 'acquires', 'buys', 'is hiring', 'plans', 'to hire', 'doubles', 'kicks off', 'to acquire',
  'agrees to acquire', 'to buy', 'acquired', 'is acquired', 'gets acquired',
];
const PERSON_HINT = /\b(?:co-?founders?|founders?|partners?|investors?|ceo|cto|former|ex-|veteran|alum|alumni)\b/i;
const LEAD_RE = new RegExp(
  String.raw`^(.{2,90}?)\s+(?:has\s+|have\s+|just\s+|officially\s+|reportedly\s+)?(?:${LEAD_VERBS.map((v) => v.replace(/ /g, '\\s+')).join('|')})\b`,
  'i',
);
const NAME = String.raw`([A-Z0-9][\w&.'’+-]*(?:\s+(?:[A-Z0-9][\w&.'’+-]*|of|for|and|&)){0,4})`;
const FALLBACKS = [
  new RegExp(String.raw`\bjoins\s+${NAME}\s+as\b`),
  new RegExp(String.raw`\b(?:CEO|CTO|CFO|COO|CRO|CMO|chief\s+\w+\s+officer|president)\s+(?:of|at)\s+${NAME}`, 'i'),
  new RegExp(String.raw`\b(?:back|backs|backed|fund|funds|leads?)\s+${NAME}(?:['’]s)?\s+(?:in|with|\$|€|£|seed|series|round)`),
  new RegExp(String.raw`\bfor\s+(?:[\w-]+\s+){0,4}?(?:startup|company|firm)\s+${NAME}`),
  new RegExp(String.raw`\bfor\s+${NAME}(?:\s*$|\s+to\b|,)`),
  new RegExp(String.raw`\b(?:bet|bets|invest|invests|pour|pours)\s+.{0,30}?\bon\s+${NAME}`),
];
const DESCRIPTOR_WORDS = 'startup|start-up|company|firm|platform|provider|maker|developer|unicorn|scaleup|scale-up|specialist|player|pioneer|giant|outfit|vendor|newcomer|upstart|operator|marketplace|lab|labs|studio|spinout|spin-off';
// Case-insensitive descriptor word, but the name after it must start with a capital letter or digit.
const DESCRIPTOR = new RegExp(
  String.raw`^.*\b(?:${DESCRIPTOR_WORDS.split('|').map((w) => `[${w[0].toUpperCase()}${w[0]}]${w.slice(1)}`).join('|')})\s+(?=[A-Z0-9])`,
);
// Lowercase only: "AI chip startup" has no name, but "The Browser Company" and "Black Forest Labs" are names.
const DESCRIPTOR_END = new RegExp(String.raw`\b(?:${DESCRIPTOR_WORDS})$`);
const STOP =/^(?:the|a|an|this|that|these|how|why|what|who|when|startup|startups|company|companies|investors?|vcs?|report|it|they|he|she|we|our|its|new|exclusive|funding|ai|tech|fintech|here|one|two|three|former|ex)$/i;

/** Best-effort company name from a headline. Returns '' when unsure (Gemini fills it in later). */
export function extractCompany(title) {
  const t = String(title || '')
    .replace(/^\s*(?:exclusive|breaking|scoop|report|funding|startup\s+news|deal|deals|news|update)\s*[:|–—-]\s*/i, '')
    .replace(/^["'“‘]+/, '')
    .trim();
  // "Turning waste into products – Southampton’s Virdi raises €2.6M": try the part that holds the verb.
  const segments = t.split(/\s[–—|]\s|:\s|[?!]\s/).reverse();
  for (const segment of segments) {
    const lead = segment.match(LEAD_RE);
    if (!lead) continue;
    // "In one of the biggest deals, Marvell buys X" -> last comma part first, then the first part.
    const parts = lead[1].split(/,\s/);
    for (const part of new Set([parts[parts.length - 1], parts[0]])) {
      const name = cleanCompany(part);
      if (name && !PERSON_HINT.test(name)) return name;
    }
  }
  for (const re of FALLBACKS) {
    const m = t.match(re);
    if (m) {
      const name = cleanCompany(m[1]);
      if (name) return name;
    }
  }
  return '';
}

export function cleanCompany(raw) {
  let s = String(raw || '').trim();
  if (s.includes(': ')) s = s.slice(s.lastIndexOf(': ') + 2);
  s = s.split(/,\s|\s[–—|]\s|\s\(/)[0];
  s = s.replace(/^.*\bis\s+now\s+/i, ''); // "Superset is now Paradev" -> "Paradev"
  s = s.replace(/^.*['’]s\s+(?=[A-Z0-9])/, ''); // "Egypt’s Turuq" -> "Turuq"
  s = s.replace(/^.*?-(?:based|backed|born|headquartered|focused|powered)\s+/i, '');
  s = s.replace(DESCRIPTOR, '');
  s = s.replace(/^(?:[a-z][\w-]*\s+)+(?=[A-Z0-9])/, ''); // drop leading lowercase descriptors
  s = s.replace(/^(?:AI|SaaS|B2B|Fintech|Healthtech|Insurtech|Proptech|Edtech|Climate\s+tech|Cybersecurity|Defense\s+tech)\s+(?=[A-Z0-9])/, '');
  s = s.replace(/['’]s$/, '').replace(/[.,:;!?"'”’]+$/, '').trim();
  const words = s.split(/\s+/);
  if (!s || s.length < 2 || s.length > 60 || words.length > 6) return '';
  if (!/^[A-Z0-9]/.test(s) && !/^[a-z]+[A-Z]/.test(s)) return ''; // allow "iPhone"-style names
  if (STOP.test(words[0]) && (words.length === 1 || !/^[A-Z]/.test(words[1] || ''))) return '';
  if (/^(?:the\s+)?(?:startup|company|firm|investors?)\b/i.test(s)) return '';
  if (DESCRIPTOR_END.test(s)) return ''; // "S.Korea AI chip startup" has no name
  return s;
}

const CURRENCY = { $: 'USD', us$: 'USD', usd: 'USD', '€': 'EUR', eur: 'EUR', '£': 'GBP', gbp: 'GBP', dollars: 'USD', euros: 'EUR', pounds: 'GBP' };
const SCALE = { k: 1e3, m: 1e6, mn: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
const AMOUNT_RES = [
  /((?:US)?\$|€|£|USD|EUR|GBP)\s?(\d[\d,]*(?:\.\d+)?)\s?(k|m|mn|mm|million|b|bn|billion)?\b/gi,
  /\b(\d[\d,]*(?:\.\d+)?)\s?(million|billion|m|bn)\s+(dollars|euros|pounds|usd|eur|gbp)\b/gi,
];

/** Largest money amount in the text: { value, currency, display } or null. */
export function extractAmount(text) {
  let best = null;
  for (const re of AMOUNT_RES) {
    for (const m of String(text || '').matchAll(re)) {
      const [cur, num, unit] = re === AMOUNT_RES[0] ? [m[1], m[2], m[3]] : [m[3], m[1], m[2]];
      const value = parseFloat(num.replace(/,/g, '')) * (SCALE[(unit || '').toLowerCase()] || 1);
      if (!Number.isFinite(value) || value < 10000) continue; // "$5 per seat" is not a round
      const currency = CURRENCY[cur.toLowerCase()] || 'USD';
      if (!best || value > best.value) best = { value, currency, display: formatMoney(value, currency) };
    }
  }
  return best;
}

export function formatMoney(value, currency = 'USD') {
  const sym = { USD: '$', EUR: '€', GBP: '£' }[currency] || `${currency} `;
  if (value >= 1e9) return `${sym}${trim(value / 1e9)}B`;
  if (value >= 1e6) return `${sym}${trim(value / 1e6)}M`;
  if (value >= 1e3) return `${sym}${trim(value / 1e3)}K`;
  return `${sym}${value}`;
}
const trim = (n) => (Math.round(n * 10) / 10).toString();

export function extractRound(text) {
  const m = String(text || '').match(/\b(pre-?seed|seed|series\s+[a-h]|angel|bridge|growth)(?=\s+(?:round|funding|financing|investment|extension|raise|equity|capital)|\b)/i);
  if (!m) return '';
  const r = m[1].toLowerCase().replace(/\s+/g, ' ');
  if (r.startsWith('series')) return `Series ${r.slice(-1).toUpperCase()}`;
  if (r.startsWith('pre')) return 'Pre-seed';
  return r[0].toUpperCase() + r.slice(1);
}

const ROLE_RE = new RegExp(String.raw`\b${ROLE}\b`, 'i');
const ACRONYMS = /\b(ceo|cto|cfo|coo|cro|cmo|cio|ciso|cpo|vp|svp|evp)\b/gi;

export function extractRole(text) {
  const m = String(text || '').match(ROLE_RE);
  if (!m) return '';
  return m[0]
    .replace(/\s+/g, ' ')
    .replace(ACRONYMS, (a) => a.toUpperCase())
    .replace(/\b(chief|head|vice|president|general|managing|senior|officer|director|manager|of|sales|marketing|revenue|growth|operations|technology|product|engineering|people|customer|financial|business|development|partnerships|success)\b/gi, (w) =>
      w.toLowerCase() === 'of' ? 'of' : w[0].toUpperCase() + w.slice(1).toLowerCase(),
    );
}
