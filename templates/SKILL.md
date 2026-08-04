---
name: {{PROJECT_SLUG}}
description: {{SKILL_DESCRIPTION}}
---

# {{PROJECT_NAME}} 项目技能

## 开始任务

先阅读仓库根目录的 `AGENTS.md`，再按其中顺序读取与当前任务相关的项目文档。

## 上下文入口

- 当前目标与未完成事项：`docs/current-state.md`
- 已确认的设计选择：`docs/decisions.md`
- 最近修改与验证结果：`docs/session-log.md`
- 可复用排障知识：`docs/pitfalls.md`

## 执行边界

- 长期协作规则以 `AGENTS.md` 为唯一来源，本 Skill 不复制规则正文。
- 排障结论以 `docs/pitfalls.md` 为唯一来源，只加载与当前问题相关的条目。
- 修改完成后按 `AGENTS.md` 的会话收尾要求更新项目文档。
