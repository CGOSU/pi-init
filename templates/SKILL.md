---
name: {{PROJECT_SLUG}}
description: {{SKILL_DESCRIPTION}}
---

# {{PROJECT_NAME}} 智能职责路由

处理本项目任务时，以仓库根目录的 `AGENTS.md` 为唯一规则入口。先按交付物选择最少职责，再读取当前任务相关的项目文档。

## 精确字符串替换

- 修改文件前先读取最新内容；使用精确的 `oldText` → `newText` 替换，不使用模糊匹配、正则或仅凭行号定位。
- `oldText` 必须在原始文件中唯一匹配；匹配为 0 次或多次时停止，重新读取并调整上下文，不猜测修改。
- `oldText` 只包含足以唯一定位的最小上下文；保留未改文本，避免整文件重写。
- 同一文件多个不相邻改动应在一次编辑中提交为多个互不重叠的替换；每个替换都以原始文件为基准匹配。
- 修改后检查实际 diff，确认没有意外改动，再运行相关验证。

## 职责配置

| 职责 | 技术水平 | 交付范围 | 模型类型 | 默认模型 | Pi 推理强度 |
| --- | --- | --- | --- | --- | --- |
| 架构师 | 专家级（Staff / Principal）：能完成系统边界、技术权衡、数据与接口设计、迁移及非功能风险分析 | 架构决策、约束、风险和验收标准；默认不改代码 | 旗舰通用推理模型，长上下文且擅长复杂权衡 | `{{ARCHITECT_PROVIDER}}/{{ARCHITECT_MODEL}}` | `{{ARCHITECT_THINKING_LEVEL}}` |
| 开发测试工程师 | 资深级（Senior / SDET）：能实现、调试、重构，并设计单元、集成和回归验证 | 最小代码改动、测试实现、命令与真实结果 | 代码专用或强工具调用模型，擅长代码理解与测试 | `{{DEVELOPER_TEST_PROVIDER}}/{{DEVELOPER_TEST_MODEL}}` | `{{DEVELOPER_TEST_THINKING_LEVEL}}` |
| 文档与收尾工程师 | 资深级（Technical Writer / Release Engineer）：能维护文档、更新版本号、核对变更并完成收尾交付 | 文档、版本号、变更摘要、收尾检查、提交边界和提交信息 | 快速通用模型，指令遵循和结构化写作能力强 | `{{DOCS_COMMIT_PROVIDER}}/{{DOCS_COMMIT_MODEL}}` | `{{DOCS_COMMIT_THINKING_LEVEL}}` |

## 智能分配

1. 涉及跨模块边界、技术选型、数据模型、安全、性能或不可逆迁移时，先由架构师给出决定、约束和验收标准。
2. 实现、修复、重构、调试或测试默认交给开发测试工程师；局部且明确的改动不额外经过架构师。
3. 纯文档任务直接交给文档与收尾工程师；代码任务仅在验证完成后进入文档与提交阶段。
4. 混合任务按“架构师 → 开发测试工程师 → 文档与收尾工程师”串行交接，不为简单任务启动全部职责。
5. 提交前必须检查实际 diff 和验证结果；只有用户明确要求提交时才执行 `git commit`，明确要求推送时才执行 `git push`。

## 架构拆分与自动任务工作流

- 项目任务工作流由 `.pi/role-models.json` 顶层 `workflowMode` 控制，默认是 `auto`：`off` 拒绝新的 `task_workflow(action=plan)`，`on` 对所有合法规划始终编排，`auto` 对不超过 2 个任务的规划跳过状态持久化、角色切换和隐藏续跑，由当前架构师直接按顺序执行；超过 2 个任务才采用连续流程。可用 `/pi-init config workflow` 在当前会话暂存，执行 `/pi-init save` 后才持久化。旧项目缺失 `workflowMode` 时，`workflowEnabled: true/false` 兼容映射为 `on/off`；两个字段同时存在时以 `workflowMode` 为准。
- 运行时角色切换和 `/pi-init config` 变更只存在于当前会话；只有用户明确执行 `/pi-init save`（保存角色配置）才写入 `.pi/role-models.json`。
- 架构师的每个任务必须包含唯一 `id`、目标 `task`、允许修改的 `files`、可验证的 `acceptanceCriteria`，并在有顺序约束时填写 `dependsOn`；任务默认按依赖就绪顺序串行执行。
- 工作流启用且用户在初始请求中明确要求“先看架构/先审阅方案”时，才把 `reviewRequired` 设为 `true`。此时保存计划后暂停，用户审阅后执行 `/pi-init workflow resume`；默认值必须是自动推进。
- 工作流启用并收到任务后，开发测试工程师应直接实现、测试和修正，不因可选偏好停顿；完成时必须调用 `task_workflow(action=complete, taskId=..., completionSummary=..., verification=[...])`，并输出精简任务报告，包含任务、角色、开始/结束时间、总耗时、摘要和验证结果。最终工作流报告同样只保留目标、进度、任务摘要、整体时间、耗时和验证。验证数组只能写实际执行过的命令和真实结果；报告时间使用系统本地时区，格式为 `YYYY-MM-DD HH:mm:ss±HH:MM`。
- 工作流执行器由 `.pi/role-models.json` 顶层 `workflowExecutor` 配置，默认是 `local`；`subtask` 由主会话调用 `subtask` 工具把当前任务委派到对话 fork，fork 结果消息回到会话后自动推进；缺少工具或异常回复都必须安全阻塞。
- 活动工作流中的方向变更使用普通自然语言提交；同一任务执行期间的连续 interactive/rpc 普通输入按到达顺序合并为一个带 `revisionId` 的待处理 revision，不创建多个 revision。扩展在当前任务完成后的边界暂停旧计划。只有架构师可根据完整合并指令用 `task_workflow(action="replan")` 提交未完成任务的新计划；新计划应用前不得启动旧后续任务，已完成任务、摘要和验证记录不可修改。立即停止当前任务时使用既有 `/pi-init workflow cancel` 流程。
- 使用 `subtask` 时，revision 不会让 pi-init 自动终止或重新派发运行中的 fork，也不会启动旧计划的下一个任务；fork 状态需要人工确认或停止。
- 模型引用必须明确：角色模型、`switch_role`、`/pi-init config` 和 `subtask` 工作流配置使用完整 `provider/model`，并要求引用精确存在；原生 Agent 子代理由 Pi 宿主决定模型，pi-init 不注入、不校验、不拦截其 `model` 参数。需要其他角色 Provider 时用 `/pi-init config`（全部已注册模型可选，随时暂存，`/pi-init save` 持久化）或直接编辑 `.pi/role-models.json`。
- 使用 `subtask` 时主会话是 `task_workflow` 状态的唯一写入者；fork 只执行当前任务，不调用 `task_workflow`，并必须返回严格的 `pi-init/task-result@1` JSON，只有合法 `complete` 才能完成任务。
- fork 在共享工作区执行，不创建 worktree、不合并分支、不自动提交或推送；reload 后非终态的已派发任务不会自动重新派发，须查看状态并人工恢复。
- 如果缺少产品决策、权限/凭据、破坏性操作确认、不可恢复失败或真正阻塞的信息，调用 `task_workflow(action=block, taskId=..., reason=...)`，不要猜测性完成；解决后用 `/pi-init workflow retry <taskId>`。
- 工作流在任务完成后由扩展自动切换配置角色和模型，并通过隐藏续跑消息启动下一任务；但存在待处理 revision 时必须先交给架构师重规划，不得启动旧后续任务。不要手动重复分配或要求用户触发下一步。若模型忘记提交完成结果，系统会自动提醒有限次数，仍未提交才暂停。

