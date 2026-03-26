# Satoshi Scraper

Satoshi Scraper is a self-hosted Node.js microservice that collects, normalizes, caches, and relays data for Satoshi Dashboard.

It is designed for deployments on your own VPS, homelab, UmbrelOS, Docker host, or Portainer stack so you can avoid exposing upstream services, secrets, and private infrastructure directly to the public internet.

## Why this service exists

Some upstream websites and APIs block traffic from Vercel or common datacenter IP ranges. By running this scraper on infrastructure you control, the dashboard can consume pre-scraped JSON from your own endpoint instead of connecting directly to fragile or rate-limited sources.

This also gives you better control over:

- origin shielding
- credential isolation
- cache persistence
- transport security
- public endpoint exposure

## Supported API routes

| Endpoint | Source | Returned data | Refresh cadence |
|----------|--------|---------------|-----------------|
| `/api/scrape/investing-currencies` | Investing.com | USD FX cross rates (EUR/USD, GBP/USD, etc.) | Every 60 seconds |
| `/api/scrape/bitinfocharts-richlist` | BitInfoCharts | Top 100 richest Bitcoin addresses and distribution data | Daily at 02:00 UTC |
| `/api/scrape/bitnodes-nodes` | BitNodes.io | Bitcoin node count and ASN distribution | Twice daily at 06:05 and 18:05 UTC |
| `/api/scrape/newhedge-global-assets` | NewHedge.io | Global asset values related to Bitcoin comparisons | Hourly |
| `/api/scrape/companiesmarketcap-gold` | CompaniesMarketCap | `GOLD`, market cap, gold price, and daily change | Every 15 minutes |
| `/api/scrape/fred-house-price` | FRED + Binance | US median house price series normalized with BTC history | Daily at 03:00 UTC |
| `/api/fred/mspus` | FRED | Raw `MSPUS` observations from St. Louis Fed | On request with local validation |
| `/api/scrape/mempool-space-memory-usage` | mempool.space | Real-time mempool memory usage from `stats.mempoolInfo.usage` | Real time via WebSocket |
| `/api/scrape/mempool-space-transaction-fees` | mempool.space | Real-time fee estimates from websocket `stats` | Real time via WebSocket |
| `/api/scrape/mempool-space-unconfirmed-transactions` | mempool.space | Unconfirmed transaction count and mempool overview | Every 5 seconds |
| `/api/scrape/mempool-knots-init-data-json` | Local Mempool Knots | Raw JSON snapshot of `/api/v1/init-data` | Every 1 second |
| `/api/scrape/mempool-knots-memory-usage` | Mempool Knots relay | Processed Knots memory payload for downstream apps | Every 1 second |
| `/api/scrape/johoe-btc-queue/latest` | Johoe queue | Latest BTC queue snapshot with `count`, `weight`, and `fee` | Every 60 seconds |
| `/api/scrape/johoe-btc-queue/history?range=24h` | Johoe queue | Rolling 24h window at roughly 1-minute resolution | Every 60 seconds |
| `/api/scrape/johoe-btc-queue/meta` | Johoe queue | Fee-band metadata for charting and legends | Static |
| `/api/scrape/johoe-btc-queue/chart/24h` | Johoe queue | Array-oriented chart payload for count, weight, and fee | Every 60 seconds |
| `/api/public/mempool/node` | Compatibility route | Public relay for the raw Knots snapshot | Every 1 second |
| `/api/v1/init-data` | Compatibility route | Raw Knots `init-data` relay served by this API | Every 1 second |
| `POST /api/scrape/refresh` | Internal/admin | Manual refresh for scrapers and Johoe syncs | On demand |

### Available endpoints

