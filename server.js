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
 *   5. companiesmarketcap.com → /api/scrape/companiesmarketcap-gold
 *   6. mempool.space ws → /api/scrape/mempool-space-memory-usage
 *   7. mempool knots json → /api/scrape/mempool-knots-init-data-json
 *   8. mempool knots usage → /api/scrape/mempool-knots-memory-usage
 */

import express from 'express';
import cron from 'node-cron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';

const PORT = Number(process.env.PORT || 9119);
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_DIR = path.resolve(process.cwd(), 'cache');
const MEMPOOL_SPACE_WS_URL = process.env.MEMPOOL_SPACE_WS_URL || 'wss://mempool.space/api/v1/ws';
const MEMPOOL_SPACE_RECONNECT_MS = Number(process.env.MEMPOOL_SPACE_RECONNECT_MS || 1000);
const MEMPOOL_SPACE_CACHE_KEY = 'mempool-space-memory-usage';
const MEMPOOL_KNOTS_HTTP_BASE = process.env.MEMPOOL_KNOTS_HTTP_BASE || 'https://knotapi.zatobox.io';
const MEMPOOL_KNOTS_HTTP_POLL_INTERVAL_MS = Number(process.env.MEMPOOL_KNOTS_HTTP_POLL_INTERVAL_MS || 1000);
const MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY = 'mempool-knots-init-data-json';
const MEMPOOL_KNOTS_CACHE_KEY = 'mempool-knots-memory-usage';
const HTTPS_REDIRECT_HOST = (process.env.HTTPS_REDIRECT_HOST || 'api.zatobox.io').toLowerCase();
const CORS_ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || 'https://zatobox.io,https://www.zatobox.io')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const STARTUP_REQUIRED_KEYS = [
  'investing-currencies',
  'bitinfocharts-richlist',
  'bitnodes-nodes',
  'newhedge-global-assets',
  'companiesmarketcap-gold',
];

const ENDPOINT_CACHE_CONTROL = {
  'investing-currencies': { sMaxAge: 30, swr: 60 },
  'bitinfocharts-richlist': { sMaxAge: 3600, swr: 7200 },
  'bitnodes-nodes': { sMaxAge: 21600, swr: 3600 },
  'newhedge-global-assets': { sMaxAge: 3600, swr: 7200 },
  'companiesmarketcap-gold': { sMaxAge: 900, swr: 1800 },
  [MEMPOOL_SPACE_CACHE_KEY]: { sMaxAge: 5, swr: 20 },
  [MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY]: { sMaxAge: 1, swr: 3 },
  [MEMPOOL_KNOTS_CACHE_KEY]: { sMaxAge: 1, swr: 3 },
};

let mempoolSpaceLastError = null;
let mempoolSpaceReconnectTimer = null;
let mempoolSpaceSocket = null;
let mempoolKnotsLastError = null;
let mempoolKnotsSnapshotTimer = null;
let mempoolKnotsLatestData = null;
let mempoolKnotsLatestInitData = null;
let mempoolKnotsHttpPollInFlight = false;

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

function setCacheAt(key, data, updatedAt) {
  cache.set(key, {
    data,
    updatedAt,
  });
}

function setPublicCacheHeaders(res, policy) {
  if (!policy) return;
  res.set('Cache-Control', `public, s-maxage=${policy.sMaxAge}, stale-while-revalidate=${policy.swr}`);
}

function hasCachedData(key) {
  const entry = cached(key);
  return Boolean(entry?.data);
}

function getReadinessStatus() {
  const readyKeys = STARTUP_REQUIRED_KEYS.filter((key) => hasCachedData(key));
  return {
    ready: readyKeys.length === STARTUP_REQUIRED_KEYS.length,
    readyKeys,
    missingKeys: STARTUP_REQUIRED_KEYS.filter((key) => !readyKeys.includes(key)),
  };
}

