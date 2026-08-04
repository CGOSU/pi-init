# {{PROJECT_NAME}} AI Collaboration Guide

This file defines the long-term AI coding rules for this project. Before starting a task, read this file and then review:

1. `docs/current-state.md` for current goals, known state, and unfinished work;
2. `docs/decisions.md` for confirmed design decisions;
3. the latest relevant entries in `docs/session-log.md`;
4. relevant historical issues in `docs/pitfalls.md`.

## Project Purpose

{{PROJECT_DESCRIPTION}}

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

Maintain each fact in one file only. Elsewhere, use a short summary and a relative link to its canonical source.
