# {{PROJECT_NAME}} AI 协作指南

本文件定义本项目长期有效的 AI Coding 协作规则。开始任务前先阅读本文件，并按顺序读取：

1. `docs/clean-code.md`：代码、测试、重构、审查和文档修改的 Clean Code 规则；
2. `docs/current-state.md`：当前目标、已知状态和未完成事项；
3. `docs/decisions.md`：已经确认的设计决策；
4. `docs/session-log.md` 中最近的相关记录；
5. `docs/pitfalls.md` 中与当前任务相关的历史问题；
6. 仅当任务需要沉淀可复用的跨项目知识时，更新知识库 `https://github.com/CGOSU/knowledge.git`；更新前先在其本地检出中执行 `git pull`，完成后使用中文提交信息并执行 `git push`；
7. 本仓库 Git 身份使用 `git config user.name CGOSU` 和 `git config user.email dev@cgosu.com`。

## 项目定位

{{PROJECT_DESCRIPTION}}

## 任务执行流程

- 默认按“架构分析 → 任务拆分 → 开发测试逐项执行 → 文档与收尾”的流水线工作；除非用户一开始明确要求先审阅架构，否则架构师完成规划后不得停下来询问下一步选择。
- 项目任务工作流策略由 `.pi/role-models.json` 顶层 `workflowMode` 控制，默认是 `auto`：`off` 拒绝新的 `plan`，`on` 始终编排，`auto` 对不超过 2 个任务的规划跳过编排并由当前架构角色直接顺序执行，超过 2 个任务才进入自动工作流。可通过 `/pi-init config workflow` 在当前会话暂存，执行 `/pi-init save` 后才持久化，或直接修改该配置字段。旧项目缺失 `workflowMode` 时，`workflowEnabled: true/false` 兼容映射为 `on/off`；关闭时不要调用 `plan`。
- 运行时角色切换和 `/pi-init config` 变更只存在于当前会话，不得直接写入 `.pi/role-models.json`；只有用户明确执行 `/pi-init save`（保存角色配置）时才持久化。
- Provider 默认 fail-closed：`.pi/role-models.json` 缺少 `providerPolicy` 时也按 `{"mode":"locked","allowedProviders":["openai-codex"]}` 处理。主会话模型选择、模型循环、会话恢复、角色/工作流切换和 Agent 子代理都不得跨 Provider；Agent 省略 `model` 时继承当前允许模型，`haiku`、`sonnet` 等未带 `provider/` 的模糊名称必须在 spawn 前拒绝。需要其他 Provider 时只能显式编辑并保存 `providerPolicy`，不提供临时解锁或隐式 fallback。
- 工作流启用并创建任务后，每个任务完成时，开发测试工程师必须实际执行验证，并调用 `task_workflow` 的 `complete` 动作提交摘要和真实结果；完成时还要输出任务完成报告，包含任务 ID、任务内容、角色、开始时间、结束时间、总耗时、完成摘要和验证结果；工作流会自动推进、自动切换到任务指定角色并开始下一个可执行任务。
- 工作流执行器由 `.pi/role-models.json` 顶层 `workflowExecutor` 配置，默认是 `local`；`subagents` 只通过 `pi.events` RPC 顺序委派，并且缺少扩展、RPC 错误或异常回复都必须安全阻塞任务。
- 使用 `subagents` 时，主会话是 `task_workflow` 状态的唯一写入者；子代理只执行当前任务，不调用 `task_workflow`，并且必须返回严格的 `pi-init/task-result@1` JSON 结果，只有合法 `complete` 才能完成任务。
- 子代理在共享工作区执行；不得创建 worktree、合并分支、自动提交或推送。reload 后已绑定的非终态子代理不会自动重生，应先查看持久化绑定再人工恢复。
- 不要因为偏好、风格或可选方案向用户提问。只有用户明确要求架构审阅，或遇到缺少产品决策、权限/凭据、破坏性操作确认、不可恢复失败或真正阻塞的信息时才暂停；把合理假设记录在任务结果中。
- 用户明确要求先看架构时，且工作流已启用，架构师将 `reviewRequired` 设为 `true`，保存规划后暂停；用户审阅后执行 `/pi-init workflow resume`。阻塞任务使用 `block`，处理完原因后使用 `/pi-init workflow retry <taskId>`。

## 工具调用规则

- `read` 只使用 `path`、`offset`、`limit` 参数；`edit` 只使用 `path` 和 `edits`，其中每项必须包含 `oldText` 与 `newText`。
- 调用 `edit` 前必须先读取文件最新内容，直接复制实际文本作为 `oldText`；不要手动改写单双引号、缩进、空格或换行。
- `oldText` 匹配失败后必须重新读取并检查实际内容，不要重复提交相同的替换文本；不要用模糊匹配绕过精确编辑保护。

## 运行环境与命令约定

{{ENVIRONMENT_CONTEXT}}

## 常用命令

- 测试：`{{TEST_COMMAND}}`

如果命令尚未补充，先检查项目现有脚本和工具链，不要猜测命令。

## 工作约定

- 修改前检查工作区和相关实现，不覆盖其他协作者的改动。
- 优先进行最小、局部、可验证的修改，不为不确定需求增加兼容层。
- 遵循项目已有的代码风格、目录结构和工具链。
- 不在代码、文档、日志或提交中记录令牌、密码、私钥等敏感信息。

## 验证要求

- 新增或修复行为时补充针对性测试。
- 至少运行与改动直接相关的测试、类型检查或构建命令。
- 只记录实际执行的验证及真实结果，不把未执行检查描述为通过。

## 会话收尾

完成任务后：

1. 更新 `docs/current-state.md`，只保留当前事实和未完成事项；
2. 将影响后续实现的重要选择追加到 `docs/decisions.md`；
3. 在 `docs/session-log.md` 记录完成内容、验证命令和遗留问题；
4. 将新发现的隐蔽且可复发问题沉淀到 `docs/pitfalls.md`。

仅在产生新事实时更新对应文件，不为留痕进行无意义修改。一个事实只在一个文件中维护；其他文件需要引用时，使用摘要和相对路径指向唯一来源。
