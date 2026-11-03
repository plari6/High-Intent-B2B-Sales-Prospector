import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400000;

/**
 * Small JSON state file:
 *  - seen:    lead keys already reported (so `watch` and --only-new show only fresh leads)
 *  - aiCache: Gemini answers per article, so re-runs cost no API calls
 *  - history: the last 500 leads reported
 */
export class Store {
  constructor(file, { retentionDays = 60 } = {}) {
    this.file = file;
    this.retentionMs = retentionDays * DAY;
    this.data = { seen: {}, aiCache: {}, history: [] };
    this.dirty = false;
    if (file && fs.existsSync(file)) {
      try {
        this.data = { ...this.data, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch {
        // A corrupt state file should not stop the scan; it is rebuilt on save.
      }
    }
  }

  isSeen(key) {
    return Boolean(this.data.seen[key]);
  }

  markSeen(key, at = new Date()) {
    if (!this.data.seen[key]) {
      this.data.seen[key] = at.toISOString();
      this.dirty = true;
    }
  }

  getAi(key) {
    return this.data.aiCache[key]?.result;
  }

  setAi(key, result, at = new Date()) {
    this.data.aiCache[key] = { at: at.toISOString(), result };
    this.dirty = true;
  }

  addHistory(leads, at = new Date()) {
    for (const l of leads) {
      this.data.history.push({
        at: at.toISOString(),
        key: l.key,
        company: l.company,
        score: l.score,
        tier: l.tier,
        signals: l.signals.map((s) => s.label),
        headline: l.headline,
        link: l.link,
      });
    }
    this.data.history = this.data.history.slice(-500);
    this.dirty = true;
  }

  history(limit = 50) {
    return this.data.history.slice(-limit).reverse();
  }

  prune(now = new Date()) {
    const cutoff = now.getTime() - this.retentionMs;
    for (const bucket of ['seen', 'aiCache']) {
      for (const [k, v] of Object.entries(this.data[bucket])) {
        const at = Date.parse(typeof v === 'string' ? v : v.at);
        if (!(at >= cutoff)) {
          delete this.data[bucket][k];
          this.dirty = true;
        }
      }
    }
  }

  save() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }
}

/** In-memory store for tests and --no-state runs. */
export const memoryStore = () => new Store(null);
