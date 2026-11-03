import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';

export const DEMO_DIR = path.join(PROJECT_ROOT, 'examples', 'feeds');
/** The sample feeds are dated around this moment, so recency scoring looks realistic. */
export const DEMO_NOW = new Date('2026-11-03T12:00:00Z');

export function demoFeeds() {
  return fs
    .readdirSync(DEMO_DIR)
    .filter((f) => f.endsWith('.xml'))
    .map((f) => ({ name: `Sample: ${path.basename(f, '.xml')}`, url: `demo://${f}` }));
}

/** fetch() stand-in that serves the sample XML files, so the demo works offline. */
export async function demoFetch(url) {
  const file = path.join(DEMO_DIR, String(url).replace('demo://', ''));
  if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
  return new Response(fs.readFileSync(file, 'utf8'), { status: 200, headers: { 'content-type': 'application/rss+xml' } });
}
