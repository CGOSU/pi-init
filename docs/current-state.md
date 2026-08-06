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
- `switch_role` 工具和 `/role` 命令读取 `.pi/role-models.json`，自动调用 Pi API 切换模型与推理强度。
- 默认映射为 `gpt-5.6-sol/max`、`gpt-5.6-terra/high`、`gpt-5.6-luna/medium`，项目可覆盖。
- 支持简体中文、英文、dry-run 和已有文件覆盖确认。
- 测试命令为 `npm test`。

## 待处理

- 暂无已知待处理事项。

## 最近一次更新

- 2026-08-04：增加智能职责路由及全自动模型与推理强度切换。
