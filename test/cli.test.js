import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(ROOT, 'bin', 'prospector.js');

function run(args, extraEnv = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-cli-'));
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    PROSPECTOR_SKIP_DOTENV: '1',
    NO_COLOR: '1',
    STATE_FILE: path.join(tmp, 'state.json'),
    ...extraEnv,
  };
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: tmp, env, encoding: 'utf8', timeout: 30000 });
  return { ...r, tmp };
}

test('demo runs offline and writes all three files', () => {
  const r = run(['demo', '--min-score', '0']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Ledgerly/);
  assert.match(r.stdout, /7 leads \(3 hot, 3 warm, 1 cool\)/);
  for (const f of ['leads.csv', 'leads.json', 'leads.md']) assert.ok(fs.existsSync(path.join(r.tmp, 'output', 'demo', f)), f);
});

test('demo --json prints machine-readable rows on stdout only', () => {
  const r = run(['demo', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = JSON.parse(r.stdout);
  assert.equal(rows[0].company, 'Ledgerly');
  assert.ok(rows.every((row) => row.score >= 40));
});

test('scan without an API key falls back to rules and says so', () => {
  const feeds = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'prospector-feeds-')), 'feeds.json');
  fs.writeFileSync(feeds, JSON.stringify([{ name: 'Dead', url: 'http://127.0.0.1:9/feed' }]));
  const r = run(['scan', '--feeds', feeds], { FETCH_TIMEOUT_MS: '2000' });
  assert.match(r.stdout + r.stderr, /GEMINI_API_KEY not set/);
  assert.match(r.stdout + r.stderr, /Every feed failed/);
  assert.equal(r.status, 2);
});

test('signals lists the library', () => {
  const r = run(['signals']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Raised pre-seed\/seed/);
  assert.match(r.stdout, /New executive hired/);
});

test('history is empty on a fresh state file', () => {
  const r = run(['history']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /No history yet/);
});