- `GET /api/scrape/investing-currencies`
- `GET /api/scrape/bitinfocharts-richlist`
- `GET /api/scrape/bitnodes-nodes`
- `GET /api/scrape/newhedge-global-assets`
- `GET /api/scrape/companiesmarketcap-gold`
- `GET /api/scrape/fred-house-price`
- `GET /api/fred/mspus`
- `GET /api/scrape/mempool-space-memory-usage`
- `GET /api/scrape/mempool-space-transaction-fees`
- `GET /api/scrape/mempool-space-unconfirmed-transactions`
- `GET /api/scrape/mempool-knots-init-data-json`
- `GET /api/scrape/mempool-knots-memory-usage`
- `GET /api/scrape/johoe-btc-queue/latest`
- `GET /api/scrape/johoe-btc-queue/latest/count`
- `GET /api/scrape/johoe-btc-queue/latest/weight`
- `GET /api/scrape/johoe-btc-queue/latest/fee`
- `GET /api/scrape/johoe-btc-queue/history?range=24h`
- `GET /api/scrape/johoe-btc-queue/meta`
- `GET /api/scrape/johoe-btc-queue/chart/24h`
- `GET /api/public/mempool/node`
- `GET /api/v1/init-data`
- `POST /api/scrape/refresh`
- `GET /health`
- `GET /readyz`

## Runtime behavior and warm-up

- The scraper restores persisted disk snapshots for `investing-currencies`, `bitinfocharts-richlist`, `bitnodes-nodes`, `newhedge-global-assets`, and `companiesmarketcap-gold`.
- Johoe uses Supabase as the canonical store and also keeps startup snapshots in `cache/` for faster container warm-up.
- Initial startup runs HTTP scrapes in parallel to reduce the time required before real data becomes available after restart.
- `GET /health` only confirms that the process is alive.
- `GET /readyz` confirms that the minimum dashboard cache set is loaded.
- Docker and Compose health checks should target `GET /readyz` so traffic only reaches the service after warm-up.
- Cache-backed endpoints return `Cache-Control` headers with `s-maxage` and `stale-while-revalidate` so downstream consumers can reuse valid snapshots.

## Johoe + Supabase architecture

The Johoe integration now keeps a single real-time dataset in Supabase:

| Supabase table | Johoe source | Persistence model | Actual resolution | Purpose |
|---|---|---|---|---|
| `public.johoe_queue_24h_rolling` | `24h.js` | Rolling mirror | ~1 minute | Canonical real-time history and `latest` route |

Important details:

- `24h.js` is mirrored as a rolling window: current points are upserted and expired points are deleted.
- `latest` is served from `public.johoe_queue_24h_rolling`.
- The service no longer relies on `30d`, `all`, or `johoe_forward_outbox` tables.

## Useful script

- `npm run sync:johoe:supabase`

This script forces a manual re-sync of the Johoe `24h` dataset directly into Supabase. It is useful for first-time seeding, repairing the rolling table, or validating a remote project after migration.

## Security model

This repository is intended to reduce public exposure of private infrastructure, upstream origins, and credentials.

### Core recommendations

- Do not expose upstream APIs directly from your frontend.
- Keep `.env` private and never commit real secrets.
- Use this service as the only public-facing relay for scraped data.
- Restrict CORS with an explicit allowlist in `CORS_ALLOWED_ORIGINS`.
- Restrict forwarded-header trust with `TRUST_PROXY` so only known reverse proxies can influence HTTPS detection.
- Use HTTPS only in production.
- Place the service behind a reverse proxy or tunnel such as Cloudflare Tunnel.
- Keep the Docker port bound to loopback unless you intentionally want LAN or public exposure.
- Avoid publishing your Supabase credentials, upstream node URLs, or internal hostnames.

### Built-in protections

