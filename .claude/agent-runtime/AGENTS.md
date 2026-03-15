---
aliases:
  - Agent Runtime Canonical
  - OpenCode Runtime Policy
tags:
  - claude/agent
  - claude/policy
  - claude/rag-source
note_type: policy
domain: agent-runtime
agent_priority: critical
source_status: canonical-local
---

# Regla Universal de Automejora y Actualizacion Continua de Documentos de Reglas

**Objetivo primordial:** Este documento y los demas archivos `.md` que contienen reglas, directrices o conocimiento operativo deben actualizarse proactivamente cuando el agente detecte un error corregido, una aplicacion deficiente de una regla, o una oportunidad clara de mejora. El objetivo es que el agente aprenda de cada tarea y mantenga su marco operativo mas preciso, util y coherente para este repositorio.

**Proceso de actualizacion automatica de documentos (`.md`):**
1. **Deteccion y correccion de eventos:** Cuando el agente detecte un error, un fallo de criterio o una mejora importante, y dicho evento sea corregido.
2. **Analisis de impacto:** Determinar si la resolucion exige mejorar este documento o cualquier otra nota operativa relacionada.
3. **Ejecucion de la actualizacion del archivo (`.md`):**
   * **Identificacion del cambio:** Localizar la regla, seccion o nota que deba ajustarse.
   * **Formato del registro historico:** Registrar el cambio al final del documento afectado en `## Registro Historico de Automejoras y Lecciones Aprendidas` con estos campos:
     * **Fecha de la Actualizacion:** `AAAA-MM-DD`
     * **Archivo(s) Afectado(s):** nombres de archivos modificados
     * **Tipo de Evento/Contexto:** error, desviacion de regla, optimizacion, etc.
     * **Descripcion del Evento Original:** que ocurrio
     * **Accion Realizada/Correccion:** como se resolvio
     * **Nueva/Modificada Regla o Directriz:** que se agrego o cambio
     * **Justificacion:** por que la mejora importa
   * **Prioridad recursiva:** Si la mejora cambia la propia forma de automejorar, actualizar tambien esta regla.

## Addendum Skills-First de Autoridad Tecnica

1. Las skills instaladas bajo `.claude/skills/*/SKILL.md`, si existen, son la autoridad tecnica primaria para patrones de implementacion y workflows.
2. Las reglas locales en `.claude/` funcionan como capa de adaptacion al repo, trazabilidad, seguridad operativa y contratos especificos del scraper.
3. Si no existen skills instaladas para el tema, la autoridad tecnica local pasa a ser `SCRAPER_RULES.md` y las notas canonicas del vault.
4. Si una regla local entra en conflicto con una skill instalada, debe prevalecer la skill salvo que el owner haya fijado una restriccion mas fuerte de seguridad, compatibilidad o integridad de datos.

## Obsidian Context

- Home: [[VAULT_HOME]]
- Retrieval: [[RAG_OPERATING_SYSTEM]]
- Policy cluster: [[indexes/POLICY_INDEX]]
- Agent docs: [[indexes/AGENT_DOCS_INDEX]]
- Related: [[SCRAPER_OPERATING_RULES]], [[repo/PROJECT_STRUCTURE]]

## Workflow Paso 0: Ciclo Pre-Entrega de Revision y Automejora

1. **Activacion por solicitud:** Cada vez que el agente reciba una tarea que termine en una salida para el usuario o el sistema.
2. **Pre-procesamiento de reglas y adhesion a directrices:** Antes de responder o tocar codigo, el agente debe:
   * Revisar las reglas generales y especificas relevantes para la tarea.
   * Confirmar que la accion planeada respeta las restricciones del repo.
   * Verificar si la tarea afecta documentos `.md` operativos y mantener su coherencia estructural.
   * **Excepcion protegida para `README.md`:** `README.md` es un documento publico. Puede leerse, pero no debe editarse ni recibir boilerplate interno sin una instruccion explicita del owner.
3. **Monitoreo y deteccion proactiva:** Durante la tarea, el agente debe vigilar errores logicos, de datos, de scraping, de seguridad, de cache y de aplicacion de reglas.
4. **Actualizacion formal de conocimiento:** Tras corregir un error o incorporar una mejora relevante, actualizar el `.md` pertinente y anotar la leccion en el registro historico.
5. **Confirmacion interna antes de entrega:** Verificar que las reglas necesarias fueron revisadas y que cualquier aprendizaje relevante quedo persistido.
6. **Entrega final:** Responder con el trabajo terminado ya alineado con las reglas y el conocimiento actualizado.

## Agent Runtime Policy

For OpenCode, Codex, Claude, and any automated coding agent:

1. Treat `.claude/` as the canonical knowledge vault for this repo and start from `.claude/VAULT_HOME.md` plus `.claude/RAG_OPERATING_SYSTEM.md`.
2. Before any scraper, cache, polling, source-priority, or API work, read `.claude/SCRAPER_OPERATING_RULES.md`.
3. Treat `SCRAPER_RULES.md` as the canonical business and cadence source; `.claude/SCRAPER_OPERATING_RULES.md` exists to bridge that policy into the vault and add agent-facing constraints.
4. Before any project analysis or improvement review, inspect `README.md`, `package.json`, `server.js`, `SCRAPER_RULES.md`, `.claude/VAULT_HOME.md`, and `.claude/RAG_OPERATING_SYSTEM.md`.
5. Do not change scraper cadence, TTL, persistence, or public endpoint contracts unless the task explicitly requires it and the result remains aligned with `SCRAPER_RULES.md`.
6. Treat disk persistence, readiness behavior, and cache headers as critical operational contracts, not optional implementation details.
7. Preserve compatibility for `GET /health`, `GET /readyz`, and the published `/api/...` routes unless the owner explicitly asks to change them.
8. Keep deployment assumptions compatible with Docker, Portainer, and the current self-hosted runtime unless the owner explicitly asks for a platform change.
9. For any data-source change, prefer safer fallbacks and do not silently degrade source integrity or freshness claims.
10. If a task reveals a better repo-specific operating rule, update the relevant `.claude/*.md` note and its historical log.

## Registro Historico de Automejoras y Lecciones Aprendidas

- **Fecha de la Actualizacion:** `2026-03-14`
- **Archivo(s) Afectado(s):** `.claude/agent-runtime/AGENTS.md`
- **Tipo de Evento/Contexto:** Adopcion inicial del runtime canonico en este repo
- **Descripcion del Evento Original:** `satoshi-scraper` no tenia una capa de runtime para agentes equivalente a la usada en `satoshi-dashboard`, lo que hacia menos consistente la forma de revisar reglas, enrutar contexto y persistir aprendizaje operativo.
- **Accion Realizada/Correccion:** Se creo una politica runtime canonica dentro de `.claude/agent-runtime/AGENTS.md`, con bridge en la raiz y referencias a las reglas del scraper ya existentes.
- **Nueva/Modificada Regla o Directriz:** Los agentes ahora deben arrancar desde `.claude/`, seguir el flujo de retrieval y usar `SCRAPER_RULES.md` como autoridad local para scraping, cache y cadencia.
- **Justificacion:** Alinea el modo de trabajo entre repositorios y reduce errores de contexto al operar sobre este microservicio.
