---
aliases:
  - Project Structure
  - Repo Structure
tags:
  - claude/repo
  - claude/rag-source
note_type: reference
domain: repo
agent_priority: high
source_status: canonical-local
---

# Project Structure

## Root Files

- `server.js` - main Express server, scrapers, cache, schedules, readiness, and public routes.
- `SCRAPER_RULES.md` - canonical cadence and cache policy for scraper behavior.
- `README.md` - public repo documentation; readable but protected from automatic edits.
- `Dockerfile` and `docker-compose.yml` - deployment contract for self-hosted runtime.
- `package.json` - runtime dependencies and npm scripts.

## Runtime Directories

- `cache/` - persisted snapshots used for warm-up and readiness.
- `.claude/` - canonical agent knowledge vault for this repo.

## Repo Constraints

1. Keep scraper implementation centralized in `server.js` unless the task explicitly introduces a new structure.
2. Preserve on-disk cache compatibility under `cache/*.json` unless a migration is part of the task.
3. Treat public API routes as compatibility-sensitive because the dashboard consumes them directly.
4. Avoid editing public docs such as `README.md` unless explicitly asked.
