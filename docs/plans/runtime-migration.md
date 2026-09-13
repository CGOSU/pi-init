# pi-init Runtime backend 迁移与切换清单

状态：双轨实现已接入并通过无模型 Runtime fixture 验收；**cutover-ready：否**。

本清单只记录迁移边界和可核对的符号，不在本任务删除旧链路。Runtime 是选择为 `runtime` 的 workflow 的唯一 authority；`local`、`subtask`、`collaboration` workflow 仍分别由现有 pi-init 后端负责。一个 workflow 不得在两个 backend 间双写。

## 已确认边界

- `workflowExecutor` 在创建时固定为 `local`、`subtask`、`collaboration` 或 `runtime`，并写入 workflow entry 的 `authority`；之后不因当前配置变化而迁移。
- Runtime workflow 在提交前固定 graph revision、Graph、每个 task 的 ProfileSnapshot、endpoint、`agent_backend`、permission profile、request ID 和 event cursor。模型 provider 与 agent backend 是不同字段。
- Runtime 负责 Graph 调度、Attempt、结果接受、取消、重试、事件 cursor 和恢复；pi-init 只查询、投影和确认事件，不能从聊天历史、本地 next-task 或本地完成动作推导 Runtime 结果。
- `permission_profile` 仍是不透明引用。测试使用 development-only direct-host fixture，不代表生产隔离，也不包含模型凭据。
- Runtime 连接是一次请求一条 loopback TCP 连接；断线只触发重连查询，不改变 workflow authority。读事件必须先投影，再用同一 cursor acknowledge。

## 联调证据矩阵

| 场景 | 证据 | 结果/边界 |
| --- | --- | --- |
| 同一计划选择旧 backend | `test/runtime-integration.test.js` 的 `same plan` 用 `workflowExecutor: local` | 保留 `local` authority；不创建 Runtime Graph，不调用本地 scheduler 的 Runtime 分支。 |
| 同一计划选择 Runtime | 同一测试使用 `workflowExecutor: runtime`、实际 `runtime-daemon` 与模型无关 fixture Agent | Graph submit、role/ProfileSnapshot、Runtime result、事件投影和完成通过；pi-init 不发送本地 task message。 |
| 事件、结果和 ack | `test/workflow-runtime-backend.test.js`、`test/runtime-client.test.js`、实际 daemon integration | `ResultAccepted` 驱动完成；跨 graph revision/坏事件 fail-closed；先读/投影再 ack，重复 request 使用稳定 ID。 |
| cancel/retry | `test/runtime-integration.test.js` 实际 daemon direct-host fixture | cancel 和 retry 只发 Runtime command；失败结果先暂停，删除失败 marker 后由 Runtime retry 完成。 |
| Pi reload/context compaction | integration 测试在运行中执行 `completeCompaction`，随后从同一 branch 重建 harness | graph ID、authority 和 cursor 不被 compaction/chat 改写；新 harness 从持久 entry 恢复。 |
| daemon restart/client reconnect | integration 测试在任务完成后停止并重启同一 SQLite daemon，再 QueryGraph/ReadEvents | terminal graph、task state、cursor 和 ack 后无迟到事件可重复读取；direct-host active recovery 不在此测试中伪造。 |
| worker reconnect | `D:/Code/Rust/agent-runtime/bin/runtime-worker/tests/control_lifecycle.rs` | 独立无模型 fixture 启动实际 worker，断开控制连接后重连并 terminate；这是 Runtime worker 层证据，不是 pi-init local fallback。 |
| 真实 Pi | `bin/runtime-daemon/src/real_pi_tests.rs` ignored gate | 必须显式授权、临时 workspace marker、worker executable 和清理；无授权时不声称真实结果通过。 |

差异语义：local backend 的 task completion/block/retry 是 pi-init 本地状态转换并由 Pi lifecycle 推进；Runtime backend 的这些动作是 Runtime 命令/事件的投影。Runtime transport、wire、provider、ack 或恢复错误保持结构化错误，不转换成空状态、成功或本地执行。

## 旧调度链路逐符号清单

### 1. `extensions/workflow-dispatch.ts`

