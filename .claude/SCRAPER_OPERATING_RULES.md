---
aliases:
  - Scraper Policy
  - Scraper Operating Rules
tags:
  - claude/policy
  - claude/scraper
  - claude/rag-source
note_type: policy
domain: scraper
agent_priority: critical
source_status: canonical-local
---

# Scraper Operating Rules

This note bridges the canonical scraper policy into the local agent vault.

## Canonical Source

- `SCRAPER_RULES.md` is the source of truth for cadence, tiers, TTL, CDN behavior, polling, persistence, and readiness expectations.

## Agent Operating Rules

1. Read `SCRAPER_RULES.md` before changing any scraper interval, cron, polling contract, cache header, or persistence behavior.
2. Treat the tier table as binding unless the owner explicitly asks for a policy change.
3. If a source updates slower than the current implementation, align the implementation downward instead of overstating freshness.
4. If a scraper interval exceeds one hour, preserve disk persistence and startup warm-up behavior.
5. Do not remove or weaken `readyz` semantics when startup caches are part of the dashboard contract.
6. Keep public freshness labels honest and consistent with real source cadence.
7. Prefer compatibility-preserving additions over breaking route or payload changes.
8. Do not treat a cache key as startup-ready if the cached payload is structurally empty or represents a failed scrape.
9. Compatibility endpoints that relay cached snapshots should reuse the same cache-header policy as their canonical source endpoint whenever the payload is identical.
10. Public response payloads should not expose private upstream base URLs, internal hostnames, or administrative secrets when those fields are not required for clients to render the data.
11. Manual or administrative endpoints must be disabled by default or protected with a server-side secret that never lives in the public repo.
12. JSONP or JavaScript data feeds must be parsed as inert data with strict wrapper validation and `JSON.parse`; never execute upstream payloads with `eval`, `Function`, or equivalent.
13. If minute-level canonical history must survive host loss or unstable local Docker state, prefer managed external Postgres over a local stateful database container; keep on-disk cache only as warm-up support.
14. Provider-supplied Postgres connection URIs may contain raw or bracketed passwords copied from dashboards; parse them safely on the backend instead of assuming strict URL encoding.
15. When an upstream already exposes bounded historical windows (for example `24h.js`, `30d.js`, `all.js`), mirror those windows into separate tables instead of forcing a single ever-growing canonical table.

## Related Notes

- [[agent-runtime/AGENTS]]
- [[repo/PROJECT_STRUCTURE]]

## Registro Historico de Automejoras y Lecciones Aprendidas

- **Fecha de la Actualizacion:** `2026-03-14`
- **Archivo(s) Afectado(s):** `.claude/SCRAPER_OPERATING_RULES.md`
- **Tipo de Evento/Contexto:** Creacion de politica puente para el vault
- **Descripcion del Evento Original:** La politica operativa del scraper existia solo en `SCRAPER_RULES.md`, fuera del flujo de navegacion agentica tipo vault.
- **Accion Realizada/Correccion:** Se creo esta nota para enlazar la politica canonica del scraper con el runtime e indices del vault.
- **Nueva/Modificada Regla o Directriz:** Los agentes deben pasar por esta nota y por `SCRAPER_RULES.md` antes de alterar scraping, cache, polling o persistencia.
- **Justificacion:** Hace consistente el modo de operacion entre repositorios sin duplicar la tabla canonica.

- **Fecha de la Actualizacion:** `2026-03-14`
- **Archivo(s) Afectado(s):** `.claude/SCRAPER_OPERATING_RULES.md`, `server.js`, `Dockerfile`, `package.json`
- **Tipo de Evento/Contexto:** Auditoria de fiabilidad y contratos de cache/readiness
- **Descripcion del Evento Original:** La auditoria detecto que `readyz` podia considerar listo el scraper de bitnodes aun con payload vacio, que endpoints de compatibilidad Knots no heredaban cache headers, que el stream de mempool.space podia quedar estancado sin deteccion, y que habia margen para mejorar reproducibilidad del runtime.
- **Accion Realizada/Correccion:** Se endurecio la validacion de readiness para bitnodes, se aplicaron `Cache-Control` a endpoints de compatibilidad, se anadio deteccion de estancamiento para el websocket de mempool.space, se redujo churn de persistencia Knots y se hizo el build mas reproducible con `npm ci` y `engines.node`.
- **Nueva/Modificada Regla o Directriz:** Readiness exige payload util, los relays compatibles deben heredar cache policy cuando sirven el mismo snapshot y los canales realtime deben vigilar estancamiento silencioso para no devolver frescura falsa.
- **Justificacion:** Evita falsos positivos de disponibilidad, mejora la reutilizacion de cache, reduce escrituras innecesarias y hace mas predecible el entorno de ejecucion.

- **Fecha de la Actualizacion:** `2026-03-14`
- **Archivo(s) Afectado(s):** `.claude/SCRAPER_OPERATING_RULES.md`, `server.js`, `docker-compose.yml`, `.env.example`
- **Tipo de Evento/Contexto:** Endurecimiento para repo publico sin romper lectura publica
- **Descripcion del Evento Original:** El repo publico seguia mostrando dominios reales en defaults y payloads, y el endpoint manual de refresh podia quedar operativo sin proteccion clara.
- **Accion Realizada/Correccion:** Se reemplazaron defaults publicos por placeholders, se movio la configuracion real a variables de entorno, se ocultaron referencias al upstream privado en respuestas JSON y se protegió el refresh con token deshabilitado por defecto.
- **Nueva/Modificada Regla o Directriz:** Los viewers publicos pueden seguir consumiendo endpoints de lectura, pero secretos operativos, upstreams privados y controles administrativos deben resolverse solo desde el entorno del servidor.
- **Justificacion:** Permite mantener el codigo abierto sin filtrar infraestructura sensible ni habilitar controles administrativos a terceros.

