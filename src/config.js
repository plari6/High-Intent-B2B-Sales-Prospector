import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Loads .env from the current folder, then the project folder (first value wins). */
export function loadEnv() {
  if (process.env.PROSPECTOR_SKIP_DOTENV === '1') return;
  for (const file of [path.resolve('.env'), path.join(PROJECT_ROOT, '.env')]) {
    if (fs.existsSync(file)) dotenv.config({ path: file, quiet: true });
  }
}

const int = (value, fallback) => {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
};

export const splitList = (value) =>
  String(value || '')
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Reads settings from the environment. CLI flags override these in bin/prospector.js. */
export function readConfig(env = process.env) {
  return {
    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-flash-latest',
    // Used when the main model is overloaded or out of quota. Set to "none" to disable.
    geminiFallbackModel: env.GEMINI_FALLBACK_MODEL === 'none' ? '' : env.GEMINI_FALLBACK_MODEL || 'gemini-flash-lite-latest',
    geminiRpm: int(env.GEMINI_RPM, 14),
    geminiTimeoutMs: int(env.GEMINI_TIMEOUT_MS, 60000),
    offer: env.SENDER_OFFER || '',
    icp: env.TARGET_ICP || '',
    keywords: splitList(env.KEYWORDS),
    feedsFile: env.FEEDS_FILE || '',
    days: int(env.LOOKBACK_DAYS, 7),
    minScore: int(env.MIN_SCORE, 40),
    maxAi: int(env.MAX_AI_LEADS, 25),
    outDir: env.OUTPUT_DIR || 'output',
    stateFile: env.STATE_FILE || path.join(PROJECT_ROOT, 'data', 'state.json'),
    webhookUrl: env.WEBHOOK_URL || '',
    fetchTimeoutMs: int(env.FETCH_TIMEOUT_MS, 15000),
    userAgent:
      env.USER_AGENT ||
      'HighIntentProspector/1.0 (+https://github.com/plari6/High-Intent-B2B-Sales-Prospector)',
  };
}
