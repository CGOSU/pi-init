---
name: {{PROJECT_SLUG}}
description: {{SKILL_DESCRIPTION}}
---

# {{PROJECT_NAME}} Intelligent Responsibility Router

For tasks in this project, treat the repository-root `AGENTS.md` as the single rules entrypoint. Select the fewest roles needed for the deliverable, then read only project documents relevant to the task.

## Role Profiles

| Role | Technical level | Deliverables | Model type | Default model | Pi reasoning level |
| --- | --- | --- | --- | --- | --- |
| Architect | Expert (Staff / Principal): capable of system boundaries, trade-offs, data and API design, migrations, and non-functional risk analysis | Architecture decisions, constraints, risks, and acceptance criteria; no code changes by default | Frontier general reasoning model with long context and strong trade-off analysis | `openai-codex/gpt-5.6-sol` | `max` |
| Development and Test Engineer | Senior (Senior / SDET): capable of implementation, debugging, refactoring, and unit, integration, and regression testing | Minimal code changes, tests, commands, and actual results | Code-specialized or strong tool-use model for code comprehension and testing | `openai-codex/gpt-5.6-terra` | `high` |
| Documentation and Commit Engineer | Senior (Technical Writer / Release Engineer): capable of terminology control, change verification, and traceable commits | Documentation, change summary, commit boundaries, and commit message | Fast general model with strong instruction following and structured writing | `openai-codex/gpt-5.6-luna` | `medium` |

## Intelligent Assignment

1. Use the Architect first for cross-module boundaries, technology choices, data models, security, performance, or irreversible migrations. It returns decisions, constraints, and acceptance criteria.
2. Route implementation, fixes, refactoring, debugging, and testing to the Development and Test Engineer. Skip the Architect for small, well-defined changes.
3. Route documentation-only work directly to the Documentation and Commit Engineer. For code work, enter this phase only after verification.
4. For mixed work, hand off sequentially: Architect → Development and Test Engineer → Documentation and Commit Engineer. Do not activate every role for a simple task.
5. Before committing, inspect the actual diff and verification results. Run `git commit` only when explicitly requested, and `git push` only when explicitly requested.

## Automatic Model Switching

- Call `switch_role` before every role starts and again at each role boundary; changing tone is not a model switch.
- Role IDs: `architect` for Architect, `developer-test` for Development and Test Engineer, and `docs-commit` for Documentation and Commit Engineer.
- `switch_role` reads the project mapping from `.pi/role-models.json`, calls Pi's model and reasoning-level APIs, and returns the effective result.
- If switching fails, stop that role immediately and report the error. Never continue under the wrong model or claim success.
- Users can verify the same mapping with `/role <role ID>` and customize models only in `.pi/role-models.json`.

## Handoff Contract

- Architect: decision, rationale, constraints, risks, and acceptance criteria.
- Development and Test Engineer: changed files, implementation summary, verification commands, and actual results.
- Documentation and Commit Engineer: documentation changes, final diff summary, and authorized commit or push results.
- During wrap-up, update a project document only when there is a new fact to record, following `AGENTS.md`.
