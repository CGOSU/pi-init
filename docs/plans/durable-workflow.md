# 编排恢复能力与 Pi durable 接入边界

> 状态：取证与实现边界记录。以下方案尚未实现；不得据此宣称 pi-init 已接入 AgentHarness durable execution。

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

### 当前实现与直接调用

- 第一阶段已调整 `extensions/workflow-report.ts::persistWorkflowState`：先调用 `pi.appendEntry("pi-init-workflow", next)`，正常返回后才赋值 `state.workflowState`、清除 `workflowRestoreError` 并刷新状态。若 append 同步抛错，内存状态和恢复错误保持原值。Pi API 仅返回 void，不能据此声称具备事务/磁盘 fsync 保证。
- 持久化函数由 `extensions/workflow-actions.ts` 的 plan/replan/complete/block/resume/retry/cancel 路径、`extensions/workflow-dispatch.ts` 的开始/阻塞/nudge/调度路径，以及 `extensions/index.ts` 的任务启动和重规划方向事件直接调用。修复失败语义时需检查这些调用方是否会继续清锁、通知成功或派发后续任务。
- `extensions/workflow-dispatch.ts::restoreWorkflowState` 在 session_start/session_tree 从当前 branch 的最后一个 `pi-init-workflow` custom entry hydration；`src/workflow-hydration.js` 对恢复数据做 schema 校验，并通过结构化结果返回 invalid/retired 错误。
- 当前任务状态包含 `currentTaskId`、开始时间和 `executionStartedAt`，但没有 execution attempt ID；`src/workflow-transitions.js::completeWorkflowTask` 按 workflow status 和当前 taskId 验收，没有 attempt/revision identity 参数。`extensions/workflow-messages.ts` 的任务消息 details 仅有 `taskId`。
- `extensions/workflow-dispatch.ts`、`extensions/workflow-compaction.ts` 和 `extensions/runtime-state.ts` 使用进程内锁、续跑 pending、压缩 continuation 与 operation ID；它们会在 shutdown/dispose 清除或不会跨进程恢复。不得把普通进程锁与跨重启业务意图混为一谈。
- compaction 是 Pi session/role transition 机制；失败和 abort 目前仍会按已有行为尝试继续/通知，watchdog 不会自动派发，用户可 reload 后 resume。优化时需保持既有压缩和恢复安全门。

### 现有测试与缺口

- `test/workflow-compaction.test.js` 覆盖任务边界压缩、防重复派发、压缩失败/停滞、Local 未启动任务恢复及压缩期间 resume 保护。
- `test/workflow-protocol.test.js` 覆盖状态机、重规划与输入/状态契约；`test/workflow-runtime-retirement.test.js` 覆盖旧 Runtime 状态拒绝；`test/role-recovery.test.js` 与 `test/extension-lifecycle.test.js` 覆盖恢复门及 session lifecycle。
- `test/helpers.js` 的 mock `appendEntry` 已支持注入同步异常；新建 `test/workflow-persistence.test.js` 覆盖持久化异常时的内存/恢复错误保留、首次派发失败后的安全重试，以及完成操作失败不返回成功/不派发后续任务。
- attempt/revision 身份阻止旧完成结果的测试仍待后续交接阶段实现。

## 阶段进度（2026-10-08）

- 已完成 `persistence-consistency`：session entry append 正常返回后才提交 runtime 状态；失败时不提交完成状态，不清除恢复错误；调度开始/暂停持久化失败会释放本地 dispatch 锁，并保留可安全重试的状态。没有改变任务验收权威或 local 顺序执行语义。
- 已完成的实际验证：`node --test test/workflow-persistence.test.js`（3 项通过）；`node --test test/workflow-persistence.test.js test/workflow-compaction.test.js test/workflow-protocol.test.js test/workflow-report.test.js`（16 项通过）；`node scripts/check-line-count.js`（通过）；`git diff --check` 与新增测试文件的 `git diff --no-index --check`（无 whitespace error）。全量 `npm test` 尚未运行。
- 尚未实现：交接阶段持久化、workflow/revision/task attempt identity、旧结果隔离和未知执行结果暂停策略。Pi durable 接口判断与剩余方案见本文件前文；不代表已实现原生 durable execution。