| 符号 | 直接调用方 | 迁移动作 | 删除条件 | 当前决定 |
| --- | --- | --- | --- | --- |
| `createWorkflowDispatch` | `extensions/index.ts` | 保留为生命周期/旧 backend dispatch 工厂；Runtime schedule 由 `workflow-actions.ts` 的 Runtime backend 调用 | local、subtask、collaboration 全部迁出且无旧 session entry | 保留 |
| `scheduleWorkflow` | `index.ts` 的 `agent_settled`/session lifecycle、`workflow-actions.ts` | local 仍按当前 task 状态推进；Runtime 不进入该本地 next-task 分支 | 所有旧 workflow entry 完成迁移并有历史兼容读取 | 保留，Runtime 路径禁止调用 |
| `scheduleWorkflowReplan` | `index.ts` 与架构工作流命令 | 保留旧 backend replan；Runtime graph revision 当前冻结并拒绝本地 replan | Runtime revision API 和迁移清单替代后再拆分 | 保留 |
| `dispatchSubtaskTask` | `scheduleWorkflow`、subtask lifecycle 测试 | 保留 subtask authority | 不再支持 subtask workflow | 保留 |
| `consumeSubtaskResult` | subtask result message handler | 保留迟到 result/requestId 校验 | 不再支持 subtask workflow | 保留 |
| `dispatchCollaborationTask` / `consumeCollaborationResult` | collaboration lifecycle 与结果消息处理 | 保留共享 workspace/agent authority | 不再支持 collaboration workflow | 保留 |
| `observeSubtaskToolCall` / `handleArchitectBlockedToolCall` | `extensions/index.ts` 的 `tool_call` | 保留旧 backend 安全边界；Runtime workflow 不能借 Pi tool call 完成任务 | 所有旧 backend 删除后再删除 | 保留 |
| `blockDelegatedTask` | timeout、迟到/失败委派结果路径 | 只允许 subtask/collaboration 状态写入；Runtime 由 Runtime 状态投影 | 无旧委派 entry | 保留 |
| `restoreWorkflowState` | `session_start` | 保留 branch hydration；Runtime 恢复 frozen authority 后只查询 Runtime | 新 session format 完全替代且完成兼容窗口 | 保留 |

### 2. `extensions/workflow-actions.ts`

| 符号/调用 | 直接调用方 | 迁移动作 | 删除条件 | 当前决定 |
| --- | --- | --- | --- | --- |
| `createWorkflowActions` | `extensions/index.ts` | 保留单一 action router；按 frozen executor 分流 | 无 | 保留 |
| `runTaskWorkflowAction` 的 `plan` | `task_workflow` tool | Runtime 分支先持久 authority 再 submit；旧分支继续 local/subtask/collaboration | 所有历史 workflow entry 已迁移 | 保留为 router |
| `runTaskWorkflowAction` 的 `complete`/`block` | `task_workflow` tool | Runtime 显式拒绝；旧 backend 保留本地验收 | 不得删除，除非旧 backend 已退役 | 保留 |
| `runTaskWorkflowAction` 的 `cancel`/`retry`/`resume` | `task_workflow` tool、`/pi-init workflow` command | Runtime 只调用 Runtime command；旧 backend 保留 transition | 不得删除旧 authority | 保留双轨分支 |
| `workflowCommand` | `/pi-init workflow` | Runtime resume/status/cancel/retry 走 Runtime；旧命令保持兼容 | 命令迁移和历史 entry 清理均完成 | 保留 |
| `completeWorkflowTask` / `blockWorkflowTask` / `retryWorkflowTask` / `cancelWorkflow` | `workflow-actions.ts`、`workflow-dispatch.ts` | 仅旧 backend 调用；Runtime 不调用 | local/subtask/collaboration 全退役 | 保留 |

### 3. `src/workflow-model.js`、`src/workflow-transitions.js`、`src/workflow-hydration.js`

| 符号 | 直接调用方/测试 | 迁移动作 | 当前决定 |
| --- | --- | --- | --- |
| `createWorkflowState`、`hydrateWorkflowState`、`workflowProgress` | actions、dispatch、`test/workflow-core.test.js`、各 backend tests | 保留作为计划/投影公共模型；增加并校验 frozen `authority`/Runtime cursor | 保留 |
| `getNextWorkflowTask` | `scheduleWorkflow`、local tests | 只服务 local/subtask/collaboration；Runtime 不调用以计算 next task | 保留，Runtime 禁用 |
| `startWorkflowTask`、`markWorkflowTaskStarted` | local lifecycle 与 dispatch | 只服务旧 local authority；Runtime chat/agent lifecycle 明确跳过 | 保留，Runtime 禁用 |
| `completeWorkflowTask`、`blockWorkflowTask`、`retryWorkflowTask`、`cancelWorkflow` | workflow actions、workflow core/dispatch tests | 只服务旧 backend；Runtime 用 Runtime response/event projection | 保留，Runtime 禁用 |
| `buildRuntimeWorkflow` | `workflow-actions.ts` Runtime initialize、`test/workflow-runtime-backend.test.js`、integration | 将 task/dependency/files/criteria/role snapshot 只读映射为 frozen Graph | 保留并作为迁移目标 |
| `projectRuntimeState`、`eventCursor` | Runtime scheduler/backend tests | 只根据 query/events 更新 Runtime projection；revision mismatch/坏事件 fail-closed | 保留 |

