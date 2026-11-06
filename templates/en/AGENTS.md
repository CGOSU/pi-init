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

Maintainers add business, API, data, safety and Git/release requirements here, including paths to any local standards.

## Project Memory Locations

Update only when later work will need the information. Put routine completion notes and verification results in the delivery response or commit message; a separate session log entry is not required. Prefer revising or merging existing entries. Maintain each fact in one place and link to that source when needed.

- `docs/current-state.md`: necessary current facts and unfinished work, without an update history.
- `docs/decisions.md`: consequential choices and rationale that affect future implementation.
- `docs/session-log.md`: investigation or verification evidence that later work will need and that is difficult to reconstruct.
- `docs/pitfalls.md`: non-obvious, recurring issues with useful prevention guidance.

## Plugin Policy Source

pi-init supplies package-owned common rules and the current role profile at turn start; plugin updates take effect after reload. Existing project files and history are neither migrated nor deleted, and general guidance must not silently replace explicit project constraints.
