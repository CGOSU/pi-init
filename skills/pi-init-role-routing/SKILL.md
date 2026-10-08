---
name: pi-init-role-routing
description: >
  处理使用 pi-init 初始化项目、执行代码和测试、维护项目文档或完成交付收尾时使用；
  根据标准职责和项目自定义角色配置执行职责路由；有显式 roleModels 映射时按映射选模，否则标准职责沿用当前 Pi 会话模型。
metadata:
  primary-category: workflow
  related-categories: coding, documentation, project-management
---

# pi-init 公共职责路由

这是随 `pi-init` package 发布的公共 Skill，集中维护角色路由、职责边界和工作流硬约束；项目不应复制或生成该 Skill 的副本。

## 路由

1. 明确对应实现/测试的指令直接交给 `developer-test`；明确对应文档、版本或 Git 收尾的指令直接交给 `docs-commit`。
2. 简单只读咨询可直接交给当前适合的非 `architect` 角色完成，不创建工作流，也不要求正式证据交接；目标明确的日常开发由 `developer-test` 一次完成调查、修改和验证。若 `before_agent_start` 注入的运行状态已确认当前职责且没有活动工作流，不调用 `task_workflow(status)`，也不重复 `switch_role`；若 `roleRecoveryPending` 且没有活动工作流、请求无需工具或新证据，可以直接回答，但不能因此解除恢复门；需要任何工具或执行时仍先 `switch_role`。
3. 不明确、含糊、需要需求判断或跨职责的指令从 `architect` 开始，由架构师负责澄清目标、边界、非目标，并安排后续职责。
4. 凡任务需要仓库、代码、测试、文档或外部事实取证，均由 `docs-commit` 完成，并将事实、来源、关系和限制整理成结构化证据包交回 `architect`；`architect` 不进行低风险或其他只读探索。
5. 代码完成并真实验证后，只有产生项目文档、版本或 Git 收尾时才交给 `docs-commit`；提交和推送仍需授权。

角色说明按需读取：
- [`roles/architect.md`](roles/architect.md)
- [`roles/developer-test.md`](roles/developer-test.md)
- [`roles/docs-commit.md`](roles/docs-commit.md)

## `/fast` 手动 Fast Path

- 用户显式调用 `/fast <任务描述>` 表示只为本次任务手动选择 Fast Path；不要再次以自动资格为门槛，也不要因任务类型、规模、文件数、代码行数或修改范围不符而退回普通流程。该命令不切换模型、不改变持久配置。
- 此选择不覆盖安全、权限、需求/契约确认、角色职责、上下文恢复门、活动工作流保护或必要验证；任务本身独立要求架构规划/工作流时仍按对应规则处理。不要只因自动 Fast Path 资格不满足而额外创建工作流或例行留痕。

## 角色和模型来源

- `.pi/role-models.json` 的 `roleModels` 保存项目显式角色模型映射；其中的自定义角色用于启用对应角色模型。标准角色 ID `architect`、`developer-test`、`docs-commit` 不依赖映射文件即可使用。
- 显式映射值必须包含 `provider`、`model` 和 `thinkingLevel`，并优先于 fallback。标准角色未显式映射时沿用当前 Pi 会话真实模型与推理强度；仅改变职责，不另选模型、不生成或持久化隐式映射。若当前模型不存在则报告错误。未知自定义角色仍需显式配置并具有对应职责说明；显式配置错误、模型不可用或凭据缺失不得静默 fallback。
- `schemaVersion: 2` 的 `roleModels` 可缺失或为空；没有其他显式映射时按无映射处理。旧版顶层角色字段仍按兼容规则读取并优先作为显式映射。损坏 JSON、未知版本、`roleModels` 类型/字段无效、显式模型不可用或凭据缺失必须保留真实错误，不能 fallback 掩盖。只有用户明确执行 `/pi-init save` 才持久化迁移；会话默认不会自动写入配置。Skill 不写入具体 provider、model 或 thinkingLevel。

## 共享硬约束

