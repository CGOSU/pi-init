# collaborating-agents 共享工作区迁移计划

状态：迁移实现完成；待文档收尾。

## 目标

fork `baochunli/pi-collaborating-agents`，复用其共享工作区协作能力，使用独立 Agent 进程/session、文件 reservation、消息、Agent registry、session tail 和 TUI；同时保留 pi-init 的角色、模型和工作流控制。

目标不是保留两套并发执行器，而是在迁移完成并通过验证后退役 `parallel_batch` 的 gmc/worktree 执行链路。

## 不可改变的边界

- `.pi/role-models.json` 是 provider、model 和 thinkingLevel 的唯一来源。
- `architect`、`developer-test`、`docs-commit` 及公共 `pi-init-role-routing` Skill 继续负责角色专业化和职责边界。
- `task_workflow` 继续负责规划、依赖、验收、阻塞、重试和重规划；Agent 进程完成不等于任务验收完成。
- `edit` 的精确参数、唯一匹配、非重叠和 fail-closed 诊断继续保留。
- 不自动 commit、push 或把共享工作区的失败修改伪装成已回滚。
- 共享工作区不是 Git worktree 或 shell 安全沙箱；reservation 不能阻止所有未经过工具 hook 的写入。
- fork 仓库地址、固定版本、Pi 包名/API 兼容性和实际 reservation/session 接口尚未确认。

## 迁移范围

### 保留 pi-init

- 角色配置、模型切换、职责恢复和上下文压缩。
- `task_workflow` 的状态机、任务依赖、验收和结果协议。
- gmc 之外的项目初始化、记忆文档、缓存统计和 usage 功能。
- 精确编辑守卫；将来与 reservation 在同一写入检查链中协作。

### 从 fork 复用

- Agent 注册、心跳、名称和运行记录。
- `agent_message` 的 direct、broadcast、feed、thread、session/tail 能力。
- `/agents` Overlay 和状态渲染。
- 文件 reservation 及冲突提示。
- process/cmux-pane 启动、session 发现和完成消息。

### 已退役的旧链路

以下代码已在共享链路完成验证后删除：

- `parallel_batch` 自研的 gmc worker 启动、等待、结果回收和独立并发状态实现。
- gmc worktree、固定基线、候选结果和 integration worktree 管理。
- 仅服务于上述链路的 `parallel-worker`、gmc client 和批次专用配置/测试。

## 实施阶段

1. **Fork 基线核对**
   - 获取 fork 地址和固定 commit。
   - 核对 Pi 包名/API、启动参数、Agent registry、reservation、session 生命周期和测试。
   - 确认对方确实使用共享 `cwd`，不假设其提供 Git worktree 隔离。

2. **协作基础设施迁移**
   - 引入 Agent registry、消息、session tail、Overlay 和 reservation。
   - 只保留一个 Pi 扩展入口，避免生命周期和工具注册重复。
   - 暂不删除现有 gmc 代码。

3. **角色与模型适配**
   - 将 `subagent({ type })` 扩展为 `subagent({ role })`。
   - 从 pi-init 解析 system prompt、allowed tools、provider/model/thinkingLevel。
   - 角色模式下禁止 fork 的 TOML model/reasoning 和默认模型 fallback。
   - 未配置角色必须显式失败。

4. **工作流和共享工作区接入**
   - 保留 `task_workflow` 的规划/依赖/验收状态机。
   - 将任务派发接入 fork 的 Agent 启动器和完成消息。
   - 每个共享任务启动前取得不重叠 reservation，完成、取消、失败和 shutdown 时释放或标记遗留。
   - 保留 lifecycle、runId、attemptId 和迟到结果隔离。

5. **编辑守卫整合**
   - 保留 pi-init 的精确 edit 参数和唯一匹配检查。
   - 在写入前接入 reservation 冲突检查。
   - 不让两个实现分别覆盖原生 edit/write hook；以实际 Pi hook 语义为准测试组合行为。

6. **旧并发链路退役**
   - 共享工作区执行器通过真实多 Agent 测试后，才删除 gmc/worktree 专用代码。
   - `parallel_batch` 的旧命令若需要兼容，应明确返回迁移提示，不静默改变隔离语义。

## 必须验证的风险

- 同一路径及父子路径 reservation 的冲突和释放。
- Agent 取消、超时、session reload、session tree 和 shutdown 后旧消息/结果不能污染当前状态。
- worker 只有 `toolUse`、provider 错误、非零退出和部分写入时的真实失败语义。
- shell 或未经过 edit/write hook 的写入不能被描述为完全受 reservation 保护。
- 角色配置能精确决定模型和 thinkingLevel，fork 的配置不能覆盖或 fallback。
- `task_workflow` 仍区分 Agent 完成、验证失败、阻塞和任务验收。
- 共享工作区失败后的修改可被发现、人工处理，不自动宣称回滚。
- Windows 宿主、真实远程模型、双 Agent 并发和 cmux（如启用）端到端链路。

## 当前状态

## fork-audit 证据包（2026-09-11）

### 事实与来源