## 职责切换模式

- `.pi/role-models.json` 顶层的 `mode` 可设为 `auto`、`confirm` 或 `manual`，默认是 `auto`。
- `auto` 直接执行自动职责切换；`confirm` 在自动切换时先询问，默认选中“采用建议”，也可切换为手动模式或取消；`manual` 阻止自动换角，原生 `/model` 切换不会被扩展回滚，并把活动角色的模型直接写回 `.pi/role-models.json`；仍可用 `/pi-init role <职责 ID>` 手动换角。
- `/pi-init mode <模式>` 只覆盖当前会话，不修改项目配置；要修改默认行为，编辑 `.pi/role-models.json`。

## 用户入口

- `/pi-init`：打开控制中心，提供快速初始化、高级初始化、职责配置、职责切换和模式切换。
- `/pi-init init [目录]`：使用项目元数据快速初始化，只需确认一次。
- `/pi-init advanced [目录]`：编辑项目名称、语言、测试命令和 Skill 后初始化。
- `/pi-init role <职责 ID>`：手动切换职责。
- `/pi-init config [职责 ID]`：暂存当前会话的职责模型与推理强度变更。
- `/pi-init config workflow`：暂存当前会话的任务工作流 `off`、`on` 或 `auto` 策略；执行 `/pi-init save` 后才写入项目配置，也可直接修改 `.pi/role-models.json` 的 `workflowMode`。旧项目可继续使用 `workflowEnabled`，未设置新字段时 `true/false` 分别映射为 `on/off`。
- `/pi-init save`：明确将当前会话暂存的角色配置写入 `.pi/role-models.json`。

## 自动模型切换

- 每个职责开始前必须先调用 `switch_role`；跨职责时再次调用，不能只改变口吻。
- 职责 ID：架构师用 `architect`，开发测试工程师用 `developer-test`，文档与收尾工程师用 `docs-commit`。
- `switch_role` 从项目默认映射和当前会话暂存覆盖中读取配置，调用 Pi 的模型与推理强度 API，并返回实际生效结果；不会写入项目文件。
- 切换失败时立即停止该职责并报告错误，不得在错误模型下继续或伪报成功。
- 自动模式仅在实际跨角色且上下文使用率达到 50% 时，于 agent 完全 settled 后压缩一次上下文；压缩保留目标、决策、进度、文件、验证结果和下一步，成功后自动继续任务。确认、手动、首次选角、同角色重复切换和未知上下文不会额外触发。
- 会话启动、resume 或 reload 时，仅在当前模型和推理强度唯一匹配时恢复角色；重复配置或无法匹配时保持未知。
- Pi 0.84 的 `model_select` 是切换后的通知事件，扩展会立即恢复到上一个或配置中的安全模型，并在 `session_start`、输入和 provider 请求前再次校验；未来 Pi 提供可取消的 `before_model_select` 后可进一步从选择源头拒绝。
- 用户可用 `/pi-init role <职责 ID>` 手动验证同一映射；在受信任项目中使用 `/pi-init config [职责 ID]` 暂存模型或推理强度变更，需要持久化时再执行 `/pi-init save`；手动模式下执行 `/pi-init role` 后再重试自动职责。


## 交接要求

- 架构师交付：决定、原因、约束、风险、验收标准。
- 开发测试工程师交付：修改文件、实现摘要、验证命令与真实结果。
- 文档与收尾工程师交付：文档和版本号变化、最终 diff 摘要、收尾检查结果，以及获授权后的提交或推送结果。
- 仅在产生新事实时，按 `AGENTS.md` 的收尾要求更新对应项目文档。
