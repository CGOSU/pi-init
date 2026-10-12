# 角色协作闭环与任务上下文视图

> 状态：实现、集成验证与选择性 Git 收尾已完成。EOF 空行已由开发职责清理，差异检查通过；本次角色协作成果已提交，既有 `/large` 增量保留在工作区且未 push。本文件保留实施前的设计取证快照；当前实现和真实验证结果以“实施状态”和“验证边界”章节为准。

## 目标

让架构师能以小而可追溯的请求安排 `docs-commit` 查证事实，审阅报告并按缺口追加取证；证据充分后形成边界清楚的开发任务。开发者发现影响业务结果的关键事实、契约或决定缺失时，应正式退回澄清，而不是自行创造规则。角色交接只向本次模型请求提供必要的任务包和证据，保留 Pi 原始 session 历史以便追溯和恢复。

这项功能不是“prompt 越短越好”，也不承诺零遗漏、跨模型缓存共享、费用下降或 exactly-once 外部副作用。

## 不可改变的边界

- `architect` 只分析、决策、计划、审阅证据和安排职责；不得读写仓库、运行命令、连接 MCP、执行任务或收集证据。它可以发出纯协议动作 `request-evidence`、`review-evidence`、`clarify`，但不能调用执行结果/恢复类动作。
- `docs-commit` 核实最新实现、直接调用方、测试及其他指定事实；报告事实、来源、检查范围、测试和未知项，不替 architect 做架构或业务决策。证据取证不自动触发例行 docs 更新或 Git commit。
- `developer-test` 实现、验证任务，并在关键事实/业务规则/公共契约不清时提交带依据的澄清，不猜测后继续。普通、可逆的实现细节（如局部 helper 拆分）留给开发者决定。
- 已有 `task_workflow` 仍是开发任务规划、依赖、完成、阻塞、重试及重规划的唯一业务权威。证据循环是协调阶段，不是 architect 可执行 task，不新增 executor，不挤占最多 12 个开发任务。
- 普通微任务、旧 workflow entry 和未启用协调协议的历史任务继续兼容；不得要求简单任务常驻创建完整取证/协调状态。
- 仅依赖已核实的公开 Pi Extension API；不接入未公开 AgentHarness/durable runtime API，不复活 retired `runtime` executor。
- 使用 session append/branch 保存协议状态；写入/读取/恢复失败明确报告并 fail-closed。没有可靠派发/执行身份时不得自动重放可能有外部副作用的操作。

## 实施前项目现状与证据基线

以下实现描述、测试清单和工作区快照均为 2026-10-12 开始实施前的历史基线，不代表当前代码状态。

### 项目 workflow 实现

- `extensions/contracts.ts::taskWorkflowParameters` 当前提供 `plan/status/complete/block/replan/resume/retry/cancel`；`workflowTaskSchema` 的关键字段为 `task/role/files/acceptanceCriteria/dependsOn`。当前没有独立的证据请求/审阅/澄清协议字段。
- `src/workflow-types.ts::WorkflowTask` 与 `src/workflow-model.ts::normalizeTask` 对应上述任务结构；`WorkflowState` 持有 workflow、plan、task、revision、handoff 和 continuation 状态。
- `extensions/workflow-messages.ts::workflowTaskPrompt` 传递目标、架构约束、已完成任务摘要、当前任务、身份、文件范围与验收标准。通用提示允许“做合理假设并记录”，新增协作路径必须限定此许可仅用于普通可逆工程选择。
- `extensions/workflow-report.ts::persistWorkflowState` 使用 `pi.appendEntry("pi-init-workflow", next)`；`extensions/workflow-dispatch.ts::restoreWorkflowState` 从活动 session branch 恢复并校验 workflow；角色/任务交接使用完整身份。派发入口由 `extensions/index.ts` 注册的 `task_workflow` tool 通过 `extensions/workflow-actions.ts`、`extensions/workflow-dispatch.ts` 执行。
- `src/roles.ts` 当前仅允许 `local` executor；`runtime` 已退役。`docs/plans/durable-workflow.md` 记录了该 API 边界；本次不得另建或迁入 AgentHarness 执行器。

### 已查看的直接测试

- `test/workflow-protocol.test.js`：架构角色不得作为可执行任务、任务校验与现有 workflow 协议边界。
- `test/workflow-handoff.test.js`：身份绑定、旧结果拒绝、恢复与派发未知结果不可盲重放。
- `test/workflow-persistence.test.js`：session branch 上 workflow state 的写入、恢复及错误处理。
- `test/workflow-replan-directions.test.js`：方向输入合并、当前任务边界和应用 revision。
- 项目相关测试集合还包括 `test/workflow-core.test.js`、`test/workflow-compaction.test.js`、`test/workflow-start-lifecycle.test.js`、`test/workflow-runtime-retirement.test.js`；其中本阶段只直接读了上述四个 test 文件，其他文件属于定位到的相邻覆盖，后续若修改相关实现应由执行者按需读取。

