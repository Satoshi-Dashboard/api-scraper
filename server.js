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
 *   6. mempool.space memory → /api/scrape/mempool-space-memory-usage
 *   7. mempool.space fees → /api/scrape/mempool-space-transaction-fees
 *   8. mempool.space mempool → /api/scrape/mempool-space-unconfirmed-transactions
 *   9. mempool knots json → /api/scrape/mempool-knots-init-data-json
 *  10. mempool knots usage → /api/scrape/mempool-knots-memory-usage
 */

import express from 'express';
import cron from 'node-cron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import WebSocket from 'ws';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const BINANCE_KLINES = 'https://api.binance.com/api/v3/klines';
const SERIES_ID = 'MSPUS';
export const FRED_CACHE_KEY = 'fred-house-price';
const DAY_MS = 86_400_000;

function quarterLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

async function fetchFredObservations(apiKey) {
  const params = new URLSearchParams({
    series_id: SERIES_ID,
    sort_order: 'asc',
    limit: '1000',
    file_type: 'json',
    ...(apiKey ? { api_key: apiKey } : {}),
  });

  const res = await fetch(`${FRED_BASE}?${params}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`FRED ${res.status}`);
  const json = await res.json();

  return (json.observations ?? [])
    .filter(o => o.value !== '.' && o.value != null)
    .map(o => ({ date: o.date, value: Number(o.value) }));
}

async function fetchBinanceDailyHistory(startMs) {
  const all = [];
  let from = startMs;

  while (true) {
    const params = new URLSearchParams({
      symbol: 'BTCUSDT',
      interval: '1d',
      startTime: String(Math.round(from)),
      limit: '1000',
    });
    let res;
    try {
      res = await fetch(`${BINANCE_KLINES}?${params}`, {
        signal: AbortSignal.timeout(15_000),
      });
    } catch (e) {
      throw new Error(`Binance fetch failed: ${e.message}`);
    }
    if (!res.ok) throw new Error(`Binance ${res.status}`);
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) break;
    all.push(...rows);
    if (rows.length < 1000) break;
    from = Number(rows[rows.length - 1][0]) + 1;
  }

  const map = new Map();
  for (const row of all) {
    const ts = Number(row[0]);
    const close = Number(row[4]);
    if (Number.isFinite(ts) && Number.isFinite(close) && close > 0) {
      map.set(ts, close);
    }
  }
  return map;
}

async function buildFredHousePricePayload() {
  const apiKey = process.env.FRED_API_KEY || '';

  const [fredObs, btcMap] = await Promise.all([
    fetchFredObservations(apiKey),
    fetchBinanceDailyHistory(Date.now() - 400 * DAY_MS),
  ]);

  if (!fredObs?.length) {
    throw new Error('No FRED observations returned');
  }

  const firstFred = fredObs[0];
  const firstFredDate = new Date(firstFred.date + 'T00:00:00Z');
  const firstBtcDate = new Date(Math.min(...btcMap.keys()));
  const startDate = new Date(Math.max(firstFredDate.getTime(), firstBtcDate.getTime()));

  const points = [];
  const now = new Date();
  let current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  while (current <= now) {
    const ts = current.getTime();

    const q0Idx = fredObs.findIndex(o => new Date(o.date + 'T00:00:00Z') >= current);
    let usd = null;
    if (q0Idx > 0) {
      const q0 = fredObs[q0Idx - 1];
      const q1 = fredObs[q0Idx] || q0;
      const d0 = new Date(q0.date + 'T00:00:00Z');
      const d1 = q1 === q0 ? d0 : new Date(q1.date + 'T00:00:00Z');
      const t = (current.getTime() - d0.getTime()) / (d1.getTime() - d0.getTime() || 1);
      usd = q0.value + t * (q1.value - q0.value);
    }

    let btcClose = null;
    const dayStart = Math.floor(ts / DAY_MS) * DAY_MS;
    for (let offset = 0; offset <= 1; offset++) {
      const candidate = btcMap.get(dayStart + offset * DAY_MS);
      if (candidate) {
        btcClose = candidate;
        break;
      }
    }

    const homeInBtc = usd && btcClose ? usd / btcClose : null;

    if (usd) {
      points.push({
        ts,
        date: current.toISOString().split('T')[0],
        usd,
        homeInBtc,
      });
    }

    current = new Date(current.getFullYear(), current.getMonth() + 1, 1);
  }

  const latest = points[points.length - 1];
  const quarter = quarterLabel(fredObs[fredObs.length - 1].date);

  return {
    data: {
      points,
      latest_value: latest?.usd ?? null,
      latest_date: latest?.date ?? null,
      quarter_label: quarter,
    },
    next_update_at: null,
  };
}

function parseBooleanEnv(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseDatabaseUrl(connectionString) {
  if (!connectionString) {
    throw new Error('DATABASE_URL is missing');
  }

  try {
    const parsed = new URL(connectionString);
    return {
      host: parsed.hostname,
      port: Number(parsed.port || 5432),
      database: safeDecodeURIComponent(parsed.pathname.replace(/^\//, '') || 'postgres'),
      user: safeDecodeURIComponent(parsed.username),
      password: safeDecodeURIComponent(parsed.password),
    };
  } catch {
    const schemeMatch = connectionString.match(/^postgres(?:ql)?:\/\//i);
    if (!schemeMatch) {
      throw new Error('Unsupported DATABASE_URL format');
    }

    const remainder = connectionString.slice(schemeMatch[0].length);
    const slashIndex = remainder.indexOf('/');
    if (slashIndex === -1) {
      throw new Error('DATABASE_URL is missing a database path');
    }

    const authority = remainder.slice(0, slashIndex);
    const pathAndQuery = remainder.slice(slashIndex + 1);
    const atIndex = authority.lastIndexOf('@');
    if (atIndex === -1) {
      throw new Error('DATABASE_URL is missing credentials');
    }

    const credentials = authority.slice(0, atIndex);
    const hostPort = authority.slice(atIndex + 1);
    const credentialSeparatorIndex = credentials.indexOf(':');
    if (credentialSeparatorIndex === -1) {
      throw new Error('DATABASE_URL is missing a password separator');
    }

    let password = credentials.slice(credentialSeparatorIndex + 1);
    let passwordWasBracketed = false;
    if (password.startsWith('[') && password.endsWith(']')) {
      password = password.slice(1, -1);
      passwordWasBracketed = true;
    }

    const portSeparatorIndex = hostPort.lastIndexOf(':');
    if (portSeparatorIndex === -1) {
      throw new Error('DATABASE_URL is missing a port');
    }

    const queryIndex = pathAndQuery.indexOf('?');
    const databasePath = queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);

    return {
      host: hostPort.slice(0, portSeparatorIndex),
      port: Number(hostPort.slice(portSeparatorIndex + 1) || 5432),
      database: safeDecodeURIComponent(databasePath || 'postgres'),
      user: safeDecodeURIComponent(credentials.slice(0, credentialSeparatorIndex)),
      password: passwordWasBracketed ? password : safeDecodeURIComponent(password),
    };
  }
}

function buildDatabasePoolConfig(connectionString) {
  return {
    ...parseDatabaseUrl(connectionString),
    ssl: JOHOE_DB_SSL ? { rejectUnauthorized: false } : false,
  };
}

const PORT = Number(process.env.PORT || 9119);
const FETCH_TIMEOUT_MS = 20_000;
const CACHE_DIR = path.resolve(process.cwd(), 'cache');
const MEMPOOL_SPACE_WS_URL = process.env.MEMPOOL_SPACE_WS_URL || 'wss://mempool.space/api/v1/ws';
const MEMPOOL_SPACE_RECONNECT_MS = Number(process.env.MEMPOOL_SPACE_RECONNECT_MS || 1000);
const MEMPOOL_SPACE_STALE_MS = Number(process.env.MEMPOOL_SPACE_STALE_MS || 30_000);
const MEMPOOL_SPACE_MEMPOOL_URL = 'https://mempool.space/api/mempool';
const MEMPOOL_SPACE_MEMPOOL_POLL_INTERVAL_MS = Number(process.env.MEMPOOL_SPACE_MEMPOOL_POLL_INTERVAL_MS || 5000);
const MEMPOOL_SPACE_CACHE_KEY = 'mempool-space-memory-usage';
const MEMPOOL_SPACE_FEES_CACHE_KEY = 'mempool-space-transaction-fees';
const MEMPOOL_SPACE_UNCONFIRMED_CACHE_KEY = 'mempool-space-unconfirmed-transactions';
const MEMPOOL_KNOTS_HTTP_BASE = process.env.MEMPOOL_KNOTS_HTTP_BASE || 'https://upstream.example.com';
const MEMPOOL_KNOTS_HTTP_POLL_INTERVAL_MS = Number(process.env.MEMPOOL_KNOTS_HTTP_POLL_INTERVAL_MS || 1000);
const MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY = 'mempool-knots-init-data-json';
const MEMPOOL_KNOTS_CACHE_KEY = 'mempool-knots-memory-usage';
const JOHOE_BASE_URL = (process.env.JOHOE_BASE_URL || 'https://johoe.jochen-hoenicke.de/queue/2').replace(/\/$/, '');
const JOHOE_NETWORK = process.env.JOHOE_NETWORK || 'btc';
const JOHOE_LATEST_CACHE_KEY = 'johoe-btc-queue-latest';
const JOHOE_HISTORY_24H_CACHE_KEY = 'johoe-btc-queue-history-24h';
const JOHOE_HISTORY_30D_CACHE_KEY = 'johoe-btc-queue-history-30d';
const JOHOE_HISTORY_ALL_CACHE_KEY = 'johoe-btc-queue-history-all';
const JOHOE_24H_SYNC_INTERVAL_MS = Number(process.env.JOHOE_24H_SYNC_INTERVAL_MS || process.env.JOHOE_POLL_INTERVAL_MS || 60_000);
const JOHOE_30D_SYNC_INTERVAL_MS = Number(process.env.JOHOE_30D_SYNC_INTERVAL_MS || 900_000);
const JOHOE_ALL_SYNC_INTERVAL_MS = Number(process.env.JOHOE_ALL_SYNC_INTERVAL_MS || 21_600_000);
const JOHOE_STALE_MS = Number(process.env.JOHOE_STALE_MS || 180_000);
const JOHOE_QUERY_LIMIT_MAX = Number(process.env.JOHOE_QUERY_LIMIT_MAX || 5000);
const JOHOE_DB_ENABLED = parseBooleanEnv(process.env.JOHOE_DB_ENABLED, true);
const JOHOE_DB_SSL = parseBooleanEnv(process.env.JOHOE_DB_SSL, false);
const DATABASE_URL = process.env.DATABASE_URL || '';
const JOHOE_FORWARD_ENABLED = parseBooleanEnv(process.env.JOHOE_FORWARD_ENABLED, false);
const JOHOE_FORWARD_URL = process.env.JOHOE_FORWARD_URL || '';
const JOHOE_FORWARD_TOKEN = process.env.JOHOE_FORWARD_TOKEN || '';
const JOHOE_FORWARD_BATCH_SIZE = Number(process.env.JOHOE_FORWARD_BATCH_SIZE || 10);
const JOHOE_FORWARD_INTERVAL_MS = Number(process.env.JOHOE_FORWARD_INTERVAL_MS || 15_000);
const JOHOE_FORWARD_TIMEOUT_MS = Number(process.env.JOHOE_FORWARD_TIMEOUT_MS || 10_000);
const JOHOE_RANGE_CONFIG = {
  '24h': {
    key: '24h',
    label: '24h rolling',
    tableName: 'johoe_queue_24h_rolling',
    historyCacheKey: JOHOE_HISTORY_24H_CACHE_KEY,
    sourcePath: '24h.js',
    syncIntervalMs: JOHOE_24H_SYNC_INTERVAL_MS,
    defaultLimit: 1440,
    maxCachedPoints: 1440,
    resolution: 'minute',
    rolling: true,
    latestSource: true,
  },
  '30d': {
    key: '30d',
    label: '30d rolling',
    tableName: 'johoe_queue_30d_rolling',
    historyCacheKey: JOHOE_HISTORY_30D_CACHE_KEY,
    sourcePath: '30d.js',
    syncIntervalMs: JOHOE_30D_SYNC_INTERVAL_MS,
    defaultLimit: 1440,
    maxCachedPoints: 1440,
    resolution: '30-minute',
    rolling: true,
    latestSource: false,
  },
  all: {
    key: 'all',
    label: 'all daily',
    tableName: 'johoe_queue_all_daily',
    historyCacheKey: JOHOE_HISTORY_ALL_CACHE_KEY,
    sourcePath: 'all.js',
    syncIntervalMs: JOHOE_ALL_SYNC_INTERVAL_MS,
    defaultLimit: 3650,
    maxCachedPoints: JOHOE_QUERY_LIMIT_MAX,
    resolution: 'daily',
    rolling: false,
    latestSource: false,
  },
};

// Bucket definitions for Johoe BTC Queue (53 raw buckets mapped to 12 standard fee bands)
// These represent sat/vB ranges used by Johoe's upstream data
const JOHOE_BUCKET_DEFINITIONS = [
  { key: 'fee_0_1', label: '0-1', longLabel: '0-1 sat/vB', minFee: 0, maxFee: 1 },
  { key: 'fee_1_2', label: '1-2', longLabel: '1-2 sat/vB', minFee: 1, maxFee: 2 },
  { key: 'fee_2_3', label: '2-3', longLabel: '2-3 sat/vB', minFee: 2, maxFee: 3 },
  { key: 'fee_3_5', label: '3-5', longLabel: '3-5 sat/vB', minFee: 3, maxFee: 5 },
  { key: 'fee_5_10', label: '5-10', longLabel: '5-10 sat/vB', minFee: 5, maxFee: 10 },
  { key: 'fee_10_20', label: '10-20', longLabel: '10-20 sat/vB', minFee: 10, maxFee: 20 },
  { key: 'fee_20_50', label: '20-50', longLabel: '20-50 sat/vB', minFee: 20, maxFee: 50 },
  { key: 'fee_50_100', label: '50-100', longLabel: '50-100 sat/vB', minFee: 50, maxFee: 100 },
  { key: 'fee_100_200', label: '100-200', longLabel: '100-200 sat/vB', minFee: 100, maxFee: 200 },
  { key: 'fee_200_500', label: '200-500', longLabel: '200-500 sat/vB', minFee: 200, maxFee: 500 },
  { key: 'fee_500_1000', label: '500-1000', longLabel: '500-1000 sat/vB', minFee: 500, maxFee: 1000 },
  { key: 'fee_1000_plus', label: '1000+', longLabel: '1000+ sat/vB', minFee: 1000, maxFee: null },
];

const JOHOE_RANGE_KEYS = Object.keys(JOHOE_RANGE_CONFIG);
const REQUESTED_JOHOE_DEFAULT_RANGE = (process.env.JOHOE_DEFAULT_RANGE || '24h').toLowerCase();
const JOHOE_DEFAULT_RANGE = JOHOE_RANGE_CONFIG[REQUESTED_JOHOE_DEFAULT_RANGE]
  ? REQUESTED_JOHOE_DEFAULT_RANGE
  : '24h';
const HTTPS_REDIRECT_HOST = (process.env.HTTPS_REDIRECT_HOST || 'api.example.com').toLowerCase();
const CORS_ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ALLOWED_ORIGINS || 'https://example.com,https://www.example.com')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);
const SCRAPE_REFRESH_TOKEN = process.env.SCRAPE_REFRESH_TOKEN || '';
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
  [MEMPOOL_SPACE_FEES_CACHE_KEY]: { sMaxAge: 5, swr: 20 },
  [MEMPOOL_SPACE_UNCONFIRMED_CACHE_KEY]: { sMaxAge: 5, swr: 20 },
  [MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY]: { sMaxAge: 1, swr: 3 },
  [MEMPOOL_KNOTS_CACHE_KEY]: { sMaxAge: 1, swr: 3 },
  [JOHOE_LATEST_CACHE_KEY]: { sMaxAge: 60, swr: 180 },
  [JOHOE_HISTORY_24H_CACHE_KEY]: { sMaxAge: 60, swr: 180 },
  [JOHOE_HISTORY_30D_CACHE_KEY]: { sMaxAge: 900, swr: 1800 },
  [JOHOE_HISTORY_ALL_CACHE_KEY]: { sMaxAge: 3600, swr: 21600 },
  [FRED_CACHE_KEY]: { sMaxAge: 86400, swr: 86400 }, // FRED updates quarterly, cache 24h
};

let mempoolSpaceLastError = null;
let mempoolSpaceLastMessageAt = 0;
let mempoolSpaceReconnectTimer = null;
let mempoolSpaceSocket = null;
let mempoolSpaceStaleWatcher = null;
let mempoolSpaceMempoolLastError = null;
let mempoolSpaceMempoolPollTimer = null;
let mempoolSpaceMempoolPollInFlight = false;
let mempoolKnotsLastError = null;
let mempoolKnotsSnapshotTimer = null;
let mempoolKnotsLatestData = null;
let mempoolKnotsLatestInitData = null;
let mempoolKnotsHttpPollInFlight = false;
let mempoolKnotsLastPersistedSignature = null;
let mempoolKnotsInitDataLastPersistedSignature = null;
let johoeLastError = null;
let johoeLastSuccessfulSyncAt = 0;
let johoeDbPool = null;
let johoeDatabaseReady = false;
const johoeSyncTimers = Object.create(null);
const johoeRangeStatus = Object.fromEntries(JOHOE_RANGE_KEYS.map((key) => [key, {
  inFlight: false,
  lastError: null,
  lastSuccessfulSyncAt: 0,
}]));
let johoeForwardTimer = null;
let johoeForwardInFlight = false;

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
  if (!entry?.data) return false;

  if (key === 'bitnodes-nodes') {
    return Boolean(entry.data.apiData || entry.data.snapshotData || entry.data.nodesHtml);
  }

  return true;
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

function isMempoolSpaceDataStale() {
  return !mempoolSpaceLastMessageAt || Date.now() - mempoolSpaceLastMessageAt > MEMPOOL_SPACE_STALE_MS;
}

function ensureMempoolSpaceFreshness() {
  if (!mempoolSpaceSocket || mempoolSpaceSocket.readyState !== WebSocket.OPEN || !isMempoolSpaceDataStale()) {
    return;
  }

  mempoolSpaceLastError = `mempool.space websocket stale for more than ${MEMPOOL_SPACE_STALE_MS}ms`;
  mempoolSpaceSocket.terminate();
}

function isCacheEntryStale(entry, staleMs) {
  if (!entry?.updatedAt) return true;
  const updatedAtMs = Date.parse(entry.updatedAt);
  if (Number.isNaN(updatedAtMs)) return true;
  return Date.now() - updatedAtMs > staleMs;
}

function formatTxCountLabel(count) {
  return `${count.toLocaleString('en-US')} TXs`;
}

function handleMempoolSpaceMessage(raw) {
  let message;
  try {
    message = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
  } catch {
    return;
  }

  const mempoolInfo = message?.mempoolInfo;
  const fees = message?.fees;
  let handled = false;

  if (mempoolInfo && typeof mempoolInfo.usage === 'number') {
    const usagePct = typeof mempoolInfo.maxmempool === 'number' && mempoolInfo.maxmempool > 0
      ? Number(((mempoolInfo.usage / mempoolInfo.maxmempool) * 100).toFixed(2))
      : null;

    setCache(MEMPOOL_SPACE_CACHE_KEY, {
      source: 'mempool.space',
      provider: 'api.zatobox.io',
      name: 'Memory Usage',
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
    handled = true;
  }

  if (fees && typeof fees.fastestFee === 'number') {
    setCache(MEMPOOL_SPACE_FEES_CACHE_KEY, {
      source: 'mempool.space',
      provider: 'api.zatobox.io',
      name: 'Transaction Fees',
      metric: 'transaction-fees',
      fastestFee: fees.fastestFee,
      halfHourFee: fees.halfHourFee ?? null,
      hourFee: fees.hourFee ?? null,
      economyFee: fees.economyFee ?? null,
      minimumFee: fees.minimumFee ?? null,
      fees,
      url: 'https://mempool.space/',
      wsUrl: MEMPOOL_SPACE_WS_URL,
    });
    handled = true;
  }

  if (!handled) return;

  mempoolSpaceLastMessageAt = Date.now();
  mempoolSpaceLastError = null;
}

async function pollMempoolSpaceMempoolHttp() {
  if (mempoolSpaceMempoolPollInFlight) return;
  mempoolSpaceMempoolPollInFlight = true;

  try {
    const mempool = await fetchJson(MEMPOOL_SPACE_MEMPOOL_URL, { timeoutMs: 4000 });
    if (typeof mempool?.count !== 'number') {
      throw new Error('count missing in mempool overview');
    }

    setCache(MEMPOOL_SPACE_UNCONFIRMED_CACHE_KEY, {
      source: 'mempool.space',
      provider: 'api.zatobox.io',
      name: 'Unconfirmed TXs',
      metric: 'unconfirmed-transactions',
      count: mempool.count,
      displayValue: formatTxCountLabel(mempool.count),
      vsize: mempool.vsize ?? null,
      totalFee: mempool.total_fee ?? null,
      feeHistogram: Array.isArray(mempool.fee_histogram) ? mempool.fee_histogram : [],
      mempool,
      url: 'https://mempool.space/',
      apiUrl: MEMPOOL_SPACE_MEMPOOL_URL,
    });

    mempoolSpaceMempoolLastError = null;
  } catch (e) {
    mempoolSpaceMempoolLastError = e instanceof Error ? e.message : String(e);
    console.warn(`[http] mempool.space mempool poll failed: ${mempoolSpaceMempoolLastError}`);
  } finally {
    mempoolSpaceMempoolPollInFlight = false;
  }
}

function startMempoolSpaceMempoolPollLoop() {
  if (mempoolSpaceMempoolPollTimer) return;

  pollMempoolSpaceMempoolHttp().catch((e) => {
    console.warn(`[http] Failed initial mempool.space mempool poll: ${e.message}`);
  });

  mempoolSpaceMempoolPollTimer = setInterval(() => {
    pollMempoolSpaceMempoolHttp().catch((e) => {
      console.warn(`[http] Failed mempool.space mempool poll: ${e.message}`);
    });
  }, MEMPOOL_SPACE_MEMPOOL_POLL_INTERVAL_MS);
}

function startMempoolSpaceStream() {
  if (mempoolSpaceSocket && (mempoolSpaceSocket.readyState === WebSocket.OPEN || mempoolSpaceSocket.readyState === WebSocket.CONNECTING)) {
    return;
  }

  console.log(`[ws] mempool.space stats stream → ${MEMPOOL_SPACE_WS_URL}`);
  const ws = new WebSocket(MEMPOOL_SPACE_WS_URL);
  mempoolSpaceSocket = ws;

  ws.addEventListener('open', () => {
    mempoolSpaceLastError = null;
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

function startMempoolSpaceStaleWatcher() {
  if (mempoolSpaceStaleWatcher) return;

  const intervalMs = Math.max(1000, Math.min(5000, Math.floor(MEMPOOL_SPACE_STALE_MS / 2)));
  mempoolSpaceStaleWatcher = setInterval(() => {
    ensureMempoolSpaceFreshness();
  }, intervalMs);
}

function nextMempoolKnotsRunAt() {
  return new Date(Date.now() + MEMPOOL_KNOTS_HTTP_POLL_INTERVAL_MS);
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
  };
}

async function persistMempoolKnotsSnapshot() {
  if (!mempoolKnotsLatestData) return;

  const signature = JSON.stringify(mempoolKnotsLatestData);
  if (signature === mempoolKnotsLastPersistedSignature) return;

  const nowIso = new Date().toISOString();
  setCacheAt(MEMPOOL_KNOTS_CACHE_KEY, mempoolKnotsLatestData, nowIso);
  await writeDiskCache(MEMPOOL_KNOTS_CACHE_KEY, mempoolKnotsLatestData, nextMempoolKnotsRunAt());
  mempoolKnotsLastPersistedSignature = signature;
}

async function persistMempoolKnotsInitDataSnapshot() {
  if (!mempoolKnotsLatestInitData) return;

  const signature = JSON.stringify(mempoolKnotsLatestInitData);
  if (signature === mempoolKnotsInitDataLastPersistedSignature) return;

  const nowIso = new Date().toISOString();
  setCacheAt(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY, mempoolKnotsLatestInitData, nowIso);
  await writeDiskCache(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY, mempoolKnotsLatestInitData, nextMempoolKnotsRunAt());
  mempoolKnotsInitDataLastPersistedSignature = signature;
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
//  11. JOHOE MEMPOOL QUEUE — BTC count / weight / fee
// ═══════════════════════════════════════════════
function sumNumericArray(values) {
  if (!Array.isArray(values)) return 0;
  return values.reduce((sum, value) => {
    const numericValue = Number(value);
    return sum + (Number.isFinite(numericValue) ? numericValue : 0);
  }, 0);
}

function normalizeJohoeBuckets(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : 0;
  });
}

function normalizeJohoePoint(row) {
  if (!Array.isArray(row) || row.length < 4) return null;

  const timestamp = Number(row[0]);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;

  const countBuckets = normalizeJohoeBuckets(row[1]);
  const weightBuckets = normalizeJohoeBuckets(row[2]);
  const feeBuckets = normalizeJohoeBuckets(row[3]);

  return {
    source: 'johoe',
    network: JOHOE_NETWORK,
    timestamp,
    date: new Date(timestamp * 1000).toISOString(),
    countBuckets,
    weightBuckets,
    feeBuckets,
    countTotal: sumNumericArray(countBuckets),
    weightTotal: sumNumericArray(weightBuckets),
    feeTotal: sumNumericArray(feeBuckets),
  };
}

function parseJohoeJsonp(text) {
  const match = text.trim().match(/^call\(([\s\S]*)\);?$/);
  if (!match?.[1]) {
    throw new Error('Unexpected Johoe response format');
  }

  const normalizedPayload = match[1].replace(/,\s*]$/, ']');
  const parsed = JSON.parse(normalizedPayload);
  if (!Array.isArray(parsed)) {
    throw new Error('Johoe payload is not an array');
  }

  return parsed
    .map(normalizeJohoePoint)
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
}

function getJohoeRangeConfig(rangeKey = JOHOE_DEFAULT_RANGE) {
  return JOHOE_RANGE_CONFIG[rangeKey] || JOHOE_RANGE_CONFIG[JOHOE_DEFAULT_RANGE];
}

function getJohoeRangeStatus(rangeKey = JOHOE_DEFAULT_RANGE) {
  return johoeRangeStatus[getJohoeRangeConfig(rangeKey).key];
}

function nextJohoeRunAt(intervalMs = JOHOE_24H_SYNC_INTERVAL_MS) {
  return new Date(Date.now() + intervalMs);
}

function buildJohoeHistoryPayload(rangeKey, points) {
  const rangeConfig = getJohoeRangeConfig(rangeKey);
  return {
    source: 'johoe',
    provider: 'api.zatobox.io',
    network: JOHOE_NETWORK,
    range: rangeConfig.key,
    label: rangeConfig.label,
    resolution: rangeConfig.resolution,
    rolling: rangeConfig.rolling,
    sourcePath: rangeConfig.sourcePath,
    points,
  };
}

function buildJohoeForwardPayload(point) {
  return {
    source: 'johoe',
    provider: 'api.zatobox.io',
    network: JOHOE_NETWORK,
    timestamp: point.timestamp,
    date: point.date,
    countBuckets: point.countBuckets,
    weightBuckets: point.weightBuckets,
    feeBuckets: point.feeBuckets,
    latest: {
      count: point.countTotal,
      weight: point.weightTotal,
      fee: point.feeTotal,
    },
  };
}

function getJohoeEntryAgeMs(entry) {
  if (!entry?.updatedAt) return Number.POSITIVE_INFINITY;
  const updatedAtMs = Date.parse(entry.updatedAt);
  if (Number.isNaN(updatedAtMs)) return Number.POSITIVE_INFINITY;
  return Date.now() - updatedAtMs;
}

function isJohoeEntryStale(entry) {
  return getJohoeEntryAgeMs(entry) > JOHOE_STALE_MS;
}

function mapJohoeRow(row) {
  const timestamp = Number(row.snapshot_ts_unix);
  return {
    source: 'johoe',
    network: JOHOE_NETWORK,
    timestamp,
    date: row.snapshot_ts ? new Date(row.snapshot_ts).toISOString() : new Date(timestamp * 1000).toISOString(),
    countBuckets: normalizeJohoeBuckets(row.count_buckets),
    weightBuckets: normalizeJohoeBuckets(row.weight_buckets),
    feeBuckets: normalizeJohoeBuckets(row.fee_buckets),
    countTotal: Number(row.count_total),
    weightTotal: Number(row.weight_total),
    feeTotal: Number(row.fee_total),
  };
}

function updateJohoeLatestCache(points, updatedAt = new Date().toISOString(), sourceRange = '24h') {
  if (!Array.isArray(points) || !points.length) return;
  const latestPoint = points[points.length - 1];
  setCacheAt(JOHOE_LATEST_CACHE_KEY, { ...latestPoint, sourceRange }, updatedAt);
}

function updateJohoeRangeCache(rangeKey, points, updatedAt = new Date().toISOString()) {
  const rangeConfig = getJohoeRangeConfig(rangeKey);
  const limitedPoints = points.slice(-rangeConfig.maxCachedPoints);
  setCacheAt(rangeConfig.historyCacheKey, buildJohoeHistoryPayload(rangeKey, limitedPoints), updatedAt);
  if (rangeConfig.latestSource) {
    updateJohoeLatestCache(limitedPoints, updatedAt, rangeConfig.key);
  }
}

async function persistJohoeCacheKeys(keys) {
  for (const key of keys) {
    const entry = cached(key);
    if (!entry?.data) continue;

    const intervalMs = (() => {
      if (key === JOHOE_LATEST_CACHE_KEY) return JOHOE_24H_SYNC_INTERVAL_MS;
      const rangeConfig = Object.values(JOHOE_RANGE_CONFIG).find((config) => config.historyCacheKey === key);
      return rangeConfig?.syncIntervalMs || JOHOE_24H_SYNC_INTERVAL_MS;
    })();

    await writeDiskCache(key, entry.data, nextJohoeRunAt(intervalMs));
  }
}

async function persistJohoeRangeCache(rangeKey) {
  const rangeConfig = getJohoeRangeConfig(rangeKey);
  const keys = [rangeConfig.historyCacheKey];
  if (rangeConfig.latestSource) {
    keys.unshift(JOHOE_LATEST_CACHE_KEY);
  }
  await persistJohoeCacheKeys(keys);
}

async function persistAllJohoeCaches() {
  await persistJohoeCacheKeys([
    JOHOE_LATEST_CACHE_KEY,
    ...JOHOE_RANGE_KEYS.map((key) => getJohoeRangeConfig(key).historyCacheKey),
  ]);
}

async function fetchJohoeScript(relativePath) {
  return fetchText(`${JOHOE_BASE_URL}/${relativePath}`, {
    headers: {
      Accept: 'application/javascript, text/plain;q=0.9, */*;q=0.8',
    },
    timeoutMs: 30_000,
  });
}

async function ensureJohoeHistoryTable(tableName) {
  await johoeDbPool.query(`
    CREATE TABLE IF NOT EXISTS ${tableName} (
      snapshot_ts_unix BIGINT PRIMARY KEY,
      snapshot_ts TIMESTAMPTZ NOT NULL,
      count_buckets JSONB NOT NULL,
      weight_buckets JSONB NOT NULL,
      fee_buckets JSONB NOT NULL,
      count_total BIGINT NOT NULL,
      weight_total BIGINT NOT NULL,
      fee_total BIGINT NOT NULL,
      fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await johoeDbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_${tableName}_snapshot_ts
      ON ${tableName} (snapshot_ts DESC)
  `);

  await johoeDbPool.query(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
  await johoeDbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON TABLE ${tableName} FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON TABLE ${tableName} FROM authenticated';
      END IF;
    END
    $$;
  `);
}

async function ensureJohoeForwardOutbox() {
  if (!JOHOE_FORWARD_ENABLED) return;

  await johoeDbPool.query(`
    CREATE TABLE IF NOT EXISTS johoe_forward_outbox (
      snapshot_ts_unix BIGINT PRIMARY KEY,
      source_table TEXT NOT NULL DEFAULT '${JOHOE_RANGE_CONFIG['24h'].tableName}',
      payload JSONB NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt_at TIMESTAMPTZ,
      last_error TEXT,
      delivered_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await johoeDbPool.query(`ALTER TABLE johoe_forward_outbox ADD COLUMN IF NOT EXISTS source_table TEXT`);
  await johoeDbPool.query(`
    UPDATE johoe_forward_outbox
    SET source_table = '${JOHOE_RANGE_CONFIG['24h'].tableName}'
    WHERE source_table IS NULL OR source_table = ''
  `);
  await johoeDbPool.query(`ALTER TABLE johoe_forward_outbox ALTER COLUMN source_table SET NOT NULL`);
  await johoeDbPool.query(`
    CREATE INDEX IF NOT EXISTS idx_johoe_forward_outbox_pending
      ON johoe_forward_outbox (snapshot_ts_unix)
      WHERE delivered_at IS NULL
  `);
  await johoeDbPool.query(`ALTER TABLE johoe_forward_outbox ENABLE ROW LEVEL SECURITY`);
  await johoeDbPool.query(`
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON TABLE johoe_forward_outbox FROM anon';
      END IF;
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON TABLE johoe_forward_outbox FROM authenticated';
      END IF;
    END
    $$;
  `);
}

async function initJohoeDatabase() {
  if (!JOHOE_DB_ENABLED) return;

  if (!DATABASE_URL) {
    johoeLastError = 'JOHOE_DB_ENABLED=true but DATABASE_URL is missing';
    console.warn(`[johoe] ${johoeLastError}`);
    return;
  }

  johoeDbPool = new Pool(buildDatabasePoolConfig(DATABASE_URL));

  for (const rangeKey of JOHOE_RANGE_KEYS) {
    await ensureJohoeHistoryTable(getJohoeRangeConfig(rangeKey).tableName);
  }

  await ensureJohoeForwardOutbox();
  johoeDatabaseReady = true;
}

async function getLatestJohoeTimestampFromDb(rangeKey) {
  if (!johoeDatabaseReady) return 0;

  const rangeConfig = getJohoeRangeConfig(rangeKey);
  const result = await johoeDbPool.query(`
    SELECT snapshot_ts_unix
    FROM ${rangeConfig.tableName}
    ORDER BY snapshot_ts_unix DESC
    LIMIT 1
  `);

  if (!result.rows[0]?.snapshot_ts_unix) return 0;
  return Number(result.rows[0].snapshot_ts_unix);
}

async function refreshJohoeLatestCacheFromDb() {
  if (!johoeDatabaseReady) return;

  for (const rangeKey of ['24h', '30d', 'all']) {
    const rangeConfig = getJohoeRangeConfig(rangeKey);
    const result = await johoeDbPool.query(`
      SELECT snapshot_ts_unix, snapshot_ts, count_buckets, weight_buckets, fee_buckets, count_total, weight_total, fee_total
      FROM ${rangeConfig.tableName}
      ORDER BY snapshot_ts_unix DESC
      LIMIT 1
    `);

    if (!result.rows.length) continue;

    const point = mapJohoeRow(result.rows[0]);
    const updatedAt = new Date().toISOString();
    updateJohoeLatestCache([point], updatedAt, rangeConfig.key);
    await persistJohoeCacheKeys([JOHOE_LATEST_CACHE_KEY]);
    return;
  }
}

async function refreshJohoeRangeCacheFromDb(rangeKey, limit = null) {
  if (!johoeDatabaseReady) return;

  const rangeConfig = getJohoeRangeConfig(rangeKey);
  const actualLimit = Math.max(1, Math.min(limit || rangeConfig.defaultLimit, JOHOE_QUERY_LIMIT_MAX));
  const result = await johoeDbPool.query(`
    SELECT snapshot_ts_unix, snapshot_ts, count_buckets, weight_buckets, fee_buckets, count_total, weight_total, fee_total
    FROM ${rangeConfig.tableName}
    ORDER BY snapshot_ts_unix DESC
    LIMIT $1
  `, [actualLimit]);

  if (!result.rows.length) return;

  const points = result.rows.map(mapJohoeRow).reverse();
  updateJohoeRangeCache(rangeKey, points);
  await persistJohoeRangeCache(rangeKey);
}

async function refreshAllJohoeCachesFromDb() {
  for (const rangeKey of JOHOE_RANGE_KEYS) {
    await refreshJohoeRangeCacheFromDb(rangeKey, getJohoeRangeConfig(rangeKey).maxCachedPoints);
  }
  await refreshJohoeLatestCacheFromDb();
}

async function readJohoeHistoryFromDb(rangeKey, { from = null, to = null, limit = null, includeBuckets = false } = {}) {
  const rangeConfig = getJohoeRangeConfig(rangeKey);
  const actualLimit = Math.max(1, Math.min(limit || rangeConfig.defaultLimit, JOHOE_QUERY_LIMIT_MAX));

  if (!johoeDatabaseReady) {
    return cached(rangeConfig.historyCacheKey)?.data?.points?.slice(-actualLimit) || [];
  }

  const clauses = [];
  const values = [];

  if (Number.isFinite(from)) {
    values.push(from);
    clauses.push(`snapshot_ts_unix >= $${values.length}`);
  }

  if (Number.isFinite(to)) {
    values.push(to);
    clauses.push(`snapshot_ts_unix <= $${values.length}`);
  }

  values.push(actualLimit);
  const whereClause = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const baseFields = 'snapshot_ts_unix, snapshot_ts, count_total, weight_total, fee_total';
  const bucketFields = includeBuckets ? ', count_buckets, weight_buckets, fee_buckets' : '';
  const fields = baseFields + bucketFields;

  const result = await johoeDbPool.query(`
    SELECT ${fields}
    FROM ${rangeConfig.tableName}
    ${whereClause}
    ORDER BY snapshot_ts_unix DESC
    LIMIT $${values.length}
  `, values);

  const rows = result.rows.map(row => {
    const point = {
      timestamp: Number(row.snapshot_ts_unix),
      date: row.snapshot_ts ? new Date(row.snapshot_ts).toISOString() : new Date(Number(row.snapshot_ts_unix) * 1000).toISOString(),
      countTotal: Number(row.count_total),
      weightTotal: Number(row.weight_total),
      feeTotal: Number(row.fee_total),
    };

    if (includeBuckets) {
      point.countBuckets = normalizeJohoeBuckets(row.count_buckets);
      point.weightBuckets = normalizeJohoeBuckets(row.weight_buckets);
      point.feeBuckets = normalizeJohoeBuckets(row.fee_buckets);
    }

    return point;
  });

  return rows.reverse();
}

async function getExistingJohoeTimestamps(client, tableName, timestamps) {
  if (!timestamps.length) return new Set();

  const result = await client.query(
    `SELECT snapshot_ts_unix FROM ${tableName} WHERE snapshot_ts_unix = ANY($1::bigint[])`,
    [timestamps]
  );

  return new Set(result.rows.map((row) => Number(row.snapshot_ts_unix)));
}

async function upsertJohoeTableBatch(client, tableName, points) {
  if (!points.length) return;

  const values = [];
  const placeholders = points.map((point) => {
    const snapshotIso = new Date(point.timestamp * 1000).toISOString();
    const offset = values.length;

    values.push(
      point.timestamp,
      snapshotIso,
      JSON.stringify(point.countBuckets),
      JSON.stringify(point.weightBuckets),
      JSON.stringify(point.feeBuckets),
      point.countTotal,
      point.weightTotal,
      point.feeTotal,
      new Date().toISOString()
    );

    return `($${offset + 1}, $${offset + 2}::timestamptz, $${offset + 3}::jsonb, $${offset + 4}::jsonb, $${offset + 5}::jsonb, $${offset + 6}, $${offset + 7}, $${offset + 8}, $${offset + 9}::timestamptz)`;
  });

  await client.query(`
    INSERT INTO ${tableName} (
      snapshot_ts_unix,
      snapshot_ts,
      count_buckets,
      weight_buckets,
      fee_buckets,
      count_total,
      weight_total,
      fee_total,
      fetched_at
    )
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (snapshot_ts_unix) DO UPDATE SET
      snapshot_ts = EXCLUDED.snapshot_ts,
      count_buckets = EXCLUDED.count_buckets,
      weight_buckets = EXCLUDED.weight_buckets,
      fee_buckets = EXCLUDED.fee_buckets,
      count_total = EXCLUDED.count_total,
      weight_total = EXCLUDED.weight_total,
      fee_total = EXCLUDED.fee_total,
      fetched_at = EXCLUDED.fetched_at
  `, values);
}

async function queueJohoeForwardPayloads(client, rangeKey, points) {
  const rangeConfig = getJohoeRangeConfig(rangeKey);
  if (!JOHOE_FORWARD_ENABLED || !rangeConfig.latestSource || !points.length) return;

  const values = [];
  const placeholders = points.map((point) => {
    const offset = values.length;
    values.push(point.timestamp, rangeConfig.tableName, JSON.stringify(buildJohoeForwardPayload(point)));
    return `($${offset + 1}, $${offset + 2}, $${offset + 3}::jsonb)`;
  });

  await client.query(`
    INSERT INTO johoe_forward_outbox (snapshot_ts_unix, source_table, payload)
    VALUES ${placeholders.join(', ')}
    ON CONFLICT (snapshot_ts_unix) DO NOTHING
  `, values);
}

async function storeJohoePoints(rangeKey, points) {
  if (!points.length) return [];

  const rangeConfig = getJohoeRangeConfig(rangeKey);

  if (!johoeDatabaseReady) {
    updateJohoeRangeCache(rangeKey, points);
    await persistJohoeRangeCache(rangeKey);
    return points;
  }

  const client = await johoeDbPool.connect();
  try {
    await client.query('BEGIN');

    const incomingTimestamps = points.map((point) => point.timestamp);
    const existingTimestamps = await getExistingJohoeTimestamps(client, rangeConfig.tableName, incomingTimestamps);
    const newPoints = points.filter((point) => !existingTimestamps.has(point.timestamp));

    for (let index = 0; index < points.length; index += 250) {
      await upsertJohoeTableBatch(client, rangeConfig.tableName, points.slice(index, index + 250));
    }

    if (rangeConfig.rolling) {
      await client.query(
        `DELETE FROM ${rangeConfig.tableName} WHERE snapshot_ts_unix <> ALL($1::bigint[])`,
        [incomingTimestamps]
      );
    }

    await queueJohoeForwardPayloads(client, rangeKey, newPoints);
    await client.query('COMMIT');

    await refreshJohoeRangeCacheFromDb(rangeKey, rangeConfig.maxCachedPoints);
    if (rangeConfig.latestSource) {
      await refreshJohoeLatestCacheFromDb();
    }

    return newPoints;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function syncJohoeRange(rangeKey) {
  const rangeConfig = getJohoeRangeConfig(rangeKey);
  const rangeStatus = getJohoeRangeStatus(rangeKey);
  if (rangeStatus.inFlight) return;

  rangeStatus.inFlight = true;

  try {
    const raw = await fetchJohoeScript(rangeConfig.sourcePath);
    const points = parseJohoeJsonp(raw);
    if (!points.length) {
      throw new Error(`${rangeConfig.sourcePath} returned no points`);
    }

    const newPoints = await storeJohoePoints(rangeKey, points);
    rangeStatus.lastError = null;
    rangeStatus.lastSuccessfulSyncAt = Date.now();
    johoeLastError = null;
    johoeLastSuccessfulSyncAt = rangeStatus.lastSuccessfulSyncAt;

    console.log(`[johoe] Synced ${rangeConfig.sourcePath} (${points.length} rows, ${newPoints.length} new)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    rangeStatus.lastError = message;
    johoeLastError = message;
    console.warn(`[johoe] Sync failed for ${rangeConfig.sourcePath}: ${message}`);
  } finally {
    rangeStatus.inFlight = false;
  }
}

async function syncAllJohoeRanges() {
  await Promise.all(JOHOE_RANGE_KEYS.map((rangeKey) => syncJohoeRange(rangeKey)));
}

async function forwardJohoePayload(payload) {
  if (!JOHOE_FORWARD_ENABLED || !JOHOE_FORWARD_URL) return;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JOHOE_FORWARD_TIMEOUT_MS);

  try {
    const res = await fetch(JOHOE_FORWARD_URL, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(JOHOE_FORWARD_TOKEN ? { Authorization: `Bearer ${JOHOE_FORWARD_TOKEN}` } : {}),
        'Idempotency-Key': `johoe-${payload.timestamp}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      throw new Error(`ZatoBox forward failed with HTTP ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function processJohoeForwardOutbox() {
  if (!JOHOE_FORWARD_ENABLED || !JOHOE_FORWARD_URL || !johoeDatabaseReady || johoeForwardInFlight) return;
  johoeForwardInFlight = true;

  const client = await johoeDbPool.connect();
  try {
    const result = await client.query(`
      SELECT snapshot_ts_unix, source_table, payload
      FROM johoe_forward_outbox
      WHERE delivered_at IS NULL
      ORDER BY snapshot_ts_unix ASC
      LIMIT $1
    `, [JOHOE_FORWARD_BATCH_SIZE]);

    for (const row of result.rows) {
      const snapshotTsUnix = Number(row.snapshot_ts_unix);
      try {
        await forwardJohoePayload(row.payload);
        await client.query(`
          UPDATE johoe_forward_outbox
          SET attempts = attempts + 1,
              last_attempt_at = NOW(),
              last_error = NULL,
              delivered_at = NOW()
          WHERE snapshot_ts_unix = $1
        `, [snapshotTsUnix]);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await client.query(`
          UPDATE johoe_forward_outbox
          SET attempts = attempts + 1,
              last_attempt_at = NOW(),
              last_error = $2
          WHERE snapshot_ts_unix = $1
        `, [snapshotTsUnix, message.slice(0, 1000)]);
        console.warn(`[johoe] Forward failed for ${snapshotTsUnix}: ${message}`);
      }
    }
  } finally {
    client.release();
    johoeForwardInFlight = false;
  }
}

function startJohoePollingLoop(rangeKey) {
  const rangeConfig = getJohoeRangeConfig(rangeKey);
  if (johoeSyncTimers[rangeConfig.key]) return;

  syncJohoeRange(rangeKey).catch((error) => {
    console.warn(`[johoe] Initial sync failed for ${rangeConfig.sourcePath}: ${error.message}`);
  });

  johoeSyncTimers[rangeConfig.key] = setInterval(() => {
    syncJohoeRange(rangeKey).catch((error) => {
      console.warn(`[johoe] Sync loop failed for ${rangeConfig.sourcePath}: ${error.message}`);
    });
  }, rangeConfig.syncIntervalMs);
}

function startAllJohoePollingLoops() {
  for (const rangeKey of JOHOE_RANGE_KEYS) {
    startJohoePollingLoop(rangeKey);
  }
}

function startJohoeForwardLoop() {
  if (!JOHOE_FORWARD_ENABLED || !JOHOE_FORWARD_URL || johoeForwardTimer) return;

  processJohoeForwardOutbox().catch((error) => {
    console.warn(`[johoe] Initial forward loop failed: ${error.message}`);
  });

  johoeForwardTimer = setInterval(() => {
    processJohoeForwardOutbox().catch((error) => {
      console.warn(`[johoe] Forward loop failed: ${error.message}`);
    });
  }, JOHOE_FORWARD_INTERVAL_MS);
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

// ── FRED house price (US Median Home Price) ─────────────────────────────────
async function scrapeFredHousePrice() {
  console.log('[scrape] FRED house price (MSPUS) ...');

  try {
    const payload = await buildFredHousePricePayload();

    console.log(`[scrape] FRED house price → ${payload.data.points.length} points`);

    setCache(FRED_CACHE_KEY, payload.data);
    await writeDiskCache(FRED_CACHE_KEY, payload.data, nextIntervalRunAt(24 * 60 * 60 * 1000)); // 24h cache
  } catch (err) {
    console.error('[scrape] FRED house price failed:', err.message);
    throw err;
  }
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
    JOHOE_LATEST_CACHE_KEY,
    JOHOE_HISTORY_24H_CACHE_KEY,
    JOHOE_HISTORY_30D_CACHE_KEY,
    JOHOE_HISTORY_ALL_CACHE_KEY,
    FRED_CACHE_KEY,
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
      if (key === JOHOE_LATEST_CACHE_KEY) {
        johoeLastSuccessfulSyncAt = Date.parse(entry.scrapedAt) || johoeLastSuccessfulSyncAt;
      }
      const rangeConfig = Object.values(JOHOE_RANGE_CONFIG).find((config) => config.historyCacheKey === key);
      if (rangeConfig) {
        const rangeStatus = getJohoeRangeStatus(rangeConfig.key);
        rangeStatus.lastSuccessfulSyncAt = Date.parse(entry.scrapedAt) || rangeStatus.lastSuccessfulSyncAt;
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
    { name: 'fred-house-price', fn: scrapeFredHousePrice },
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

function serveMempoolSpaceStatsCached(key) {
  return (_req, res) => {
    setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[key]);
    const entry = cached(key);
    if (!entry?.data || isMempoolSpaceDataStale()) {
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
  };
}

function getRefreshTokenFromRequest(req) {
  const authHeader = req.get('authorization');
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }

  return (req.get('x-refresh-token') || '').trim();
}

function getJohoeLatestEntry() {
  return cached(JOHOE_LATEST_CACHE_KEY);
}

function buildJohoeMeta(entry, rangeKey = JOHOE_DEFAULT_RANGE) {
  const rangeConfig = getJohoeRangeConfig(rangeKey);
  const rangeStatus = getJohoeRangeStatus(rangeKey);
  return {
    range: rangeConfig.key,
    label: rangeConfig.label,
    resolution: rangeConfig.resolution,
    rolling: rangeConfig.rolling,
    sourcePath: rangeConfig.sourcePath,
    cachedAt: entry?.updatedAt || null,
    scraper: 'satoshi-scraper',
    transport: johoeDatabaseReady ? 'postgres-http-poll' : 'disk-http-poll',
    pollIntervalMs: rangeConfig.syncIntervalMs,
    stale: isJohoeEntryStale(entry),
    ageMs: getJohoeEntryAgeMs(entry),
    lastError: rangeStatus.lastError || johoeLastError,
    lastSuccessfulSyncAt: rangeStatus.lastSuccessfulSyncAt ? new Date(rangeStatus.lastSuccessfulSyncAt).toISOString() : null,
  };
}

function buildJohoeLatestResponse(entry, metric = null) {
  const point = entry.data;
  const payload = {
    source: 'johoe',
    provider: 'api.zatobox.io',
    network: JOHOE_NETWORK,
    sourceRange: point.sourceRange || '24h',
    timestamp: point.timestamp,
    date: point.date,
    latest: {
      count: point.countTotal,
      weight: point.weightTotal,
      fee: point.feeTotal,
    },
    _meta: buildJohoeMeta(entry, point.sourceRange || '24h'),
  };

  if (!metric) {
    return {
      ...payload,
      countBuckets: point.countBuckets,
      weightBuckets: point.weightBuckets,
      feeBuckets: point.feeBuckets,
    };
  }

  const metricConfig = {
    count: {
      totalField: 'countTotal',
      bucketsField: 'countBuckets',
      unit: 'tx',
      name: 'Count',
    },
    weight: {
      totalField: 'weightTotal',
      bucketsField: 'weightBuckets',
      unit: 'vbytes',
      name: 'Weight',
    },
    fee: {
      totalField: 'feeTotal',
      bucketsField: 'feeBuckets',
      unit: 'sats',
      name: 'Fee',
    },
  }[metric];

  return {
    ...payload,
    metric,
    metricName: metricConfig.name,
    unit: metricConfig.unit,
    value: point[metricConfig.totalField],
    buckets: point[metricConfig.bucketsField],
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
app.get('/api/scrape/fred-house-price', serveCached(FRED_CACHE_KEY));

// FRED MSPUS endpoint (direct FRED API)
app.get('/api/fred/mspus', async (req, res) => {
  const apiKey = process.env.FRED_API_KEY || '';
  const { from, limit } = req.query;

  const sortOrder = limit ? 'desc' : 'asc';
  const limitValue = limit ? String(limit) : '1000';

  const params = new URLSearchParams({
    series_id: 'MSPUS',
    sort_order: sortOrder,
    limit: limitValue,
    file_type: 'json',
    ...(apiKey ? { api_key: apiKey } : {}),
  });

  try {
    const response = await fetch(`https://api.stlouisfed.org/fred/series/observations?${params}`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      res.status(502).json({ error: 'FRED unavailable' });
      return;
    }

    const json = await response.json();
    let observations = (json.observations ?? [])
      .filter(o => o.value !== '.' && o.value != null && !isNaN(Number(o.value)))
      .map(o => ({ date: o.date, value: Number(o.value) }));

    if (from) {
      observations = observations.filter(o => o.date >= from);
    }

    if (!limit) {
      observations.sort((a, b) => a.date.localeCompare(b.date));
    }

    res.json({
      source: 'FRED — St. Louis Fed',
      source_url: 'https://fred.stlouisfed.org/series/MSPUS',
      updated_at: new Date().toISOString(),
      observations,
    });
  } catch (e) {
    res.status(502).json({ error: 'FRED unavailable' });
  }
});

// 6. Mempool.space memory usage via websocket stats
app.get('/api/scrape/mempool-space-memory-usage', serveMempoolSpaceStatsCached(MEMPOOL_SPACE_CACHE_KEY));

// 7. Mempool.space transaction fees via websocket stats
app.get('/api/scrape/mempool-space-transaction-fees', serveMempoolSpaceStatsCached(MEMPOOL_SPACE_FEES_CACHE_KEY));

// 8. Mempool.space unconfirmed tx count via HTTP mempool overview
app.get('/api/scrape/mempool-space-unconfirmed-transactions', (_req, res) => {
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[MEMPOOL_SPACE_UNCONFIRMED_CACHE_KEY]);
  const entry = cached(MEMPOOL_SPACE_UNCONFIRMED_CACHE_KEY);
  const staleMs = Math.max(15_000, MEMPOOL_SPACE_MEMPOOL_POLL_INTERVAL_MS * 3);
  if (!entry?.data || isCacheEntryStale(entry, staleMs)) {
    res.status(503).json({ ok: false, error: mempoolSpaceMempoolLastError || 'mempool.space mempool data not yet available' });
    return;
  }

  res.json({
    ...entry.data,
    _meta: {
      cachedAt: entry.updatedAt,
      scraper: 'satoshi-scraper',
      transport: 'http-poll',
      pollIntervalMs: MEMPOOL_SPACE_MEMPOOL_POLL_INTERVAL_MS,
    },
  });
});

// 9. Mempool Knots raw init-data snapshot JSON
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
    },
  });
});

// 10. Mempool Knots memory usage relay
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
    },
  });
});


