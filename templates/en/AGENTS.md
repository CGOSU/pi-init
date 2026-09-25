# {{PROJECT_NAME}} AI Collaboration Guide

This file defines the long-term AI coding rules for this project. The package-published `pi-init-role-routing` Skill is the single source for the general task workflow, evidence gating, tool invocation, and role handoff rules; load it and the relevant `roles/*.md` profile on demand instead of copying those rules here.

1. Start with project-specific rules (including `docs/clean-code.md` when its Clean Code guidance applies), project memory, or code directly relevant to the task; locate relevant memory by keywords instead of reading every document;
2. Use the project's `.pi/role-models.json` only to enable roles and configure models through `roleModels`, and do not generate or maintain a project-level role Skill;
3. only when a task produces reusable cross-project knowledge, update `https://github.com/CGOSU/knowledge.git`; run `git pull` in its local checkout first, then commit in Chinese and run `git push`;
4. use `git config user.name CGOSU` and `git config user.email dev@cgosu.com` for this repository.

## Project Purpose

{{PROJECT_DESCRIPTION}}

## Shared Collaboration Rules

The package-published `pi-init-role-routing` Skill is the single source for the general task workflow, evidence gating, `read`/`edit` invocation, role boundaries, and real verification requirements. When working on code, tests, documentation, or workflows, load that Skill and the relevant role profile on demand; this file keeps only project-specific purpose, environment, commands, knowledge-base, and Git rules.

For a clear, low-risk goal, make ordinary implementation choices and proceed without asking the user about helpers, internal decomposition, test organization, investigation order, or bug fixes that restore intended behavior. Ask only for business or contract conflicts, missing permission or credentials, irreversible or external-state operations, unsafe merges, or blocked real verification; record newly requested behavior, contracts, permissions, or data structures in the confirmed requirements or decision record first.

## Workflow Executors

`workflowExecutor` supports only `local` (sequential execution in the main session) and `runtime` (execution through the configured Runtime endpoint); the default is `local`.

## Runtime Environment and Command Conventions

{{ENVIRONMENT_CONTEXT}}

## Common Commands

- Test: `{{TEST_COMMAND}}`

## Validation Requirements

- For new or fixed behavior, add focused tests when appropriate; start with the smallest relevant test set and use file or change-range filters when supported instead of defaulting to the full suite.
- Within the same workspace, reuse a passing validation result when the relevant implementation, tests, dependencies, and test configuration have not changed since it ran; rerun affected checks after relevant changes.
- Run the full suite only when explicitly requested, changes span multiple modules or affect test infrastructure or dependency configuration, the relevant scope cannot be determined, or the project is being prepared for delivery or release.
- Record only validations actually run and their real results; when reusing a result, state the basis rather than describing an unrun check as passed.

<!-- pi-init:managed:start fast-path-wrap-up -->
## Fast Path Wrap-up Priority

When all Fast Path conditions defined by the global `AGENTS.md` are met, this section takes precedence over the general session wrap-up rules below.

- Modify only explicitly targeted files and direct related files required to keep the repository consistent;
- Do not create `task_workflow` or an additional written plan;
- Do not pre-read or update `docs/current-state.md`, `docs/decisions.md`, `docs/session-log.md`, or `docs/pitfalls.md` merely to decide whether to leave a record;
- Do not run test, typecheck, lint, formatter, build, or dev server by default; perform only necessary static checks;
- Do not switch roles merely for planning or routine record-keeping; role routing, the context-recovery gate, and the architect's execution prohibition remain effective.

If the target file itself is documentation or a project record, it may be read and modified directly without exiting Fast Path.

Exit Fast Path when any of the following applies:

- The change modifies an API, data structure, dependency, architecture, business rule, permission, route, interaction, or accessibility semantics;
- The change creates a new fact, important decision, remaining issue, key verification result, or recurring pitfall that later development depends on;
- The scope is no longer local, low-risk, or reversible.

When the user explicitly requests tests, builds, other documentation updates, or Git wrap-up, perform only the requested action and continue to follow the applicable responsibility rules.
<!-- pi-init:managed:end fast-path-wrap-up -->

## Session Wrap-up

After completing a task:

1. Update `docs/current-state.md`, retaining only current facts and unfinished work; keep its “Last Updated” list in reverse chronological order;
2. record consequential implementation choices in `docs/decisions.md`, inserting entries in reverse chronological order with the newest first;
3. add completed work, verification commands, and remaining issues to `docs/session-log.md`, inserting entries in reverse chronological order with the newest first;
4. add newly discovered, non-obvious, recurring issues to `docs/pitfalls.md`, inserting entries in reverse chronological order with the newest first.

Update a file only when there is a new fact to record; do not make no-op documentation edits. Maintain each fact in one file only. Elsewhere, use a short summary and a relative link to its canonical source.
