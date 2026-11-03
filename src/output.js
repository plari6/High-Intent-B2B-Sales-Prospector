import fs from 'node:fs';
import path from 'node:path';

/** Flat row used by CSV, JSON and webhooks. */
export function toRow(lead) {
  const ai = lead.ai || {};
  const top = [...lead.signals].sort((a, b) => b.weight - a.weight)[0] || {};
  return {
    score: lead.score,
    tier: lead.tier,
    company: lead.company || '',
    signals: lead.signals.map((s) => s.label).join('; '),
    headline: lead.headline,
    round: lead.round || '',
    amount: lead.amount?.display || '',
    role: lead.role || '',
    person: ai.person_name || '',
    person_role: ai.person_role || '',
    industry: ai.industry || '',
    location: ai.location || '',
    investors: (ai.investors || []).join('; '),
    website: ai.company_website || '',
    why_now: ai.why_now || top.why || '',
    likely_needs: (ai.likely_needs || []).join('; '),
    play: top.angle || '',
    outreach_angle: ai.outreach_angle || '',
    icp_fit: ai.icp_fit ?? '',
    summary: ai.summary || lead.articles[0]?.summary?.slice(0, 300) || '',
    published: lead.published ? lead.published.slice(0, 10) : '',
    source: lead.source,
    link: lead.link,
    other_links: lead.articles.slice(1).map((a) => a.link).join(' '),
    score_reasons: lead.reasons.map((r) => `${r.points > 0 ? '+' : ''}${r.points} ${r.why}`).join('; '),
    is_new: lead.isNew ? 'yes' : 'no',
    ai_enriched: lead.ai ? 'yes' : 'no',
  };
}

const csvCell = (v) => {
  const s = String(v ?? '');
  // Neutralise spreadsheet formulas (CSV injection) from headlines.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(leads) {
  const rows = leads.map(toRow);
  const headers = Object.keys(rows[0] || toRow(EMPTY));
  return `﻿${[headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\r\n')}\r\n`;
}

const EMPTY = { signals: [], articles: [], reasons: [] };

export function toMarkdown(leads, { stats, generatedAt = new Date(), options = {} } = {}) {
  const lines = [
    `# High-intent leads, ${generatedAt.toISOString().slice(0, 16).replace('T', ' ')} UTC`,
    '',
    `${leads.length} leads from ${stats ? `${stats.feeds - stats.feedsFailed}/${stats.feeds} feeds, ${stats.inWindow} articles in the last ${options.days ?? 7} days, ${stats.flagged} with buying signals` : 'the latest scan'}.`,
    '',
  ];
  for (const tier of ['hot', 'warm', 'cool']) {
    const group = leads.filter((l) => l.tier === tier);
    if (!group.length) continue;
    lines.push(`## ${tier === 'hot' ? '🔥 Hot' : tier === 'warm' ? 'Warm' : 'Cool'} (${group.length})`, '');
    for (const l of group) {
      const r = toRow(l);
      lines.push(`### ${r.company || '(company unknown)'}: ${r.score}/100`);
      lines.push(`[${l.headline.replace(/[[\]]/g, '')}](${l.link}) (${r.source}, ${r.published || 'undated'})`, '');
      lines.push(`- **Signals:** ${r.signals}${r.amount ? ` · ${r.amount}` : ''}${r.round ? ` · ${r.round}` : ''}${r.role ? ` · ${r.role}` : ''}`);
      if (r.industry || r.location) lines.push(`- **Company:** ${[r.industry, r.location].filter(Boolean).join(', ')}`);
      lines.push(`- **Why now:** ${r.why_now}`);
      if (r.likely_needs) lines.push(`- **Likely needs:** ${r.likely_needs}`);
      if (r.play) lines.push(`- **Play:** ${r.play}`);
      if (r.outreach_angle) lines.push(`- **Opener (AI):** ${r.outreach_angle}`);
      lines.push(`- **Score:** ${r.score_reasons}`, '');
    }
  }
  return lines.join('\n');
}

/** Writes leads.csv / leads.json / leads.md into outDir. Returns the paths written. */
export function writeOutputs(leads, { outDir = 'output', formats = ['csv', 'json', 'md'], stats, options, now = new Date() } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const put = (name, content) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, content);
    written.push(file);
  };
  if (formats.includes('csv')) put('leads.csv', toCsv(leads));
  if (formats.includes('json')) put('leads.json', JSON.stringify({ generatedAt: now.toISOString(), stats, leads: leads.map(toRow) }, null, 2));
  if (formats.includes('md')) put('leads.md', toMarkdown(leads, { stats, generatedAt: now, options }));
  return written;
}

// ------------------------------------------------------------------ console

const useColor = () => process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const c = { red: paint('31'), yellow: paint('33'), green: paint('32'), cyan: paint('36'), dim: paint('2'), bold: paint('1') };

const tierColor = { hot: c.red, warm: c.yellow, cool: c.dim };

export function printLeads(leads, { limit = 20, write = console.log } = {}) {
  if (!leads.length) {
    write(c.dim('No leads above the score threshold. Try --days 14, --min-score 30, or more feeds.'));
    return;
  }
  for (const [i, l] of leads.slice(0, limit).entries()) {
    const r = toRow(l);
    const badge = tierColor[l.tier](`${String(l.score).padStart(3)} ${l.tier.toUpperCase().padEnd(4)}`);
    const facts = [r.amount, r.round, r.role].filter(Boolean).join(' · ');
    write(`${badge}  ${c.bold(r.company || '(unknown company)')}${facts ? c.dim(`  ${facts}`) : ''}${l.isNew ? c.green('  NEW') : ''}`);
    write(`          ${r.signals}`);
    write(`          ${c.dim(truncate(l.headline, 110))}`);
    if (l.ai?.outreach_angle) write(`          ${c.cyan('Opener:')} ${truncate(l.ai.outreach_angle, 140)}`);
    write(`          ${c.dim(l.link)}`);
    if (i < Math.min(limit, leads.length) - 1) write('');
  }
  if (leads.length > limit) write(c.dim(`\n...and ${leads.length - limit} more in the output files.`));
}

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// ------------------------------------------------------------------ webhook

/**
 * POSTs leads to a webhook. Slack and Discord URLs get a chat message,
 * anything else (Zapier, Make, n8n, your CRM) gets JSON { leads: [...] }.
 */
export async function sendWebhook(url, leads, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (!leads.length) return { sent: false, reason: 'no leads' };
  const isSlack = /hooks\.slack\.com/.test(url);
  const isDiscord = /discord(?:app)?\.com\/api\/webhooks/.test(url);
  let body;
  if (isSlack || isDiscord) {
    const text = [
      `*${leads.length} new high-intent lead${leads.length === 1 ? '' : 's'}*`,
      ...leads.slice(0, 15).map((l) => {
        const r = toRow(l);
        return `• *${r.company || 'Unknown'}* (${r.score}, ${r.tier}): ${r.signals}${r.amount ? `, ${r.amount}` : ''}\n  ${isSlack ? `<${l.link}|${l.headline.replace(/[<>|]/g, '')}>` : `${l.headline} ${l.link}`}`;
      }),
    ].join('\n');
    body = isSlack ? { text } : { content: text.slice(0, 1990) };
  } else {
    body = { generatedAt: new Date().toISOString(), count: leads.length, leads: leads.map(toRow) };
  }
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`webhook returned HTTP ${res.status}`);
  return { sent: true, count: leads.length };
}