function nextIntervalRunAt(intervalMs) {
  return new Date(Date.now() + intervalMs);
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

function extractFirstMatch(text, regex, fieldName) {
  const match = text.match(regex);
  if (!match?.[1]) {
    throw new Error(`Could not extract ${fieldName}`);
  }
  return match[1].trim();
}

function scheduleMempoolSpaceReconnect() {
  if (mempoolSpaceReconnectTimer) return;

  mempoolSpaceReconnectTimer = setTimeout(() => {
    mempoolSpaceReconnectTimer = null;
    startMempoolSpaceStream();
  }, MEMPOOL_SPACE_RECONNECT_MS);
}

function handleMempoolSpaceMessage(raw) {
  let message;
  try {
    message = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    return;
  }

  const mempoolInfo = message?.mempoolInfo;
  if (!mempoolInfo || typeof mempoolInfo.usage !== 'number') return;

  const usagePct = typeof mempoolInfo.maxmempool === 'number' && mempoolInfo.maxmempool > 0
    ? Number(((mempoolInfo.usage / mempoolInfo.maxmempool) * 100).toFixed(2))
    : null;

  setCache(MEMPOOL_SPACE_CACHE_KEY, {
    source: 'mempool.space',
    metric: 'memory-usage',
    usage: mempoolInfo.usage,
    maxmempool: mempoolInfo.maxmempool ?? null,
    usagePct,
    bytes: mempoolInfo.bytes ?? null,
    size: mempoolInfo.size ?? null,
    mempoolInfo,
    url: 'https://mempool.space/',
    wsUrl: MEMPOOL_SPACE_WS_URL,
  });

  mempoolSpaceLastError = null;
}

function startMempoolSpaceStream() {
  if (mempoolSpaceSocket && (mempoolSpaceSocket.readyState === WebSocket.OPEN || mempoolSpaceSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log(`[ws] mempool.space stats stream → ${MEMPOOL_SPACE_WS_URL}`);
  const ws = new WebSocket(MEMPOOL_SPACE_WS_URL);
  mempoolSpaceSocket = ws;

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ action: 'want', data: ['stats'] }));
  });

  ws.addEventListener('message', (event) => {
    handleMempoolSpaceMessage(event.data);
  });

  ws.addEventListener('error', () => {
    mempoolSpaceLastError = 'mempool.space websocket error';
  });

  ws.addEventListener('close', () => {
    mempoolSpaceLastError = mempoolSpaceLastError || 'mempool.space websocket closed';
    if (mempoolSpaceSocket === ws) {
      mempoolSpaceSocket = null;
    }
    scheduleMempoolSpaceReconnect();
  });
}

function nextMempoolKnotsRunAt() {
  return new Date(Date.now() + 1000);
}

function mempoolKnotsInitDataUrl() {
  return `${MEMPOOL_KNOTS_HTTP_BASE.replace(/\/$/, '')}/api/v1/init-data`;
}

function buildMempoolKnotsPayload(mempoolInfo) {
  const usagePct = typeof mempoolInfo.maxmempool === 'number' && mempoolInfo.maxmempool > 0
    ? Number(((mempoolInfo.usage / mempoolInfo.maxmempool) * 100).toFixed(2))
    : null;

  return {
    source: 'mempool knots',
    metric: 'memory-usage',
    usage: mempoolInfo.usage,
    maxmempool: mempoolInfo.maxmempool ?? null,
    usagePct,
    bytes: mempoolInfo.bytes ?? null,
    size: mempoolInfo.size ?? null,
    mempoolInfo,
    url: MEMPOOL_KNOTS_HTTP_BASE,
    fetchUrl: mempoolKnotsInitDataUrl(),
  };
}

async function persistMempoolKnotsSnapshot() {
  if (!mempoolKnotsLatestData) return;

  const nowIso = new Date().toISOString();
  setCacheAt(MEMPOOL_KNOTS_CACHE_KEY, mempoolKnotsLatestData, nowIso);
  await writeDiskCache(MEMPOOL_KNOTS_CACHE_KEY, mempoolKnotsLatestData, nextMempoolKnotsRunAt());
}

