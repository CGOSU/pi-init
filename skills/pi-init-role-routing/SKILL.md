---
name: pi-init-role-routing
description: >
  处理使用 pi-init 初始化项目、执行代码和测试、维护项目文档或完成交付收尾时使用；
  根据项目 roleModels 映射选择已启用角色，在角色边界调用 switch_role，并按需使用 task_workflow 顺序推进工作流。
metadata:
  primary-category: workflow
  related-categories: coding, documentation, project-management
---

# pi-init 公共职责路由

这是随 `pi-init` package 发布的公共 Skill，集中维护角色路由、职责边界和工作流硬约束；项目不应复制或生成该 Skill 的副本。

## 路由

1. 明确对应实现/测试的指令直接交给 `developer-test`；明确对应文档、版本或 Git 收尾的指令直接交给 `docs-commit`。
2. 不明确、含糊、需要需求判断或跨职责的指令从 `architect` 开始，由架构师澄清目标、边界、非目标和后续职责。
3. 架构判断需要仓库、调用链或外部事实时，先由 `docs-commit` 收集最小结构化证据，再交回 `architect`；架构师只消费证据，不自行探索。
4. 代码完成并真实验证后，再由 `docs-commit` 负责文档、diff 和经授权的提交/推送。

角色说明按需读取：
- [`roles/architect.md`](roles/architect.md)
- [`roles/developer-test.md`](roles/developer-test.md)
- [`roles/docs-commit.md`](roles/docs-commit.md)

## 角色和模型来源

- `.pi/role-models.json` 的 `roleModels` 是唯一启用角色和模型的项目级来源；只有其中已配置的角色才能被请求。
- 内置角色 ID 为 `architect`、`developer-test`、`docs-commit`；角色值必须包含 `provider`、`model` 和 `thinkingLevel`。不为缺失角色借用模型或自动 fallback。
- `schemaVersion: 2` 和旧版顶层角色字段按现有兼容规则读取；只有用户明确执行 `/pi-init save` 才持久化迁移。Skill 不写入具体 provider、model 或 thinkingLevel。

## 共享硬约束

- 每个职责开始和边界切换前调用 `switch_role`；普通压缩、reload、resume、fork 或已有上下文恢复后，先确认任务边界并重新切换。`manual` 模式要求用户执行 `/pi-init role <role>`，`confirm` 按确认流程执行。
- `docs-commit` 的证据包至少区分事实、来源、相关符号、调用/依赖、测试、工作区状态、风险和未确认项；充分证据不重复读取，局部缺口通常 1 轮，未知位置/符号通常最多 2 轮；高风险改动（安全、认证、公共 API、迁移、并发、删除或共享工作区）必须核对最新实现、直接调用方和测试。
- `read` 只接收 `path`、`offset`、`limit`；`edit` 只接收 `path`、`edits`。每个 `oldText` 调用前必须精确匹配一次，区域不得重叠；零匹配只允许定向重读并最多重试一次，禁止模糊/正则替换和持久缓存。运行时守卫对无效或歧义写入 fail-closed。
- 不伪造成功、验证、权限或真实依赖；不泄露或写入密钥、凭据和敏感数据。行为变化前先更新用户确认的需求/决策载体。
- 上下文恢复门只放行读取、`task_workflow(action="status")` 和 `switch_role`，直到角色或任务交接成功。

## 工作流

- 只有明确规划请求、跨模块/高风险工作或无法安全归并为小局部任务时才使用 `task_workflow(action="plan")`；`architect` 是唯一可执行 `plan` 和 `replan` 的角色。
- `workflowMode: off` 拒绝新规划，`on` 始终编排，`auto` 对不超过两个低风险任务走直接角色顺序；`reviewRequired` 只有用户一开始明确要求架构审阅时才为 `true`。
- 当前任务必须由实际执行角色完成并真实验证后调用 `complete`；缺少需求、权限、凭据、破坏性操作确认或无法恢复时调用 `block`，不得用默认值或空结果掩盖失败。
- 活动工作流的普通方向变更在当前任务边界合并为一个 revision；应用新计划前不得启动旧后续任务。`subtask` 下 fork 不写工作流状态、不建 worktree、不合并、提交或推送，并返回严格的 `pi-init/task-result@1` 结果。

## 交付

架构交付包含决定、原因、约束、风险和验收标准；代码交付包含修改文件、实现摘要和真实验证；文档收尾只记录新事实并说明 diff、遗留问题及经授权的 Git 结果。遇到需求边界、架构方案或不可恢复问题时交回 `architect`；不要因可选偏好暂停流程。
