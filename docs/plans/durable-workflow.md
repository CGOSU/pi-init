# 编排恢复能力与 Pi durable 接入边界

> 状态：durable 边界取证、实现与最终验证记录。persistence-consistency 与 recoverable-handoff 均已实现；定向测试 45 项和最终 `npm test` 162 项全部通过。pi-init 使用 Pi Extension session append/branch 恢复，不是 AgentHarness durable execution 集成。

## 用户确认的目标

用户授权规划、实现和在适当阶段创建中文 commit；不 push、不发布、不部署、不执行真实外部写入。优化当前 local 顺序工作流的持久化一致性、任务交接恢复和旧执行结果隔离。

必须保持：

- `task_workflow` 是计划、依赖、阻塞、验收和重规划的唯一业务权威；Pi 回合结束不等于业务任务验收完成。
- 仅使用 Pi 官方稳定公共 Extension API。未导出、未实现或未经确认的 API 不进入产品代码。
- 保持当前主会话 local 顺序执行，不复活退役的 Runtime executor，不新增并行/后台执行。
- 旧 session entry 不原地改写；读取/解析失败应保留可诊断错误，已退役的 Runtime 状态继续拒绝。
- 不承诺外部副作用 exactly-once。执行是否发生不确定、或结果缺少身份时，不盲目重放，应暂停并要求核对。

## 取证事实

### Pi 版本与 API 边界

- 本项目是 `pi-init` 2.0.3。`package.json` 和 lockfile 声明 `@earendil-works/pi-coding-agent: ^0.86.0`，即当前声明的 peer 范围不包含 1.1.0。
- 取证环境实际安装的 `@earendil-works/pi-coding-agent` 为 1.1.0，其依赖的 `@earendil-works/pi-agent-core` 也为 1.1.0。该观察不能自动证明本项目声明支持 Pi 1.1.0；后续实施需避免把 host 上安装的类型版本冒充为项目 peer 兼容矩阵。
- 官方扩展文档 `@earendil-works/pi-coding-agent/docs/extensions.md` 的 State 段落将 `pi.appendEntry()` 定义为不进入 LLM context 的 durable extension data，并要求在 `session_start` 从 `ctx.sessionManager.getBranch()` 重建分支相关状态；不能从所有文件 entries 合并 abandoned branches。
- 已安装 1.1.0 的 Extension API 类型 `dist/core/extensions/types.d.ts` 声明 `appendEntry<T>(customType, data?): void` 和 `sendMessage(...): void`。两者都不是返回 durable operation handle 的 Promise API；`appendEntry` 是 session extension data 持久化入口，`sendMessage` 会发送自定义会话消息并可能触发 turn，语义不同。
- 官方 1.1.0 `CHANGELOG.md` 提到 pi-agent-core 的 v4 Session/SessionStorage/SessionRepo、durable operation records，以及 AgentHarness v2；但这段发行说明不是扩展可调用接口的证明。实际安装的 `pi-agent-core` `package.json` 只导出 `.` 和 `./package.json`，其 `dist/index.d.ts` 仅导出 `agent.ts`、`agent-loop.ts`、`proxy.ts`、`stream-fn.ts`、`types.ts`，未导出 `AgentHarness`、`SessionRepo` 或上述 durable operation/session API；Pi Extension API 类型也未暴露这些接口。本次证据因此不支持 pi-init extension 直接接入这些 durable harness APIs。
- API 判断来源均为官方发行包内的 `docs/extensions.md`、`CHANGELOG.md`、`dist/core/extensions/types.d.ts`、`pi-agent-core/package.json` 与 `dist/index.d.ts`。Pi package 的 repository 元数据指向 `https://github.com/earendil-works/pi`。本次没有从网络独立核实未来/其他版本 API。

**边界结论：**当前可确认、面向扩展的 session durable API 是 `pi.appendEntry` + 当前 branch 恢复。CHANGELOG 中的 durable execution 属于不同层的 agent-core harness/session 能力；即使该实现存在，也不能由本项目当前稳定 Extension API 直接调用。因此本轮先改善 session 级状态与交接恢复，不引入私有 API、直接依赖内部 agent-core 模块或自建 Runtime。以后若 Pi 正式把 durable operation capability 暴露给扩展，并进入本项目支持的 peer 范围，再单独评估迁移。

### 已实现能力与直接调用