### Pi Extension API

- 项目当前 `package.json` 声明版本 `2.0.4` 和 Pi peer `^1.1.0`。本机已安装 Pi 文档 `docs/extensions.md` 中 State/Context 段说明：`pi.appendEntry()` 存 durable extension data 且不进入模型上下文；`pi.sendMessage()` 会把自定义消息发送到模型；状态应按当前 branch 恢复。
- 本机公开类型 `dist/core/extensions/types.d.ts::ContextEvent` 在每次模型调用前提供不含 system messages 的 `messages: AgentMessage[]`。`ContextEventResult` 可返回替换用的 `messages?: AgentMessage[]`；Pi 随后恢复 prompt/tool system state。`context_with_system` 则要求扩展接管完整 transcript、system prompt 和工具声明，因此本方案不使用它。
- 该 API 可用于改变单次模型请求看到的历史，不会删除 session 原文。上下文钩子必须保持工具调用与结果配对、当前角色的本轮消息、新用户要求和真实失败。没有可靠边界时保留完整消息，不盲目截断。
- 当前项目没有专门的 context 过滤回归测试；既有 workflow harness 对上下文变换的支持需要实现阶段核实，不能假定现有测试已经证明工具配对、安全裁剪或真实 Provider 行为。

### 工作区初始改动基线

在本任务实现开始前，`git rev-parse HEAD` 为 `ea031c859fa55c2dbd618537d2f2ef7b5a66e4ee`；`git diff --binary | git hash-object --stdin` 为 `27fc567b82ef8b9194491e808abfce59a34122f1`。初始 `git status --short`：

```text
 M docs/decisions.md
 M extensions/file-review-runtime.ts
 M extensions/index.ts
 M test/file-review-runtime.test.js
?? extensions/large-command.ts
?? test/large-command.test.js
```

这是此前 `/large` 手动审阅功能的既有改动。初始 tracked diff stat 为 4 files changed, 99 insertions(+), 40 deletions(-)。`extensions/index.ts` 有独立 `/large` runtime 注入 hunk；`docs/decisions.md` 新增 `/large` 决策；其余 modified/new 文件属于 `/large` 功能。实现者不得覆盖、重构或把这些既有改动混入本任务 commit；若共用文件需要改动，最终必须核对并只暂存本任务独有 hunks，否则暂停 Git 收尾。

## 实施状态（2026-10-12）

- 协调领域由 `src/coordination-types.ts`、`src/coordination-validation.ts`、`src/coordination.ts` 实现，负责结构化 Result 校验、请求/报告/审阅迁移、来源版本及无进展检查；`WorkflowState` 可选携带契约，schema v5 兼容 v4 的身份记录且不伪造旧任务契约。
- `extensions/coordination-runtime.ts` 接入 `request-evidence`、`report-evidence`、`review-evidence`，沿用角色运行时、session append/branch、settled 调度和 compaction continuation；权限、session/branch、协调版本、request/task attempt 与 handoff 身份校验、派发未知结果和持久化失败均 fail-closed。协调状态独立于单一 Local 开发任务执行器。
- `extensions/workflow-actions.ts`、`extensions/workflow-dispatch.ts`、`src/workflow-task-contract.ts` 和 `src/workflow-clarification.ts` 实现契约就绪门与 `clarify` 回路。有效证据、关键未决项和来源版本变化会影响协调计划派发；普通无契约历史任务保持兼容。澄清以新 revision 显式处置，未知副作用不自动重放。
- `extensions/role-context-view.ts` 通过 Pi 公开 `context` hook 选择实际请求消息；`extensions/workflow-messages.ts` 与 `extensions/coordination-messages.ts` 编译最小交接包。边界不可靠时返回完整输入及诊断；session 历史未删除或改写，不用 `context_with_system`，Pi system/tool state 不由扩展接管。
- `test/coordination-runtime.test.js`、`test/task-contract-runtime.test.js`、`test/role-context-view.test.js` 等 harness 回归覆盖两轮取证、审阅后派发、澄清/replan、恢复/旧身份/重复回调、持久化失败、普通任务兼容和工具调用配对。最终 `npm test` 300 项通过、0 失败；`npm run typecheck` 与 `git diff --check` 通过。
- 未执行真实 Provider、Pi TUI/E2E、跨模型 cache 或费用测量；不得把扩展 harness 测试描述为这些真实链路验证。

