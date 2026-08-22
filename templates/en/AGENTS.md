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
- Model references must be explicit: the main session and fully qualified Agent models use `provider/model` values. An omitted Agent `model`, or an unqualified name such as `haiku` or `sonnet`, inherits the current full model with a notice; a fully qualified model must exist exactly, with no cross-provider fallback. To change providers, edit the role model directly (`/pi-init config` lists every registered model and `/pi-init save` persists, or edit `.pi/role-models.json`).
- After each task in an enabled workflow, the Development and Test Engineer must run real verification and call `task_workflow` with `complete`, including the implementation summary and actual results. Completion must also output a concise task report containing the task, role, start/end time, total duration, summary, and verification results. The final workflow report is concise as well; report times use the system local timezone in `YYYY-MM-DD HH:mm:ss±HH:MM` format. Without a pending revision, the workflow automatically switches to the assigned role and starts the next ready task; with a revision, it first hands the unfinished plan to the Architect.
- The executor is configured by top-level `workflowExecutor` in `.pi/role-models.json` and defaults to `local`; with `subtask`, the main session delegates the current task to a separate conversation fork by calling the `subtask` tool, and the fork's result message is delivered back into the session. A missing tool or a malformed result must safely block the task.
- During an active workflow, describe a changed direction or new follow-up work in ordinary natural language; the extension records a revision with a `revisionId` and waits until the current task reaches its boundary before pausing the old plan. The Architect alone submits the unfinished-work plan with `task_workflow(action="replan")`; completed tasks, summaries, and verification records are immutable. To stop the current task immediately, use the existing `/pi-init workflow cancel` flow.
- With `subtask`, the parent session is the sole writer of `task_workflow` state. The fork only executes the current task, never calls `task_workflow`, and must return strict JSON using `pi-init/task-result@1`; only a valid `complete` result may complete a task. A revision does not make pi-init terminate or re-dispatch a running fork, and it must not start the old plan's next task; inspect or stop the fork manually when needed.
- The fork works in the shared checkout; it must not create worktrees, merge branches, commit, or push automatically. After reload, a delegated non-terminal task is not re-dispatched automatically; inspect the workflow state and recover manually (`/pi-init workflow retry <taskId>` or cancel and re-plan).
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
