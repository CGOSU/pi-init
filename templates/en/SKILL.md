---
name: {{PROJECT_SLUG}}
description: {{SKILL_DESCRIPTION}}
---

# {{PROJECT_NAME}} Project Skill

## Starting a Task

Read `AGENTS.md` at the repository root first, then follow its order for the project documents relevant to the task.

## Context Entrypoints

- Current goals and unfinished work: `docs/current-state.md`
- Confirmed design choices: `docs/decisions.md`
- Recent changes and verification: `docs/session-log.md`
- Reusable troubleshooting knowledge: `docs/pitfalls.md`

## Boundaries

- `AGENTS.md` is the single source of truth for long-term collaboration rules; this Skill does not duplicate them.
- `docs/pitfalls.md` is the single source of truth for troubleshooting conclusions; load only entries relevant to the current problem.
- After making changes, follow the session wrap-up requirements in `AGENTS.md`.