async function persistMempoolKnotsInitDataSnapshot() {
  if (!mempoolKnotsLatestInitData) return;

  const nowIso = new Date().toISOString();
  setCacheAt(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY, mempoolKnotsLatestInitData, nowIso);
  await writeDiskCache(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY, mempoolKnotsLatestInitData, nextMempoolKnotsRunAt());
}

async function pollMempoolKnotsHttp() {
  if (mempoolKnotsHttpPollInFlight) return;
  mempoolKnotsHttpPollInFlight = true;

  try {
    const initData = await fetchJson(mempoolKnotsInitDataUrl(), { timeoutMs: 4000 });
    const mempoolInfo = initData?.mempoolInfo;
    if (!mempoolInfo || typeof mempoolInfo.usage !== 'number') {
      throw new Error('mempoolInfo missing in init-data');
    }

    mempoolKnotsLatestInitData = {
      source: 'mempool knots',
      kind: 'init-data',
      url: MEMPOOL_KNOTS_HTTP_BASE,
      fetchUrl: mempoolKnotsInitDataUrl(),
      data: initData,
    };

    mempoolKnotsLatestData = buildMempoolKnotsPayload(mempoolInfo);
    setCache(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY, mempoolKnotsLatestInitData);
    setCache(MEMPOOL_KNOTS_CACHE_KEY, mempoolKnotsLatestData);
    mempoolKnotsLastError = null;
  } catch (e) {
    mempoolKnotsLastError = e instanceof Error ? e.message : String(e);
    console.warn(`[http] mempool knots poll failed: ${mempoolKnotsLastError}`);
  } finally {
    mempoolKnotsHttpPollInFlight = false;
  }
}

function startMempoolKnotsSnapshotLoop() {
  if (mempoolKnotsSnapshotTimer) return;

  pollMempoolKnotsHttp().catch((e) => {
    console.warn(`[http] Failed initial mempool knots poll: ${e.message}`);
  });

  persistMempoolKnotsSnapshot().catch((e) => {
    console.warn(`[disk] Failed initial mempool knots snapshot write: ${e.message}`);
  });
  persistMempoolKnotsInitDataSnapshot().catch((e) => {
    console.warn(`[disk] Failed initial mempool knots init-data write: ${e.message}`);
  });

  mempoolKnotsSnapshotTimer = setInterval(() => {
    pollMempoolKnotsHttp().catch((e) => {
      console.warn(`[http] Failed mempool knots poll: ${e.message}`);
    });
    persistMempoolKnotsSnapshot().catch((e) => {
      console.warn(`[disk] Failed mempool knots snapshot write: ${e.message}`);
    });
    persistMempoolKnotsInitDataSnapshot().catch((e) => {
      console.warn(`[disk] Failed mempool knots init-data write: ${e.message}`);
    });
  }, MEMPOOL_KNOTS_HTTP_POLL_INTERVAL_MS);
}

// ═══════════════════════════════════════════════
//  1. INVESTING.COM — FX currency crosses
// ═══════════════════════════════════════════════
const INVESTING_URL = 'https://www.investing.com/currencies/single-currency-crosses?currency=usd';

async function scrapeInvestingCurrencies() {
  console.log('[scrape] investing.com currencies ...');
  const html = await fetchText(INVESTING_URL);
  console.log(`[scrape] investing.com → ${html.length} bytes`);
  const data = { html, source: 'investing.com', url: INVESTING_URL };
  setCache('investing-currencies', data);
  await writeDiskCache('investing-currencies', data, nextIntervalRunAt(60_000));
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

  if (!apiData || !snapshotData) {
    try {
      nodesHtml = await fetchText(BITNODES_NODES_PAGE_URL);
      console.log(`[scrape] bitnodes.io HTML → ${nodesHtml.length} bytes`);
    } catch (e) {
      console.warn(`[scrape] bitnodes.io HTML fallback failed: ${e.message}`);
    }
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
    const data = {
      html: markdown,
      source: 'newhedge.io',
      url: NEWHEDGE_URL,
      fetchUrl: NEWHEDGE_JINA_URL,
    };
    setCache('newhedge-global-assets', data);
    await writeDiskCache('newhedge-global-assets', data, nextIntervalRunAt(60 * 60_000));
  }
}

