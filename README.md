# Satoshi Dashboard Scraper

Este es un microservicio autónomo en Node.js que sirve como recolector de datos (scraper) para el Satoshi Dashboard.

## ¿Por qué existe este servicio?
Satoshi Dashboard necesita extraer datos de sitios web que bloquean las IPs de Vercel y otros datacenters (como `investing.com` o `bitinfocharts.com`). Al alojar este servicio en tu propia red o VPS (UmbrelOS, Portainer, etc.), utilizas IPs que no están bloqueadas, resolviendo así los errores 502 de la aplicación principal.

## APIs Soportadas

| Endpoint | Descripción | Datos que muestra | Frecuencia de actualización |
|----------|-------------|-------------------|----------------------------|
| `/api/scrape/investing-currencies` | Investing.com | Tipos de cambio de divisas USD (EUR/USD, GBP/USD, etc.) | Cada 60 segundos |
| `/api/scrape/bitinfocharts-richlist` | BitInfoCharts | Top 100 direcciones más ricas de Bitcoin y distribución | Diario (02:00 UTC) |
| `/api/scrape/bitnodes-nodes` | BitNodes.io | Número de nodos Bitcoin y distribución por ASN | 2 veces al día (06:05 y 18:05 UTC) |
| `/api/scrape/newhedge-global-assets` | NewHedge.io | Valores de activos globales relacionados con Bitcoin | Cada hora |
| `/api/scrape/companiesmarketcap-gold` | CompaniesMarketCap | `GOLD`, market cap, precio y variación diaria del oro | Cada 15 minutos |
| `/api/scrape/mempool-space-memory-usage` | mempool.space | Uso de memoria del mempool en tiempo real desde `stats.mempoolInfo.usage` | Tiempo real (WebSocket) |
| `/api/scrape/mempool-knots-init-data-json` | Mempool Knots local | Snapshot JSON bruto de `/api/v1/init-data` | Cada 1 segundo |
| `/api/scrape/mempool-knots-memory-usage` | Mempool Knots relay | JSON procesado desde el snapshot de Knots listo para la otra app | Cada 1 segundo |
| `/api/scrape/johoe-btc-queue/latest` | Johoe queue | Último snapshot BTC con `count`, `weight` y `fee` | Cada 60 segundos |
| `/api/scrape/johoe-btc-queue/history?range=24h` | Johoe queue | Ventana rolling de 24h en resolución ~1 minuto | Cada 60 segundos |
| `/api/scrape/johoe-btc-queue/history?range=30d` | Johoe queue | Ventana rolling de 30 días en resolución ~30 minutos | Cada 15 minutos |
| `/api/scrape/johoe-btc-queue/history?range=all` | Johoe queue | Histórico persistente diario desde `all.js` | Cada 6 horas |
| `/api/public/mempool/node` | Compatibilidad Mempool API | Expone el snapshot raw de Knots desde esta API para evitar acceso directo a knotapi | Cada 1 segundo |
| `/api/v1/init-data` | Compatibilidad Knots | Relay del payload raw de init-data de Knots servido por `api.zatobox.io` | Cada 1 segundo |

### Endpoints disponibles

- `GET /api/scrape/investing-currencies`
- `GET /api/scrape/bitinfocharts-richlist`
- `GET /api/scrape/bitnodes-nodes`
- `GET /api/scrape/newhedge-global-assets`
- `GET /api/scrape/companiesmarketcap-gold`
- `GET /api/scrape/mempool-space-memory-usage`
- `GET /api/scrape/mempool-knots-init-data-json`
- `GET /api/scrape/mempool-knots-memory-usage`
- `GET /api/scrape/johoe-btc-queue/latest`
- `GET /api/scrape/johoe-btc-queue/latest/count`
- `GET /api/scrape/johoe-btc-queue/latest/weight`
- `GET /api/scrape/johoe-btc-queue/latest/fee`
- `GET /api/scrape/johoe-btc-queue/history?range=24h|30d|all`
- `GET /api/public/mempool/node`
- `GET /api/v1/init-data`
- `GET /health`
- `GET /readyz`

## Operacion y tiempo de primera respuesta

- El scraper ahora reutiliza snapshots persistidos en disco para `investing-currencies`, `bitinfocharts-richlist`, `bitnodes-nodes`, `newhedge-global-assets` y `companiesmarketcap-gold`.
- Johoe usa Supabase como almacenamiento canónico y conserva además snapshots de arranque en `cache/` para warm-up rápido del contenedor.
- El arranque inicial ejecuta los scrapes HTTP de forma paralela para reducir el tiempo hasta tener datos reales disponibles tras reinicios.
- `GET /health` indica que el proceso esta vivo; `GET /readyz` indica que los caches minimos para el dashboard ya estan cargados.
- Los endpoints servidos desde cache publican `Cache-Control` con `s-maxage` y `stale-while-revalidate` para que el dashboard y el edge reutilicen snapshots reales ya obtenidos.

## Arquitectura Johoe + Supabase

La integración de Johoe quedó separada en tres datasets para mantener estable el peso en Supabase Free y seguir entregando una API propia a ZatoBox:

