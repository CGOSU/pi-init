# Local 工作流交接状态机

## 本次实现范围

`src/workflow-orchestrator.ts` 收敛调度决策、任务派发/排队/启动、重规划派发/排队，以及完成、阻塞、重试、恢复和取消生命周期事件。继续使用 Pi 公开 Extension API、原 session append/branch 存储与现有 schema，不新增执行器、依赖或配置。

- `selectWorkflowScheduleEffect(state)` 只返回启动、派发、提醒或重规划决策，不修改状态。暂停、终态、已派发和边界压缩等待期间不产生执行动作；启动任务继续遵循依赖顺序。
- `transitionWorkflowDispatch(state, event, now)` 是显式时间输入的纯转换，返回新状态与发送效果。身份或阶段不匹配时返回原状态与空效果。
- 消息层先构造任务包，再持久化 `dispatching` 意图，成功后才发送；发送完成仅回报 `queued`，不代表执行开始或任务完成。
- 实际启动仍要求现有消息消费证据；迟到排队事件不能将 `executing` 回退成 `queued`。执行中续跑提醒使用独立事件，沿用原有提醒次数限制。
- 重规划只能从 `pending` 派发一次；同步重入、重复调用与排队记录写入失败后的重复调用均不能重新发送。
- 所有转换检查 workflow、plan、session、recovery、handoff 与对应 task/attempt 或 revision 身份；旧回调不能推进新尝试。

## 生命周期提交

- `transitionWorkflowLifecycle(state, event, now)` 复用现有业务转换，返回待持久化活动状态、当前层业务结果和提交后效果，不执行 IO。完成/阻塞要求匹配的 executing handoff；入口保留 session、branch、角色和 queued 启动证据校验。
- 命令与工具通过同一 `commitLifecycleTransition` 先持久化活动状态，再撤销终态工作流原身份的续跑。写入失败不运行撤销效果、不清除调度标记、不调度后续任务；成功后才处理这些瞬态变化。
- 子流程完成或取消返回父层时，父层进入结果审阅，父状态、子层输出/验证/契约及历史通过一次 workflow append 保存；撤销使用事件前身份，不使用 complete/cancel 后递增的 recoveryGeneration。
- 命令与工具统一：cancel 取消当前层，子层返回父层等待结果处置；cancel-all 终止父子流程，保留历史。取消不回滚副作用，也不保证已运行的工具/进程或宿主压缩停止。已派发或执行中的取消任务记为结果未知，不伪报未执行。

## 显式单层子流程

讨论、解释、纠正和普通继续输入不写入工作流；模型可用 request-replan 明确调整当前队列。显式“子流程：目标”或 request-child 才安排独立子目标，仅允许一层新活动子流程；已有深层状态仍可读取和逐层处置。

新子流程必须提供 inputs、expectedOutputs、acceptanceCriteria、allowedFiles 契约，返回位置由父 frame 身份绑定。创建、后续重规划和恢复时校验未完成任务的声明范围；allowedFiles 不是 IO 沙箱，也不授权外部副作用。

子层结果通过现有重规划 handoff 交给 architect 的 review-child，不直接恢复旧计划。continue 要求子层成功、全部期望输出明确被接受、真实验证已记录、父计划仍有效；否则先 replan 或 block，禁止绕过审阅直接 replan。block 暂停，显式 resume 只重开审阅。没有影响时复用原队列，不重新生成计划；需要查证时复用证据请求机制。历史审阅追加记录，schema v6 的新增可选字段兼容旧状态；旧子流程缺失契约时不能直接 continue。代码核对结构与身份，不证明模型陈述或真实副作用是否属实。

## 故障与恢复

派发意图写入失败则不发送，存储恢复后可安全重试首次派发。消息发送后的结果未知继续采用原有 fail-closed 恢复：不自动重放，任务副作用须核实后显式确认 retry，并签发新 attempt/handoff。持久化意图不是原子外部消息事务，不承诺 exactly-once。

## 验证范围

`test/workflow-orchestration.test.js` 覆盖重复派发、发送重入、持久化故障、确定性与输入不变性、逐字段身份隔离、启动与排队乱序、压缩/终态调度门、依赖顺序，以及崩溃恢复和新尝试身份。`test/workflow-lifecycle.test.js` 覆盖子流程完成/取消提交失败不提前撤销、提交后原身份撤销、纯转换确定性、逐字段身份隔离、queued 验收门、未知结果重试、命令提交顺序和审阅恢复。现有工作流、压缩、持久化与启动生命周期测试继续作为回归检查。未进行真实 Pi/TUI 交互及真实进程崩溃/磁盘故障实验，故障由测试注入。

## 保留边界

本阶段不是所有状态写入入口的统一重写。规划、重规划应用、证据协调、派发失败阻塞、角色切换与压缩恢复仍使用现有业务转换与持久化入口；workflow 与 coordination 两个账本之间仍无跨记录原子事务，没有新增并行执行、独立验收角色或持久化 outbox。后续若迁移其他入口，应逐类复用事件转换，而不是同时引入第二套业务权威。