- 来源：用户 fork `https://github.com/CGOSU/pi-collaborating-agents`。
- 固定版本：GitHub fork 的 `main` 当前显示与上游同步，最新 commit 为 `acd50d0ec091deb03bb90b57b694131cff0c297d`，提交信息为 `Advanced the version to 0.4.6.`；后续实现必须固定该 commit 或用户另行指定的 commit，不能只依赖浮动 `main`。
- 包信息：`package.json` 的包名为 `@baochunli/pi-collaborating-agents`，版本 `0.4.6`，MIT license，Pi extension 入口为 `extensions/collaborating-agents/index.ts`，peer dependencies 使用 `@mariozechner/pi-*` 和 `@sinclair/typebox`。
- 当前 pi-init 使用 `@earendil-works/pi-*`，且自身 package 没有 fork 的 peer dependency；需要实际包/API 兼容适配，不能直接复制后假定可加载。

### 关键符号与调用关系

- `extensions/collaborating-agents/index.ts` 注册 `agent_message` 和 `subagent` 工具、`/agents` 等命令/Overlay，并挂接 `tool_call`、`session_start`、`turn_end`、`session_shutdown` 生命周期。
- `index.ts` 的 `executeSubagentParams` 解析 `type`、调用 `createSpawnAgentDefinitionFromType` 和 `runSpawnTask`；当前公开参数没有 pi-init `role`。
- `subagent-spawn.ts` 的 `runSpawnTask` 使用 `task.cwd || defaultCwd || runtimeCwd`，启动独立 Pi 进程或 cmux pane；没有 Git worktree、base commit 或 integration 流程。
- `subagent-spawn.ts` 和 `index.ts` 允许 type 的 model/reasoning，并且 `index.ts` 在 type model 缺失时根据当前 session model 做 provider/model fallback；这与 pi-init 的精确 roleModels 唯一来源冲突，必须替换或在 role 模式下禁用。
- `index.ts` 的 `tool_call` 只对 `edit`/`write` 按 Agent registry 的 reservation 冲突进行拦截；README 明确 reads 不拦截，shell 或其他未经过该 hook 的写入不受 reservation 保护。
- `store.ts` 负责 registry、inbox、message log、run records；`session-tail.ts` 负责 session JSONL tail；`overlays/messages-overlay.ts` 提供协作 UI。

### 测试与验证事实

- fork README 声明验证命令为 `bun test`、`npm pack --dry-run`，并列出 `docs.test.ts`、`index.test.ts`、`session-tail.test.ts` 等 focused checks；本次没有执行 fork 测试或打包。
- 通过公开 raw 文件读取并统计固定 commit 的主要文件：`index.ts` 2,985 行、`subagent-spawn.ts` 1,935 行、`store.ts` 1,049 行、`messages-overlay.ts` 873 行、`session-tail.ts` 335 行。pi-init 的 500 物理行门禁不允许直接合入这些大文件，必须拆分或保留为受控第三方目录并明确门禁策略。
- 本地工作区在本次文档修改后包含 `docs/current-state.md`、`docs/decisions.md`、`docs/session-log.md` 的修改和新增 `docs/plans/`；未修改代码、未运行 fork 测试、未运行真实 Agent。

### 风险与未确认项

- 共享 cwd + reservation 只能提供协作协调，不提供 worktree 回滚、部分修改隔离或 shell 写入沙箱；失败后的修改发现和人工处理必须成为工作流语义。
- 目标 fork 的 `session_shutdown` 代码会停止 watcher、停止远程 session refresh、注销自身 registry，但从已核对的入口看没有证明会终止所有已启动子进程；需要在实现阶段补充并验证父会话取消/关闭行为。
- fork 的 `package.json` 仅声明 peer dependencies，当前 pi-init 的 package、Pi 包名和 line-count 规则均不兼容；具体安装方式、源码合并位置和依赖版本需由 architect 在此证据基础上确定。
- reservation 的路径规范化、父子路径冲突、Windows 分隔符、竞争注册和释放时机仍需读取完整实现并用临时共享工作区验证；本证据包不将 README 描述扩展为已验证实现事实。

### 交给 architect 的集成接点

- 保留 pi-init 的 `role-runtime`、`roleModels`、`task_workflow`、恢复门和 `edit-guard`；将 fork 的协作代码拆成不超过 500 行的模块，或明确第三方目录的行数门禁例外后再由用户确认。
- 修改 subagent API 为 `role` 优先；角色模型、thinkingLevel、system prompt 和 allowed tools 从 pi-init 解析，禁止 fork type/TOML 覆盖和 fallback。
- 先接入 registry/message/session/reservation 与旧 `parallel_batch` 并存，完成共享工作区取消、失败、迟到结果和真实双 Agent 验证后，才讨论删除 gmc/worktree 代码。
- 保留 MIT license 版权声明；对方 fork 的源仓库、固定 commit、包名/API 兼容结果和测试结果需在实现文档中追踪。

迁移实施已完成：已接入共享 cwd Agent、registry、消息、session tail、`/agents`、reservation、roleModels 适配和 `collaboration` 工作流；已删除 `parallel_batch`、gmc、worktree/integration 专用代码和测试。当前代码与文档收尾事实以 [`../current-state.md`](../current-state.md) 和 [`../session-log.md`](../session-log.md) 为准。

相关决策见 [`../decisions.md`](../decisions.md)，当前事实见 [`../current-state.md`](../current-state.md)，会话记录见 [`../session-log.md`](../session-log.md)。