## 实现边界和建议顺序

1. **持久化一致性：**调用 session append 前不得发布新的内存状态或清除恢复错误；失败必须保留旧状态并真实暴露，且调用方不能误发成功、锁死或派发下一任务。因 Extension API 的 appendEntry 返回 void，处理真实同步异常，不伪造异步确认或事务保证。
2. **可恢复交接：**以 session entry 表达必须跨 reload 恢复的工作流意图；进程内 in-flight mutex/timer 继续保持 ephemeral。界定已选中、等待角色/压缩、可派发、已开始及结果未知这些状态，并在 session_start/session_tree 按当前 branch 恢复。
3. **执行身份与隔离：**对当前 workflow/plan revision/task attempt 建立稳定身份，complete/block/续跑只接受当前身份，不能只靠 taskId 让旧 attempt 结果完成 retry 后的新 attempt。具体 schema 迁移在编码前需按 `src/workflow-model.js`、`src/workflow-hydration.js` 兼容规则定义并以本文件记录。
4. **未知执行结果安全策略：**Pi session durable 不等于外部工具副作用可重放。对已经启动、但没有可靠终态证据的任务不自动重做；让 `task_workflow` 明确暂停/请求核对，不宣称 exactly-once。
5. **测试和交付：**覆盖 appendEntry 抛错、派发边界恢复、已启动未验收、retry/replan 后旧结果、不同 branch/旧 session 回调和重复事件；局部测试后因跨模块交付跑一次 `npm test`。按用户授权对纯本任务文件分阶段中文 commit，不 push。

## 工作区与验证状态

- 取证开始时 `git status --short` 无输出，工作区干净；项目 Git 身份是 `CGOSU <dev@cgosu.com>`。
- 本文件是取证/实现边界，不代表代码已改动或计划已测试。
- 本阶段未运行测试、未启动真实 Agent、未触发外部写入、未安装/升级依赖，未执行 commit 或 push。
- 未确认项：Pi 后续版本是否会把 durable AgentHarness/operation records 作为稳定 Extension API 暴露；本项目将来是否提升并扩展 peer dependency 支持 1.1.0。两项都不影响按当前稳定 Extension API 继续改进 session 级恢复。

## 来源

- Pi 1.1.0：`@earendil-works/pi-coding-agent/docs/extensions.md`（State、Context and session changes、Errors and cleanup）；`dist/core/extensions/types.d.ts`（`appendEntry`/`sendMessage` API）；`CHANGELOG.md` 1.1.0；依赖包 `@earendil-works/pi-agent-core/package.json` 和 `dist/index.d.ts`。
- pi-init：`package.json`、`package-lock.json`；`extensions/workflow-report.ts`、`workflow-dispatch.ts`、`workflow-actions.ts`、`workflow-messages.ts`、`workflow-compaction.ts`、`runtime-state.ts`、`index.ts`；`src/workflow-model.js`、`workflow-hydration.js`、`workflow-transitions.js`、`workflow-replan.js`；`test/workflow-compaction.test.js`、`workflow-protocol.test.js`、`workflow-runtime-retirement.test.js`、`role-recovery.test.js`、`extension-lifecycle.test.js`、`helpers.js`。
- Historical record only: `docs/plans/runtime-migration.md` explicitly marks the self-built Runtime integration retired; it is not a migration/cutover plan.
- Git identity/worktree command: `git status --short; git config user.name; git config user.email`。
- Installed dependency resolution command: `node -e "const p='C:/Users/gorou/AppData/Roaming/npm/node_modules/@earendil-works/pi-coding-agent'; for (const n of ['@earendil-works/pi-agent-core/package.json','@earendil-works/pi-agent-core']) { try { console.log(n, require.resolve(n,{paths:[p]})); } catch(e) { console.log(n, e.code); } }"`。
- No tests were executed during evidence gathering.
