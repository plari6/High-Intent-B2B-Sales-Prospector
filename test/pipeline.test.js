import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runScan, commitLeads, groupLeads } from '../src/pipeline.js';
import { memoryStore } from '../src/store.js';
import { demoFeeds, demoFetch, DEMO_NOW } from '../src/demo.js';

const scan = (options = {}, deps = {}) =>
  runScan({ feeds: demoFeeds(), minScore: 0, ...options }, { fetchImpl: demoFetch, now: DEMO_NOW, ...deps });

const byCompany = (leads) => Object.fromEntries(leads.map((l) => [l.company, l]));

test('demo feeds: finds the real buyers and skips the traps', async () => {
  const { leads, stats, warnings } = await scan();
  assert.deepEqual(warnings, []);
  const names = leads.map((l) => l.company).sort();
  assert.deepEqual(names, ['Brightpath Robotics', 'Cloudnest', 'Ledgerly', 'Medically', 'Mistweave', 'Orbitly', 'Teamforge']);
  // Never leads: VC funds, roundups, how-to guides, layoffs, shutdowns, stale news.
  for (const bad of ['Northpeak Ventures', 'Harbor Capital', 'Quantafy', 'Shipsy Freight', 'Fernway', 'Gridwise']) {
    assert.ok(!names.includes(bad), bad);
  }
  assert.equal(stats.noise, 2);
  assert.equal(stats.distress, 1);
  assert.equal(stats.feedsFailed, 0);
});

test('stories about the same company merge into one lead', async () => {
  const { leads } = await scan();
  const ledgerly = byCompany(leads).Ledgerly;
  assert.equal(ledgerly.articles.length, 2);
  assert.deepEqual(ledgerly.signals.map((s) => s.id).sort(), ['exec_hire', 'funding_seed', 'hiring_spree']);
  assert.equal(ledgerly.amount.display, '$4.5M');
  assert.equal(ledgerly.role, 'VP of Sales');
  assert.equal(ledgerly.tier, 'hot');
  assert.equal(leads[0].company, 'Ledgerly');
});

test('duplicate stories across feeds keep the copy with more text', async () => {
  const { leads } = await scan();
  const seedStory = byCompany(leads).Ledgerly.articles.find((a) => /seed/.test(a.title));
  assert.match(seedStory.summary, /double its team/);
});

test('min score, categories and include/exclude filters', async () => {
  assert.ok((await scan({ minScore: 60 })).leads.every((l) => l.score >= 60));
  const leadership = await scan({ categories: ['leadership'] });
  assert.deepEqual(leadership.leads.map((l) => l.company).sort(), ['Cloudnest', 'Ledgerly', 'Medically']);
  const fintech = await scan({ include: ['fintech'] });
  assert.deepEqual(fintech.leads.map((l) => l.company), ['Ledgerly']);
  const noRobots = await scan({ exclude: ['robot'] });
  assert.ok(!noRobots.leads.some((l) => l.company === 'Brightpath Robotics'));
});

test('custom keywords add signals', async () => {
  const { leads } = await scan({ keywords: ['month-end close'] });
  assert.ok(byCompany(leads).Ledgerly.signals.some((s) => s.id === 'kw:month-end close'));
});

test('only-new hides leads reported by an earlier run', async () => {
  const store = memoryStore();
  const first = await scan({ onlyNew: true }, { store });
  assert.ok(first.leads.length > 0 && first.leads.every((l) => l.isNew));
  commitLeads(store, first.leads, DEMO_NOW);
  const second = await scan({ onlyNew: true }, { store });
  assert.equal(second.leads.length, 0);
  assert.equal(second.stats.alreadySeen, first.leads.length);
});

test('a failing feed becomes a warning, not a crash', async () => {
  const feeds = [...demoFeeds(), { name: 'Broken', url: 'demo://missing.xml' }];
  const { leads, warnings, stats } = await scan({ feeds }, { sleepImpl: async () => {} });
  assert.equal(stats.feedsFailed, 1);
  assert.match(warnings[0], /Broken.*HTTP 404/);
  assert.ok(leads.length > 0);
});

function fakeGemini(answers, calls = []) {
  return {
    model: 'fake',
    async enrich(lead, ctx) {
      calls.push({ lead, ctx });
      const a = answers(lead);
      if (a instanceof Error) throw a;
      return {
        is_lead: true, company: lead.company, icp_fit: 5, confidence: 0.9, investors: [], likely_needs: [],
        signal_type: 'funding', summary: '', why_now: '', outreach_angle: '', ...a,
      };
    },
  };
}

test('AI: enriches, rescoring with fit, and drops rejected leads', async () => {
  const calls = [];
  const gemini = fakeGemini(
    (lead) =>
      lead.company === 'Orbitly'
        ? { is_lead: false, confidence: 0.9 }
        : lead.company === 'Cloudnest'
          ? { icp_fit: 10, outreach_angle: 'Saw Maya Chen joined as CRO.' }
          : {},
    calls,
  );
  const { leads, stats } = await scan({ offer: 'RevOps automation', icp: 'B2B SaaS' }, { gemini });
  const map = byCompany(leads);
  assert.ok(!map.Orbitly, 'rejected lead removed');
  assert.equal(stats.aiRejected, 1);
  assert.equal(map.Cloudnest.ai.outreach_angle, 'Saw Maya Chen joined as CRO.');
  assert.ok(map.Cloudnest.reasons.some((r) => r.points === 15 && /AI fit/.test(r.why)));
  assert.equal(calls[0].ctx.offer, 'RevOps automation');
  assert.equal(stats.aiCalls, calls.length);
});

test('AI: names a company the rules missed and caches answers', async () => {
  const store = memoryStore();
  const feeds = [{ name: 'One', url: 'demo://one' }];
  const xml = `<rss version="2.0"><channel><item><title>Insurance claims AI gets $9M Series A from Northpeak</title><link>https://x.example/a</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
  const fetchImpl = async () => new Response(xml);
  const calls = [];
  const gemini = fakeGemini(() => ({ company: 'Claimwise', icp_fit: 8 }), calls);
  const first = await runScan({ feeds, minScore: 0 }, { fetchImpl, gemini, store, now: DEMO_NOW });
  assert.equal(first.leads[0].company, 'Claimwise');
  const second = await runScan({ feeds, minScore: 0 }, { fetchImpl, gemini, store, now: DEMO_NOW });
  assert.equal(calls.length, 1, 'second run uses the cache');
  assert.equal(second.stats.aiCached, 1);
});

test('AI: a daily quota error stops further AI calls but keeps the leads', async () => {
  const calls = [];
  const gemini = fakeGemini(() => Object.assign(new Error('quota'), { daily: true }), calls);
  const { leads, warnings } = await scan({}, { gemini });
  assert.ok(leads.length >= 6);
  assert.ok(calls.length <= 2, `stopped early (${calls.length} calls, 2 workers)`);
  assert.ok(warnings.some((w) => /quota/.test(w)));
});

test('groupLeads merges by normalized company name', () => {
  const base = { signals: [{ id: 'funding', category: 'funding', weight: 30 }], articles: [{ link: 'a', title: 'a' }], published: '2026-11-01T00:00:00Z' };
  const merged = groupLeads([
    { ...base, company: 'Acme Inc.' },
    { ...base, company: 'ACME', articles: [{ link: 'b', title: 'b' }], published: '2026-11-02T00:00:00Z' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].articles.length, 2);
  assert.equal(merged[0].published, '2026-11-02T00:00:00Z');
  assert.equal(merged[0].key, 'co:acme|funding');
});
