import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fetchFeedText } from '../src/fetcher.js';
import { toCsv, toRow, sendWebhook, writeOutputs } from '../src/output.js';
import { Store } from '../src/store.js';
import { loadFeeds } from '../src/feeds.js';

const noSleep = async () => {};

test('fetcher: rejects HTML bot walls without retrying', async () => {
  let n = 0;
  const fetchImpl = async () => (n++, new Response('<!DOCTYPE html><html>Attention Required</html>'));
  await assert.rejects(fetchFeedText('https://x', { fetchImpl, sleepImpl: noSleep }), /HTML page instead of a feed/);
  assert.equal(n, 1);
});

test('fetcher: 403 is final, 503 is retried', async () => {
  let n = 0;
  await assert.rejects(fetchFeedText('https://x', { fetchImpl: async () => (n++, new Response('', { status: 403 })), sleepImpl: noSleep }), /HTTP 403 \(blocked/);
  assert.equal(n, 1);
  let m = 0;
  const xml = await fetchFeedText('https://x', {
    fetchImpl: async () => (++m === 1 ? new Response('', { status: 503 }) : new Response('<rss/>')),
    sleepImpl: noSleep,
  });
  assert.equal(xml, '<rss/>');
});

test('fetcher: sends an honest user agent', async () => {
  let ua;
  await fetchFeedText('https://x', { userAgent: 'Bot/1', fetchImpl: async (u, init) => ((ua = init.headers['user-agent']), new Response('<rss/>')) });
  assert.equal(ua, 'Bot/1');
});

const sampleLead = {
  score: 80,
  tier: 'hot',
  company: '=HYPERLINK("x")',
  signals: [{ label: 'Raised funding', weight: 30, why: 'Budget', angle: 'Play' }],
  headline: 'Acme raises $5M, "big" news',
  amount: { display: '$5M' },
  round: 'Seed',
  role: '',
  articles: [{ link: 'https://a', summary: 'line1\nline2' }],
  reasons: [{ points: 30, why: 'Raised funding' }],
  link: 'https://a',
  source: 'Wire',
  published: '2026-11-02T00:00:00Z',
  isNew: true,
  ai: null,
};

test('csv: BOM, quoting and formula neutralisation', () => {
  const csv = toCsv([sampleLead]);
  assert.ok(csv.startsWith('﻿score,tier,company,'));
  assert.match(csv, /,"'=HYPERLINK\(""x""\)",/);
  assert.match(csv, /"Acme raises \$5M, ""big"" news"/);
  assert.match(csv, /"line1\nline2"/);
  assert.equal(toRow(sampleLead).play, 'Play');
});

test('writeOutputs writes the requested formats', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-'));
  const files = writeOutputs([sampleLead], { outDir: dir, formats: ['csv', 'json', 'md'], stats: { feeds: 1, feedsFailed: 0, inWindow: 3, flagged: 1 } });
  assert.equal(files.length, 3);
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'leads.json'), 'utf8'));
  assert.equal(json.leads[0].score, 80);
  assert.match(fs.readFileSync(path.join(dir, 'leads.md'), 'utf8'), /## 🔥 Hot \(1\)/);
});

test('webhook: Slack gets text, others get JSON rows', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => (bodies.push([url, JSON.parse(init.body)]), new Response('ok'));
  await sendWebhook('https://hooks.slack.com/services/T/B/X', [sampleLead], { fetchImpl });
  await sendWebhook('https://discord.com/api/webhooks/1/abc', [sampleLead], { fetchImpl });
  await sendWebhook('https://hook.make.example/abc', [sampleLead], { fetchImpl });
  assert.match(bodies[0][1].text, /1 new high-intent lead\*/);
  assert.match(bodies[1][1].content, /Raised funding/);
  assert.equal(bodies[2][1].leads[0].tier, 'hot');
  assert.deepEqual(await sendWebhook('https://x', [], { fetchImpl }), { sent: false, reason: 'no leads' });
  await assert.rejects(sendWebhook('https://x', [sampleLead], { fetchImpl: async () => new Response('', { status: 500 }) }), /HTTP 500/);
});

test('store: persists seen keys, AI cache and history; prunes old entries', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-')), 'state.json');
  const s = new Store(file, { retentionDays: 30 });
  s.markSeen('co:acme|funding', new Date('2026-11-01'));
  s.markSeen('co:old|funding', new Date('2026-08-01'));
  s.setAi('ai:1', { company: 'Acme' }, new Date('2026-11-01'));
  s.addHistory([{ ...sampleLead, key: 'co:acme|funding' }]);
  s.prune(new Date('2026-11-03'));
  s.save();
  const again = new Store(file);
  assert.ok(again.isSeen('co:acme|funding'));
  assert.ok(!again.isSeen('co:old|funding'));
  assert.equal(again.getAi('ai:1').company, 'Acme');
  assert.equal(again.history(5)[0].company, '=HYPERLINK("x")');
});

test('store: survives a corrupt state file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-')), 'state.json');
  fs.writeFileSync(file, '{not json');
  assert.equal(new Store(file).isSeen('x'), false);
});

test('feeds: default list loads; text lists with names work', () => {
  assert.ok(loadFeeds().length >= 5);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-')), 'feeds.txt');
  fs.writeFileSync(file, '# my feeds\nMy Blog | https://blog.example/feed\nhttps://www.other.example/rss\n');
  assert.deepEqual(loadFeeds(file), [
    { name: 'My Blog', url: 'https://blog.example/feed' },
    { name: 'other.example', url: 'https://www.other.example/rss' },
  ]);
});
