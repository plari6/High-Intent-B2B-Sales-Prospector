# High-Intent B2B Sales Prospector

A Node.js CLI that reads tech news RSS feeds every day, flags companies showing **buying signals** (fresh funding, a new executive, a hiring push, expansion, a launch, an acquisition), scores how likely they are to buy right now, and uses **Gemini** to write the "why now" and a personalised opening line for each lead.

```
 78 HOT   Roleo  €2.9M · Seed
          Raised funding; Expansion / new market
          Looking for a job? Estonia’s Roleo just raised €2.9 million to help you on your journey
          Opener: Expanding your AI career agent across Europe following your €2.9 million round
                  brings a surge in lead volume that can quickly overwhelm your sales pipeline.

 78 HOT   LO:TECH  $12M · Series A
          Raised Series A/B
          London-based LO:TECH lands $12M Series A led by MMC
```
*(real output from a live scan, November 2026)*

## Why this works

Companies spend money right after something changes. A seed round means a stack built from scratch. A new CRO reviews every vendor in their first 90 days. An office in a new country needs local pipeline. Reaching them in that window beats cold lists by a wide margin, and tech news announces these moments every day.

## How it works

```
RSS / Atom feeds ──► parse ──► de-duplicate ──► detect signals ──► group by company
                                                  (rules, no API)          │
        leads.csv / leads.json / leads.md ◄── score 0-100 ◄── Gemini enrichment (optional)
        console, Slack/Discord/Zapier webhook
```

1. **Fetch** 9 publisher feeds by default (TechCrunch, Crunchbase News, EU-Startups, Tech.eu, GeekWire, SiliconANGLE, VentureBeat, Hacker News). Add your own in `config/feeds.json`.
2. **Detect** buying signals with a regex library tuned on real headlines (`prospector signals` lists them). Headline matches count fully, matches in the article body count 60%.
3. **Skip the noise**: VC funds raising their own fund, weekly roundups, "how to raise" guides, market reports, and companies announcing layoffs or shutdowns.
4. **Extract** company, amount (`$4.5M`, `€155K`, `£2.2M`), round (Pre-seed to Series H) and role (CEO, CRO, VP of Sales…).
5. **Group** stories about the same company (seed round + new VP of Sales = one hotter lead).
6. **Enrich with Gemini** (optional): confirms it's a real buyer, names the company when the headline doesn't, and adds industry, location, investors, why now, likely needs, a one-line opener and a 0-10 fit score against **your** offer and ICP. Answers are cached, so re-runs are free.
7. **Score** 0-100 with every point explained (signal strength, recency, round size, multiple stories, AI fit). Tiers: 🔥 hot ≥ 70, warm ≥ 45, cool.

## Quick start

```bash
npm install
node bin/prospector.js demo          # offline demo on sample feeds, no key needed
cp .env.example .env                 # add GEMINI_API_KEY, SENDER_OFFER, TARGET_ICP
node bin/prospector.js doctor        # checks Node, the Gemini key and every feed
node bin/prospector.js scan          # live scan -> output/leads.csv, .json, .md
```

Node 20+ required. A free Gemini key is at <https://aistudio.google.com/app/apikey>. Without a key the tool runs rule-based only.

## Commands

| Command | What it does |
|---|---|
| `scan` | One scan. Writes `leads.csv` (Excel-friendly), `leads.json` and `leads.md` (a readable report) |
| `watch --every 60` | Scans on a schedule and reports **only new** leads; pair with `--webhook` |
| `demo` | Offline run on the bundled sample feeds (`--with-ai` to also call Gemini) |
| `doctor` | Checks Node, the Gemini key and every feed |
| `feeds [--check]` | Lists feeds, or downloads and parses each one |
| `signals` | Lists buying signals and their weights |
| `history` | Leads reported by earlier runs |

### Useful options (scan, watch, demo)