// 11. Compatibility: relay Knots init-data under public API path
app.get('/api/public/mempool/node', (_req, res) => {
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY]);
  const entry = cached(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY);
  if (!entry?.data?.data) {
    res.status(503).json({ ok: false, error: mempoolKnotsLastError || 'mempool knots init-data not yet available' });
    return;
  }

  res.json(entry.data.data);
});

// 12. Compatibility: expose Knots-like init-data route from this API
app.get('/api/v1/init-data', (_req, res) => {
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY]);
  const entry = cached(MEMPOOL_KNOTS_INIT_DATA_CACHE_KEY);
  if (!entry?.data?.data) {
    res.status(503).json({ ok: false, error: mempoolKnotsLastError || 'mempool knots init-data not yet available' });
    return;
  }

  res.json(entry.data.data);
});

// 13. Johoe BTC queue latest snapshot (count / weight / fee)
app.get('/api/scrape/johoe-btc-queue/latest', (_req, res) => {
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[JOHOE_LATEST_CACHE_KEY]);
  const entry = getJohoeLatestEntry();
  if (!entry?.data) {
    res.status(503).json({ ok: false, error: johoeLastError || 'johoe data not yet available' });
    return;
  }

  res.json(buildJohoeLatestResponse(entry));
});

app.get('/api/scrape/johoe-btc-queue/latest/:metric(count|weight|fee)', (req, res) => {
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[JOHOE_LATEST_CACHE_KEY]);
  const entry = getJohoeLatestEntry();
  if (!entry?.data) {
    res.status(503).json({ ok: false, error: johoeLastError || 'johoe data not yet available' });
    return;
  }

  res.json(buildJohoeLatestResponse(entry, req.params.metric));
});

