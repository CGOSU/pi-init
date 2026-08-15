# {{PROJECT_NAME}} AI Collaboration Guide

This file defines the long-term AI coding rules for this project. Before starting a task, read this file and then review:

1. `docs/clean-code.md` for Clean Code rules covering code, tests, refactoring, review, and documentation changes;
2. `docs/current-state.md` for current goals, known state, and unfinished work;
3. `docs/decisions.md` for confirmed design decisions;
4. the latest relevant entries in `docs/session-log.md`;
5. relevant historical issues in `docs/pitfalls.md`;
6. only when a task produces reusable cross-project knowledge, update `https://github.com/CGOSU/knowledge.git`; run `git pull` in its local checkout first, then commit in Chinese and run `git push`;
7. use `git config user.name CGOSU` and `git config user.email dev@cgosu.com` for this repository.

## Project Purpose

{{PROJECT_DESCRIPTION}}

## Task Execution Workflow

- By default, run a continuous pipeline: Architecture analysis → task decomposition → sequential development/testing → documentation and wrap-up. Unless the user explicitly asks at the beginning to review the architecture first, the Architect must not stop to ask which next step to choose.
- The project task workflow is controlled by top-level `workflowMode` in `.pi/role-models.json`, defaulting to `auto`: `off` rejects new `plan` calls, `on` always orchestrates, and `auto` bypasses orchestration for plans with at most 2 tasks so the current Architect executes them directly in order; larger plans use the automatic workflow. Stage changes for the current session with `/pi-init config workflow` and persist them only with `/pi-init save`, or edit the field directly. For legacy projects without `workflowMode`, `workflowEnabled: true/false` maps to `on/off`; do not call `plan` when the mode is `off`.
- Runtime role switches and `/pi-init config` changes are session-only and must not write `.pi/role-models.json`; persist them only after the user explicitly runs `/pi-init save` (Save Role Configuration).
- Provider policy is fail-closed: when `.pi/role-models.json` lacks `providerPolicy`, it behaves as `{"mode":"locked","allowedProviders":["openai-codex"]}`. Main-session model selection, cycling, session restore, role/workflow switches, and Agent subagents must not cross providers. An omitted Agent `model` inherits the current allowed model; fuzzy names such as `haiku` or `sonnet` without `provider/` are rejected before spawn. To use another provider, explicitly edit and save `providerPolicy`; there is no temporary unlock or implicit fallback.
- After each task in an enabled workflow, the Development and Test Engineer must run real verification and call `task_workflow` with `complete`, including the implementation summary and actual results. Completion must also output a concise task report containing the task, role, start/end time, total duration, summary, and verification results. The final workflow report is concise as well; report times use the system local timezone in `YYYY-MM-DD HH:mm:ss±HH:MM` format. The workflow automatically switches to the assigned role and starts the next ready task.
- The executor is configured by top-level `workflowExecutor` in `.pi/role-models.json` and defaults to `local`; `subagents` delegates sequentially only through `pi.events` RPC, and missing extensions, RPC errors, or malformed replies must safely block the task.
- With `subagents`, the parent session is the sole writer of `task_workflow` state. A sub-agent only executes the current task, never calls `task_workflow`, and must return strict JSON using `pi-init/task-result@1`; only a valid `complete` result may complete a task.
- Sub-agents work in the shared checkout; they must not create worktrees, merge branches, commit, or push automatically. After reload, a bound non-terminal sub-agent is not respawned automatically; inspect the persisted binding and recover it manually.
- Do not ask about preferences, style, or optional alternatives mid-task. Pause only for an explicit architecture review request, missing product decisions, permissions/credentials, approval for destructive operations, unrecoverable failures, or genuinely blocking information; record reasonable assumptions in the task result.
- When the user explicitly asks to see the architecture first and the workflow is enabled, the Architect sets `reviewRequired` to `true` and pauses after saving the plan; after review, run `/pi-init workflow resume`. Blocked tasks use `block`; after the cause is resolved, use `/pi-init workflow retry <taskId>`.

## Tool Invocation Rules

- Use only `path`, `offset`, and `limit` with `read`; use only `path` and `edits` with `edit`, and include `oldText` and `newText` in every edit item.
- Read the latest file content before calling `edit`, and copy the actual text directly into `oldText`; do not manually rewrite quotation marks, indentation, spaces, or line endings.
- If an `oldText` match fails, read the file again and inspect the actual content before retrying; do not repeat the same replacement or bypass exact-edit protection with fuzzy matching.

## Runtime Environment and Command Conventions

{{ENVIRONMENT_CONTEXT}}

## Common Commands

- Test: `{{TEST_COMMAND}}`

If a command has not been provided, inspect the existing scripts and toolchain instead of guessing.

## Working Agreements

- Inspect the worktree and relevant implementation before editing. Do not overwrite changes from other collaborators.
- Prefer small, local, verifiable changes. Do not add compatibility layers for uncertain requirements.
- Follow the project's existing code style, directory structure, and toolchain.
- Do not record tokens, passwords, private keys, or other secrets in code, documentation, logs, or commits.

## Verification

- Add focused tests when adding or fixing behavior.
- Run at least the tests, type checks, or build commands directly relevant to the change.
- Record only checks that were actually run and their real results.

## Session Wrap-up

After completing a task:

1. Update `docs/current-state.md`, retaining only current facts and unfinished work;
2. append consequential implementation choices to `docs/decisions.md`;
3. record completed work, verification commands, and remaining issues in `docs/session-log.md`;
4. add newly discovered, non-obvious, recurring issues to `docs/pitfalls.md`.

Update a file only when there is a new fact to record; do not make no-op documentation edits. Maintain each fact in one file only. Elsewhere, use a short summary and a relative link to its canonical source.
