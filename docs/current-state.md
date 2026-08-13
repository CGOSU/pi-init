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
- 已增加架构驱动的 `task_workflow` 顺序任务编排：项目级 `workflowMode` 默认是 `auto`，`off` 拒绝新规划，`on` 始终编排，`auto` 对不超过 2 个任务的规划跳过状态持久化、调度和角色切换，由当前架构角色直接顺序执行，超过 2 个任务才进入工作流；既有工作流仍可查看和收尾。工作流状态使用 session custom entry 持久化，支持恢复、重试、取消和有限次未完成提醒。旧项目缺失 `workflowMode` 时兼容 `workflowEnabled: true/false` 为 `on/off`。
- 已移除自研的 `parallel_develop` 工具及其隔离 worktree/Pi worker 实现；不配置第三方替代品。架构规划后的开发测试任务继续通过顺序 `task_workflow` 执行。
- 默认映射为 `gpt-5.6-sol/max`、`gpt-5.6-luna/max`、`gpt-5.6-luna/medium`，项目可覆盖；`.pi/role-models.json` 保存默认 `workflowMode: "auto"`。
- 支持简体中文、英文、dry-run 和已有文件覆盖确认。
- 初始化会在中英文 `AGENTS.md` 中记录当前 Pi 宿主系统、CPU 架构和平台相关命令约定；目标环境若不同，需以实际运行环境为准。
- 初始化提供快速和高级两条路径；快速路径从 `package.json`、包管理器锁文件和目录名推断项目元数据，只需一次确认，并在当前项目完成后自动 reload。高级路径仍可编辑项目名称、语言、描述、测试命令、Skill 名称和职责模型。
- 控制中心现在显示模式、角色、模型和工作流策略/状态卡片，按“初始化/变更/工作流”分组菜单；工作流策略已从“角色与模型”中移到顶层变更入口，主 `pi-init` 状态项也持续显示策略和活动工作流进度。标题下有间距、内容统一左右留出 2 格 padding，状态卡片文字与背景之间另有 1 格内边距；首次进入提供简短引导，取消配置会返回上一级菜单，初始化通知默认只显示文件数量和冲突摘要。
- 模型选择在 TUI 中使用带即时筛选的搜索列表，显示模型名称和支持的推理级别，并使用友好的角色和模式名称；Pi 原生 `/model` 与 `Shift+Tab` 仍是会话级临时切换。
- 测试命令为 `npm test`；包版本已更新为 `1.0.4`，扩展在工作流策略函数缺失时会报告扩展与 `src/roles.js` 版本不一致，并提示 `pi update --extensions`、`/reload` 或重启 Pi。
- 提供跨平台 `scripts/pi-usage.*` 用量统计命令；Windows PowerShell 安装器会把所需文件复制到 Pi 所在的 npm 可执行目录，POSIX 安装器优先使用 Pi 可执行目录、无写权限时回退到用户 bin 目录。`pi-usage` 普通查询在首次查询、距离上次检查超过 1 小时或跨自然日时自动执行增量检查，其余时间直接读取 DuckDB；`--update` 始终强制检查。Models 表还可导入 `pi-token-speed` 扩展写入的有效生成时长，按模型展示加权平均 TPS；扩展在 `message_end` 生命周期记录样本，避免等待 `agent_end` 或重复记录。

## 待处理

- `task_workflow` 真实模型连续多任务端到端演练尚未执行；当前覆盖纯状态机测试和扩展 RPC 加载检查。
- Linux、macOS 的 CI 矩阵已加入但尚未在本地执行；第三方 `agent-browser` 工具在 Windows 上仍需上游修复 CLI 检测和 `.cmd` 启动兼容性，本项目只能通过 `AGENTS.md` 降低误安装和误用。

## 最近一次更新

- 2026-08-10：`pi-usage` 基于 DuckDB 扫描 Pi JSONL session，按模型汇总调用次数、输入/输出/cache token、费用和近似使用时长；报告移除 Git changes，增加按模型总 token 缩放的柱状图，并在 Overview 显示缓存占比；缺少 DuckDB 时自动安装用户目录运行时；普通查询增加 1 小时缓存和跨自然日自动检查。
- 2026-08-13：`pi-usage` 增量导入 `pi-token-speed` 的自定义 session 采样，按 provider/model 计算 `输出 token / 有效生成秒数` 的加权平均 TPS；旧数据库升级时只回填 `speed_events`，不再重建既有用量和活动数据。
- 2026-08-14：移除自研 `parallel_develop` 及其测试、模板和文档说明，保留 `task_workflow`、`switch_role`、角色配置和脚手架能力。
- 2026-08-14：任务工作流升级为默认 `workflowMode: "auto"` 的 off/on/auto 策略；`auto` 对不超过 2 个任务跳过编排，配置入口为 `/pi-init config workflow`，并兼容旧 `workflowEnabled`。
