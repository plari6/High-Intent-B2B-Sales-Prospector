import crypto from 'node:crypto';
import { fetchFeedText, mapLimit } from './fetcher.js';
import { parseFeed } from './parser.js';
import { loadFeeds, googleNewsFeed, DEFAULT_SEARCH_PHRASES } from './feeds.js';
import { detectSignals, formatMoney } from './detector.js';
import { SIGNALS, keywordSignals } from './signals.js';
import { scoreLead } from './scorer.js';
import { memoryStore } from './store.js';

const DAY = 86400000;
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

/**
 * Runs one full scan: fetch feeds -> parse -> detect signals -> group by company
 * -> (optional) Gemini enrichment -> score -> filter.
 *
 * deps: { fetchImpl, gemini, store, now, log }
 */
export async function runScan(options = {}, deps = {}) {
  const o = {
    days: 7,
    minScore: 40,
    maxAi: 25,
    keywords: [],
    categories: [],
    include: [],
    exclude: [],
    onlyNew: false,
    keepRejected: false,
    googleNews: false,
    feedConcurrency: 4,
    aiConcurrency: 2,
    fetchTimeoutMs: 15000,
    userAgent: 'HighIntentProspector/1.0',
    offer: '',
    icp: '',
    ...options,
  };
  const { fetchImpl = fetch, gemini = null, store = memoryStore(), now = new Date(), log = () => {} } = deps;
  const warnings = [];
  const stats = { feeds: 0, feedsFailed: 0, articles: 0, inWindow: 0, flagged: 0, noise: 0, distress: 0, filtered: 0, aiCalls: 0, aiCached: 0, aiRejected: 0, belowMin: 0, alreadySeen: 0 };

  // 1. Feeds
  const feeds = [...(o.feeds || loadFeeds(o.feedsFile || undefined))];
  if (o.googleNews) {
    const phrases = o.keywords.length ? o.keywords : DEFAULT_SEARCH_PHRASES;
    feeds.push(...phrases.map((p) => googleNewsFeed(p, o.days)));
  }
  stats.feeds = feeds.length;
  log(`Fetching ${feeds.length} feeds...`);
  const feedReports = await mapLimit(feeds, o.feedConcurrency, async (feed) => {
    try {
      const xml = await fetchFeedText(feed.url, { fetchImpl, timeoutMs: o.fetchTimeoutMs, userAgent: o.userAgent, sleepImpl: deps.sleepImpl });
      const items = parseFeed(xml, { feedName: feed.name });
      return { ...feed, ok: true, count: items.length, items };
    } catch (err) {
      stats.feedsFailed++;
      warnings.push(`Feed "${feed.name}" failed: ${err.message}`);
      return { ...feed, ok: false, count: 0, items: [], error: err.message };
    }
  });

  // 2. Articles in the time window, de-duplicated across feeds
  const cutoff = now.getTime() - o.days * DAY;
  const byLink = new Map();
  const byTitle = new Map();
  const articles = [];
  for (const report of feedReports) {
    for (const a of report.items) {
      stats.articles++;
      if (!a.title) continue;
      if (a.published && Date.parse(a.published) < cutoff) continue;
      const linkKey = normalizeLink(a.link);
      const titleKey = a.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      const dup = (linkKey ? byLink.get(linkKey) : undefined) ?? byTitle.get(titleKey);
      if (dup !== undefined) {
        // Same story from two feeds: keep the copy with more text (aggregators often have none).
        if ((a.summary || '').length > (articles[dup].summary || '').length) articles[dup] = a;
        continue;
      }
      if (linkKey) byLink.set(linkKey, articles.length);
      byTitle.set(titleKey, articles.length);
      articles.push(a);
    }
  }
  stats.inWindow = articles.length;

  // 3. Signal detection
  const signals = [...SIGNALS, ...keywordSignals(o.keywords)];
  const wantCats = new Set(o.categories.map((c) => c.toLowerCase()));
  const flagged = [];
  for (const article of articles) {
    const d = detectSignals(article, { signals });
    const strong = d.hits.some((h) => h.field === 'title' || h.category === 'keyword');
    if (!strong) continue;
    if (d.noise) {
      stats.noise++;
      continue;
    }
    if (d.distress) {
      stats.distress++;
      continue;
    }
    let hits = d.hits;
    if (wantCats.size) hits = hits.filter((h) => wantCats.has(h.category) || wantCats.has(h.id));
    const text = `${article.title} ${article.summary} ${article.categories.join(' ')}`.toLowerCase();
    if (!hits.length || (o.include.length && !o.include.some((t) => text.includes(t.toLowerCase()))) || o.exclude.some((t) => text.includes(t.toLowerCase()))) {
      stats.filtered++;
      continue;
    }
    flagged.push({ article, ...d, hits });
  }
  stats.flagged = flagged.length;

  // 4. Group stories about the same company into one lead
  let leads = groupLeads(flagged.map(toLead));
  for (const lead of leads) Object.assign(lead, scoreLead(lead, { now }));
  leads.sort((a, b) => b.score - a.score);

  // 5. Gemini enrichment for the most promising leads
  if (gemini && o.maxAi > 0) {
    const candidates = leads.filter((l) => l.score >= o.minScore - 20).slice(0, o.maxAi);
    log(`Enriching ${candidates.length} leads with Gemini (${gemini.model})...`);
    let stopAi = false;
    await mapLimit(candidates, o.aiConcurrency, async (lead) => {
      if (stopAi) return;
      const key = `ai:${hash(`${gemini.model}|${o.offer}|${o.icp}|${lead.articles.map((a) => a.link || a.title).join('|')}`)}`;
      let ai = store.getAi(key);
      if (ai) stats.aiCached++;
      else {
        try {
          ai = await gemini.enrich(lead, { offer: o.offer, icp: o.icp });
          stats.aiCalls++;
          store.setAi(key, ai, now);
        } catch (err) {
          if (err.daily) stopAi = true;
          warnings.push(`AI skipped for "${lead.company || lead.headline}": ${err.message}`);
          return;
        }
      }
      applyAi(lead, ai);
    });
    stats.aiRejected = leads.filter((l) => l.aiRejected).length;
    if (!o.keepRejected) leads = leads.filter((l) => !l.aiRejected);
    leads = groupLeads(leads); // AI may have named companies that now match each other
    for (const lead of leads) Object.assign(lead, scoreLead(lead, { now }));
  }

  // 6. Final filter and order
  for (const lead of leads) lead.isNew = !store.isSeen(lead.key);
  const result = leads
    .filter((l) => {
      if (l.score < o.minScore) {
        stats.belowMin++;
        return false;
      }
      if (o.onlyNew && !l.isNew) {
        stats.alreadySeen++;
        return false;
      }
      return true;
    })
    .sort((a, b) => b.score - a.score || Date.parse(b.published || 0) - Date.parse(a.published || 0));

  return { leads: result, stats, warnings, feedReports: feedReports.map(({ items, ...r }) => r) };
}

