import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workspaceRoot = path.resolve(__dirname, '..');

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseBoolean(value, defaultValue = false) {
  if (value == null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

async function loadEnv() {
  const envPath = path.join(workspaceRoot, '.env');
  try {
    const content = await readFile(envPath, 'utf8');
    for (const line of content.split(/\r?\n/)) {
      if (!line || line.trim().startsWith('#')) continue;
      const separatorIndex = line.indexOf('=');
      if (separatorIndex === -1) continue;
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1);
      if (!(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env is optional for manual runs
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
    const authority = remainder.slice(0, slashIndex);
    const pathAndQuery = remainder.slice(slashIndex + 1);
    const atIndex = authority.lastIndexOf('@');
    const credentials = authority.slice(0, atIndex);
    const hostPort = authority.slice(atIndex + 1);
    const credentialSeparatorIndex = credentials.indexOf(':');
    let password = credentials.slice(credentialSeparatorIndex + 1);
    let passwordWasBracketed = false;

    if (password.startsWith('[') && password.endsWith(']')) {
      password = password.slice(1, -1);
      passwordWasBracketed = true;
    }

    const hostSeparatorIndex = hostPort.lastIndexOf(':');
    const queryIndex = pathAndQuery.indexOf('?');
    const databasePath = queryIndex === -1 ? pathAndQuery : pathAndQuery.slice(0, queryIndex);

    return {
      host: hostPort.slice(0, hostSeparatorIndex),
      port: Number(hostPort.slice(hostSeparatorIndex + 1) || 5432),
      database: safeDecodeURIComponent(databasePath || 'postgres'),
      user: safeDecodeURIComponent(credentials.slice(0, credentialSeparatorIndex)),
      password: passwordWasBracketed ? password : safeDecodeURIComponent(password),
    };
  }
}

function normalizeBuckets(values) {
  if (!Array.isArray(values)) return [];
  return values.map((value) => {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue >= 0 ? numericValue : 0;
  });
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function parseJsonpPayload(text) {
  const match = text.trim().match(/^call\(([\s\S]*)\);?$/);
  if (!match?.[1]) {
    throw new Error('Unexpected Johoe JSONP payload');
  }

  return JSON.parse(match[1].replace(/,\s*]$/, ']'))
    .map((row) => {
      const timestamp = Number(row[0]);
      const countBuckets = normalizeBuckets(row[1]);
      const weightBuckets = normalizeBuckets(row[2]);
      const feeBuckets = normalizeBuckets(row[3]);

      return {
        timestamp,
        countBuckets,
        weightBuckets,
        feeBuckets,
        countTotal: sum(countBuckets),
        weightTotal: sum(weightBuckets),
        feeTotal: sum(feeBuckets),
      };
    })
    .filter((row) => Number.isFinite(row.timestamp) && row.timestamp > 0)
    .sort((a, b) => a.timestamp - b.timestamp);
}

async function fetchPoints(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/javascript, text/plain;q=0.9, */*;q=0.8',
    },
  });

  if (!response.ok) {
    throw new Error(`Johoe request failed for ${url} with HTTP ${response.status}`);
  }

  return parseJsonpPayload(await response.text());
}

async function upsertBatch(client, tableName, points) {
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

async function syncDataset(client, config) {
  const points = await fetchPoints(config.url);
  if (!points.length) {
    throw new Error(`No rows returned for ${config.url}`);
  }

  await client.query('BEGIN');
  try {
    for (let index = 0; index < points.length; index += 250) {
      await upsertBatch(client, config.tableName, points.slice(index, index + 250));
    }

    if (config.rolling) {
      await client.query(
        `DELETE FROM ${config.tableName} WHERE snapshot_ts_unix <> ALL($1::bigint[])`,
        [points.map((point) => point.timestamp)]
      );
    }

    await client.query('COMMIT');
    return points.length;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function main() {
  await loadEnv();

  const databaseUrl = process.env.DATABASE_URL || '';
  const skipVerify = parseBoolean(process.env.JOHOE_DB_SSL_INSECURE_SKIP_VERIFY, false);
  const pool = new Pool({
    ...parseDatabaseUrl(databaseUrl),
    ssl: parseBoolean(process.env.JOHOE_DB_SSL, true) ? { rejectUnauthorized: !skipVerify } : false,
    max: 1,
    connectionTimeoutMillis: 10_000,
  });

  const datasets = [
    {
      key: '24h',
      tableName: 'johoe_queue_24h_rolling',
      url: 'https://johoe.jochen-hoenicke.de/queue/2/24h.js',
      rolling: true,
    },
  ];

  try {
    for (const dataset of datasets) {
      const client = await pool.connect();
      try {
        const syncedRows = await syncDataset(client, dataset);
        console.log(`[johoe-sync] ${dataset.key}: ${syncedRows} rows mirrored into ${dataset.tableName}`);
      } finally {
        client.release();
      }
    }

    const counts = await pool.query(`
      SELECT table_name, count(*)::int AS rows, min(snapshot_ts) AS first_ts, max(snapshot_ts) AS last_ts
      FROM (
        SELECT 'johoe_queue_24h_rolling'::text AS table_name, snapshot_ts FROM public.johoe_queue_24h_rolling
      ) AS datasets
      GROUP BY 1
      ORDER BY 1
    `);

    console.log(JSON.stringify(counts.rows, null, 2));
  } finally {
    await pool.end().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`[johoe-sync] ${error.message}`);
  process.exit(1);
});
