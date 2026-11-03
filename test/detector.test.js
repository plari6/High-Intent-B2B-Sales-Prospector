import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectSignals, extractCompany, extractAmount, extractRound, extractRole } from '../src/detector.js';
import { keywordSignals, SIGNALS } from '../src/signals.js';

const ids = (title, summary = '') => detectSignals({ title, summary }).hits.map((h) => h.id).sort();

test('company names from real-world headline shapes', () => {
  const cases = [
    ['Trajectory raises $45M to make AI model training accessible', 'Trajectory'],
    ['Exclusive: Numeracle Raises $28M To Keep Business Calls From Spam Label', 'Numeracle'],
    ['Turning pollution into everyday products – Southampton’s Virdi raises €2.6 million', 'Virdi'],
    ['Following Austria’s first commercial satellite launch, Tumbleweed raises €6.9 million', 'Tumbleweed'],
    ['Looking for a job? Estonia’s Roleo just raised €2.9 million to help you', 'Roleo'],
    ['Riga-based Unitoq raises €155K in pre-seed', 'Unitoq'],
    ['FreightTech startup Conlio secures €6.4 million to expand', 'Conlio'],
    ['Portuguese AI startup Granter bags €1.6M to expand across Europe', 'Granter'],
    ['London-based LO:TECH lands $12M Series A led by MMC', 'LO:TECH'],
    ['Startup Athena raises $2.5M in pre-seed funding', 'Athena'],
    ['Google X co-founder Sebastian Thrun raises $130M for AI engineering startup Dulo', 'Dulo'],
    ['VCs bet $30M on Larridin’s ability to help enterprises', 'Larridin'],
    ['In one of the largest deals in tech history, Marvell buys Lumentum for $115B', 'Marvell'],
    ['Veriff co-founder’s Roleo raises €2.9M to expand AI career agent', 'Roleo'],
    ['Superset is now Paradev, raises $11.5M seed', 'Paradev'],
    ['Cloudnest appoints former Stripe exec Maya Chen as Chief Revenue Officer', 'Cloudnest'],
    ['Jane Doe joins Acme Robotics as CEO', 'Acme Robotics'],
    ['The Browser Company raises $50M', 'The Browser Company'],
  ];
  for (const [title, want] of cases) assert.equal(extractCompany(title), want, title);
});

test('company is empty when the headline names no company', () => {
  for (const title of [
    'S.Korea AI chip startup raises $620M at a $2.9B valuation',
    'Yvonne Bajela is bringing $17M in fresh capital to Europe’s startup scene',
    'Startups raise more money in October',
    'Ex-Phoenix Court partner launches $17M debut solo fund',
  ]) {
    assert.equal(extractCompany(title), '', title);
  }
});

test('funding rounds map to the right signal', () => {
  assert.deepEqual(ids('Acme raises $4M seed round'), ['funding_seed']);
  assert.deepEqual(ids('Superset is now Paradev, raises $11.5M seed'), ['funding_seed']);
  assert.deepEqual(ids('Mistweave emerges from stealth with $6M pre-seed'), ['funding_seed', 'stealth_launch']);
  assert.deepEqual(ids('Infisical raises $40M Series B led by Elad Gil'), ['funding_early']);
  assert.deepEqual(ids('Acme closes $120M Series D'), ['funding_growth']);
  assert.deepEqual(ids('Hex Raises $100M'), ['funding']);
  assert.deepEqual(ids('Robotics startup Tutor Intelligence nabs $75M investment'), ['funding']);
});

test('not funding: prices and generic launches without money', () => {
  assert.deepEqual(ids('Apple Raises MacBook Starting Price to $649 on Education Store'), []);
  assert.deepEqual(ids('Remote work is here to stay'), []);
});

test('leadership and hiring signals', () => {
  assert.deepEqual(ids('Cloudnest appoints former Stripe exec Maya Chen as Chief Revenue Officer'), ['exec_hire']);
  assert.deepEqual(ids('Acme names Jordan Blake VP of Sales'), ['exec_hire']);
  assert.deepEqual(ids('Medically is hiring a new CEO as founder steps back'), ['exec_hire']);
  assert.deepEqual(ids('Acme CEO Jane Smith steps down'), ['exec_departure']);
  assert.deepEqual(ids('Acme plans to hire 200 engineers in Lisbon'), ['hiring_spree']);
  assert.deepEqual(ids('Teamforge is building out its sales team'), ['hiring_spree']);
});

