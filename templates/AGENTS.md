# {{PROJECT_NAME}} AI 协作指南

本文件定义本项目长期有效的 AI Coding 协作规则。通用任务执行流程、证据门控、工具调用和角色交接规则由随 package 发布的 `pi-init-role-routing` Skill 统一维护；执行相关任务时按需读取该 Skill 及对应的 `roles/*.md`，不要在本文件复制其内容。

1. 先确认与任务直接相关的项目规则（包括需要时的 `docs/clean-code.md`）、项目记忆或代码；项目记忆优先按关键词定位相关段落，而非全量读取；
2. 项目 `.pi/role-models.json` 仅通过 `roleModels` 映射启用角色和配置模型，不生成或维护项目级 Skill；
3. 仅当任务需要沉淀可复用的跨项目知识时，更新知识库 `https://github.com/CGOSU/knowledge.git`；更新前先在其本地检出中执行 `git pull`，完成后使用中文提交信息并执行 `git push`；
4. 本仓库 Git 身份使用 `git config user.name CGOSU` 和 `git config user.email dev@cgosu.com`。

## 项目定位

{{PROJECT_DESCRIPTION}}

## 公共协作规则

通用的任务执行流程、证据门控、`read`/`edit` 工具调用、角色边界和真实验证要求由随 package 发布的 `pi-init-role-routing` Skill 统一维护。执行代码、测试、文档或工作流任务时，按需读取该 Skill 及对应角色说明；本文件只保留项目定位、环境、命令、知识库和 Git 等项目特有规则。

目标明确的低风险任务由 AI 自主选择实现方案并直接推进；不因 helper、内部拆分、测试组织、排查顺序或恢复既定行为的 bug 请求用户选择。只有业务/契约冲突、权限或凭据缺失、不可逆或外部状态操作、已有改动无法安全合并或真实验证阻塞时才询问；新增行为、契约、权限或数据结构仍先记录到确认的需求/决策载体。
## 运行环境与命令约定

{{ENVIRONMENT_CONTEXT}}

## 常用命令

- 测试：`{{TEST_COMMAND}}`

## 会话收尾

完成任务后：

1. 更新 `docs/current-state.md`，只保留当前事实和未完成事项；其“最近一次更新”列表按日期倒序；
2. 将影响后续实现的重要选择记录到 `docs/decisions.md`，按日期倒序插入，最新条目在前；
3. 在 `docs/session-log.md` 新增完成内容、验证命令和遗留问题，按日期倒序插入，最新条目在前；
4. 将新发现的隐蔽且可复发问题沉淀到 `docs/pitfalls.md`，按日期倒序插入，最新条目在前。

仅在产生新事实时更新对应文件，不为留痕进行无意义修改。一个事实只在一个文件中维护；其他文件需要引用时，使用摘要和相对路径指向唯一来源。
