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

## 工作流执行器

`workflowExecutor` 仅支持 `local`（主会话顺序执行）和 `runtime`（由配置的 Runtime endpoint 执行）；默认值为 `local`。

## 运行环境与命令约定

{{ENVIRONMENT_CONTEXT}}

## 常用命令

- 测试：`{{TEST_COMMAND}}`

## 验证要求

- 新增或修复行为时补充针对性测试；先根据本次改动选择最小相关测试集，测试运行器支持时使用文件或变更范围过滤，不要默认运行全量测试。
- 同一工作区内，如果自最近一次验证后，相关实现、测试、依赖和测试配置均未变化，可复用已通过的验证结果，不要重复执行；相关内容发生变化后，重新运行受影响的检查。
- 仅在用户明确要求、改动跨多个模块或影响测试基础设施/依赖配置、无法界定相关测试范围，或准备交付/发布时运行全量测试。
- 只记录实际执行的验证及真实结果；复用结果时说明依据，不把未执行检查描述为通过。

<!-- pi-init:managed:start fast-path-wrap-up -->
## Fast Path 收尾优先级

满足全局 `AGENTS.md` 定义的全部 Fast Path 条件时，本节优先于下方通用会话收尾规则。

- 只修改明确目标及保持仓库一致性所必需的直接关联内容；
- 不创建 `task_workflow` 或额外书面计划；
- 不为判断是否需要留痕而预读或更新 `docs/current-state.md`、`docs/decisions.md`、`docs/session-log.md` 和 `docs/pitfalls.md`；
- 不默认运行 test、typecheck、lint、formatter、build 或 dev server，只进行必要的静态核对；
- 不因规划或例行留痕额外切换角色，但职责路由、上下文恢复门和 architect 禁止执行的边界仍然有效。

若目标文件本身就是文档或项目记录，可以定向读取和修改该目标，不因此退出 Fast Path。

出现以下任一情况时退出 Fast Path：

- 修改 API、数据结构、依赖、架构、业务规则、权限、路由、交互或无障碍语义；
- 产生后续开发需要依赖的新事实、重要决策、遗留问题、关键验证结果或可复发陷阱；
- 修改范围不再局部、低风险或可逆。

用户明确要求测试、构建、更新其他文档或执行 Git 收尾时，只增加对应动作，并继续遵循相应职责规则。
<!-- pi-init:managed:end fast-path-wrap-up -->

## 会话收尾

完成任务后：

1. 更新 `docs/current-state.md`，只保留当前事实和未完成事项；其“最近一次更新”列表按日期倒序；
2. 将影响后续实现的重要选择记录到 `docs/decisions.md`，按日期倒序插入，最新条目在前；
3. 在 `docs/session-log.md` 新增完成内容、验证命令和遗留问题，按日期倒序插入，最新条目在前；
4. 将新发现的隐蔽且可复发问题沉淀到 `docs/pitfalls.md`，按日期倒序插入，最新条目在前。

仅在产生新事实时更新对应文件，不为留痕进行无意义修改。一个事实只在一个文件中维护；其他文件需要引用时，使用摘要和相对路径指向唯一来源。