test('expansion, launch and M&A signals', () => {
  assert.deepEqual(ids('Acme opens new office in Austin'), ['expansion']);
  assert.deepEqual(ids('Acme expands into the UK'), ['expansion']);
  assert.deepEqual(ids('PagerDuty debuts Paige AI agent'), ['product_launch']);
  assert.deepEqual(ids('Orbitly acquires analytics startup Pixelcount'), ['acquisition']);
});

test('summary matches count, but less than headline matches', () => {
  const d = detectSignals({ title: 'Ledgerly raises $4.5M seed round', summary: 'The company plans to double its team.' });
  const hiring = d.hits.find((h) => h.id === 'hiring_spree');
  assert.equal(hiring.field, 'summary');
  assert.ok(hiring.weight < SIGNALS.find((s) => s.id === 'hiring_spree').weight);
});

test('roundups, guides and VC funds are flagged as noise', () => {
  const noise = (title) => detectSignals({ title, summary: '' }).noise;
  assert.ok(noise('The Week’s 10 Biggest Funding Rounds: Physical AI Leads'));
  assert.ok(noise('How to raise a seed round in 2027'));
  assert.ok(noise('Disruptive raises $10B fund to make big bets on at least 10 companies'));
  assert.ok(noise('Swedish VC Creandum closes €668 million CVIII fund'));
  assert.ok(noise('Robin Capital raises €15M Fund II'));
  assert.ok(noise('Series B Funding Is Up, But Fewer Deals Are Getting Done'));
  assert.ok(!noise('Trajectory raises $45M to fund expansion'));
  assert.ok(!noise('Acme raises $10M to fund growth and hiring'));
});

test('layoffs and shutdowns are flagged as distress', () => {
  const distress = (title) => detectSignals({ title, summary: '' }).distress;
  assert.ok(distress('Quantafy lays off 30% of staff'));
  assert.ok(distress('Shipsy shuts down after failing to raise'));
  assert.ok(distress('Retailer enters administration'));
  assert.ok(!distress('Biden administration backs chip startups'));
});

test('amount extraction picks the largest and normalizes', () => {
  assert.deepEqual(extractAmount('raises $4.5M seed'), { value: 4.5e6, currency: 'USD', display: '$4.5M' });
  assert.equal(extractAmount('secures €6.4 million').display, '€6.4M');
  assert.equal(extractAmount('£2.2M round').currency, 'GBP');
  assert.equal(extractAmount('raised 3 million euros').display, '€3M');
  assert.equal(extractAmount('$5 per seat'), null);
  assert.equal(extractAmount('$500K now, $2B valuation').display, '$2B');
});

test('round and role extraction', () => {
  assert.equal(extractRound('lands $12M Series A led by MMC'), 'Series A');
  assert.equal(extractRound('raises €155K in pre-seed'), 'Pre-seed');
  assert.equal(extractRound('a $3M seed round'), 'Seed');
  assert.equal(extractRole('names Maya Chen chief revenue officer'), 'Chief Revenue Officer');
  assert.equal(extractRole('hires a VP of sales'), 'VP of Sales');
});

test('facts only attach to matching signals', () => {
  const d = detectSignals({ title: 'Brightpath lands $22M Series A', summary: 'CEO Dana Ortiz said the money helps.' });
  assert.equal(d.role, '');
  assert.equal(d.round, 'Series A');
});

test('custom keyword signals match flexible phrasing', () => {
  const signals = keywordSignals(['raised seed', 'hiring CEO']);
  const hit = (title) => detectSignals({ title, summary: '' }, { signals }).hits.map((h) => h.id);
  assert.deepEqual(hit('Acme raised a $2M seed'), ['kw:raised seed']);
  assert.deepEqual(hit('Medically is hiring a new CEO'), ['kw:hiring ceo']);
  assert.deepEqual(hit('Nothing here'), []);
});
