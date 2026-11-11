<!--
Included from https://github.com/ciembor/agent-rules-books/blob/main/clean-code/clean-code.md.
Copyright (c) 2026 Maciej Ciemborowicz. Licensed under the MIT License.
-->

# OBEY Clean Code by Robert C. Martin

This file defines mandatory working rules for this repository. Follow these instructions before making any code, test, refactor, review, or documentation change.

## Priority and behavior

- Treat every unqualified rule in this file as `MUST`; treat `Prefer` as `SHOULD`; treat `Do not`, `Avoid`, and `Never` as `MUST NOT` unless the user explicitly overrides it.
- Prefer readability, maintainability, correctness, and safe change over cleverness or speed hacks.
- Optimize for the next human reader.
- When trade-offs exist, choose the option that reduces long-term complexity.
- Never preserve bad structure just because it already exists.
- Apply the Boy Scout Rule: leave touched code cleaner than you found it.

## Core clean code principles

- Write code primarily for humans, not just for execution.
- Keep code simple, direct, and easy to modify.
- Avoid accidental complexity.
- Avoid surprising behavior.
- Prefer explicit intent over implicit magic.
- Prefer local reasoning: a reader should understand code with minimal jumping across files.
- Reduce technical debt instead of moving it around.

## Naming rules

- Use intention-revealing names.
- Names must explain purpose, role, or behavior without requiring extra comments.
- Avoid misleading names, overloaded meanings, and visually confusable identifiers.
- Make distinctions meaningful. Do not create names that differ only cosmetically.
- Use pronounceable, searchable names.
- Avoid abbreviations unless they are established domain or platform standards.
- Avoid encodings in names, including type prefixes, implementation hints, and Hungarian notation.
- Avoid unnecessary context in identifiers.
- Add context through modules, classes, namespaces, or types when that is cleaner than longer names.
- Use one word per concept across the codebase.
- Do not use multiple synonyms for the same operation or concept.
- Do not reuse a familiar word for a different meaning.
- Class, type, and module names should be nouns or noun phrases.
- Function and method names should be verbs or verb phrases.
- Use problem-domain names for domain concepts.
- Use solution-domain names for technical concepts.
- Do not use cute, funny, cryptic, or private-joke names.

## Function rules

- Keep functions small.
- Each function must do one thing.
- A function should have one clear reason to change.
- Keep each function at one level of abstraction.
- Organize code top-down so readers see the high-level story before details.
- Prefer descriptive names over short names.
- Minimize the number of parameters.
- Avoid boolean flag parameters. Split behavior into separate functions instead.
- Avoid output parameters unless language conventions make them necessary.
- Eliminate hidden side effects.
- Separate commands from queries.
- A function that answers a question should not also mutate state.
- Prefer exceptions or explicit result types over ad hoc error codes, according to project language norms.
- Isolate error handling from main logic.
- Eliminate duplication aggressively.
- Prefer straightforward control flow over clever control flow.
- Refactor deep nesting into clearer structure.

## Comment rules

- Do not use comments to compensate for bad naming or bad structure.
- First improve the code, then decide whether a comment is still needed.
- Prefer self-explanatory code.
- Use comments only when they add information the code cannot express well.
- Good comment categories include:
  - legal or licensing requirements
  - non-obvious intent
  - important warnings or constraints
  - rationale for a surprising decision
  - clarification of external behavior or protocol assumptions
- Remove redundant, obsolete, obvious, noisy, and misleading comments.
- Do not narrate the code line by line.
- Keep comments precise and maintain them when code changes.
- Avoid TODO comments unless they are actionable, specific, and necessary.

## Formatting and structure

- Use consistent formatting across the repository.
- Format code to reveal structure and intent.
- Keep related concepts close together.
- Keep files, classes, and functions reasonably small.
- Use vertical ordering to tell the story from higher level to lower level.
- Use indentation to clarify scope, not to hide complexity.
- Avoid excessive line length when it hurts readability.
- Avoid decorative alignment that is brittle during edits.
- Preserve a layout that supports fast scanning.

## Objects, modules, and data structures

- Separate behavior-rich objects from plain data carriers intentionally.
- Do not mix data containers and business behavior arbitrarily.
- Hide implementation details behind clear interfaces.
- Expose behavior, not representation.
- Use DTO-like structures as simple carriers when appropriate.
- Avoid train-wreck call chains and unnecessary knowledge of internal structure.
- Respect loose coupling and local boundaries.
- Keep persistence, framework, and third-party details from obscuring business behavior or core logic.

## Class and module design

- Keep classes and modules small.
- Each class or module should have one primary responsibility.
- Favor high cohesion.
- Split classes that accumulate unrelated behavior.
- Organize code so likely changes remain local.
- Public APIs should be small, obvious, and hard to misuse.
- Prefer composition over complex inheritance unless inheritance is clearly the simpler and more stable model.
- Keep constructors and setup logic from overwhelming domain behavior.

