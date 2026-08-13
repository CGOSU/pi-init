---
name: {{PROJECT_SLUG}}
description: {{SKILL_DESCRIPTION}}
---

# {{PROJECT_NAME}} Intelligent Responsibility Router

For tasks in this project, treat the repository-root `AGENTS.md` as the single rules entrypoint. Select the fewest roles needed for the deliverable, then read only project documents relevant to the task.

## Exact String Replacement

- Read the latest file contents before editing; use exact `oldText` → `newText` replacement rather than fuzzy matching, regular expressions, or line-number-only positioning.
- `oldText` must match exactly once in the original file; if it matches zero or multiple times, stop, reread the file, and adjust the context instead of guessing.
- Keep `oldText` to the smallest context that makes the match unique; preserve unchanged text and avoid rewriting the whole file.
- For multiple non-adjacent changes in one file, submit multiple non-overlapping replacements in one edit operation; each replacement is matched against the original file.
- Inspect the actual diff after editing, confirm there are no unintended changes, then run relevant verification.

## Role Profiles

| Role | Technical level | Deliverables | Model type | Default model | Pi reasoning level |
| --- | --- | --- | --- | --- | --- |
| Architect | Expert (Staff / Principal): capable of system boundaries, trade-offs, data and API design, migrations, and non-functional risk analysis | Architecture decisions, constraints, risks, and acceptance criteria; no code changes by default | Frontier general reasoning model with long context and strong trade-off analysis | `{{ARCHITECT_PROVIDER}}/{{ARCHITECT_MODEL}}` | `{{ARCHITECT_THINKING_LEVEL}}` |
| Development and Test Engineer | Senior (Senior / SDET): capable of implementation, debugging, refactoring, and unit, integration, and regression testing | Minimal code changes, tests, commands, and actual results | Code-specialized or strong tool-use model for code comprehension and testing | `{{DEVELOPER_TEST_PROVIDER}}/{{DEVELOPER_TEST_MODEL}}` | `{{DEVELOPER_TEST_THINKING_LEVEL}}` |
| Documentation and Wrap-up Engineer | Senior (Technical Writer / Release Engineer): capable of documentation maintenance, version bumps, change verification, and release wrap-up | Documentation, version bumps, change summary, wrap-up checks, commit boundaries, and commit message | Fast general model with strong instruction following and structured writing | `{{DOCS_COMMIT_PROVIDER}}/{{DOCS_COMMIT_MODEL}}` | `{{DOCS_COMMIT_THINKING_LEVEL}}` |

## Intelligent Assignment

1. Use the Architect first for cross-module boundaries, technology choices, data models, security, performance, or irreversible migrations. It returns decisions, constraints, and acceptance criteria.
2. Route implementation, fixes, refactoring, debugging, and testing to the Development and Test Engineer. Skip the Architect for small, well-defined changes.
3. Route documentation-only work directly to the Documentation and Wrap-up Engineer. For code work, enter this phase only after verification.
4. For mixed work, hand off sequentially: Architect → Development and Test Engineer → Documentation and Wrap-up Engineer. Do not activate every role for a simple task.
5. Before committing, inspect the actual diff and verification results. Run `git commit` only when explicitly requested, and `git push` only when explicitly requested.

## Architecture Decomposition and Automatic Task Workflow

- Default to a continuous flow: Architect analysis → call `task_workflow(action=plan)` to freeze tasks → Development and Test Engineer completes tasks one by one → automatically start the next task → Documentation and Wrap-up Engineer finishes. Do not ask the user to choose between tasks.
- Every Architect-created task must include a unique `id`, a goal in `task`, allowed `files`, verifiable `acceptanceCriteria`, and `dependsOn` when ordering matters; tasks run sequentially when their dependencies are ready.
- Set `reviewRequired` to `true` only when the user's initial request explicitly asks to see or review the architecture first. The workflow then pauses after saving the plan and resumes with `/pi-init workflow resume`; the default is automatic advancement.
- After receiving a task, the Development and Test Engineer should implement, test, and fix directly instead of pausing for optional preferences. On completion, call `task_workflow(action=complete, taskId=..., completionSummary=..., verification=[...])`; the verification list may contain only commands actually run and their real results.
- If a product decision, permission/credential, destructive-operation approval, unrecoverable failure, or genuinely blocking fact is missing, call `task_workflow(action=block, taskId=..., reason=...)` instead of guessing completion; after resolution, use `/pi-init workflow retry <taskId>`.
- After completion, the extension switches the configured role/model and starts the next task through a hidden continuation message. Do not manually reassign the next task or ask the user to trigger it. If the model forgets the completion action, the system nudges it a limited number of times and then pauses.
- `parallel_develop` is an optimization for independent work, not the default. Shared interfaces, DOM/API behavior, test contracts, or ordering dependencies must use the sequential workflow.

