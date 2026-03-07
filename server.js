/**
 * Satoshi Scraper — Self-hosted proxy for HTML-scraped data sources.
 *
 * Runs on UmbrelOS / Docker / Portainer.
 * Exposed via Cloudflare Tunnel so Vercel can fetch pre-scraped JSON.
 *
 * Proxied sources:
 *   1. investing.com  → /api/scrape/investing-currencies
 *   2. bitinfocharts   → /api/scrape/bitinfocharts-richlist
 *   3. bitnodes.io     → /api/scrape/bitnodes-nodes  (API + HTML fallback)
 *   4. newhedge.io     → /api/scrape/newhedge-global-assets
 */

import express from 'express';
import cron from 'node-cron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const PORT = Number(process.env.PORT || 9119);
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_DIR = path.resolve(process.cwd(), 'cache');

// ─────────────────────────────────────────────
//  Disk persistence helpers
// ─────────────────────────────────────────────
async function ensureCacheDir() {
  try {
    await mkdir(CACHE_DIR, { recursive: true });
  } catch {
    /* ignore if already exists */
  }
}

async function readDiskCache(key) {
  try {
    const text = await readFile(path.join(CACHE_DIR, `${key}.json`), 'utf8');
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || !parsed.data) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeDiskCache(key, data, nextRunAt) {
  try {
    const entry = {
      data,
      scrapedAt: new Date().toISOString(),
      nextRunAt: nextRunAt instanceof Date ? nextRunAt.toISOString() : nextRunAt,
    };
    await writeFile(path.join(CACHE_DIR, `${key}.json`), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');
  } catch (e) {
    console.warn(`[disk] Failed to write cache for ${key}: ${e.message}`);
  }
}

// ─────────────────────────────────────────────
//  In-memory cache
// ─────────────────────────────────────────────
const cache = new Map();

function cached(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  return entry;
}

function setCache(key, data) {
  cache.set(key, {
    data,
    updatedAt: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────
//  Shared fetch helpers
// ─────────────────────────────────────────────
async function fetchText(url, { headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, { headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: 'application/json',
        ...headers,
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// ═══════════════════════════════════════════════
//  1. INVESTING.COM — FX currency crosses
// ═══════════════════════════════════════════════
const INVESTING_URL = 'https://www.investing.com/currencies/single-currency-crosses?currency=usd';

async function scrapeInvestingCurrencies() {
  console.log('[scrape] investing.com currencies ...');
  const html = await fetchText(INVESTING_URL);
  console.log(`[scrape] investing.com → ${html.length} bytes`);
  setCache('investing-currencies', { html, source: 'investing.com', url: INVESTING_URL });
}

// ═══════════════════════════════════════════════
//  2. BITINFOCHARTS — Richest addresses & distribution
// ═══════════════════════════════════════════════
const BITINFOCHARTS_URL = 'https://bitinfocharts.com/top-100-richest-bitcoin-addresses.html';

// Next daily run at 02:00 UTC
function nextBitinfochartsRunAt() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 2, 0, 0, 0));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

async function scrapeBitinfocharts() {
  console.log('[scrape] bitinfocharts.com richlist ...');
  const html = await fetchText(BITINFOCHARTS_URL);
  console.log(`[scrape] bitinfocharts.com → ${html.length} bytes`);
  const data = { html, source: 'bitinfocharts.com', url: BITINFOCHARTS_URL };
  setCache('bitinfocharts-richlist', data);
  await writeDiskCache('bitinfocharts-richlist', data, nextBitinfochartsRunAt());
}

// ═══════════════════════════════════════════════
//  3. BITNODES.IO — Bitcoin nodes (API + HTML fallback)
// ═══════════════════════════════════════════════
const BITNODES_API_URL = 'https://bitnodes.io/api/v1/snapshots/latest/?field=sorted_asns';
const BITNODES_SNAPSHOT_URL = 'https://bitnodes.io/api/v1/snapshots/latest/';
const BITNODES_NODES_PAGE_URL = 'https://bitnodes.io/nodes/';

// Next snapshot run at 06:05 or 18:05 UTC (5 min after bitnodes.io snapshots)
function nextBitnodesRunAt() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const candidates = [
    new Date(Date.UTC(y, m, d, 6, 5, 0, 0)),
    new Date(Date.UTC(y, m, d, 18, 5, 0, 0)),
    new Date(Date.UTC(y, m, d + 1, 6, 5, 0, 0)),
  ];
  return candidates.find((c) => c > now) || candidates[candidates.length - 1];
}

async function scrapeBitnodes() {
  console.log('[scrape] bitnodes.io ...');

  let apiData = null;
  let snapshotData = null;
  let nodesHtml = null;
  let apiError = null;

  // Try API first
  try {
    const [apiResult, snapshotResult] = await Promise.allSettled([
      fetchJson(BITNODES_API_URL),
      fetchJson(BITNODES_SNAPSHOT_URL),
    ]);
    if (apiResult.status === 'fulfilled') apiData = apiResult.value;
    else apiError = String(apiResult.reason);
    if (snapshotResult.status === 'fulfilled') snapshotData = snapshotResult.value;
  } catch (e) {
    apiError = e instanceof Error ? e.message : String(e);
  }

  // Always try HTML scrape as well (for fallback data)
  try {
    nodesHtml = await fetchText(BITNODES_NODES_PAGE_URL);
    console.log(`[scrape] bitnodes.io HTML → ${nodesHtml.length} bytes`);
  } catch (e) {
    console.warn(`[scrape] bitnodes.io HTML fallback failed: ${e.message}`);
  }

  const result = {
    source: 'bitnodes.io',
    apiData,
    snapshotData,
    nodesHtml,
    apiError,
  };

  if (apiData) {
    console.log('[scrape] bitnodes.io API → OK');
  } else {
    console.warn(`[scrape] bitnodes.io API → FAIL (${apiError})`);
  }

  setCache('bitnodes-nodes', result);
  await writeDiskCache('bitnodes-nodes', result, nextBitnodesRunAt());
}

// ═══════════════════════════════════════════════
//  4. NEWHEDGE.IO — Global asset values
// ═══════════════════════════════════════════════
const NEWHEDGE_URL = 'https://newhedge.io/bitcoin/global-asset-values';
const NEWHEDGE_JINA_URL = 'https://r.jina.ai/http://newhedge.io/bitcoin/global-asset-values';

async function scrapeNewhedge() {
  console.log('[scrape] newhedge.io global assets ...');

  // Try jina.ai reader first (returns markdown, easier to parse)
  let markdown = null;
  try {
    markdown = await fetchText(NEWHEDGE_JINA_URL, {
      headers: {
        Accept: 'text/plain, text/markdown, text/html;q=0.9',
        'User-Agent': 'satoshi-dashboard/1.0 (+module-s13-newhedge-scraper)',
      },
    });
    console.log(`[scrape] newhedge.io (jina) → ${markdown.length} bytes`);
  } catch (e) {
    console.warn(`[scrape] newhedge.io jina failed: ${e.message}, trying direct...`);
    // Fallback: direct HTML
    try {
      markdown = await fetchText(NEWHEDGE_URL);
      console.log(`[scrape] newhedge.io (direct) → ${markdown.length} bytes`);
    } catch (e2) {
      console.error(`[scrape] newhedge.io direct also failed: ${e2.message}`);
    }
  }

  if (markdown) {
    setCache('newhedge-global-assets', {
      html: markdown,
      source: 'newhedge.io',
      url: NEWHEDGE_URL,
      fetchUrl: NEWHEDGE_JINA_URL,
    });
  }
}

// ═══════════════════════════════════════════════
//  Disk cache warm-up (runs at startup)
// ═══════════════════════════════════════════════
async function warmUpFromDisk() {
  const persistedKeys = ['bitinfocharts-richlist', 'bitnodes-nodes'];
  for (const key of persistedKeys) {
    const entry = await readDiskCache(key);
    if (entry?.data) {
      cache.set(key, { data: entry.data, updatedAt: entry.scrapedAt });
      console.log(`[disk] Loaded ${key} from disk (scraped at ${entry.scrapedAt})`);
    }
  }
}

// ═══════════════════════════════════════════════
//  Scrape orchestrator
// ═══════════════════════════════════════════════
async function scrapeAll() {
  const jobs = [
    { name: 'investing-currencies', fn: scrapeInvestingCurrencies },
    { name: 'bitinfocharts-richlist', fn: scrapeBitinfocharts },
    { name: 'bitnodes-nodes', fn: scrapeBitnodes },
    { name: 'newhedge-global-assets', fn: scrapeNewhedge },
  ];

  for (const job of jobs) {
    try {
      await job.fn();
    } catch (e) {
      console.error(`[scrape] ${job.name} FAILED: ${e.message}`);
    }
  }
}

// ═══════════════════════════════════════════════
//  Express API
// ═══════════════════════════════════════════════
const app = express();

// Middleware: CORS for Vercel
app.use((_req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  const keys = [...cache.keys()];
  const status = {};
  for (const key of keys) {
    const entry = cached(key);
    status[key] = entry ? { updatedAt: entry.updatedAt, hasData: Boolean(entry.data) } : null;
  }
  res.json({ status: 'ok', uptime: process.uptime(), caches: status });
});

// Generic handler for cached scrape data
function serveCached(key) {
  return (_req, res) => {
    const entry = cached(key);
    if (!entry || !entry.data) {
      res.status(503).json({ error: `${key} not yet scraped`, availableAt: 'wait for next cron cycle' });
      return;
    }
    res.json({
      ...entry.data,
      _meta: {
        cachedAt: entry.updatedAt,
        scraper: 'satoshi-scraper',
      },
    });
  };
}

// 1. Investing.com currencies
app.get('/api/scrape/investing-currencies', serveCached('investing-currencies'));

// 2. BitInfoCharts richlist
app.get('/api/scrape/bitinfocharts-richlist', serveCached('bitinfocharts-richlist'));

// 3. Bitnodes nodes
app.get('/api/scrape/bitnodes-nodes', serveCached('bitnodes-nodes'));

// 4. Newhedge global assets
app.get('/api/scrape/newhedge-global-assets', serveCached('newhedge-global-assets'));

// Manual refresh trigger
app.get('/api/scrape/refresh', async (_req, res) => {
  try {
    await scrapeAll();
    res.json({ status: 'refreshed', timestamp: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════════════════════
//  Cron schedules
// ═══════════════════════════════════════════════

// Investing.com: every 60 seconds (reduced from 30s; FX updates ~15-30s, backend TTL 30s)
cron.schedule('0 * * * * *', () => {
  scrapeInvestingCurrencies().catch((e) => console.error('[cron] investing:', e.message));
});

// BitInfoCharts: once per day at 02:00 UTC (on-chain data changes every ~24h)
cron.schedule('0 2 * * *', () => {
  scrapeBitinfocharts().catch((e) => console.error('[cron] bitinfocharts:', e.message));
});

// Bitnodes: twice daily at 06:05 and 18:05 UTC (5 min after bitnodes.io snapshots)
cron.schedule('5 6,18 * * *', () => {
  scrapeBitnodes().catch((e) => console.error('[cron] bitnodes:', e.message));
});

// Newhedge: every hour (aligned with source update frequency)
cron.schedule('0 * * * *', () => {
  scrapeNewhedge().catch((e) => console.error('[cron] newhedge:', e.message));
});

// ═══════════════════════════════════════════════
//  Start
// ═══════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🛰️  Satoshi Scraper running on http://0.0.0.0:${PORT}`);
  console.log('   Endpoints:');
  console.log('     GET /health');
  console.log('     GET /api/scrape/investing-currencies');
  console.log('     GET /api/scrape/bitinfocharts-richlist');
  console.log('     GET /api/scrape/bitnodes-nodes');
  console.log('     GET /api/scrape/newhedge-global-assets');
  console.log('     GET /api/scrape/refresh');
  console.log('\n   Cron schedules:');
  console.log('     investing-currencies  : every 60s');
  console.log('     bitinfocharts-richlist: daily at 02:00 UTC');
  console.log('     bitnodes-nodes        : 06:05 and 18:05 UTC');
  console.log('     newhedge-global-assets: every hour');
  console.log('\n   Loading cached data from disk...\n');

  await ensureCacheDir();
  await warmUpFromDisk();
  console.log('\n   Running initial scrape...\n');

  await scrapeAll();
  console.log('\n✅ Initial scrape complete. Cron schedules active.\n');
});
