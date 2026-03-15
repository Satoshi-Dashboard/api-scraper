---
aliases:
  - RAG OS
  - Retrieval Operating System
tags:
  - claude/rag
  - claude/rag-source
  - claude/home
note_type: playbook
domain: retrieval
agent_priority: critical
source_status: canonical-local
---

# RAG Operating System

This note defines how the local vault is consumed by coding agents.

## Retrieval Order

1. Start from [[VAULT_HOME]].
2. Classify the task: `agent-runtime`, `scraper`, `data-source`, `api`, `deploy`, `repo-docs`, or `general`.
3. Read the matching upstream skill from [[indexes/SKILLS_INDEX]] first when such a skill exists.
4. Read the matching local policy from [[indexes/POLICY_INDEX]] for repo-specific constraints.
5. For runtime and structural guidance, route through [[indexes/AGENT_DOCS_INDEX]] or [[indexes/REPO_DOCS_INDEX]].
6. Follow related notes before making changes if the task spans multiple domains.

## Task Routing

- `agent-runtime` -> [[indexes/AGENT_DOCS_INDEX]] + [[agent-runtime/AGENTS]]
- `scraper` -> [[SCRAPER_OPERATING_RULES]]
- `data-source` -> [[SCRAPER_OPERATING_RULES]]
- `api` -> [[SCRAPER_OPERATING_RULES]] + [[repo/PROJECT_STRUCTURE]]
- `deploy` -> [[SCRAPER_OPERATING_RULES]] + [[repo/PROJECT_STRUCTURE]]
- `repo-docs` -> [[indexes/REPO_DOCS_INDEX]] + [[repo/PROJECT_STRUCTURE]]

## Minimum Metadata For New Notes

```yaml
---
tags:
  - claude/<domain>
note_type: <policy|playbook|reference|log|welcome|moc>
domain: <topic>
agent_priority: <low|medium|high|critical>
source_status: <canonical-local|working-note|reference-only>
---
```

## Anti-Loss Rules

- Every important note must be linked from at least one index note.
- Every canonical note should carry `claude/rag-source` when it is part of the retrieval graph.
- Avoid standalone policy files with no backlinks.
- Preserve original repo paths when external tooling already depends on them.
