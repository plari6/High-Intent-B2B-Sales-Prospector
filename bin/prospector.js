#!/usr/bin/env node
import path from 'node:path';
import { Command, Option } from 'commander';
import { loadEnv, readConfig, splitList } from '../src/config.js';
import { runScan, commitLeads } from '../src/pipeline.js';
import { createGemini } from '../src/ai.js';
import { Store, memoryStore } from '../src/store.js';
import { loadFeeds, googleNewsFeed, DEFAULT_SEARCH_PHRASES, DEFAULT_FEEDS_FILE } from '../src/feeds.js';
import { fetchFeedText, mapLimit } from '../src/fetcher.js';
import { parseFeed } from '../src/parser.js';
import { SIGNALS } from '../src/signals.js';
import { writeOutputs, printLeads, sendWebhook, toRow, c } from '../src/output.js';
import { demoFeeds, demoFetch, DEMO_NOW } from '../src/demo.js';

loadEnv();
const cfg = readConfig();

const program = new Command();
program
  .name('prospector')
  .description('Scans tech news RSS feeds for buying signals (fresh funding, new execs, hiring, expansion) and ranks the companies most likely to buy now.')
  .version('1.0.0');

/** Options shared by scan, watch and demo. */
function scanOptions(cmd) {
  return cmd
    .option('-d, --days <n>', 'look-back window in days', toInt, cfg.days)
    .option('-m, --min-score <n>', 'only keep leads scoring at least this (0-100)', toInt, cfg.minScore)
    .option('-k, --keywords <list>', 'extra keyword phrases, comma separated (e.g. "raised seed,hiring CEO")', splitList, cfg.keywords)
    .option('-s, --signals <list>', 'only these categories: funding, leadership, hiring, expansion, launch, mna, keyword', splitList, [])
    .option('--include <list>', 'only articles mentioning one of these words (e.g. "saas,fintech,ai")', splitList, [])
    .option('--exclude <list>', 'drop articles mentioning any of these words (e.g. "crypto,defense")', splitList, [])
    .option('--feeds <file>', 'feed list (.json array or .txt with one URL per line)', cfg.feedsFile || undefined)
    .option('--google-news', 'also search Google News RSS for each keyword (personal use only per Google terms)')
    .option('--no-ai', 'skip Gemini enrichment (rule-based only)')
    .option('--max-ai <n>', 'max leads sent to Gemini per run', toInt, cfg.maxAi)
    .option('--offer <text>', 'what you sell, used for the AI fit score', cfg.offer)
    .option('--icp <text>', 'who you sell to, used for the AI fit score', cfg.icp)
    .option('-o, --out <dir>', 'output folder', cfg.outDir)
    .option('-f, --format <list>', 'csv,json,md', splitList, ['csv', 'json', 'md'])
    .option('--only-new', 'hide leads already reported in earlier runs')
    .option('--keep-rejected', 'keep leads the AI judged not to be real buyers')
    .option('--webhook <url>', 'POST leads to Slack, Discord, Zapier, Make, n8n or any URL', cfg.webhookUrl || undefined)
    .option('-l, --limit <n>', 'leads to print in the console', toInt, 15)
    .option('--json', 'print the leads as JSON to stdout (for piping) instead of the table')
    .option('--no-state', 'do not read or update data/state.json');
}

scanOptions(program.command('scan').description('Run one scan and write leads.csv, leads.json and leads.md')).action(async (opts) => {
  const { exitCode } = await scanOnce(opts);
  process.exitCode = exitCode;
});

scanOptions(program.command('watch').description('Scan on a schedule and report only new leads (pair with --webhook)'))
  .option('-e, --every <minutes>', 'minutes between scans', toInt, 60)
  .action(async (opts) => {
    opts.onlyNew = true;
    const every = Math.max(5, opts.every);
    log(c.bold(`Watching every ${every} min. Ctrl+C to stop.`));
    for (;;) {
      log(c.dim(`\n[${new Date().toLocaleString()}] scanning...`));
      try {
        await scanOnce(opts);
      } catch (err) {
        log(c.red(`Scan failed: ${err.message}`));
      }
      await new Promise((r) => setTimeout(r, every * 60000));
    }
  });

scanOptions(program.command('demo').description('Offline demo on bundled sample feeds (no network, no API key needed)'))
  .option('--with-ai', 'also call Gemini on the sample leads (needs GEMINI_API_KEY)')
  .action(async (opts) => {
    if (!opts.withAi) opts.ai = false;
    if (opts.out === cfg.outDir) opts.out = path.join(cfg.outDir, 'demo');
    opts.state = false;
    const { exitCode } = await scanOnce(opts, { feeds: demoFeeds(), fetchImpl: demoFetch, now: DEMO_NOW });
    process.exitCode = exitCode;
  });