- 只有真正进入职责或跨越职责边界时调用 `switch_role`；在允许取证和执行的非 `architect` 职责内，调查、实现和验证不重复切换。普通压缩、reload、resume、fork 或已有上下文恢复后，先确认任务边界并重新切换；恢复门仍优先于低风险快捷路径。`manual` 模式要求用户执行 `/pi-init role <role>`，`confirm` 按确认流程执行。
- `architect` 只负责思考、分析、决策、规划和安排；除 `switch_role` 与 `task_workflow(action="plan"/"replan"/"status")` 外不得调用任何工具，不得连接或调用 MCP。运行时对其他工具一律 fail-closed。
- 低风险、局部、可逆且不改变既定契约的实现选择由 AI 自主决定：helper、内部命名、函数拆分、测试组织、排查顺序和已有模式内的方案不询问用户，也不因这些选择创建工作流。修复既定行为的 bug 不重新确认需求；新增行为、契约、权限或数据结构先写入用户已确认的需求/决策载体。
- 用户明确要求简单任务只做实现时，采用最小验证策略：不创建 `task_workflow`，不默认运行全量测试、类型检查或构建；纯文档、文案、注释和样式修改只做必要的差异/静态核对。不得因此跳过安全措施、输入校验、数据不丢失处理、无障碍基础或用户明确要求的验证；涉及公共接口、权限、数据、并发、迁移或删除等高风险边界时恢复针对性验证，并明确列出未执行项。
- `before_agent_start` 只能依据运行时真实状态注入简短的结构化职责/工作流 section；不得根据用户文本启发式分类、自动切换模型或自动确认 `roleRecoveryPending`，不得替代 `tool_call` 的执行类硬守卫。
- 只有业务目标冲突、公共契约/数据/权限/架构含义无法从证据确定、不可逆或外部状态操作、无法安全合并已有改动、缺少必要权限/凭据或真实验证阻塞时才暂停；询问时说明事实、推荐方案、影响和最少必要问题。
- `docs-commit` 的正式证据包至少区分事实、来源、相关符号、调用/依赖、测试、工作区状态、风险和未确认项；仅在复杂/高风险判断或明确证据交接时建立。充分证据不重复读取，局部缺口通常 1 轮，未知位置/符号通常最多 2 轮；高风险改动（安全、认证、公共 API、迁移、并发、删除或共享工作区）必须核对最新实现、直接调用方和测试。
- `read` 只接收 `path`、`offset`、`limit`；`edit` 只接收 `path`、`edits`。每个 `oldText` 调用前必须精确匹配一次，区域不得重叠；零匹配只允许定向重读并最多重试一次，禁止模糊/正则替换和持久缓存。运行时守卫对无效或歧义写入 fail-closed。
- 不伪造成功、验证、权限或真实依赖；不泄露或写入密钥、凭据和敏感数据。行为变化前先更新用户确认的需求/决策载体。
- 上下文恢复门对一般角色只放行读取、`task_workflow(action="status")` 和 `switch_role`，直到角色或任务交接成功；若当前角色是 `architect`，仅放行 `task_workflow(action="status")` 和 `switch_role`。

## 工作流

- 只有明确规划请求、跨模块/高风险工作或无法安全归并为小局部任务时才使用 `task_workflow(action="plan")`；`architect` 是唯一可执行 `plan` 和 `replan` 的角色。
- `workflowMode: off` 拒绝新规划，`on` 始终编排，`auto` 对不超过两个低风险任务走直接角色顺序；`reviewRequired` 只有用户一开始明确要求架构审阅时才为 `true`。
- 当前任务必须由实际执行角色完成；若任务属于需要工作流的范围，完成时仍须由实际执行角色提供真实验证并调用 `complete`。简单任务采用最小验证策略时，不把未执行的检查描述为通过；缺少需求、权限、凭据、破坏性操作确认或无法恢复时调用 `block`，不得用默认值或空结果掩盖失败。
- 活动工作流的普通方向变更在当前任务边界合并为一个 revision；应用新计划前不得启动旧后续任务。
- pi-init 工作流仅支持当前主会话内 local 顺序执行；缺省及旧 `workflowExecutor: "local"` 配置可用。旧 `runtime` 配置和 Runtime executor/authority 状态返回结构化退役错误，不会回退、自动恢复或改写 session entry。
- `task_workflow` 是唯一的规划、依赖、验收、阻塞和重规划状态机；Agent 完成、进程退出或返回文本都不自动等于任务验收完成。
- 工作流记录通过 Pi Extension API 的 `appendEntry` 保存到当前 session，并从活动 branch 恢复；这不是 AgentHarness durable operation 集成，不能保证事务/fsync 或外部副作用 exactly-once。任务 `complete`/`block` 必须匹配当前 `workflowId`、`planVersion`、`sessionId`、`recoveryGeneration`、`taskId`、`attemptId` 和 `handoffId`；`replan` 必须匹配当前基础身份、`revisionId` 和 `handoffId`。只使用当前交接提示提供的身份，不得从任务文本补齐，旧 branch/attempt/revision 结果必须拒绝。
- 恢复时仅未派发的准备阶段可安全续接；已派发/启动但无业务结果的任务按结果未知暂停，禁止自动重放。核对可能的外部副作用后，显式 `/pi-init workflow retry <taskId> --confirm-unknown-outcome` 才能创建新 attempt；legacy `in_progress` 缺少身份时同样转为需核对状态，旧 session entry 不原地改写，已退役 Runtime 状态继续 fail-closed。

## 交付

架构交付包含决定、原因、约束、风险和验收标准；代码交付包含修改文件、实现摘要和真实验证；文档收尾只记录新事实并说明 diff、遗留问题及经授权的 Git 结果。遇到需求边界、架构方案或不可恢复问题时交回 `architect`；不要因可选偏好暂停流程。