## 协作协议

下表定义动作的协议权限；动作可以复用现有 `task_workflow` tool，但必须在运行时以 active role、当前 session、workflow/coordination version、请求或 task attempt/handoff identity 验证。参数缺失、类型错误、角色越权、版本过期、重复回报和持久化失败应以区分明确的结构化错误返回。

| 动作 | 允许角色 | 输入/输出与持久状态 | 不允许的隐式行为 |
|---|---|---|---|
| `request-evidence` | architect | 问题 ID、待回答问题、理由、限定范围/排除范围、完成条件、引用的已知资料；持久为待处理请求及身份 | 不允许直接读文件/工具执行；不允许把推测写成事实或自动派开发 |
| `report-evidence` | 当前请求指定的 docs-commit 执行角色 | 按问题 ID 返回发现、事实/推断/未知分类、来源位置及版本、检查范围、测试源码与实际运行结果、冲突/风险；保留报告历史 | 不允许替 architect 接受证据、决定方案或自动宣布“足够” |
| `review-evidence` | architect | 针对当前报告明确接受、要求补查（指出 gap 并生成新 request）、或阻塞并说明决策缺口；只在接受所有关键项后标记 evidence ready | 不允许 architect 通过状态字段伪造缺失证据；接受结论不能消除其来源/版本 |
| `clarify` | 当前执行任务的 developer-test | 当前 task/attempt 身份、具体缺失问题、已核实事实、已改动/验证、潜在副作用；转交 architect 按事实取证、架构选择或用户决定分类 | 不允许继续实现关键未决规则；不允许清空已完成成果或自动重放不确定副作用 |

协调记录只服务于请求、证据审阅、澄清和任务就绪；可与 workflow 计划通过稳定身份引用，但不能创建第二个可执行队列。协调记录应可按当前 branch 持久化和恢复，运行时临时锁/定时器仍只保存在内存。API `appendEntry/sendMessage` 返回 void，不应被描述为事务、磁盘 fsync 或 exactly-once。

## 开发任务契约与就绪门

开发任务在现有字段上按需携带：

- 目标与用户/业务可观察的预期行为；
- 需求/关键事实来源（已接受证据引用及版本）；
- 已确认的固定决策、不变量、错误语义和边界；
- 非目标；
- 尚未解决的问题（如果影响验收，必须阻止就绪）；
- 可自主处理的普通工程自由度；
- 验收、必要验证和任务依赖。

字段必须可选/按任务类型适用，不能使历史普通工作流数据失效。协调任务的“未决关键问题为空、证据引用有效、验收可判定”作为派发就绪条件。仅有完整字段但语义冲突仍不算 ready。开发者发现关键缺口时通过 `clarify` 返回，不要自行创造业务契约；不影响外部行为的工程细节继续自主决定。

## 角色上下文视图

- 持久工作流/协调账本完整保存在 Pi session entry；模型请求通过 `context` 事件取得只读 session 消息，再按当前角色、活动 request/task、直接依赖和当前完整执行窗口生成请求局部视图。
- `docs-commit` 获取本轮请求、检查范围、上一轮被接受事实摘要和新缺口；`architect` 获取用户目标、被接受证据、未决列表和架构决策；开发者获取当前完整任务契约、其引用证据与必要的直接依赖成果。不是每个角色都收到全量历史或所有已完成任务。
- context 过滤保持 Pi 管理的 system/tool state 不变，不使用 `context_with_system`；不改 session 原始 branch/entries。必须保留完整的 assistant tool call 与对应 tool result，包含与当前任务相关的错误和用户后续指令。
- 如果无法安全识别活动任务边界、工具调用对、分支/压缩后的消息来源或用户新指令，保留完整输入并报告未裁剪；不能为了节省 token 丢弃有歧义内容。
- 必须用测试证明 hook 实际改变发送模型的消息且保留 session 原文/工具协议。mock 只能证明扩展逻辑，不代表真实 Pi provider/TUI 已验证。无实际跨模型缓存/费用测量时不宣称节省已量化。

## 状态、恢复和兼容