| Tabla Supabase | Fuente Johoe | Persistencia | Resolución real | Propósito |
|---|---|---|---|---|
| `public.johoe_queue_all_daily` | `all.js` | Crece en el tiempo | ~1 punto por día | Histórico largo persistente |
| `public.johoe_queue_24h_rolling` | `24h.js` | Rolling, espejo exacto | ~1 minuto | Último día y `latest` |
| `public.johoe_queue_30d_rolling` | `30d.js` | Rolling, espejo exacto | ~30 minutos | Últimos 30 días sin crecimiento infinito |

Detalles importantes:

- El backend no resume `all.js`; Johoe ya entrega ese histórico en resolución diaria.
- `24h.js` y `30d.js` se espejan como ventanas rolling: se hace `upsert` de los puntos actuales y se borran los que ya salieron de la ventana.
- El histórico persistente lo aporta solo `all.js`, por eso el tamaño de la base queda estable y predecible en Supabase Free.
- `latest` se sirve desde la tabla rolling de `24h`, porque es la de mayor resolución disponible.
- `history?range=all` devuelve histórico diario; `history?range=24h` y `history?range=30d` devuelven las ventanas vivas actuales.

## Scripts utiles

- `npm run sync:johoe:supabase`

Este script fuerza una resincronización manual de las tres tablas Johoe (`all`, `24h`, `30d`) directamente contra Supabase. Es útil para sembrar datos por primera vez, reparar una tabla rolling o validar que el proyecto remoto quedó bien migrado.

## Despliegue en Portainer (Vía GitHub)

Ya que este directorio contiene toda la configuración necesaria (`Dockerfile` y `docker-compose.yml`), puedes desplegarlo muy fácilmente en Portainer directamente desde este repositorio.

### Paso 1: Subir código a GitHub
Sube el contenido de esta carpeta (`satoshi-scraper`) a tu propio repositorio de GitHub (puede ser privado o público).

### Paso 2: Configurar Stack en Portainer
1. Abre tu interfaz de Portainer y ve a **Stacks**.
2. Dale a **Add stack**.
3. Ponle un nombre (ej. `satoshi-scraper`).
4. Selecciona el método de despliegue **Repository**.
5. Pon la URL del repositorio al que acabas de subir estos archivos.
6. Si es privado, asegúrate de activar **Authentication** y proporcionar tu token de acceso (PAT) o credenciales de la cuenta.
7. (Opcional) Activa **Enable automatic updates** (usando webhook) vía polling o trigger para que Portainer aplique el nuevo código si actualizas la branch.
8. En **Compose path**, asegúrate de que ponga `docker-compose.yml`.
9. Haz clic en **Deploy the stack**.

Variables Johoe recomendadas para Portainer:

- `DATABASE_URL`: usa el `Transaction pooler` de Supabase
- `JOHOE_24H_SYNC_INTERVAL_MS=60000`
- `JOHOE_30D_SYNC_INTERVAL_MS=900000`
- `JOHOE_ALL_SYNC_INTERVAL_MS=21600000`
- `JOHOE_DEFAULT_RANGE=24h`
- `JOHOE_QUERY_LIMIT_MAX=5000`

### Paso 3: Exponer mediante un túnel
Una vez desplegado, el servicio estará corriendo en el puerto `9119` (ej. `http://localhost:9119` o IP local `http://192.168.0.x:9119`).

Crea un túnel (como Cloudflare Tunnel) que exponga dicha IP local y puerto al dominio externo `https://api.zatobox.io/` (tal como has configurado).

Asegúrate de comprobar la viabilidad llamando a:
`https://api.zatobox.io/health` (respuesta mínima esperada: `{ "status": "ok" }`).

Checks recomendados tras el deploy:

- `GET /api/scrape/johoe-btc-queue/latest`
- `GET /api/scrape/johoe-btc-queue/history?range=24h&limit=60`
- `GET /api/scrape/johoe-btc-queue/history?range=30d&limit=120`
- `GET /api/scrape/johoe-btc-queue/history?range=all&limit=365`

¡Con esto, el Satoshi Dashboard leerá mágicamente los datos y todo volverá a funcionar!


## Seguridad de credenciales

- **Nunca** subas `.env` al repositorio; usa solo `.env.example` como plantilla.
- Si alguna vez un `.env` real estuvo versionado/publicado, rota inmediatamente passwords/tokens/credenciales (RPC, API keys, etc.).

## Seguridad de despliegue

- El backend fuerza redirección HTTP→HTTPS (308) cuando el host coincide con `HTTPS_REDIRECT_HOST` (por defecto `api.zatobox.io`).
- En tráfico HTTPS se envía `Strict-Transport-Security: max-age=31536000; includeSubDomains; preload`.
- CORS usa allowlist explícita vía `CORS_ALLOWED_ORIGINS` (CSV), sin wildcard `*`.
- `x-powered-by` de Express está deshabilitado.
- `/health` está minimizado para exponer solo `{ "status": "ok" }`.


### Migración desde `knotapi.zatobox.io`

Si tu app aún consume datos de Knots desde `knotapi.zatobox.io`, puedes apuntarla a `api.zatobox.io` usando rutas compatibles:

- `GET /api/public/mempool/node`
- `GET /api/v1/init-data`

Ambas rutas son relays del snapshot de Knots obtenido por este servicio, para centralizar seguridad y exposición pública en un solo host.
