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