## Error handling

- Design error handling deliberately.
- Keep the happy path easy to read.
- Provide enough context in error messages for diagnosis.
- Use error types or exception classes that support caller decisions.
- Do not return `null` or equivalent absence sentinels when a safer model exists.
- Do not pass `null` or equivalent invalid states unless the API explicitly models that case.
- Prefer exceptions, special cases, empty objects, or explicit optionality according to the codebase's language and conventions.
- Make resource cleanup and shutdown paths correct and visible.

## Boundaries and external dependencies

- Isolate third-party libraries behind local adapters or wrappers when practical.
- Avoid coupling core logic directly to unstable external APIs.
- Create narrow interfaces around dependencies.
- Add learning tests or focused integration tests for tricky external behavior.
- When a dependency does not exist yet, define interfaces from local needs, not from guesses about future implementations.

## System construction rules

- Separate constructing a system from using it.
- Keep object graph assembly, dependency injection, factories, and framework bootstrapping out of ordinary business behavior.
- Put startup wiring in an explicit main or composition area.
- Use factories when construction policy is meaningful or complex.
- Do not let cross-cutting concerns obscure ordinary code flow.
- Use standards, frameworks, proxies, or AOP-style mechanisms only when they add demonstrable value.
- Test-drive architectural decisions with executable slices, not only diagrams or configuration.
- Use domain-specific languages only when they make system intent clearer than general-purpose code.

## Tests

- Treat tests as production-quality code.
- Keep tests clean, readable, deterministic, and maintainable.
- A test should communicate one main idea.
- Prefer simple setup and clear assertions.
- Avoid brittle tests coupled to irrelevant implementation details.
- Tests should be fast when possible.
- Tests should be isolated and order-independent.
- Tests should be self-checking.
- Add or update tests for behavior changes, bug fixes, and significant refactors.
- Do not ship code changes without proportionate validation.
- When fixing a bug, add a test that would have caught it, when feasible.

## TDD and clean test rules

- Prefer writing a failing test before production code when the behavior can be specified clearly.
- Do not write production behavior beyond what a failing test or explicit requirement justifies.
- Keep tests small enough that a failure names one behavior or one concept.
- Prefer one assert or one conceptual assertion per test when that improves clarity.
- Use test names and test data that reveal the business or technical behavior under test.
- Build a small testing vocabulary or helper DSL when repeated setup hides intent.
- Keep test code clean; dirty tests reduce the ability to change production code safely.
- Avoid tests that require multiple manual steps to run.
- Use coverage patterns to find untested risk, not as a substitute for meaningful assertions.
- Treat ignored, flaky, or skipped tests as unresolved questions.

## Concurrency and async work

- Do not introduce concurrency unless it provides a real benefit.
- Prefer simpler sequential code when it is sufficient.
- Minimize shared mutable state.
- Prefer immutability, message passing, or clear ownership boundaries.
- Keep synchronized or locked sections as small as possible.
- Be explicit about shutdown, cancellation, timeouts, and cleanup.
- Test concurrent behavior carefully where it matters.
- Know the execution model before changing concurrent code.
- Avoid dependencies between synchronized methods.
- Get non-concurrent behavior correct before adding threading.
- Make threaded code pluggable and tunable when its policy or concurrency level may vary.
- Run concurrency-sensitive tests under varied thread counts, schedules, and platforms where practical.
- Treat spurious failures as possible concurrency defects until evidence says otherwise.

## Refactoring rules

- Refactor in small, safe steps.
- Preserve behavior while improving structure.
- First make it work, then make it right.
- Remove duplication, dead code, misleading abstractions, and special-case clutter.
- Rename aggressively when names are weak.
- Extract code when doing so improves cohesion and clarity.
- Inline abstractions that no longer earn their cost.
- Prefer the simplest design that passes all relevant tests.

## Emergent design and successive refinement

- Prefer designs that run all relevant tests, remove duplication, express intent, and use the fewest necessary classes and methods.
- Refine code through working drafts rather than expecting the first version to be clean.
- When code starts rough, keep improving names, structure, and tests until intent is clear.
- Do not start a grand redesign when incremental refinement can recover the design safely.
- Use the Boy Scout Rule on touched code, but keep cleanup proportional to the task.

## Smells to detect and eliminate

Actively look for and fix these issues when touching code:

- vague or misleading names
- duplicated logic
- oversized functions
- oversized classes or modules
- mixed abstraction levels
- hidden side effects
- boolean control flags
- long parameter lists
- deep nesting
- excessive conditionals that should be isolated or polymorphic
- comment-heavy code that should be refactored instead
- dead code and unused abstractions
- fragile tests
- environment-dependent tests without need
- unnecessary indirection
- accidental complexity
- coupling that spreads change broadly
- build or tests requiring more than one manual step
- code at the wrong level of abstraction
- base classes depending on derivatives
- transitive navigation through object internals
- artificial coupling between unrelated concepts
- hidden logical dependencies
- unimplemented obvious behavior
- incorrect boundary behavior
- overridden safeties
- magic numbers without named meaning
- negative conditionals that obscure intent
- ignored tests and insufficient boundary tests
- functions that require readers to understand an algorithm before they can trust the name