### 4. `extensions/index.ts` 及其他旧 backend

- `task_workflow` tool 的注册和 `workflowActions.runTaskWorkflowAction` 是唯一入口，保留；不得再注册第二个 scheduler。
- `agent_start`、`agent_settled`、`input` 和 `session_*` handler 保留角色/旧 backend lifecycle。Runtime workflow 中它们只能查询/恢复/清理，不能写 `executionStartedAt`、pending replan 或任务完成。
- `extensions/role-runtime.ts`、`extensions/workflow-report.ts`、`src/roles.js` 的 roleModels 解析保留；Runtime 只读取 frozen ProfileSnapshot，不能以当前聊天模型或模型 provider 替换 `agent_backend`。
- `extensions/subtask-*`、`extensions/collaboration-*`、`src/subtask.js`、reservation/message/session-tail 相关符号保留，直到旧 authority 的迁移条件全部通过。

## 回归测试与直接调用方索引

- `test/workflow-dispatch.test.js`：锁定 `scheduleWorkflow`、subtask/collaboration dispatch、迟到结果和旧 backend 的本地状态推进；删除前必须保留或迁移每个断言。
- `test/role-recovery.test.js`：锁定 session reload、session tree、compaction 后的职责恢复门；Runtime reload 不能绕过该门，也不能把 chat role 当作 Runtime ProfileSnapshot。
- `test/collaboration-core.test.js`：锁定 collaboration registry/message/reservation、取消、迟到结果和共享 workspace authority。
- `test/runtime-client.test.js`：锁定 wire framing、transport-only retry、request ID replay、read-before-ack、结构化 error 和 cancel/retry payload。
- `test/workflow-runtime-backend.test.js`：锁定 Runtime Graph/ProfileSnapshot 映射、revision/cursor projection、ack、RecoveryUnknown 和禁止本地 fallback。
- `test/runtime-integration.test.js`：锁定实际 daemon development direct-host fixture 的双 authority 对照、role execution、compaction/reload/restart、重复 request、cancel/retry 与临时 workspace 清理。
- `D:/Code/Rust/agent-runtime/bin/runtime-worker/tests/control_lifecycle.rs`：锁定实际 worker process 的 client disconnect/reconnect/terminate；`bin/runtime-daemon/src/real_pi_tests.rs` 的真实 Pi reconnect 继续是显式 ignored gate。

## 切换条件与未完成事项

在下列项目全部完成前，状态保持 `cutover-ready: 否`，不能删除旧调度符号：

1. 生产 profile 的 external launcher、canonical workspace/tool/network policy、launcher proof 和 secret/ACL 已由 Runtime 端到端验收；当前 pi-init integration 仅是 development direct-host fixture。
2. Runtime worker broker 有稳定、持久的 endpoint registry；daemon/worker 分别崩溃、result commit 前后、cancel/timeout 与 takeover race 的故障注入矩阵均通过。
3. pi-init 新旧 backend 的历史 entry/reload/compaction 兼容窗口和迁移脚本已经实际验收；当前仅证明同一计划的 authority 选择，不迁移历史 workflow。
4. worker reconnect 和 active daemon restart 在 pi-init Runtime backend 上以真实 broker evidence 验收；当前 worker reconnect 证据在 agent-runtime worker test，pi-init 使用 direct-host terminal restart，不能互相冒充。
5. 真实 Pi 测试在显式授权下通过临时 workspace marker、有限 wall-clock、清理检查；未授权时只运行 fixture。
6. 所有旧 local/subtask/collaboration 调用方和测试已迁移并删除/保留决定逐项复核；在此之前本清单所有“保留”项不得删除。

因此本任务完成了双轨联调与证据清单，但**不执行旧模块删除，不宣称 cutover-ready**。