- Express `x-powered-by` is disabled.
- Proxy trust is configurable with `TRUST_PROXY` and defaults to local/private proxy hops only.
- HTTP to HTTPS redirection is enforced when the request host matches `HTTPS_REDIRECT_HOST`.
- HTTPS responses include `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.
- `GET /health` is intentionally minimal and returns only `{ "status": "ok" }`.
- `POST /api/scrape/refresh` requires `Authorization: Bearer <SCRAPE_REFRESH_TOKEN>` or `X-Refresh-Token` and is rate-limited by `REFRESH_MIN_INTERVAL_MS`.
- CORS uses an explicit allowlist and does not rely on `*`.
- Sensitive refresh operations can be protected with `SCRAPE_REFRESH_TOKEN`.
- Postgres TLS verification stays enabled unless `JOHOE_DB_SSL_INSECURE_SKIP_VERIFY=true` is set deliberately for a controlled environment.

### Secret-handling guidance

- Never commit `.env`; only commit `.env.example`.
- If a real `.env` was ever exposed, rotate all affected credentials immediately.
- Treat `DATABASE_URL`, `JOHOE_FORWARD_TOKEN`, `FRED_API_KEY`, and private upstream URLs as secrets.
- Use long random values for `SCRAPE_REFRESH_TOKEN`.
- Prefer secret managers, Portainer environment variables, or private deployment variables over hardcoded values.

### Network exposure guidance

If you do not want to expose your APIs publicly as-is, use one of these patterns:

- expose only the routes your dashboard needs through a reverse proxy
- restrict access by IP allowlist, access policy, or tunnel authentication
- keep private upstream services on an internal network and let only this scraper reach them
- avoid direct port forwarding from your router to the container when a tunnel or hardened reverse proxy is available
- separate public relay routes from private admin or internal-only services

## Portainer deployment via Git repository

This directory already includes `Dockerfile` and `docker-compose.yml`, so you can deploy it directly from a Git repository in Portainer.

### Step 1: Push the code to GitHub

Push the contents of this folder (`satoshi-scraper`) to your own GitHub repository. It can be private or public, but private is recommended.

### Step 2: Create the stack in Portainer

1. Open Portainer and go to **Stacks**.
2. Click **Add stack**.
3. Choose a name such as `satoshi-scraper`.
4. Select the **Repository** deployment method.
5. Enter the repository URL.
6. If the repository is private, enable **Authentication** and provide a PAT or repository credentials.
7. Optionally enable automatic updates if you want Portainer to pull new changes.
8. Set **Compose path** to `docker-compose.yml`.
9. Click **Deploy the stack**.

Recommended Johoe environment values for Portainer:

- `DATABASE_URL`: use the Supabase Transaction Pooler
- `JOHOE_24H_SYNC_INTERVAL_MS=60000`
- `JOHOE_DEFAULT_RANGE=24h`
- `JOHOE_QUERY_LIMIT_MAX=5000`
- `TRUST_PROXY=loopback, linklocal, uniquelocal`
- `SCRAPER_BIND_ADDRESS=127.0.0.1`

### Step 3: Publish safely through a tunnel or reverse proxy

After deployment, the service runs on port `9119`, for example `http://localhost:9119` or `http://192.168.0.x:9119`.

For safer exposure:

- prefer a Cloudflare Tunnel, Tailscale funnel, or hardened reverse proxy
- prefer `SCRAPER_BIND_ADDRESS=127.0.0.1` and let the proxy or tunnel publish the service
- publish only HTTPS
- apply origin restrictions and access controls where possible
- do not expose private upstream services directly

Example health check:

- `https://api.your-domain.com/health`

Expected minimal response:

```json
{ "status": "ok" }
```

Recommended post-deploy checks:

- `GET /api/scrape/johoe-btc-queue/latest`
- `GET /api/scrape/johoe-btc-queue/history?range=24h&limit=60`
- `GET /readyz`
- `POST /api/scrape/refresh` with `Authorization: Bearer <SCRAPE_REFRESH_TOKEN>`

## Migration from `knotapi.zatobox.io`

If your app still consumes Knots data from `knotapi.zatobox.io`, you can point it to this service using compatible routes:

- `GET /api/public/mempool/node`
- `GET /api/v1/init-data`

Both routes relay the Knots snapshot through this service so you can centralize security controls and public exposure on a single host.
