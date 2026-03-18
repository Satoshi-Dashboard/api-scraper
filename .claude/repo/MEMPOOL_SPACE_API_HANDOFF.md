---
aliases:
  - Mempool API Handoff
  - api.zatobox.io Mempool Routes
tags:
  - claude/repo
  - claude/agent
  - claude/rag-source
note_type: reference
domain: mempool-api
agent_priority: medium
source_status: canonical-local
---

# Mempool Space API Handoff

## Nombre a mencionar al otro agente

- Pidele la API a `api.zatobox.io`.
- Si necesita un nombre corto, usa `Zatobox API`.

## Endpoints listos

- `GET /api/scrape/mempool-space-memory-usage` - `Memory Usage`
- `GET /api/scrape/mempool-space-transaction-fees` - `Transaction Fees`
- `GET /api/scrape/mempool-space-unconfirmed-transactions` - `Unconfirmed TXs`

## Fuentes upstream

- `Memory Usage` y `Transaction Fees` salen del websocket `wss://mempool.space/api/v1/ws` con la suscripcion `stats`.
- `Unconfirmed TXs` sale de `https://mempool.space/api/mempool` usando el campo `count`.

## Subagentes sugeridos

- `Subagente rutas mempool`: verifica que `api.zatobox.io` exponga las tres rutas y revise `_meta.cachedAt`.
- `Subagente upstream mempool`: compara `fees`, `mempoolInfo.usage` y `count` contra `mempool.space` para validar integridad.
- `Subagente dashboard`: conecta el frontend al dominio `api.zatobox.io` y usa los nombres `Transaction Fees`, `Memory Usage` y `Unconfirmed TXs` tal cual.

## Prompt corto reutilizable

```text
Usa la API de api.zatobox.io (Zatobox API) y consume estas rutas:
- /api/scrape/mempool-space-transaction-fees
- /api/scrape/mempool-space-memory-usage
- /api/scrape/mempool-space-unconfirmed-transactions

Necesito los bloques visuales Transaction Fees, Memory Usage y Unconfirmed TXs usando esos endpoints.
```