// ═══════════════════════════════════════════════
//  5. COMPANIESMARKETCAP.COM — Gold market cap
// ═══════════════════════════════════════════════
const COMPANIESMARKETCAP_GOLD_URL = 'https://companiesmarketcap.com/gold/marketcap/';
const COMPANIESMARKETCAP_ASSETS_URL = 'https://companiesmarketcap.com/assets-by-market-cap/';

function parseCompaniesMarketCapGoldDetails(html) {
  const marketCap = extractFirstMatch(html, /<h2>\s*Estimated Market Cap:\s*([^<]+)\s*<\/h2>/i, 'gold market cap');
  const price = extractFirstMatch(
    html,
    /current gold price\s*\((\$[\d,]+)\s*per ounce\)/i,
    'gold price'
  );

  return { marketCap, price };
}

function parseCompaniesMarketCapGoldToday(html) {
  const rowMatch = html.match(/<tr class="precious-metals-outliner">[\s\S]*?<a href="\/gold\/marketcap\/">[\s\S]*?<\/tr>/i);
  if (!rowMatch?.[0]) {
    throw new Error('Could not find Gold row in assets table');
  }

  const row = rowMatch[0];
  const id = extractFirstMatch(row, /<div class="company-code">(?:<span[^>]*><\/span>)?\s*([^<\s]+)\s*<\/div>/i, 'gold id');
  const changeTodayPct = extractFirstMatch(
    row,
    /<td class="rh-sm"[^>]*>\s*<span[^>]*>\s*([+\-]?[\d.,]+%)\s*<\/span>\s*<\/td>/i,
    'gold change today'
  );

  return { id, changeTodayPct };
}

async function scrapeCompaniesMarketCapGold() {
  console.log('[scrape] companiesmarketcap.com gold ...');

  const [goldHtml, assetsHtml] = await Promise.all([
    fetchText(COMPANIESMARKETCAP_GOLD_URL),
    fetchText(COMPANIESMARKETCAP_ASSETS_URL),
  ]);

  console.log(`[scrape] companiesmarketcap.com gold page → ${goldHtml.length} bytes`);
  console.log(`[scrape] companiesmarketcap.com assets page → ${assetsHtml.length} bytes`);

  const details = parseCompaniesMarketCapGoldDetails(goldHtml);
  const summary = parseCompaniesMarketCapGoldToday(assetsHtml);

  const data = {
    source: 'companiesmarketcap.com',
    id: summary.id,
    marketCap: details.marketCap,
    price: details.price,
    changeTodayPct: summary.changeTodayPct,
    url: COMPANIESMARKETCAP_GOLD_URL,
    assetsUrl: COMPANIESMARKETCAP_ASSETS_URL,
  };
  setCache('companiesmarketcap-gold', data);
  await writeDiskCache('companiesmarketcap-gold', data, nextIntervalRunAt(15 * 60_000));
}