app.get('/api/scrape/johoe-btc-queue/history', async (req, res) => {
  const requestedRange = String(req.query.range || JOHOE_DEFAULT_RANGE).trim().toLowerCase();
  const rangeConfig = getJohoeRangeConfig(requestedRange);
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[rangeConfig.historyCacheKey]);

  const from = Number(req.query.from);
  const to = Number(req.query.to);
  const includeBuckets = parseBooleanEnv(req.query.includeBuckets, false);
  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, JOHOE_QUERY_LIMIT_MAX))
    : rangeConfig.defaultLimit;

  try {
    let points;
    let useCache = false;
    const cachedEntry = cached(rangeConfig.historyCacheKey);

    if (cachedEntry?.data?.points?.length) {
      useCache = true;
      let cachedPoints = cachedEntry.data.points;

      if (Number.isFinite(from) || Number.isFinite(to)) {
        cachedPoints = cachedPoints.filter(p =>
          (!Number.isFinite(from) || p.timestamp >= from) &&
          (!Number.isFinite(to) || p.timestamp <= to)
        );
      }

      points = cachedPoints.slice(-limit);
    } else {
      points = await readJohoeHistoryFromDb(rangeConfig.key, {
        from: Number.isFinite(from) ? from : null,
        to: Number.isFinite(to) ? to : null,
        limit,
        includeBuckets,
      });
    }

    if (!points.length) {
      res.status(503).json({ ok: false, error: johoeLastError || 'johoe history not yet available' });
      return;
    }

    const historyEntry = useCache ? cachedEntry : cached(rangeConfig.historyCacheKey);
    res.json({
      source: 'johoe',
      provider: 'api.zatobox.io',
      network: JOHOE_NETWORK,
      dataset: {
        range: rangeConfig.key,
        label: rangeConfig.label,
        resolution: rangeConfig.resolution,
        rolling: rangeConfig.rolling,
      },
      ...(includeBuckets ? { bands: JOHOE_BUCKET_DEFINITIONS } : {}),
      range: {
        from: points[0].timestamp,
        to: points[points.length - 1].timestamp,
        limit,
      },
      points: points.map((point) => (
        includeBuckets
          ? point
          : {
              timestamp: point.timestamp,
              date: point.date,
              count: point.countTotal,
              weight: point.weightTotal,
              fee: point.feeTotal,
            }
      )),
      _meta: buildJohoeMeta(historyEntry, rangeConfig.key),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ ok: false, error: message });
  }
});

