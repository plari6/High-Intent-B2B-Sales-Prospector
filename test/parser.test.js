import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseFeed, htmlToText } from '../src/parser.js';
import { DEMO_DIR } from '../src/demo.js';

const read = (f) => fs.readFileSync(path.join(DEMO_DIR, f), 'utf8');

test('parses RSS 2.0 with content, categories and strips the WordPress footer', () => {
  const items = parseFeed(read('startup-wire.xml'), { feedName: 'Wire' });
  assert.equal(items.length, 9);
  const first = items[0];
  assert.equal(first.title, 'Ledgerly raises $4.5M seed round to automate month-end close for SMBs');
  assert.equal(first.published, '2026-11-02T14:10:00.000Z');
  assert.deepEqual(first.categories, ['Fintech', 'Funding']);
  assert.match(first.summary, /double its team/);
  assert.doesNotMatch(first.summary, /appeared first/);
  assert.equal(first.source, 'Wire');
  assert.match(items[1].summary, /Rotterdam/); // from content:encoded
});

test('parses Atom entries', () => {
  const items = parseFeed(read('eu-tech-daily.xml'), { feedName: 'EU' });
  assert.equal(items.length, 5);
  assert.equal(items[0].link, 'https://eutechdaily.example/teamforge-8m');
  assert.equal(items[0].published, '2026-11-02T11:00:00.000Z');
  assert.match(items[0].summary, /London office/);
});

test('Google News style: strips " - Publisher" and uses the source name', () => {
  const items = parseFeed(read('news-search.xml'), { feedName: 'Search' });
  assert.equal(items[0].title, 'Ledgerly raises $4.5M seed round to automate month-end close for SMBs');
  assert.equal(items[0].source, 'Startup Wire');
});

test('parses RSS 1.0 (RDF)', () => {
  const xml = `<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/">
    <channel><title>x</title></channel>
    <item><title>Acme raises $3M seed</title><link>https://x.example/a</link><dc:date>2026-11-01T10:00:00Z</dc:date><description>Hi</description></item>
  </rdf:RDF>`;
  const [item] = parseFeed(xml);
  assert.equal(item.title, 'Acme raises $3M seed');
  assert.equal(item.published, '2026-11-01T10:00:00.000Z');
});

test('decodes entities and strips HTML', () => {
  assert.equal(htmlToText('<p>R&amp;D &#8217;s &#x2014; <b>big</b></p>'), 'R&D ’s — big.');
});

test('rejects non-feeds', () => {
  assert.throws(() => parseFeed('<html><body>nope</body></html>'), /not an RSS or Atom feed/);
});
