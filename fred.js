/**
 * FRED Data Fetching for Zatobox
 *
 * Fetches US Median Home Price (MSPUS) from FRED API
 * and serves it to the dashboard.
 */

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';
const BINANCE_KLINES = 'https://api.binance.com/api/v3/klines';
const SERIES_ID = 'MSPUS';
const FRED_CACHE_KEY = 'fred-house-price';

const DAY_MS = 86_400_000;
const MONTH_MS = 30 * DAY_MS;

// ── FRED helpers ──────────────────────────────────────────────────────────────

function quarterLabel(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

export async function fetchFredObservations(apiKey) {
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

// ── Binance helpers ───────────────────────────────────────────────────────────

export async function fetchBinanceDailyHistory(startMs) {
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

  // Return Map: dayStartMs → closePrice
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

// ── Main: Build unified payload ─────────────────────────────────────────────

export async function buildFredHousePricePayload() {
  const apiKey = process.env.FRED_API_KEY || '';

  // Fetch both sources in parallel
  const [fredObs, btcMap] = await Promise.all([
    fetchFredObservations(apiKey),
    fetchBinanceDailyHistory(Date.now() - 400 * DAY_MS), // ~400 days of history
  ]);

  if (!fredObs?.length) {
    throw new Error('No FRED observations returned');
  }

  // Find earliest FRED and BTC dates
  const firstFred = fredObs[0];
  const firstFredDate = new Date(firstFred.date + 'T00:00:00Z');
  const firstBtcDate = new Date(Math.min(...btcMap.keys()));
  const startDate = new Date(Math.max(firstFredDate.getTime(), firstBtcDate.getTime()));

  // Generate monthly timestamps from startDate to now
  const points = [];
  const now = new Date();
  let current = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  while (current <= now) {
    const ts = current.getTime();
    const tsSec = Math.floor(ts / 1000);

    // Interpolate FRED value (quarterly → monthly linear)
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

    // Get BTC close for this day (or nearest prior)
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

    // Next month
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
    next_update_at: null, // FRED updates quarterly
  };
}

export { FRED_CACHE_KEY };
