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
| `/api/scrape/bitcoin-core-mempool` | Bitcoin Core RPC vía Tor | Resultado completo de `getmempoolinfo` cacheado | Cada 5 segundos |
| `/api/scrape/mempool-space-memory-usage` | mempool.space | Uso de memoria del mempool en tiempo real desde `stats.mempoolInfo.usage` | Tiempo real (WebSocket) |
| `/api/scrape/mempool-knots-init-data-json` | Mempool Knots local | Snapshot JSON bruto de `/api/v1/init-data` | Cada 1 segundo |
| `/api/scrape/mempool-knots-memory-usage` | Mempool Knots relay | JSON procesado desde el snapshot de Knots listo para la otra app | Cada 1 segundo |

### Endpoints disponibles

- `GET /api/scrape/investing-currencies`
- `GET /api/scrape/bitinfocharts-richlist`
- `GET /api/scrape/bitnodes-nodes`
- `GET /api/scrape/newhedge-global-assets`
- `GET /api/scrape/companiesmarketcap-gold`
- `GET /api/scrape/bitcoin-core-mempool`
- `GET /api/scrape/mempool-space-memory-usage`
- `GET /api/scrape/mempool-knots-init-data-json`
- `GET /api/scrape/mempool-knots-memory-usage`
- `GET /health`

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

### Paso 3: Exponer mediante un túnel
Una vez desplegado, el servicio estará corriendo en el puerto `9119` (ej. `http://localhost:9119` o IP local `http://192.168.0.x:9119`).

Crea un túnel (como Cloudflare Tunnel) que exponga dicha IP local y puerto al dominio externo `https://api.zatobox.io/` (tal como has configurado).

Asegúrate de comprobar la viabilidad llamando a:
`https://api.zatobox.io/health`

¡Con esto, el Satoshi Dashboard leerá mágicamente los datos y todo volverá a funcionar!