program
  .command('signals')
  .description('List the buying signals and their weights')
  .action(() => {
    for (const s of SIGNALS) {
      log(`${c.bold(s.label.padEnd(28))} ${c.dim(`${s.category}/${s.id}`.padEnd(30))} weight ${s.weight}`);
      log(`  ${s.why}`);
    }
    log(c.dim('\nAdd your own with --keywords "raised seed,hiring CEO" (weight 24 each).'));
  });

program
  .command('feeds')
  .description('List configured feeds; --check fetches each one')
  .option('--feeds <file>', 'feed list file', cfg.feedsFile || undefined)
  .option('--check', 'download and parse every feed')
  .option('--google-news', 'include the Google News keyword searches')
  .option('-k, --keywords <list>', 'keyword phrases for Google News', splitList, cfg.keywords)
  .action(async (opts) => {
    const feeds = listFeeds(opts);
    if (!opts.check) {
      for (const f of feeds) log(`${f.name.padEnd(34)} ${c.dim(f.url)}`);
      log(c.dim(`\n${feeds.length} feeds from ${opts.feeds || DEFAULT_FEEDS_FILE}`));
      return;
    }
    const results = await checkFeeds(feeds);
    process.exitCode = results.every((r) => !r.ok) ? 2 : 0;
  });

program
  .command('doctor')
  .description('Check Node, Gemini key and feed connectivity')
  .option('--feeds <file>', 'feed list file', cfg.feedsFile || undefined)
  .action(async (opts) => {
    let ok = true;
    const major = Number(process.versions.node.split('.')[0]);
    log(`${major >= 20 ? c.green('✔') : c.red('✘')} Node ${process.versions.node}${major >= 20 ? '' : ' (need 20+)'}`);
    ok &&= major >= 20;
    if (!cfg.geminiApiKey) {
      log(`${c.yellow('!')} GEMINI_API_KEY not set: scans run rule-based only (add it to .env for AI enrichment)`);
    } else {
      try {
        const g = createGemini({ apiKey: cfg.geminiApiKey, model: cfg.geminiModel, fallbackModel: cfg.geminiFallbackModel, retries: 0, timeoutMs: 45000 });
        await g.ping();
        const note = g.model === cfg.geminiModel ? '' : c.yellow(` (${cfg.geminiModel} unavailable right now, fallback used)`);
        log(`${c.green('✔')} Gemini key works (model ${g.model})${note}`);
      } catch (err) {
        ok = false;
        log(`${c.red('✘')} Gemini: ${err.message}`);
      }
    }
    log(`${cfg.offer ? c.green('✔') : c.yellow('!')} SENDER_OFFER ${cfg.offer ? 'set' : 'not set (AI fit score uses a generic agency profile)'}`);
    log('');
    const results = await checkFeeds(listFeeds(opts));
    if (results.every((r) => !r.ok)) ok = false;
    process.exitCode = ok ? 0 : 1;
  });

program
  .command('history')
  .description('Show leads reported by earlier runs')
  .option('-l, --limit <n>', 'how many', toInt, 30)
  .action((opts) => {
    const items = new Store(cfg.stateFile).history(opts.limit);
    if (!items.length) return log(c.dim('No history yet. Run "prospector scan" first.'));
    for (const h of items) {
      log(`${c.dim(h.at.slice(0, 16).replace('T', ' '))}  ${String(h.score).padStart(3)} ${h.tier.padEnd(4)}  ${c.bold(h.company || '(unknown)')}  ${c.dim(h.signals.join(', '))}`);
    }
  });

program.parseAsync().catch((err) => {
  console.error(c.red(`Error: ${err.message}`));
  process.exitCode = 1;
});

// ------------------------------------------------------------------ helpers