## Change Process

For every non-trivial task:

1. Understand the intent and affected behavior.
2. Identify the simplest correct change.
3. Improve names before adding comments.
4. Keep edits localized when possible.
5. Add or update tests as needed.
6. Run relevant validation.
7. Review the diff for readability, duplication, and unnecessary complexity.
8. Ensure the final code is cleaner than before.

## Implementation preferences

- Prefer explicit, boring, maintainable solutions.
- Prefer standard library and existing project patterns over new dependencies.
- Do not add a dependency unless it clearly reduces overall complexity.
- Reuse established project conventions unless they conflict with these rules or the user explicitly asks otherwise.
- Keep interfaces small.
- Keep state transitions obvious.
- Avoid premature optimization.
- Optimize only when there is evidence or a known requirement.

## Review checklist

Before finishing, verify all of the following:

- Names reveal intent.
- Functions are small and focused.
- Classes and modules have clear responsibilities.
- Comments are necessary and accurate.
- Error handling is explicit and useful.
- Duplication was removed where reasonable.
- Tests cover the changed behavior appropriately.
- The code reads cleanly from top to bottom.
- The design is simpler or at least not more complex than before.
- The change follows existing project conventions.

## Output Expectations

When making changes:

- Briefly explain what changed.
- State what tests or checks were run.
- Call out any unresolved risk, assumption, or trade-off.
- If a requested change conflicts with these rules, follow the user request but mention the conflict explicitly.

## Hard rules

- Do not introduce misleading names.
- Do not keep duplicated logic without a strong reason.
- Do not add comments where better code would remove the need.
- Do not mix querying with mutation without a strong reason.
- Do not silently broaden scope beyond the requested task.
- Do not leave touched code less readable than before.

## pi-init 本地执行补充

以下为本包维护的执行原则，借鉴[ub-mode](https://github.com/unclebob/ub-mode/blob/master/SKILL.md)的思想并适配现有权限、职责与风险验证规则；不改变上方第三方署名，不要求额外工具或流程。

- **先核实前提，再叠加修复。** 两种方案依赖同一前提、又在同一验收点失败时，先用一句话写清共同假设，检查事实及责任归属并直接验证。网络重试或无关工具错误不机械算成设计失败；普通技术复盘由原执行角色完成。
- **新增前先做减法。** 一项业务决策保持一个来源；先判断能否删除、替换或收拢旧路径。引入替代能力时一并检查旧入口、重复状态、无用依赖和专属测试是否退役；不能只加新引擎而保留两套执行路径。
- **数据形状与边界优先。** 外部数据在入口解析校验一次，内部信任已验证类型；状态互斥时优先判别联合等明确结构，不靠多个布尔值和可选字段组合猜状态。不能用any、类型断言或静默默认值掩盖无效业务状态；合法SDK适配与语言必要转换仍按已核实契约处理。
- **先分离共享状态，再谈同步。** 不需要共享同一可变对象的参与者分别持有自己的状态；必须共享时明确一个写入者并从结构上约束。业务判断尽量放在纯函数，I/O、持久化与SDK调用留在边界，不新增无收益的中间层。
- **副作用可重复且可核对。** 同一请求重复到达、或中途崩溃后恢复，不应重复创建资源、提交业务或派发任务。沿已有操作ID、唯一写入路径及持久化结果设计幂等性；结果未知时先核对，不用重试伪装恢复。
- **先做样本，再推广批量工具。** 重复修改先完成并核对一个代表性样本，再让脚本/工具匹配该样本，批量后审查差异及必要行为。脚本退出0不证明目标变化正确，新增工具必须节约总体复杂度。
- **失败测试必须诚实。** 能明确复现的行为缺陷先看到测试或最小探针因预期原因失败，再做最小修复；不把环境、语法或缺工具导致的失败当作缺陷复现。纯展示、真实环境不可用或诚实测试不切实际时说明边界，不制造低收益断言。
- **整理不另起流程。** 先实现可核对行为，再在同一任务内清理必要结构，并证明行为未被意外改变。清楚且局部的代码保持不动；不为一般命名/拆函数/补测切换架构角色，不因“第一性原理”每次重设计全仓。
- **度量只辅助风险判断。** 可按需观察复杂度、重复或mutation结果，不强制CRAP阈值、相似度分数、全覆盖或杀死所有survivors，也不假定crapper/dryer/mutator存在。测试应能发现错误行为，不能只验证函数被调用或对象形状；已有有效回归不按年龄或覆盖率删除。