// ═══════════════════════════════════════════════
//  Disk cache warm-up (runs at startup)
// ═══════════════════════════════════════════════
async function warmUpFromDisk() {
  const persistedKeys = [
    'investing-currencies',
    'bitinfocharts-richlist',
    'bitnodes-nodes',
    'newhedge-global-assets',
    'companiesmarketcap-gold',
    MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY,
    MEMPOOL_KNOTS_CACHE_KEY,
  ];
  for (const key of persistedKeys) {
    const entry = await readDiskCache(key);
    if (entry?.data) {
      cache.set(key, { data: entry.data, updatedAt: entry.scrapedAt });
      console.log(`[disk] Loaded ${key} from disk (scraped at ${entry.scrapedAt})`);
      if (key === MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY) {
        mempoolKnotsLatestInitData = entry.data;
      }
      if (key === MEMPOOL_KNOTS_CACHE_KEY) {
        mempoolKnotsLatestData = entry.data;
      }
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
    { name: 'companiesmarketcap-gold', fn: scrapeCompaniesMarketCapGold },
  ];

  const results = await Promise.allSettled(jobs.map(async (job) => {
    await job.fn();
    return job.name;
  }));

  results.forEach((result, index) => {
    if (result.status === 'rejected') {
      console.error(`[scrape] ${jobs[index].name} FAILED: ${result.reason?.message || result.reason}`);
    }
  });
}

// ═══════════════════════════════════════════════
//  Express API
// ═══════════════════════════════════════════════
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// Middleware: force HTTPS for public host + set HSTS on secure requests
app.use((req, res, next) => {
  const host = (req.headers.host || '').split(':')[0].toLowerCase();
  const isSecure = req.secure || req.get('x-forwarded-proto') === 'https';

  if (host === HTTPS_REDIRECT_HOST && !isSecure) {
    return res.redirect(308, `https://${HTTPS_REDIRECT_HOST}${req.originalUrl}`);
  }

  if (isSecure) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  }

  next();
});

// Middleware: restrictive CORS allowlist
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && CORS_ALLOWED_ORIGINS.has(origin)) {
    res.set('Access-Control-Allow-Origin', origin);
    res.set('Vary', 'Origin');
    res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
  }

  if (req.method === 'OPTIONS') {
    if (origin && !CORS_ALLOWED_ORIGINS.has(origin)) {
      return res.status(403).json({ error: 'origin not allowed' });
    }
    return res.sendStatus(204);
  }

  next();
});

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/readyz', (_req, res) => {
  const readiness = getReadinessStatus();
  if (!readiness.ready) {
    res.status(503).json({ status: 'warming', ...readiness });
    return;
  }
  res.json({ status: 'ready', ...readiness });
});

// Generic handler for cached scrape data
function serveCached(key) {
  return (_req, res) => {
    setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[key]);
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

// 5. CompaniesMarketCap gold
app.get('/api/scrape/companiesmarketcap-gold', serveCached('companiesmarketcap-gold'));

// 6. Mempool.space memory usage via websocket stats
app.get('/api/scrape/mempool-space-memory-usage', (_req, res) => {
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[MEMPOOL_SPACE_CACHE_KEY]);
  const entry = cached(MEMPOOL_SPACE_CACHE_KEY);
  if (!entry?.data) {
    res.status(503).json({ ok: false, error: mempoolSpaceLastError || 'mempool.space data not yet available' });
    return;
  }

  res.json({
    ...entry.data,
    _meta: {
      cachedAt: entry.updatedAt,
      scraper: 'satoshi-scraper',
      transport: 'websocket',
      subscription: 'stats',
    },
  });
});

// 7. Mempool Knots raw init-data snapshot JSON
app.get('/api/scrape/mempool-knots-init-data-json', (_req, res) => {
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY]);
  const entry = cached(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY);
  if (!entry?.data) {
    res.status(503).json({ ok: false, error: mempoolKnotsLastError || 'mempool knots init-data not yet available' });
    return;
  }

  res.json({
    ...entry.data,
    _meta: {
      cachedAt: entry.updatedAt,
      scraper: 'satoshi-scraper',
      transport: 'http-poll',
      fetchUrl: mempoolKnotsInitDataUrl(),
    },
  });
});

