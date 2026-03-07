# SCRAPER_RULES.md — Satoshi Dashboard
> Tabla canónica de decisión para scrapers, TTL de backend, CDN y polling de frontend.
> Actualizado: 2026-03-07

---

## Tabla canónica de decisión

| Fuente | Tier | Frecuencia real | Cron scraper | TTL backend (s-maxage) | CDN (swr) | Polling frontend | Label UX |
|--------|------|----------------|-------------|----------------------|-----------|-----------------|---------|
| Binance BTCUSDT tick | 1 | < 1s | — (WebSocket) | 5s | 15s | 30s | `~30s` |
| Mempool.space overview | 2 | ~10s | — (directo) | 5s | 20s | 30s | `~30s` |
| Investing.com FX | 2 | ~15–30s | `0 * * * * *` (60s) | 30s | 60s | 30s | `~30s` |
| CoinGecko stablecoins | 3 | ~60s | — (directo) | 120s | 240s | 2min | `↻ 2min` |
| Newhedge global assets | 3 | ~1h | `0 * * * *` (1h) | 3 600s | 7 200s | 1h | `update: 1h` |
| Bitnodes.io snapshots | 4 | 2× día (6h UTC) | `5 6,18 * * *` | 21 600s | 3 600s | 10min | `Next update: in Xh` |
| BitInfoCharts richlist | 5 | ~24h | `0 2 * * *` | 3 600s | 7 200s | 1h | `daily update` |
| Fear & Greed (alt.me) | 5 | ~24h | — (directo) | 21 600s | 3 600s | fetch-once | `actualización diaria` |
| Big Mac Index (Economist) | 5 | ~1 año | — (directo) | 604 800s | 86 400s | fetch-once | `Índice anual` |
| GeoJSON (NaturalEarth) | 5 | estático | — (directo) | 2 592 000s | 86 400s | fetch-once | — |

---

## Categorías de fuentes por Tier

### Tier 1 — `< 30s`
Datos de alta frecuencia en tiempo real. Requieren WebSocket o polling muy agresivo.
- **Ejemplos:** Binance tick, mempool blocks (mempool.space SSE)
- **Regla:** No usar scraper HTTP. Usar WebSocket o SSE nativo.

### Tier 2 — `30s – 5min`
Datos cuasi-real-time. HTTP polling agresivo válido.
- **Ejemplos:** Mempool overview, FX investing.com
- **Regla:** Scraper ≤ 60s. Backend TTL = intervalo scraper. Frontend poll ≥ TTL backend.

### Tier 3 — `5min – 1h`
Datos sub-horarios. Polling moderado.
- **Ejemplos:** CoinGecko precios, Lightning topology, Newhedge
- **Regla:** Scraper ≤ 5min–1h según fuente. Backend TTL = 2–5× intervalo scraper. Frontend poll ≥ TTL CDN.

### Tier 4 — `1h – 24h`
Datos actualizados varias veces al día.
- **Ejemplos:** Bitnodes.io snapshots (2×/día: 6:00 y 18:00 UTC)
- **Regla:** Cron alineado con horario real de la fuente. Persistencia en disco obligatoria.

### Tier 5 — `> 24h`
Datos diarios, anuales o estáticos.
- **Ejemplos:** BitInfoCharts (24h), Fear & Greed (24h), Big Mac (1 año), GeoJSON (estático)
- **Regla:** Scraper diario o menos. Frontend: fetch-once en mount, sin setInterval. Persistencia en disco obligatoria si cron > 1h.

---

## Reglas de cache headers

- **NO usar `{ cache: 'no-store' }` en el frontend** si el endpoint tiene TTL > 60s. Permite que el CDN sirva respuestas cacheadas.
- **Configurar `s-maxage` correctamente** en el backend para que Vercel Edge pueda cachear.
- **`stale-while-revalidate` (swr)** debe ser ≥ `s-maxage` para evitar latencia en revalidación.

```
Cache-Control: public, s-maxage=<TTL>, stale-while-revalidate=<TTL*2>
```

---

## Regla de persistencia Docker

**Todo scraper con intervalo > 1h DEBE persistir su cache en volumen Docker** para sobrevivir reinicios sin período de calentamiento (503).

