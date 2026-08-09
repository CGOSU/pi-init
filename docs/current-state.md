# 当前状态

## 项目

- 名称：`pi-init`
- 定位：用于 Pi 的项目初始化扩展，生成 `AGENTS.md`、项目记忆文档，以及支持智能职责路由和自动模型切换的项目级 Skill。

## 当前目标

- 生成可按任务阶段自动切换具体模型与 Pi 推理强度的中英文项目 Skill。

## 已知状态

- 提供统一的 `/pi-init` 控制中心和 `init_project` 模型工具；控制中心包含快速初始化、高级初始化、职责与模型配置、职责切换和会话模式切换。
- 默认生成 `AGENTS.md`、`docs/clean-code.md`、四个项目记忆文档及 `.pi/skills/<slug>/SKILL.md`；`AGENTS.md` 要求任务开始前先读取 Clean Code 规则。
- 生成的中英文项目 Skill 均包含精确字符串替换规则：读取最新内容、要求唯一匹配、使用最小上下文、支持同一编辑中的多个非重叠替换，并在修改后检查 diff。
- Skill 在架构师、开发测试工程师、文档与收尾工程师之间选择最少角色。
- `switch_role` 工具和 `/pi-init role` 读取 `.pi/role-models.json`，按 `auto`、`confirm` 或 `manual` 模式切换职责；`/pi-init mode` 可临时覆盖当前会话，`/pi-init config` 持久修改职责模型。
- 自动模式在真实跨角色且上下文使用率达到 50% 时，于 agent 完全 settled 后触发一次定制上下文压缩；成功后注入隐藏续跑消息，失败仅提示并保留已切换角色。会话启动、resume 或 reload 时，会根据当前模型和推理强度唯一匹配角色并恢复角色状态。
- `parallel_develop` 工具在架构规划后，在允许自动切换且项目受信任时为多个开发测试任务创建隔离 worktree；最多接受 4 个任务，默认 2 个 worker 并发，其余排队。子代理通过 Pi JSON 事件流实时报告任务状态、当前工具、耗时和最后活动，高频模型 delta 会节流；结果包含 worker 和 setup/worker/merge 阶段的耗时、turn/token/cache/cost/自动重试指标。基础设施错误（包括 `terminated` 等传输中断）自动重试一次，代码/测试错误交由主开发测试工程师接管，失败现场和日志保留，全部成功后才合并和清理；文件范围按 Git `core.ignorecase` 适配大小写规则，Windows `.cmd` 启动和取消/超时进程树终止已有回归测试。
- 默认映射为 `gpt-5.6-sol/max`、`gpt-5.6-luna/max`、`gpt-5.6-luna/medium`，项目可覆盖。
- 支持简体中文、英文、dry-run 和已有文件覆盖确认。
- 初始化会在中英文 `AGENTS.md` 中记录当前 Pi 宿主系统、CPU 架构和平台相关命令约定；目标环境若不同，需以实际运行环境为准。
- 初始化提供快速和高级两条路径；快速路径从 `package.json`、包管理器锁文件和目录名推断项目元数据，只需一次确认，并在当前项目完成后自动 reload。高级路径仍可编辑项目名称、语言、描述、测试命令、Skill 名称和职责模型。
- 控制中心现在显示模式、角色、模型状态卡片，按“初始化/变更”分组菜单，标题下有间距、内容统一左右留出 2 格 padding，状态卡片文字与背景之间另有 1 格内边距；首次进入提供简短引导，取消配置会返回上一级菜单，初始化通知默认只显示文件数量和冲突摘要。
- 模型选择在 TUI 中使用带即时筛选的搜索列表，显示模型名称和支持的推理级别，并使用友好的角色和模式名称；Pi 原生 `/model` 与 `Shift+Tab` 仍是会话级临时切换。
- 测试命令为 `npm test`。
- 提供跨平台 `scripts/pi-fast.*`、`scripts/pi-update.*` 和 `scripts/pi-usage.*` 辅助命令；Windows PowerShell 安装器会把所需文件复制到 Pi 所在的 npm 可执行目录，POSIX 安装器优先使用 Pi 可执行目录、无写权限时回退到用户 bin 目录。

## 待处理

- 真实 LLM 子代理端到端演练尚未执行；当前已完成任务校验、扩展加载和 RPC 命令检查，独立 TypeScript 检查仍受环境未安装 `tsc` 限制。
- Linux、macOS 的 CI 矩阵已加入但尚未在本地执行；第三方 `agent-browser` 工具在 Windows 上仍需上游修复 CLI 检测和 `.cmd` 启动兼容性，本项目只能通过 `AGENTS.md` 降低误安装和误用。

## 最近一次更新

- 2026-08-09：新增基于 DuckDB 的 `pi-usage [YYYY-MM-DD]`，扫描 Pi JSONL session，按模型汇总调用次数、输入/输出/cache token、费用、关联 Git 代码变化和近似使用时长；报告的 Overview、Models、Time 和 Git changes 均使用带边框的对齐表格，交互终端为表头和汇总行提供 ANSI 颜色；缺少 DuckDB 时自动安装用户目录运行时。