/** Remembers reported leads so the next run (or `watch`) only shows new ones. */
export function commitLeads(store, leads, now = new Date()) {
  for (const l of leads) store.markSeen(l.key, now);
  store.addHistory(leads, now);
  store.prune(now);
  store.save();
}

function toLead(f) {
  const a = f.article;
  return {
    key: '',
    company: f.company,
    signals: f.hits,
    articles: [a],
    headline: a.title,
    link: a.link,
    source: a.source,
    published: a.published,
    amount: f.amount,
    round: f.round,
    role: f.role,
    ai: null,
    aiRejected: false,
  };
}

export const companyKey = (name) =>
  String(name || '')
    .toLowerCase()
    .replace(/\b(inc|ltd|llc|gmbh|corp|co|plc|sa|ag|bv|oy|ab)\b\.?/g, '')
    .replace(/[^a-z0-9]+/g, '');

/** Merges leads with the same company. Keeps the strongest signals and the freshest date. */
export function groupLeads(leads) {
  const map = new Map();
  for (const lead of leads) {
    const ck = companyKey(lead.company);
    const id = ck ? `co:${ck}` : `article:${hash(lead.link || lead.headline)}`;
    const existing = map.get(id);
    if (!existing) {
      map.set(id, { ...lead, signals: [...lead.signals], articles: [...lead.articles] });
      continue;
    }
    for (const s of lead.signals) {
      const i = existing.signals.findIndex((x) => x.id === s.id);
      if (i === -1) existing.signals.push(s);
      else if (s.weight > existing.signals[i].weight) existing.signals[i] = s;
    }
    for (const a of lead.articles) if (!existing.articles.some((x) => x.link === a.link && x.title === a.title)) existing.articles.push(a);
    if (Date.parse(lead.published || 0) > Date.parse(existing.published || 0)) existing.published = lead.published;
    if ((lead.amount?.value || 0) > (existing.amount?.value || 0)) existing.amount = lead.amount;
    existing.round ||= lead.round;
    existing.role ||= lead.role;
    existing.ai ||= lead.ai;
    existing.aiRejected = existing.aiRejected && lead.aiRejected;
  }
  for (const [id, lead] of map) {
    const cats = [...new Set(lead.signals.map((s) => s.category))].sort().join('+');
    lead.key = id.startsWith('co:') ? `${id}|${cats}` : id;
  }
  return [...map.values()];
}

function applyAi(lead, ai) {
  lead.ai = ai;
  if (!ai.is_lead && ai.confidence >= 0.6) lead.aiRejected = true;
  if (ai.company && (!lead.company || ai.confidence >= 0.7)) lead.company = ai.company;
  if (!lead.round && ai.funding_round) lead.round = ai.funding_round;
  // A role only belongs on the lead when the news is about a leadership change; otherwise it is just who was quoted.
  if (!lead.role && ai.person_role && lead.signals.some((s) => s.category === 'leadership')) lead.role = ai.person_role;
  if (!lead.amount && ai.amount) lead.amount = { value: 0, currency: '', display: ai.amount };
}

function normalizeLink(link) {
  try {
    const u = new URL(link);
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|ref$|source$|oc$)/i.test(p)) u.searchParams.delete(p);
    return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`;
  } catch {
    return link || '';
  }
}

export { formatMoney };
