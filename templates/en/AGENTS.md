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
- For cross-module or non-trivial work, the Architect must call `task_workflow` with `plan`, splitting the work into ordered tasks with dependencies, file scopes, and acceptance criteria. Do not leave only a vague prose plan that cannot drive execution.
- After each task, the Development and Test Engineer must run real verification and call `task_workflow` with `complete`, including the implementation summary and actual results. The workflow automatically switches to the assigned role and starts the next ready task.
- Do not ask about preferences, style, or optional alternatives mid-task. Pause only for an explicit architecture review request, missing product decisions, permissions/credentials, approval for destructive operations, unrecoverable failures, or genuinely blocking information; record reasonable assumptions in the task result.
- When the user explicitly asks to see the architecture first, the Architect sets `reviewRequired` to `true` and pauses after saving the plan; after review, run `/pi-init workflow resume`. Blocked tasks use `block`; after the cause is resolved, use `/pi-init workflow retry <taskId>`.

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