async function scanOnce(opts, overrides = {}) {
  const quiet = Boolean(opts.json);
  const say = quiet ? (m) => process.stderr.write(`${m}\n`) : log;
  const store = opts.state === false ? memoryStore() : new Store(cfg.stateFile);
  let gemini = null;
  if (opts.ai !== false) {
    if (cfg.geminiApiKey) {
      gemini = createGemini({
        apiKey: cfg.geminiApiKey,
        model: cfg.geminiModel,
        fallbackModel: cfg.geminiFallbackModel,
        rpm: cfg.geminiRpm,
        timeoutMs: cfg.geminiTimeoutMs,
        onFallback: (from, to, err) => say(c.yellow(`! ${from} unavailable (${err.message.slice(0, 80)}), switching to ${to}`)),
      });
    }
    else say(c.yellow('GEMINI_API_KEY not set: running rule-based only (use --no-ai to hide this note).'));
  }
  const now = overrides.now || new Date();
  const result = await runScan(
    {
      days: opts.days,
      minScore: opts.minScore,
      keywords: opts.keywords,
      categories: opts.signals,
      include: opts.include,
      exclude: opts.exclude,
      feedsFile: opts.feeds,
      feeds: overrides.feeds,
      googleNews: Boolean(opts.googleNews),
      maxAi: opts.maxAi,
      offer: opts.offer,
      icp: opts.icp,
      onlyNew: Boolean(opts.onlyNew),
      keepRejected: Boolean(opts.keepRejected),
      fetchTimeoutMs: cfg.fetchTimeoutMs,
      userAgent: cfg.userAgent,
    },
    { fetchImpl: overrides.fetchImpl || fetch, gemini, store, now, log: (m) => say(c.dim(m)) },
  );
  const { leads, stats, warnings } = result;

  for (const w of warnings) say(c.yellow(`! ${w}`));
  if (stats.feeds && stats.feedsFailed === stats.feeds) {
    say(c.red('Every feed failed. Check your internet connection or run "prospector doctor".'));
    return { exitCode: 2, ...result };
  }

  const files = writeOutputs(leads, { outDir: opts.out, formats: opts.format, stats, options: opts, now });
  if (opts.json) process.stdout.write(`${JSON.stringify(leads.map(toRow), null, 2)}\n`);
  else {
    log('');
    printLeads(leads, { limit: opts.limit });
  }

  say(
    c.dim(
      `\n${stats.feeds - stats.feedsFailed}/${stats.feeds} feeds · ${stats.inWindow} articles in ${opts.days} days · ${stats.flagged} with signals · ` +
        `${stats.noise} roundups/funds skipped · ${stats.distress} layoffs/shutdowns skipped` +
        (gemini ? ` · AI: ${stats.aiCalls} calls, ${stats.aiCached} cached, ${stats.aiRejected} rejected` : '') +
        ` · ${stats.belowMin} below score ${opts.minScore}${opts.onlyNew ? ` · ${stats.alreadySeen} already reported` : ''}`,
    ),
  );
  const tiers = ['hot', 'warm', 'cool'].map((t) => `${leads.filter((l) => l.tier === t).length} ${t}`).join(', ');
  say(`${c.bold(`${leads.length} leads`)} (${tiers}) → ${files.join(', ')}`);

  if (opts.webhook && leads.length) {
    try {
      const sent = await sendWebhook(opts.webhook, leads);
      say(c.green(`Sent ${sent.count} leads to the webhook.`));
    } catch (err) {
      say(c.red(`Webhook failed: ${err.message}`));
    }
  }
  if (opts.state !== false) commitLeads(store, leads, now);
  return { exitCode: 0, ...result };
}

function listFeeds(opts) {
  const feeds = loadFeeds(opts.feeds || undefined);
  if (opts.googleNews) feeds.push(...(opts.keywords?.length ? opts.keywords : DEFAULT_SEARCH_PHRASES).map((p) => googleNewsFeed(p)));
  return feeds;
}

async function checkFeeds(feeds) {
  log(c.dim(`Checking ${feeds.length} feeds...`));
  const results = await mapLimit(feeds, 4, async (f) => {
    try {
      const items = parseFeed(await fetchFeedText(f.url, { timeoutMs: cfg.fetchTimeoutMs, userAgent: cfg.userAgent }), { feedName: f.name });
      const newest = items.map((i) => i.published).filter(Boolean).sort().pop();
      return { ...f, ok: true, msg: `${items.length} items${newest ? `, newest ${newest.slice(0, 10)}` : ''}` };
    } catch (err) {
      return { ...f, ok: false, msg: err.message };
    }
  });
  for (const r of results) log(`${r.ok ? c.green('✔') : c.red('✘')} ${r.name.padEnd(34)} ${c.dim(r.msg)}`);
  log(c.dim(`${results.filter((r) => r.ok).length}/${results.length} feeds OK`));
  return results;
}

function toInt(v) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`"${v}" is not a number`);
  return n;
}

function log(m = '') {
  console.log(m);
}