- `extensions/workflow-report.ts::persistWorkflowState` 先调用 `pi.appendEntry("pi-init-workflow", next)`；正常返回后才更新 runtime 内存状态、清除恢复错误并刷新状态。同步 append 异常保留旧内存状态/恢复错误。该 API 返回 void，不提供事务、磁盘 fsync 或外部副作用 exactly-once 保证。
- `extensions/workflow-dispatch.ts::restoreWorkflowState` 在 `session_start`/`session_tree` 从当前 branch 读取最新 workflow custom entry，经 `src/workflow-hydration.js` 做 schema/身份校验；旧 session fail-closed，新 fork 可创建新 workflow，但不沿用旧身份。旧 entry 不原地改写，Runtime retired 状态仍结构化拒绝。
- `src/workflow-model.js` v4 状态包含 workflowId、sessionId、planVersion、recoveryGeneration、task handoff 与 continuation；`src/workflow-handoff.js` 生成/校验身份，并要求 complete/block/replan 结果匹配当前 session、当前 handoff 消息及 branch。重规划结果另校验 revisionId，task retry 创建新 attempt/handoff。
- Local 任务启动证据由 `extensions/index.ts` 的当前 Agent run `message_start` 入口采集：仅当事件实际消费 `pi-init-workflow-task` 且 `extensions/workflow-start-evidence.ts` 验证完整 workflow/plan/session/recovery/task/attempt/handoff 身份匹配当前任务，`extensions/workflow-dispatch.ts` 才尝试复用统一持久化转换记录启动；当前 branch 已含同身份消息时拒绝重复推断。`agent_start` 只打开本次 run 的事件窗口，不独自证明任务启动；message_end 扩展回调早于 Pi 写入 branch，因此不能把旧 branch 检查移到该回调。消息派发/queued 写入异常仍不伪装成功，角色切换、压缩和调度 continuation 继续通过稳定身份隔离旧 callback。
- `src/workflow-handoff.js::recoverWorkflowState` 仅允许没有启动证据且未进入派发阶段的 prepared/waiting-role/compacting 状态安全续接；已派发/启动但缺少业务结果、以及缺身份的 legacy in_progress，都变为 paused/outcomeUnknown。retry 必须显式确认外部副作用已核对（`--confirm-unknown-outcome`），不提供 exactly-once 保证。
- direct action schema 与提示在 `extensions/contracts.ts`、`extensions/workflow-actions.ts`、`extensions/workflow-messages.ts` 同步传递身份：基础 workflow/plan/session/recoveryGeneration；complete/block 附 taskId/attemptId/handoffId；replan 附 revisionId/handoffId。缺失身份不会从当前状态或自由文本补齐。

### 测试与剩余验证

- 2026-10-10 的任务启动时序修复和实测命令见 [`docs/session-log.md`](../session-log.md)；本地宿主源码/类型及 harness 已核实 `agent_start`、`message_start` 与 branch 写入顺序，未验证真实 Pi TUI/E2E 或真实模型链路。
- 新增 `test/workflow-handoff.test.js` 覆盖身份缺失/过期、旧 attempt/session/revision、retry unknown outcome、legacy migration、fork session、恢复安全、dispatch persist failure 与损坏阶段的启动证据；既有 workflow/compaction/protocol/lifecycle/persistence/runtime retirement 测试覆盖直接调用和兼容边界。
- 最近相关组合：`node --test test/workflow-core.test.js test/workflow-handoff.test.js test/workflow-compaction.test.js test/workflow-persistence.test.js test/workflow-protocol.test.js test/workflow-replan-directions.test.js test/workflow-report.test.js test/workflow-runtime-retirement.test.js test/extension-lifecycle.test.js`，45 项通过。
- `node scripts/check-line-count.js` 与 `git diff --check` 通过；后者仅输出 Windows 工作树 LF/CRLF 转换提示。全量 `npm test` 留待最终交付阶段；真实 Pi E2E、安装/reload 和 peer 依赖升级未执行。

## 本阶段确认实现契约（2026-10-08）

本契约用于 `recoverable-handoff` 实现；它把用户确认的验收边界落实为状态与恢复规则，不改变 `task_workflow` 业务权威。

- 新状态 schema 升级至 v4，为每个工作流分配不可复用的 `workflowId`；当前计划有单调递增 `planVersion`；每次任务启动/显式 retry 生成新的 `attemptId` 与 `handoffId`。重规划应用时递增 planVersion，旧 plan/attempt 的回调永不匹配新身份。身份字段必须由扩展生成并持久化，缺失不能以当前任务/当前版本自动补齐。
- 持久化 handoff 阶段至少区分：任务已选但尚未派发、等待角色选择、压缩 continuation 待恢复、派发意图已持久化、消息已排队、agent 已开始、结果未知/需核对。需跨 reload/session_tree 的 continuation 与 handoff 阶段写入 session entry；dispatch mutex、timer 和局部 in-flight 标志继续仅存内存。
- 每条 workflow task custom message details 与 prompt、complete/block 契约携带同一 workflowId/planVersion/taskId/attemptId/handoffId。complete/block 必须显式提供且逐项匹配当前身份；不得从当前 workflow/task 默认补值。恢复/验收同时校验当前 `sessionManager.getSessionId()` 与活动 branch 上对应的 handoff 消息身份；不依赖未公开的 branch ID 字段。若当前 session/branch 无法证明身份、或出现已排队/已启动而无业务终态结果的记录，结构化暂停并要求核对，旧 callback 不得推进状态。
- `sendMessage`/`appendEntry` 是返回 void 的公开 Extension API；派发意图必须先持久化，调用失败保留可诊断状态。进入派发意图后若无法证明任务尚未启动，恢复不重发、不根据文本补完成；未进入派发意图的准备阶段才允许安全续跑。新状态创建时记录 session identity；旧 local 状态可继续解析，但缺少 attempt/handoff identity 的 legacy `in_progress` 任务转为需核对状态，不能静默启动或接受旧结果。原 session entry 不原地改写，Runtime retired 错误继续 fail-closed。
- 无 exactly-once 承诺：unknown handoff 的人工核对/显式 retry 可创建新 attempt，但旧 attempt identity 保留在不再活动的历史记录或以不可匹配方式失效。task_workflow 仍唯一决定 complete/block/retry/replan 与验收，Pi agent_start/settled 和 message 文本本身不构成业务完成。

