---
aliases:
  - Claude Vault Home
  - Knowledge Vault Home
tags:
  - claude/home
  - claude/rag-source
note_type: moc
domain: vault
agent_priority: critical
source_status: canonical-local
---

# Vault Home

`.claude/` is the shared knowledge vault for this repo's coding agents.

## Start Here

1. [[RAG_OPERATING_SYSTEM]]
2. [[indexes/POLICY_INDEX]]
3. [[indexes/SKILLS_INDEX]]
4. [[indexes/AGENT_DOCS_INDEX]]
5. [[indexes/REPO_DOCS_INDEX]]

## Canonical Local Policies

- [[agent-runtime/AGENTS]]
- [[SCRAPER_OPERATING_RULES]]
- [[repo/PROJECT_STRUCTURE]]

## Shared Retrieval Contract

- Agents start from this note, then route through [[RAG_OPERATING_SYSTEM]].
- Local repo policy lives canonically under `.claude/` when possible.
- Root compatibility files such as `AGENTS.md` exist only for tooling that still expects them.
- New operational notes should link back to at least one index note.
