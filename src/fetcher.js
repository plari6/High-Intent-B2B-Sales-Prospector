const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FeedError extends Error {
  constructor(message, { status, retryable = false } = {}) {
    super(message);
    this.name = 'FeedError';
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Downloads one feed and returns its XML text.
 * Retries once on network errors, timeouts, 429 and 5xx. Rejects HTML pages
 * (bot walls, error pages) with a clear message instead of parsing them.
 */
export async function fetchFeedText(
  url,
  { fetchImpl = fetch, timeoutMs = 15000, userAgent, retries = 1, sleepImpl = sleep } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetchOnce(url, { fetchImpl, timeoutMs, userAgent });
    } catch (err) {
      const retryable = err.retryable ?? true;
      if (attempt >= retries || !retryable) throw err;
      await sleepImpl(1000 * 2 ** attempt);
    }
  }
}

async function fetchOnce(url, { fetchImpl, timeoutMs, userAgent }) {
  let res;
  try {
    res = await fetchImpl(url, {
      headers: {
        'user-agent': userAgent,
        accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const why = err.name === 'TimeoutError' ? `timed out after ${timeoutMs} ms` : err.cause?.code || err.message;
    throw new FeedError(`network error: ${why}`, { retryable: true });
  }
  if (!res.ok) {
    throw new FeedError(`HTTP ${res.status}${res.status === 403 ? ' (blocked by the site)' : ''}`, {
      status: res.status,
      retryable: res.status === 429 || res.status >= 500,
    });
  }
  const text = await res.text();
  const head = text.slice(0, 600).trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
    throw new FeedError('returned an HTML page instead of a feed (bot wall or wrong URL)', { retryable: false });
  }
  return text;
}

/** Runs async work over items with a fixed number of workers, keeping input order. */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
