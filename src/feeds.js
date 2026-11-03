import fs from 'node:fs';
import path from 'node:path';
import { PROJECT_ROOT } from './config.js';

export const DEFAULT_FEEDS_FILE = path.join(PROJECT_ROOT, 'config', 'feeds.json');

/**
 * Loads the feed list. Accepts a JSON array of {name, url} (or plain URL strings),
 * or a text file with one URL per line ("Name | URL" also works).
 */
export function loadFeeds(file = DEFAULT_FEEDS_FILE) {
  const raw = fs.readFileSync(file, 'utf8');
  const list = file.endsWith('.json') ? JSON.parse(raw) : parseFeedLines(raw);
  if (!Array.isArray(list)) throw new Error(`${file} must contain a JSON array of feeds`);
  return list
    .map((f) => (typeof f === 'string' ? { url: f } : f))
    .filter((f) => f && f.url && f.enabled !== false)
    .map((f) => ({ name: f.name || hostOf(f.url), url: f.url }));
}

function parseFeedLines(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const [a, b] = l.split('|').map((s) => s.trim());
      return b ? { name: a, url: b } : { url: a };
    });
}

export const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/**
 * Google News RSS search for one keyword phrase. Opt-in (--google-news): Google's
 * feed terms limit it to personal, non-commercial use.
 */
export function googleNewsFeed(phrase, days = 7) {
  const q = `"${phrase}" when:${Math.max(1, days)}d`;
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
  return { name: `Google News: ${phrase}`, url, googleNews: true };
}

/** Phrases searched on Google News when --google-news is on and no --keywords were given. */
export const DEFAULT_SEARCH_PHRASES = [
  'raised seed',
  'seed round',
  'series A',
  'hiring CEO',
  'appoints chief revenue officer',
  'names new CEO',
  'VP of sales',
];
