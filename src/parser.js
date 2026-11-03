import { XMLParser } from 'fast-xml-parser';

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  removeNSPrefix: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
  parseTagValue: false,
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
});

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

const safeChar = (code) => {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
};

/** Strips tags and collapses whitespace. */
export function htmlToText(html) {
  return decodeEntities(
    String(html ?? '')
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/h\d>/gi, '. ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/([.!?])(?:\s*\.)+/g, '$1')
    .trim();
}

const text = (node) => {
  if (node == null) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return text(node[0]);
  return node['#text'] != null ? String(node['#text']) : '';
};

function parseDate(value) {
  const t = Date.parse(text(value));
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Parses RSS 2.0, RSS 1.0 (RDF) and Atom into a flat list of articles:
 * { title, link, published, summary, source, guid, categories }
 */
export function parseFeed(xmlText, { feedName = '' } = {}) {
  let doc;
  try {
    doc = xml.parse(xmlText);
  } catch (err) {
    throw new Error(`invalid XML: ${err.message}`);
  }
  if (doc.rss?.channel) return (doc.rss.channel.item || []).map((i) => fromRssItem(i, feedName));
  if (doc['rdf:RDF']) return (doc['rdf:RDF'].item || []).map((i) => fromRssItem(i, feedName));
  if (doc.feed) return (doc.feed.entry || []).map((e) => fromAtomEntry(e, feedName));
  throw new Error('not an RSS or Atom feed');
}

function fromRssItem(item, feedName) {
  const source = text(item.source) || feedName;
  let title = htmlToText(text(item.title));
  // Google News appends " - Publisher" to every title.
  if (item.source && title.endsWith(` - ${text(item.source)}`)) {
    title = title.slice(0, -(text(item.source).length + 3)).trim();
  }
  const content = text(item['content:encoded']);
  const description = text(item.description);
  const link = text(item.link) || (item.guid?.['@isPermaLink'] !== 'false' ? text(item.guid) : '');
  return {
    title,
    link: link.trim(),
    published: parseDate(item.pubDate ?? item['dc:date'] ?? item.published),
    summary: summarize(content || description, title),
    source,
    feed: feedName,
    guid: text(item.guid) || link,
    categories: (item.category || []).map((c) => htmlToText(text(c))).filter(Boolean),
  };
}

function fromAtomEntry(entry, feedName) {
  const links = entry.link || [];
  const alt = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') || links[0];
  const link = alt?.['@href'] || '';
  const title = htmlToText(text(entry.title));
  return {
    title,
    link,
    published: parseDate(entry.published ?? entry.updated),
    summary: summarize(text(entry.content) || text(entry.summary), title),
    source: feedName,
    feed: feedName,
    guid: text(entry.id) || link,
    categories: (entry.category || []).map((c) => c['@term'] || text(c)).filter(Boolean),
  };
}

/** Plain-text summary, without a repeated title and without WordPress "The post ... appeared first on" footers. */
function summarize(html, title) {
  let s = htmlToText(html)
    .replace(/\bThe post .{0,200}? appeared first on .{0,80}?\.?$/i, '')
    .replace(/\[(…|\.\.\.)\]\s*$/, '…')
    .trim();
  if (title && s.startsWith(title)) s = s.slice(title.length).replace(/^[\s.:–—-]+/, '');
  return s.length > 1500 ? `${s.slice(0, 1500)}…` : s;
}