- Archivo: `/app/cache/{key}.json`
- Formato: `{ data: {...}, scrapedAt: "ISO string", nextRunAt: "ISO string" }`
- Al arrancar: leer de disco antes del primer scrape (warm-up)
- Tras cada scrape exitoso: escribir a disco
- Error en lectura: continuar normalmente (primer arranque)

Scrapers que deben persistir actualmente:
- `bitinfocharts-richlist` (cron diario)
- `bitnodes-nodes` (cron 2×/día)

---

## Regla de deduplicación de polling

Si dos componentes consultan el mismo endpoint, centralizar el fetch en:
1. Un hook compartido (e.g. `useMempoolOverview`)
2. O en el store de Zustand (`dashboardStore.js`)

**No duplicar setInterval en dos componentes para el mismo endpoint.**

---

## Checklist de incorporación de nuevo scraper

Al crear un nuevo endpoint, seguir estos pasos en orden:

1. **Definir frecuencia real** de actualización de la fuente (revisar documentación o inspección de red)
2. **Calcular TTL backend** = `max(intervalo_scraper, frecuencia_fuente) + margen 10%`
3. **Definir cron Docker** alineado con frecuencia fuente (Tier 4–5: usar horario exacto)
4. **Definir polling frontend** = `max(TTL_CDN, 30s)`; si TTL > 1h → fetch-once en mount
5. **Definir label UX honesto** con la frecuencia real (no el intervalo de polling interno)
6. **Si intervalo > 1h** → activar persistencia en disco (`writeDiskCache` + warm-up)
7. **Eliminar `{ cache: 'no-store' }`** del fetch en el frontend
8. **Configurar `s-maxage` + `swr`** en el handler de Express

---

## Resumen de configuración actual (post-auditoría 2026-03-07)

### Frontend polling

| Componente | Endpoint | Antes | Después |
|-----------|---------|-------|---------|
| S10 FearGreedIndex | `/api/public/fear-greed` | setInterval 60s | fetch-once en mount |
| S01 BitcoinOverview | `/api/public/mempool/overview` | setInterval 15s | setInterval 30s |
| S14 TransactionCount | `/api/s14/addresses-richer` | setInterval 60s | setInterval 1h |
| S08 NodesMap (cache) | `/api/bitnodes/cache` | setInterval 60s | setInterval 10min |
| UniqueVisitorsCounter | `/api/visitors/stats` | setInterval 30s | setInterval 5min |
| S09b Stablecoins list | `/api/s08/stablecoins` | setInterval 60s | setInterval 2min |
| S09b Stablecoins peg | `/api/s08/stablecoins/live-prices` | setInterval 60s | setInterval 2min |

### Backend TTL (s-maxage)

| Endpoint | Antes | Después |
|---------|-------|---------|
| `/api/bitnodes/cache` | 300s | 21 600s (6h) |
| `/api/s03/multi-currency` | 10s | 30s |
| `/api/s08/stablecoins` | 30s | 120s |
| `/api/s08/stablecoins/live-prices` | 30s | 120s |
| `/api/s10/btc-distribution` | 60s | 3 600s |
| `/api/s14/addresses-richer` | 60s | 3 600s |
| `/api/s13/global-assets` | 60s | 3 600s |
| `/api/public/fear-greed` | 10s | 21 600s (6h) |
| `/api/public/s21/big-mac-sats-data` | 10s | 604 800s (7d) |
| `/api/public/geo/countries` | 3 600s | 2 592 000s (30d) |
| `/api/public/geo/land` | 3 600s | 2 592 000s (30d) |

### Scrapers Docker

| Scraper | Cron anterior | Cron nuevo | Ahorro |
|---------|-------------|-----------|--------|
| `bitinfocharts-richlist` | `*/30 * * * *` (30min) | `0 2 * * *` (1×/día) | −96% |
| `bitnodes-nodes` | `*/10 * * * *` (10min) | `5 6,18 * * *` (2×/día) | −97% |
| `newhedge-global-assets` | `0 * * * *` (1h) | sin cambio ✅ | — |
| `investing-currencies` | `*/30 * * * * *` (30s) | `0 * * * * *` (60s) | −50% |

---

*Satoshi Dashboard · Auditoría de alineación de relojes · 2026-03-07*