// Meta endpoint - returns bucket definitions
app.get('/api/scrape/johoe-btc-queue/meta', (_req, res) => {
  res.json({
    source: 'johoe',
    provider: 'api.zatobox.io',
    network: JOHOE_NETWORK,
    bands: JOHOE_BUCKET_DEFINITIONS,
  });
});

app.get('/api/scrape/johoe-btc-queue/chart/:range', (req, res) => {
  const requestedRange = String(req.params.range || JOHOE_DEFAULT_RANGE).trim().toLowerCase();
  const rangeConfig = getJohoeRangeConfig(requestedRange);
  setPublicCacheHeaders(res, ENDPOINT_CACHE_CONTROL[rangeConfig.historyCacheKey]);

  const requestedLimit = Number(req.query.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, JOHOE_QUERY_LIMIT_MAX))
    : rangeConfig.defaultLimit;

  const cachedEntry = cached(rangeConfig.historyCacheKey);
  if (!cachedEntry?.data?.points?.length) {
    res.status(503).json({ ok: false, error: johoeLastError || 'johoe data not yet available' });
    return;
  }

  const points = cachedEntry.data.points.slice(-limit);
  const timestamps = [];
  const counts = [];
  const weights = [];
  const fees = [];

  for (const point of points) {
    timestamps.push(point.timestamp);
    counts.push(point.countTotal);
    weights.push(point.weightTotal);
    fees.push(point.feeTotal);
  }

  res.json({
    timestamps,
    counts,
    weights,
    fees,
    _meta: {
      range: rangeConfig.key,
      from: points[0]?.timestamp,
      to: points[points.length - 1]?.timestamp,
      count: points.length,
      updatedAt: cachedEntry.updatedAt,
    },
  });
});

