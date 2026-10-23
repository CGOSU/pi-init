# {{PROJECT_NAME}} AI Collaboration Guide

This file defines the long-term AI coding rules for this project. The package-published `pi-init-role-routing` Skill is the single source for the general task workflow, evidence gating, tool invocation, and role handoff rules; load it and the relevant `roles/*.md` profile on demand instead of copying those rules here.

1. Start with project-specific rules (including `docs/clean-code.md` when its Clean Code guidance applies), project memory, or code directly relevant to the task; locate relevant memory by keywords instead of reading every document;
2. Use the project's `.pi/role-models.json` only to enable roles and configure models through `roleModels`, and do not generate or maintain a project-level role Skill;
3. only when a task produces reusable cross-project knowledge, update `https://github.com/CGOSU/knowledge.git`; run `git pull` in its local checkout first, then create a Chinese-language commit automatically; `git push` still requires explicit user authorization;
4. use `git config user.name CGOSU` and `git config user.email dev@cgosu.com` for this repository;
5. after a task is complete and applicable checks pass, create a Chinese-language commit by default, containing only changes clearly attributable to that task; pause and explain if existing or staged changes cannot be safely separated. `git push` requires explicit user authorization.

## Project Purpose

{{PROJECT_DESCRIPTION}}

## Shared Collaboration Rules

The package-published `pi-init-role-routing` Skill is the single source for the general task workflow, evidence gating, `read`/`edit` invocation, role boundaries, and real verification requirements. When working on code, tests, documentation, or workflows, load that Skill and the relevant role profile on demand; this file keeps only project-specific purpose, environment, commands, knowledge-base, and Git rules.

For a clear, low-risk goal, make ordinary implementation choices and proceed without asking the user about helpers, internal decomposition, test organization, investigation order, or bug fixes that restore intended behavior. Ask only for business or contract conflicts, missing permission or credentials, irreversible or external-state operations, unsafe merges, or blocked real verification; record newly requested behavior, contracts, permissions, or data structures in the confirmed requirements or decision record first.

## Workflow Execution

pi-init workflows run sequentially in the current main session (local only); missing configuration and the legacy `workflowExecutor: "local"` value remain readable. A legacy top-level `runtime` field or `workflowExecutor: "runtime"` returns a distinct retirement error rather than silently falling back. Old session entries with Runtime executor/authority are not automatically restored, rewritten, or deleted; review legacy configuration and records, and decide how to handle them manually.

## Runtime Environment and Command Conventions

{{ENVIRONMENT_CONTEXT}}

## Common Commands

- Test: `{{TEST_COMMAND}}`

## Validation Requirements

- When a task meets the Fast Path conditions, follow the Fast Path rules and do not run tests by default; otherwise, follow these validation requirements.
- For new or fixed behavior, add focused tests when appropriate; start with the smallest relevant test set and use file or change-range filters when supported instead of defaulting to the full suite.
- Scope incremental tests by the behavior change itself and its necessary direct impact rather than a fixed line count: prefer reusing or adjusting existing tests, add tests only for real risk gaps within that scope, and keep valuable long-term regression coverage; do not add tests for presentation-only, style, or copy changes by default, and do not add coverage for unrelated legacy logic. Do not generate tests to delete them by default, and do not delete tests automatically by age, last-pass time, or coverage.
- Within the same workspace, reuse a passing validation result when the relevant implementation, tests, dependencies, and test configuration have not changed since it ran; rerun affected checks after relevant changes.
- Run the full suite only when explicitly requested, changes span multiple modules or affect test infrastructure or dependency configuration, the relevant scope cannot be determined, or the project is being prepared for delivery or release.
- Record only validations actually run and their real results; when reusing a result, state the basis rather than describing an unrun check as passed.

<!-- pi-init:managed:start fast-path-wrap-up -->
## Fast Path Wrap-up Priority

Use a lightweight path for a clear, local, low-risk and reversible goal. Subject to higher-priority safety and permission rules, this section takes precedence over general wrap-up rules and unconditional bulk history reading at session start. Scope the task before reading history. Preserve explicitly required validation, role boundaries, recovery gates and pre-commit safety checks.

- Search only necessary history by keyword; do not dump all project memory files merely to decide whether a record is needed;
- Changes to default grouping, initial presentation, local display sorting, styling or copy may stay lightweight when actual item selection, connections/routing, business rules, storage formats and accessibility behavior remain unchanged; not every UI behavior change requires a heavier process;
- Modify only the target and directly related consistency requirements; file size or changed-line count alone does not determine risk;
- Do not create `task_workflow` or an additional written plan solely because automatic Fast Path eligibility is not met; independently required architecture planning still applies;
- Do not update `docs/current-state.md`, `docs/decisions.md`, `docs/session-log.md` and `docs/pitfalls.md` for routine bookkeeping. A small display change already expressed by code does not automatically require three records; correct only necessary canonical facts when existing documentation would become wrong;
- Do not default to the full test suite, typecheck, lint, formatter, build or dev server. Select the smallest necessary checks by risk, perform explicit user/project validation requirements, and never claim an unrun check passed;
- Do not switch roles for routine records. Actual documentation, release or Git work still follows role rules; preserve fresh ownership/staging checks before committing and explicit authorization before pushing.

Documentation may be the direct task target without making it ineligible for the lightweight path.

Escalate when any of the following applies:

- Public APIs, data formats, dependencies/architecture, business decisions, permissions, actual connections/routing, user operation flows or accessibility semantics change. Internal field renames/mappings stay lightweight only when external contracts, persistence and safety semantics are unchanged;
- Later work needs a consequential decision, operating procedure, unresolved blocker or recurring pitfall that current code/tests cannot adequately express;
- Scope is no longer local, low-risk or reversible, or important impact remains uncertain.

An explicit request for tests, builds, documentation or Git adds those actions, not the entire process. Safety, credentials, role recovery and necessary validation remain mandatory.
<!-- pi-init:managed:end fast-path-wrap-up -->

## Session Wrap-up

After completing a task:

1. Update `docs/current-state.md`, retaining only current facts and unfinished work; keep its “Last Updated” list in reverse chronological order;
2. record consequential implementation choices in `docs/decisions.md`, inserting entries in reverse chronological order with the newest first;
3. add completed work, verification commands, and remaining issues to `docs/session-log.md`, inserting entries in reverse chronological order with the newest first;
4. add newly discovered, non-obvious, recurring issues to `docs/pitfalls.md`, inserting entries in reverse chronological order with the newest first.

Update a file only when there is a new fact to record; do not make no-op documentation edits. Maintain each fact in one file only. Elsewhere, use a short summary and a relative link to its canonical source.
