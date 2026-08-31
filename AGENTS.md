# pi-init AI 协作指南

本文件定义本项目长期有效的 AI Coding 协作规则。通用任务执行流程、证据门控、工具调用和角色交接规则由随 package 发布的 `pi-init-role-routing` Skill 统一维护；执行相关任务时按需读取该 Skill 及对应的 `roles/*.md`，不要在本文件复制其内容。

1. 先读取与任务直接相关的项目规则、项目记忆或代码；项目记忆优先按关键词定位相关段落，而非全量读取；
2. 需要规则、事实、历史或风险时，按需读取 `docs/clean-code.md`、`docs/current-state.md`、`docs/decisions.md`、`docs/session-log.md` 和 `docs/pitfalls.md`；
3. 仅当任务需要沉淀可复用的跨项目知识时，更新知识库 `https://github.com/CGOSU/knowledge.git`；更新前先在其本地检出中执行 `git pull`，完成后使用中文提交信息并执行 `git push`；
4. 本仓库 Git 身份使用 `git config user.name CGOSU` 和 `git config user.email dev@cgosu.com`。

## 项目定位

用于 Pi 的项目初始化扩展，生成 AGENTS.md 和项目记忆文档，并通过公共 Skill 支持智能职责路由和自动模型切换。

## 公共协作规则

通用的任务执行流程、证据门控、`read`/`edit` 工具调用、角色边界和真实验证要求由随 package 发布的 `pi-init-role-routing` Skill 统一维护。执行代码、测试、文档或工作流任务时，按需读取该 Skill 及对应角色说明；本文件只保留项目特有规则。
## 运行环境与命令约定

- 初始化时检测到的宿主系统：Windows (`win32`)，CPU 架构：`x64`。
- 这是运行 Pi 的宿主环境快照，不一定是项目部署目标；如果实际执行发生在 WSL、容器、远程主机或其他环境中，应重新检测并以当前环境为准。
- Pi 的内置 `bash` 工具在 Windows 上通常通过 Bash 执行；扩展使用 `pi.exec` 时是直接启动进程，不会经过 Bash。
- 查找命令优先使用 `where.exe` 或当前 shell 支持的 `command -v`；不要把 Linux-only 的 `which` 作为唯一检查。
- npm 全局 CLI 可能通过 Windows `.cmd` shim 暴露；直接启动时要选择当前平台可用的执行入口。
- 如果工具提示 CLI 不存在，先用 `where.exe <command>`（以及对应的 `.cmd` shim）核实，再决定是否安装。

## 常用命令

- 测试：`npm test`

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