// Manual refresh trigger
app.get('/api/scrape/refresh', async (req, res) => {
  if (!SCRAPE_REFRESH_TOKEN) {
    res.status(403).json({ error: 'manual refresh disabled' });
    return;
  }

  if (getRefreshTokenFromRequest(req) !== SCRAPE_REFRESH_TOKEN) {
    res.status(401).json({ error: 'invalid refresh token' });
    return;
  }

  try {
    await Promise.all([scrapeAll(), syncAllJohoeRanges()]);
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

// FRED house price: once per day at 03:00 UTC (FRED updates quarterly)
cron.schedule('0 3 * * *', () => {
  scrapeFredHousePrice().catch((e) => console.error('[cron] fred-house-price:', e.message));
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
  console.log('     GET /api/scrape/mempool-space-transaction-fees');
  console.log('     GET /api/scrape/mempool-space-unconfirmed-transactions');
  console.log('     GET /api/scrape/mempool-knots-init-data-json');
  console.log('     GET /api/scrape/mempool-knots-memory-usage');
  console.log('     GET /api/scrape/johoe-btc-queue/latest');
  console.log('     GET /api/scrape/johoe-btc-queue/latest/count');
  console.log('     GET /api/scrape/johoe-btc-queue/latest/weight');
  console.log('     GET /api/scrape/johoe-btc-queue/latest/fee');
  console.log('     GET /api/scrape/johoe-btc-queue/history?range=24h|30d|all');
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
  console.log(`     mempool-space-transaction-fees: realtime via WS (reconnect ${MEMPOOL_SPACE_RECONNECT_MS}ms)`);
  console.log(`     mempool-space-unconfirmed-transactions: every ${MEMPOOL_SPACE_MEMPOOL_POLL_INTERVAL_MS}ms via HTTP`);
  console.log(`     mempool-knots-init-data-json: snapshot json every ${MEMPOOL_KNOTS_HTTP_POLL_INTERVAL_MS}ms via local HTTP`);
  console.log(`     mempool-knots-memory-usage: relay cached json snapshot`);
  console.log(`     johoe 24h rolling: every ${JOHOE_24H_SYNC_INTERVAL_MS}ms via 24h.js`);
  console.log(`     johoe 30d rolling: every ${JOHOE_30D_SYNC_INTERVAL_MS}ms via 30d.js`);
  console.log(`     johoe all daily  : every ${JOHOE_ALL_SYNC_INTERVAL_MS}ms via all.js`);
  console.log('\n   Loading cached data from disk...\n');

  await ensureCacheDir();
  await warmUpFromDisk();
  await initJohoeDatabase().catch((error) => {
    johoeLastError = error instanceof Error ? error.message : String(error);
    console.error(`[johoe] Database init failed: ${johoeLastError}`);
  });
  if (johoeDatabaseReady) {
    await refreshAllJohoeCachesFromDb().catch((error) => {
      johoeLastError = error instanceof Error ? error.message : String(error);
      console.error(`[johoe] Failed to warm cache from database: ${johoeLastError}`);
    });
  }
  if (JOHOE_FORWARD_ENABLED && !JOHOE_FORWARD_URL) {
    console.warn('[johoe] JOHOE_FORWARD_ENABLED=true but JOHOE_FORWARD_URL is missing; forwarding stays disabled');
  }
  startMempoolSpaceStream();
  startMempoolSpaceStaleWatcher();
  startMempoolSpaceMempoolPollLoop();
  startMempoolKnotsSnapshotLoop();
  startAllJohoePollingLoops();
  startJohoeForwardLoop();
  console.log('\n   Running initial scrape...\n');

  scrapeAll()
    .then(() => {
      console.log('\n✅ Initial scrape complete. Cron schedules active.\n');
    })
    .catch((error) => {
      console.error(`\n❌ Initial scrape failed: ${error.message}\n`);
    });
});