## Role Switching Modes

- The top-level `mode` in `.pi/role-models.json` can be `auto`, `confirm`, or `manual`; the default is `auto`.
- `auto` applies automatic role changes immediately; `confirm` asks before an automatic change, with “Accept suggestion” selected by default and options to switch to manual mode or cancel; `manual` blocks automatic changes and requires `/pi-init role <role ID>` first.
- `/pi-init mode <mode>` overrides the mode for the current session only; edit `.pi/role-models.json` to change the project default.

## User Entry Point

- `/pi-init`: open the control center for quick/advanced initialization, role configuration, role switching, and mode switching.
- `/pi-init init [directory]`: initialize from project metadata with one confirmation.
- `/pi-init advanced [directory]`: edit the project name, language, test command, and Skill before initialization.
- `/pi-init role <role ID>`: manually switch roles.
- `/pi-init config [role ID]`: persistently change a role's model and reasoning level.

## Automatic Model Switching

- Call `switch_role` before every role starts and again at each role boundary; changing tone is not a model switch.
- Role IDs: `architect` for Architect, `developer-test` for Development and Test Engineer, and `docs-commit` for Documentation and Wrap-up Engineer.
- `switch_role` reads the project mapping from `.pi/role-models.json`, calls Pi's model and reasoning-level APIs, and returns the effective result.
- If switching fails, stop that role immediately and report the error. Never continue under the wrong model or claim success.
- In auto mode, only a real role boundary at 50% or more context usage triggers one compaction after the agent is fully settled; it preserves the goal, decisions, progress, files, verification results, and next steps, then resumes the task on success. Confirm, manual, first-role, same-role, and unknown-context switches do not trigger extra compaction.
- At session start, resume, or reload, restore a role only when the current model and thinking level uniquely match its configuration; otherwise keep the role unknown.
- Users can verify the same mapping with `/pi-init role <role ID>`; in trusted projects, use `/pi-init config [role ID]` to persistently adjust a role's model or reasoning level; in manual mode, run `/pi-init role` and retry the automatic role boundary.

- After the Architect produces a plan with at least two truly independent, contract-frozen work packages that are large enough to run for a while, call `parallel_develop` to run multiple Development and Test Engineers concurrently; use one engineer for small or semantically coupled files.
- Every `parallel_develop` task must provide an `id`, `task`, and non-overlapping `files` scope; non-overlapping files are not sufficient when tasks share a DOM, API, or test contract. Up to 4 tasks are accepted, with 2 workers running concurrently by default.
- `parallel_develop` runs only in trusted projects, uses isolated Git worktrees, and merges successful changes automatically; workers use Pi's JSON event stream, while the status bar and tool progress show each task's status, current tool, elapsed time, and last activity, with high-frequency model updates throttled. Infrastructure failures, including `terminated` transport interruptions, are retried once automatically; results include elapsed time, token/cache/cost/retry metrics. Code or test failures are handed to the main Development and Test Engineer. Failed worktrees and logs are preserved; the main worktree must be clean, and workers must not commit or push. Workers use `--no-approve` and never promote project trust automatically.
- `parallel_develop` follows Git `core.ignorecase` for filesystem case sensitivity; on Windows it launches npm `.cmd` shims safely through `cmd.exe` and terminates the entire process tree on cancellation or timeout.
- Skip `parallel_develop` for one small work package and use a single Development and Test Engineer.

## Handoff Contract

- Architect: decision, rationale, constraints, risks, and acceptance criteria.
- Development and Test Engineer: changed files, implementation summary, verification commands, and actual results.
- Documentation and Wrap-up Engineer: documentation and version changes, final diff summary, wrap-up checks, and authorized commit or push results.
- During wrap-up, update a project document only when there is a new fact to record, following `AGENTS.md`.