```bash
prospector scan --days 3 --min-score 60               # only fresh, strong leads
prospector scan --signals funding,leadership          # only these categories
prospector scan --include "saas,fintech" --exclude crypto
prospector scan --keywords "raised seed,hiring CEO"   # your own phrases (+24 points each)
prospector scan --google-news --keywords "hiring VP of sales"   # also search Google News
prospector scan --offer "Webflow agency" --icp "Seed-stage B2B SaaS in Europe"
prospector scan --only-new --webhook https://hooks.slack.com/services/...
prospector scan --json | jq '.[] | select(.tier=="hot")'
prospector scan --no-ai                                # rules only, zero API calls
```

Run `prospector <command> --help` for all options. Settings can also live in `.env` (see `.env.example`).

## Output columns

`score, tier, company, signals, headline, round, amount, role, person, person_role, industry, location, investors, website, why_now, likely_needs, play, outreach_angle, icp_fit, summary, published, source, link, other_links, score_reasons, is_new, ai_enriched`

- **play**: the rule-based sales angle for the strongest signal.
- **outreach_angle**: Gemini's one-sentence opener, written to the company's leader.
- **score_reasons**: why the lead got its score, e.g. `+34 Raised pre-seed/seed; +20 Published in the last 48 hours; +9 AI fit with your ICP: 8/10`.

## Webhooks

`--webhook <url>` (or `WEBHOOK_URL`) posts the leads after each scan:
- **Slack** and **Discord** webhook URLs get a formatted message.
- Any other URL (Zapier, Make, n8n, your CRM) gets JSON: `{ generatedAt, count, leads: [...] }` with the same fields as the CSV.

## Running it daily

- **Windows Task Scheduler**: action `node`, arguments `C:\path\to\bin\prospector.js scan --only-new --webhook <url>`, start in the project folder.
- **cron**: `0 8 * * 1-5 cd /path/to/prospector && node bin/prospector.js scan --only-new`
- Or keep `prospector watch --every 120 --webhook <url>` running.

`data/state.json` remembers reported leads (60 days) and caches Gemini answers. Delete it to start fresh, or pass `--no-state`.

## Feeds

Edit `config/feeds.json` (`[{ "name": "...", "url": "..." }]`, `"enabled": false` to switch one off) or pass `--feeds my-feeds.txt` with one URL per line (`Name | URL` also works). `prospector feeds --check` tests them.

The fetcher identifies itself honestly (`HighIntentProspector/1.0`), times out after 15 s, retries once on 5xx, and reports bot walls (HTML instead of XML) clearly. Respect each publisher's terms. The Google News search (`--google-news`) is opt-in because Google limits that feed to personal, non-commercial use.

## Gemini details

- REST API with a JSON response schema, temperature 0.2, no SDK.
- Spaces requests to stay under the free tier (`GEMINI_RPM=14`), retries 429/5xx using the delay Gemini asks for, and switches to `GEMINI_FALLBACK_MODEL` when the main model is overloaded or out of daily quota.
- Only the top `MAX_AI_LEADS` (25) leads per run are sent. If the daily quota runs out, the scan still finishes with rule-based leads.
- Leads the AI marks as "not a buyer" (confidence ≥ 0.6) are removed; `--keep-rejected` keeps them.

## Project layout

```
bin/prospector.js     CLI (commander)
src/feeds.js          feed list loading, Google News search feeds
src/fetcher.js        HTTP with timeout, retry, bot-wall detection
src/parser.js         RSS 2.0 / RSS 1.0 / Atom -> articles
src/signals.js        buying-signal library, noise and distress patterns
src/detector.js       signal matching + company / amount / round / role extraction
src/pipeline.js       scan orchestration, de-duplication, grouping, AI step
src/ai.js             Gemini client, prompt, schema, rate limiter, model fallback
src/scorer.js         explainable 0-100 score and tiers
src/store.js          state file: seen leads, AI cache, history
src/output.js         CSV / JSON / Markdown / console / webhooks
config/feeds.json     default feeds
examples/feeds/       sample feeds (fictional companies) for the demo and tests
test/                 node:test suite (58 tests, no network or keys needed)
```

## Tests

```bash
npm test
```

All tests run offline: feeds come from `examples/feeds`, and Gemini and webhooks use injected fakes.

## License

MIT
