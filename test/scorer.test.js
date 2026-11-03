import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scoreLead, tierFor } from '../src/scorer.js';

const now = new Date('2026-11-03T12:00:00Z');
const sig = (category, weight, label = category, field = 'title') => ({ category, weight, label, field });
const lead = (over = {}) => ({
  company: 'Acme',
  signals: [sig('funding', 34)],
  articles: [{}],
  published: '2026-11-02T12:00:00Z',
  amount: null,
  ...over,
});

test('fresh seed round scores warm, with explained points', () => {
  const r = scoreLead(lead({ amount: { value: 4e6, display: '$4M' } }), { now });
  assert.equal(r.score, 34 + 20 + 6);
  assert.equal(r.tier, 'warm');
  assert.deepEqual(
    r.reasons.map((x) => x.points),
    [34, 20, 6],
  );
});

test('a second signal category adds 40% of its weight', () => {
  const r = scoreLead(lead({ signals: [sig('funding', 34), sig('leadership', 32), sig('funding', 30)] }), { now });
  assert.equal(r.score, 34 + Math.round(32 * 0.4) + 20);
});

test('old news, unknown company and poor AI fit lower the score', () => {
  const r = scoreLead(lead({ company: '', published: '2026-09-01T00:00:00Z', ai: { icp_fit: 1 } }), { now });
  assert.equal(r.score, Math.max(0, 34 - 10 - 15 - 12));
});

test('mega deals are penalised, multiple stories add points', () => {
  const r = scoreLead(lead({ amount: { value: 5e9, display: '$5B' }, articles: [{}, {}, {}] }), { now });
  assert.equal(r.score, 34 + 20 - 10 + 10);
});

test('score is clamped to 0-100 and tiers are stable', () => {
  const r = scoreLead(lead({ signals: [sig('a', 90), sig('b', 90), sig('c', 90)], ai: { icp_fit: 10 } }), { now });
  assert.equal(r.score, 100);
  assert.equal(tierFor(70), 'hot');
  assert.equal(tierFor(69), 'warm');
  assert.equal(tierFor(45), 'warm');
  assert.equal(tierFor(44), 'cool');
});
