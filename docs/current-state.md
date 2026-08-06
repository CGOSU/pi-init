# 当前状态

## 项目

- 名称：`pi-init`
- 定位：用于 Pi 的项目初始化扩展，生成 `AGENTS.md`、项目记忆文档，以及支持智能职责路由和自动模型切换的项目级 Skill。

## 当前目标

- 生成可按任务阶段自动切换具体模型与 Pi 推理强度的中英文项目 Skill。

## 已知状态

- 提供 `/init-project` 交互命令和 `init_project` 模型工具。
- 默认生成 `AGENTS.md`、四个项目记忆文档及 `.pi/skills/<slug>/SKILL.md`。
- Skill 在架构师、开发测试工程师、文档与提交工程师之间选择最少职责。
- `switch_role` 工具和 `/role` 命令读取 `.pi/role-models.json`，按 `auto`、`confirm` 或 `manual` 模式切换职责；`/role-mode` 可临时覆盖当前会话。
- `parallel_develop` 工具在架构规划后，在允许自动切换且项目受信任时为多个开发测试任务创建隔离 worktree，并发执行后自动合并非重叠修改；当前已有确定性 worktree、合并和重命名范围测试。
- 默认映射为 `gpt-5.6-sol/max`、`gpt-5.6-luna/max`、`gpt-5.6-luna/medium`，项目可覆盖。
- 支持简体中文、英文、dry-run 和已有文件覆盖确认。
- 测试命令为 `npm test`。

## 待处理

- 真实 LLM 子代理端到端演练尚未执行；当前已完成任务校验、扩展加载和编译检查。

## 最近一次更新

- 2026-08-06：增加自动、确认和手动职责切换模式，并加固并行开发的信任、范围和职责一致性检查。