- **Fecha de la Actualizacion:** `2026-03-23`
- **Archivo(s) Afectado(s):** `.claude/SCRAPER_OPERATING_RULES.md`, `SCRAPER_RULES.md`, `server.js`, `docker-compose.yml`, `.env.example`, `.env`
- **Tipo de Evento/Contexto:** Nueva integracion de fuente Johoe con JSONP y persistencia SQL
- **Descripcion del Evento Original:** La integracion de Johoe para mempool historico minuto a minuto exigio consumir un feed estructurado en JSONP/JS y no existia una regla local explicita para tratar ese formato como datos no ejecutables.
- **Accion Realizada/Correccion:** Se anadio una regla explicita para feeds JSONP/JS, se implemento parsing estricto sin ejecucion de codigo y se monto persistencia SQL/Portainer para desacoplar ZatoBox del upstream.
- **Nueva/Modificada Regla o Directriz:** Los feeds JSONP/JS se aceptan solo con validacion estricta del wrapper y parseo inerte; ademas, las fuentes historicas cuasi realtime deben persistirse fuera del proceso en almacenamiento durable cuando alimentan endpoints propios del stack.
- **Justificacion:** Reduce riesgo de seguridad, evita fragilidad del frontend frente al upstream y deja trazabilidad operativa para fuentes sin API JSON formal.

- **Fecha de la Actualizacion:** `2026-03-23`
- **Archivo(s) Afectado(s):** `.claude/SCRAPER_OPERATING_RULES.md`, `docker-compose.yml`, `.env.example`, `.env`
- **Tipo de Evento/Contexto:** Ajuste de despliegue para usar Supabase en lugar de Postgres local
- **Descripcion del Evento Original:** El owner reporto cortes de luz y fallos del host Docker, lo que hacia riesgoso guardar el historico Johoe en un contenedor Postgres local dentro del mismo servidor.
- **Accion Realizada/Correccion:** Se elimino el servicio Postgres del stack, se mantuvo la compatibilidad con `pg` y se reorientaron las variables de entorno para apuntar a Supabase con SSL.
- **Nueva/Modificada Regla o Directriz:** Para historicos minuto a minuto que deben sobrevivir perdida del host, se permite y prioriza Postgres gestionado externo sobre base stateful local en Docker.
- **Justificacion:** Mejora resiliencia operativa sin cambiar el contrato API ni la logica de ingestion.

- **Fecha de la Actualizacion:** `2026-03-23`
- **Archivo(s) Afectado(s):** `.claude/SCRAPER_OPERATING_RULES.md`, `server.js`, `.env.example`, `.env`
- **Tipo de Evento/Contexto:** Endurecimiento de parsing para URIs directas de Supabase
- **Descripcion del Evento Original:** La URI de conexion directa copiada desde Supabase podia incluir password con simbolos y formato entre corchetes, lo que rompe parsers estrictos basados solo en `new URL()`.
- **Accion Realizada/Correccion:** Se agrego parsing tolerante para `DATABASE_URL` y se documentaron ejemplos de URI directa compatibles con el scraper.
- **Nueva/Modificada Regla o Directriz:** Las credenciales remotas copiadas desde dashboards de proveedores deben aceptarse de forma segura aunque vengan en formato raw/bracketed, sin ejecutar ni reinterpretar contenido fuera de un parser controlado.
- **Justificacion:** Reduce friccion operativa al configurar proveedores gestionados y evita fallos silenciosos por encoding incompleto de passwords.

- **Fecha de la Actualizacion:** `2026-03-23`
- **Archivo(s) Afectado(s):** `.claude/SCRAPER_OPERATING_RULES.md`, `SCRAPER_RULES.md`, `README.md`, `server.js`, `docker-compose.yml`, `.env.example`, `.env`, `supabase/migrations/20260323220000_split_johoe_queue_tables.sql`, `scripts/sync-johoe-datasets.mjs`
- **Tipo de Evento/Contexto:** Persistencia Johoe dividida en datasets rolling y dataset diario persistente
- **Descripcion del Evento Original:** Usar una sola tabla para snapshots Johoe mezclaba resoluciones distintas y hacia crecer innecesariamente la base de Supabase Free, pese a que el upstream ya ofrece ventanas `24h`, `30d` y `all` con semánticas diferentes.
- **Accion Realizada/Correccion:** Se separo la persistencia en tres tablas (`24h` rolling, `30d` rolling y `all` diario persistente), se añadió una migración específica y se creó un script de resincronización manual para Supabase.
- **Nueva/Modificada Regla o Directriz:** Si el upstream ya modela ventanas acotadas, la persistencia interna debe respetar esas ventanas con tablas separadas y evitar historiales infinitos innecesarios.
- **Justificacion:** Conserva el contrato API, estabiliza el peso en Supabase Free y reduce la complejidad operativa respecto a compactaciones posteriores.
