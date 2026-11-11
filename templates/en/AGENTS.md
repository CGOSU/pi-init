# {{PROJECT_NAME}} AI Collaboration Guide

This file is project-maintainer-owned context. pi-init creates it only when missing; repeated initialization and plugin updates never overwrite existing content. General execution rules and role boundaries come from the installed pi-init package rather than copied rules here.

## Project Purpose

{{PROJECT_DESCRIPTION}}

## Directories and Project-specific Responsibilities

Maintainers describe important directories, module responsibilities and project-specific roles here. Do not duplicate package-owned role policies as project copies.

## Runtime Environment and Command Conventions

{{ENVIRONMENT_CONTEXT}}

## Common Commands

- Test: `{{TEST_COMMAND}}`

## Project-specific Constraints

- Only when a task produces reusable cross-project knowledge, update `https://github.com/CGOSU/knowledge.git`; run `git pull` in its local checkout first, then a Chinese-language commit may be created automatically. `git push` still requires explicit user authorization.
- Use `git config user.name CGOSU` and `git config user.email dev@cgosu.com` for this repository.
- After the whole task is complete and applicable checks pass, automatically create a Chinese-language commit by default, containing only changes clearly attributable to that task. Pause and explain if existing or staged changes cannot be safely separated; do not create an empty commit when nothing changed. Follow any explicit user or project override. `git push` requires explicit user authorization.
- For JS/TS projects without a specified package manager or established toolchain, default to pnpm. Use the corresponding pnpm commands for dependency installation, scripts, and tool execution.
- For existing projects, first check `package.json`'s `packageManager`, lockfiles, and project commands. Resolve conflicting conventions before proceeding; do not migrate or mix package managers without authorization.
- In pnpm projects, do not introduce another package manager's lockfile, such as `package-lock.json`, `npm-shrinkwrap.json`, or `yarn.lock`.
- If pnpm is unavailable, check the environment and executable entry point instead of silently falling back to npm/npx.

Maintainers add other business, API, data, safety and Git/release requirements here, including paths to any local standards.

## Project Memory Locations

Update only when later work will need the information. Put routine completion notes and verification results in the delivery response or commit message; a separate session log entry is not required. Prefer revising or merging existing entries. Maintain each fact in one place and link to that source when needed.

- `docs/current-state.md`: necessary current facts and unfinished work, without an update history.
- `docs/decisions.md`: consequential choices and rationale that affect future implementation.
- `docs/session-log.md`: investigation or verification evidence that later work will need and that is difficult to reconstruct.
- `docs/pitfalls.md`: non-obvious, recurring issues with useful prevention guidance.

## Plugin Policy Source

pi-init supplies package-owned common rules and the current role profile at turn start; plugin updates take effect after reload. Existing project files and history are neither migrated nor deleted, and general guidance must not silently replace explicit project constraints.