- 每个请求/报告/澄清有唯一 ID 和 workflow/session/plan（或协调）版本；report/review/clarify 必须匹配当前活动身份。过期或重复回报是显式拒绝/幂等 no-op，不能覆盖新状态。
- 输入先结构化校验，区分缺失、空值、类型/格式错误、冲突、角色越权、证据不足、身份过期和恢复错误；读取旧记录遵循现有 hydration 兼容/fail-closed 策略。
- 持久化成功前不向下一角色发送可执行 continuation。持久化或派发状态未知时暂停并暴露状态，不伪报成功、不自动重放。
- 证据引用可以因文件版本变化而失效；依赖当前实现的结论在引用内容变更后需重新取证，纯稳定需求/决策不因此自动失效。
- 已完成任务及其真实验证不能因澄清而丢失。需要更新后续计划时，由 architect 使用现有 revision/replan 身份和 retained task 规则，不通过新队列绕过原验收。

## 实施顺序与验收

实施顺序（已完成）：

1. [x] 固化协议及实施前事实（docs-commit）。
2. [x] 添加协调/证据/任务契约的类型、校验、持久化与恢复适配（developer-test）。
3. [x] 接入 request/report/review 交接闭环与权限身份（developer-test）。
4. [x] 接入开发就绪门和 clarify/replan 回路（developer-test）。
5. [x] 实现并测试 context 请求视图与工具调用配对保护（developer-test）。
6. [x] 完成集成回归、类型检查和静态 diff 检查；完整读取受影响的 >500 行文件并审阅当前 fingerprint（developer-test）。
7. [x] docs-commit 已对照真实实现更新 Skill、README、项目状态/会话记忆和本设计状态；EOF 空行已清理且暂存差异检查通过，仅将可明确归属本任务的内容创建为中文提交，保留既有 `/large` 改动未提交；不 push。

必须覆盖：多轮取证仅补缺口；未知/冲突证据不就绪；architect 和 docs-commit 权限不越界；开发澄清、补证据和 revision 后继续；旧 identity/重复 callback 不推进；session 重载恢复准确阶段；持久化/派发失败不伪完成；普通旧任务兼容；context 过滤完整保留工具调用结果配对、当前任务工作窗口和后续用户指令；没有安全边界时回退完整输入。最终应运行项目全量 `npm test`、`npm run typecheck`、`git diff --check` 并报告真实结果；不调用真实 Provider/MCP，不声称已验证真实 TUI/E2E 或跨模型缓存。

## 证据来源

- 项目实现：`extensions/contracts.ts`、`extensions/index.ts`、`extensions/workflow-messages.ts`、`extensions/workflow-actions.ts`、`extensions/workflow-dispatch.ts`、`extensions/workflow-report.ts`、`extensions/role-runtime.ts`、`extensions/workflow-compaction.ts`、`src/workflow-types.ts`、`src/workflow-model.ts`、`src/workflow-hydration.ts`、`src/workflow-transitions.ts`、`src/roles.ts`。
- 实际直接阅读测试：`test/workflow-protocol.test.js`、`test/workflow-handoff.test.js`、`test/workflow-persistence.test.js`、`test/workflow-replan-directions.test.js`。定位到但本取证阶段未逐行阅读全文的相邻测试：`test/workflow-core.test.js`、`test/workflow-compaction.test.js`、`test/workflow-start-lifecycle.test.js`、`test/workflow-runtime-retirement.test.js`。
- Pi API：当前安装版 `@earendil-works/pi-coding-agent/docs/extensions.md` 的 events、context、state 章节；`dist/core/extensions/types.d.ts` 的 `ContextEvent`、`ContextEventResult`、`ContextWithSystemEvent` 定义；`docs/sessions.md` 与 `docs/session-format.md`。durable extension storage 与 AgentHarness durable execution 是不同层；公开 Extension API 的证据不支持本扩展直接使用 AgentHarness。
- 取证仅读取代码、类型、测试与文档；本设计阶段没有执行测试、真实 provider 或 Pi TUI/E2E。

## 验证边界与未执行范围

- 已由扩展 harness 验证 context 回调确实返回裁剪后的消息，并覆盖多轮工具调用、对应结果、真实失败、新用户指令、system-message 不确定时 fail-open、session/branch 不变及未知边界的诊断。Harness 验证扩展逻辑，不代表 Pi TUI 或模型 Provider 的线上请求已观测。
- 已实际运行 `npm test`（300 项通过，0 失败）、`npm run typecheck` 和 `git diff --check`。大文件结构审阅依据各当前文件 fingerprint，超过 500 行本身没有触发拆分。
- 未调用真实 Provider/MCP，未做 Pi TUI/E2E、跨模型缓存命中或费用收益测量；不得声称这些真实链路已验证或有收益。
- 初始 `/large` 工作区变更基线见上节。本任务收尾只选择性提交其自身内容；原 `/large` 文件和共用 `index.ts` 中与其相关的 hunks 保留在未提交工作区。
