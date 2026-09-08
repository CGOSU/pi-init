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

## Runtime Environment and Command Conventions

{{ENVIRONMENT_CONTEXT}}

## Common Commands

- Test: `{{TEST_COMMAND}}`



## Session Wrap-up

After completing a task:

1. Update `docs/current-state.md`, retaining only current facts and unfinished work;
2. append consequential implementation choices to `docs/decisions.md`;
3. record completed work, verification commands, and remaining issues in `docs/session-log.md`;
4. add newly discovered, non-obvious, recurring issues to `docs/pitfalls.md`.

Update a file only when there is a new fact to record; do not make no-op documentation edits. Maintain each fact in one file only. Elsewhere, use a short summary and a relative link to its canonical source.