## 阶段进度（2026-10-08）

- 已完成 `persistence-consistency`：session entry append 正常返回后才提交 runtime 状态；失败时不提交完成状态、不清除恢复错误；调度开始/暂停持久化失败会释放本地 dispatch 锁并保留真实错误。
- 已完成 `recoverable-handoff`：实现 v4 workflow/plan/session/recovery generation 身份、task attempt/handoff/replan continuation，branch 验证、恢复门、旧结果隔离及未知结果显式 retry；保持 local 顺序执行、`task_workflow` 验收唯一权威、旧 entry 不原地改写和 Runtime retired fail-closed。
- 最近实际验证：`node --test test/workflow-core.test.js test/workflow-handoff.test.js test/workflow-compaction.test.js test/workflow-persistence.test.js test/workflow-protocol.test.js test/workflow-replan-directions.test.js test/workflow-report.test.js test/workflow-runtime-retirement.test.js test/extension-lifecycle.test.js`（45 项通过）；`node scripts/check-line-count.js` 通过；`git diff --check` 通过，仅有 Windows 工作区 LF/CRLF 转换提示。
- 最终 `npm test` 已通过：脚本先执行 `scripts/check-line-count.js`，再运行 Node 测试 162 项全部通过、0 失败、0 跳过。未运行真实 Pi E2E、未升级 peer 依赖、未安装/reload。以后若 AgentHarness durable operation capability 正式进入受支持 Extension API 和本项目 peer 范围，再独立评估接入，不影响当前 session 级边界。

## 已落实的实现边界

- `appendEntry` 和 `sendMessage` 为公开 Extension API 的 void 调用；仅按同步异常处理，不伪造事务、fsync、异步确认或外部 exactly-once。
- 持久化跨恢复的 handoff/continuation；mutex、timer、dispatch in-flight 等只保留进程内。只有未派发且没有启动证据的准备阶段才安全续跑；派发/启动后没有业务终态结果即暂停，不能自动重放。
- 完成/阻塞/replan 只接受当前 session 和活动 branch 上匹配的 workflow/plan/recovery/attempt/handoff/revision identity。缺失身份不从当前状态、任务 ID 或文本补齐，旧 branch/session/revision/attempt 结果拒绝。
- legacy local 状态继续读取；没有 identity 的 legacy `in_progress` 转为需核对的未知结果；原 session entry 不原地改写；Runtime executor/authority retired 错误继续 fail-closed。
- 未执行安装、真实 Pi E2E、依赖升级或 push；第二阶段提交仅覆盖本任务相关文件并使用中文提交信息。

## 来源

- Pi 1.1.0：`@earendil-works/pi-coding-agent/docs/extensions.md`（State、Context and session changes、Errors and cleanup）；`dist/core/extensions/types.d.ts`（`appendEntry`/`sendMessage` API）；`CHANGELOG.md` 1.1.0；依赖包 `@earendil-works/pi-agent-core/package.json` 和 `dist/index.d.ts`。
- pi-init：`package.json`、`package-lock.json`；`extensions/contracts.ts`、`workflow-report.ts`、`workflow-dispatch.ts`、`workflow-actions.ts`、`workflow-messages.ts`、`workflow-compaction.ts`、`runtime-state.ts`、`index.ts`；`src/workflow-model.js`、`workflow-handoff.js`、`workflow-hydration.js`、`workflow-transitions.js`、`workflow-replan.js`；`test/workflow-handoff.test.js`、`workflow-persistence.test.js`、`workflow-compaction.test.js`、`workflow-protocol.test.js`、`workflow-runtime-retirement.test.js`、`extension-lifecycle.test.js`、`helpers.js`。
- Historical record only: `docs/plans/runtime-migration.md` explicitly marks the self-built Runtime integration retired; it is not a migration/cutover plan.
- Git identity/worktree command: `git status --short; git config user.name; git config user.email`。
- Installed dependency resolution command: `node -e "const p='C:/Users/gorou/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent'; for (const n of ['@earendil-works/pi-agent-core/package.json','@earendil-works/pi-agent-core']) { try { console.log(n, require.resolve(n,{paths:[p]})); } catch(e) { console.log(n, e.code); } }"`。
- API evidence collection did not run tests; implementation verification is listed above.