// 8. Mempool Knots memory usage relay
app.get('/api/scrape/mempool-knots-memory-usage', (_req, res) => {
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[MEMPOOL_KNOTS_CACHE_KEY]);
  const entry = cached(MEMPOOL_KNOTS_CACHE_KEY);
  if (!entry?.data) {
    res.status(503).json({ ok: false, error: mempoolKnotsLastError || 'mempool knots data not yet available' });
    return;
  }

  res.json({
    ...entry.data,
    _meta: {
      cachedAt: entry.updatedAt,
      scraper: 'satoshi-scraper',
      transport: 'snapshot-relay',
      sourceCache: MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY,
      fetchUrl: mempoolKnotsInitDataUrl(),
    },
  });
});


// 9. Compatibility: relay Knots init-data under public API path
app.get('/api/public/mempool/node', (_req, res) => {
  const entry = cached(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY);
  if (!entry?.data?.data) {
    res.status(503).json({ ok: false, error: mempoolKnotsLastError || 'mempool knots init-data not yet available' });
    return;
  }

  res.json(entry.data.data);
});

// 10. Compatibility: expose Knots-like init-data route from this API
app.get('/api/v1/init-data', (_req, res) => {
  const entry = cached(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY);
  if (!entry?.data?.data) {
    res.status(503).json({ ok: false, error: mempoolKnotsLastError || 'mempool knots init-data not yet available' });
    return;
  }

  res.json(entry.data.data);
});

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

// CompaniesMarketCap gold: every 15 minutes (source data is delayed, but intraday)
cron.schedule('*/15 * * * *', () => {
  scrapeCompaniesMarketCapGold().catch((e) => console.error('[cron] companiesmarketcap gold:', e.message));
});

// ═══════════════════════════════════════════════
//  Start
// ═══════════════════════════════════════════════
app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n🛰️  Satoshi Scraper running on http://0.0.0.0:${PORT}`);
  console.log('   Endpoints:');
  console.log('     GET /health');
  console.log('     GET /readyz');
  console.log('     GET /api/scrape/investing-currencies');
  console.log('     GET /api/scrape/bitinfocharts-richlist');
  console.log('     GET /api/scrape/bitnodes-nodes');
  console.log('     GET /api/scrape/newhedge-global-assets');
  console.log('     GET /api/scrape/companiesmarketcap-gold');
  console.log('     GET /api/scrape/mempool-space-memory-usage');
  console.log('     GET /api/scrape/mempool-knots-init-data-json');
  console.log('     GET /api/scrape/mempool-knots-memory-usage');
  console.log('     GET /api/public/mempool/node');
  console.log('     GET /api/v1/init-data');
  console.log('     GET /api/scrape/refresh');
  console.log('\n   Cron schedules:');
  console.log('     investing-currencies  : every 60s');
  console.log('     bitinfocharts-richlist: daily at 02:00 UTC');
  console.log('     bitnodes-nodes        : 06:05 and 18:05 UTC');
  console.log('     newhedge-global-assets: every hour');
  console.log('     companiesmarketcap-gold: every 15 min');
  console.log(`     mempool-space-memory-usage: realtime via WS (reconnect ${MEMPOOL_SPACE_RECONNECT_MS}ms)`);
  console.log(`     mempool-knots-init-data-json: snapshot json every ${MEMPOOL_KNOTS_HTTP_POLL_INTERVAL_MS}ms via local HTTP`);
  console.log(`     mempool-knots-memory-usage: relay cached json snapshot`);
  console.log('\n   Loading cached data from disk...\n');

  await ensureCacheDir();
  await warmUpFromDisk();
  startMempoolSpaceStream();
  startMempoolKnotsSnapshotLoop();
  console.log('\n   Running initial scrape...\n');

  scrapeAll()
    .then(() => {
      console.log('\n✅ Initial scrape complete. Cron schedules active.\n');
    })
    .catch((error) => {
      console.error(`\n❌ Initial scrape failed: ${error.message}\n`);
    });
});
