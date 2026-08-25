# 当前状态

## 项目

- 名称：`pi-init`
- 定位：用于 Pi 的项目初始化扩展，生成 `AGENTS.md`、项目记忆文档，以及支持智能职责路由和自动模型切换的项目级 Skill。

## 当前目标

- 生成可按任务阶段自动切换具体模型与 Pi 推理强度的中英文项目 Skill。

## 已知状态

- 提供统一的 `/pi-init` 控制中心和 `init_project` 模型工具；控制中心包含快速初始化、高级初始化、职责与模型配置、职责切换和会话模式切换。控制中心和脚手架运行时已改为扩展实例内 Promise 缓存的按需加载，工作流恢复从 session branch 末尾直接查找最新状态。
- `pi-usage` 的 session 导入已使用 DuckDB Appender、每文件事务和 1024 行有界 flush；JSONL 使用流式读取并在 `session_files` 保存 offset、行号、cwd、尾部校验和不完整尾部状态。追加内容只读取新增字节，截断、改写或校验失败回退全量重建；duration summary 只刷新受影响日期。
- TTY 下 `pi-usage --update` 以及首次/过期自动刷新会显示扫描统计；非 TTY 只输出原有报表。当前本机 112 个 session、约 215,607,665 字节的首次导入统计为 112 个重建文件，实际约 2.3 秒；后续无变化刷新约 65 ms，跳过 112 个文件且不重算日期。
- 默认生成 `AGENTS.md`、`docs/clean-code.md`、四个项目记忆文档及 `.pi/skills/<slug>/SKILL.md`；`AGENTS.md` 要求任务开始前先读取 Clean Code 规则。
- 生成的中英文项目 Skill 均包含精确字符串替换规则：读取最新内容、要求唯一匹配、使用最小上下文、支持同一编辑中的多个非重叠替换，并在修改后检查 diff。
- Skill 在架构师、开发测试工程师、文档与收尾工程师之间选择最少角色。
- `switch_role` 工具和 `/pi-init role` 读取项目默认配置及当前会话暂存覆盖，按 `auto`、`confirm` 或 `manual` 模式切换职责；`/pi-init mode` 和 `/pi-init config` 的运行时变更只影响当前会话，执行 `/pi-init save` 才持久化职责配置。`manual` 模式下原生 `/model` 切换不会被扩展回滚，并把活动角色的模型直接写回 `.pi/role-models.json`；无活动角色或非受信任项目只提示不写。
- 自动模式在真实跨角色且上下文使用率达到 50% 时，于 agent 完全 settled 后触发一次定制上下文压缩；若 Pi 刚在同一边界完成自动压缩，则跳过重复调用并直接续跑，避免 `Already compacted` 警告。成功后注入隐藏续跑消息，失败仅提示并保留已切换角色。会话启动、resume 或 reload 时，会根据当前模型和推理强度唯一匹配角色并恢复角色状态。
- 已增加架构驱动的 `task_workflow` 顺序任务编排：项目级 `workflowMode` 默认是 `auto`，`off` 拒绝新规划，`on` 始终编排，`auto` 对不超过 2 个任务的规划跳过状态持久化、调度和角色切换，由当前架构角色直接顺序执行，超过 2 个任务才进入工作流；既有工作流仍可查看和收尾。工作流状态使用 session custom entry 持久化，支持恢复、重试、取消和有限次未完成提醒。旧项目缺失 `workflowMode` 时兼容 `workflowEnabled: true/false` 为 `on/off`。任务和最终工作流报告均保留摘要、时间、耗时和验证，开始/结束时间使用系统本地时区，格式为 `YYYY-MM-DD HH:mm:ss±HH:MM`。
- 活动工作流支持普通自然语言方向变更：同一任务执行期间的连续 interactive/rpc 普通输入按到达顺序合并到一个 `pendingRevision`/`revisionId`，同步更新 revision 审计记录；当前任务完成后进入 `replanning`，由架构师依据完整指令通过 `task_workflow(action="replan")` 仅重规划未完成后续任务。新计划应用前 local 和 `subtask` 均不会启动旧后续任务，运行中的 subtask fork 不由 pi-init 自动终止或重派，立即停止仍使用既有 cancel 流程。
- 未进入活动 `task_workflow` 的 `interactive`/`rpc` Agent 执行会追加 `pi-init-run-timing` session custom entry，并在 TUI 显示来源、开始/结束时间、总耗时和计时口径；计时从首次 `agent_start` 到最终 `agent_settled`，不把普通执行报告当作任务完成。活动工作流、subtask、扩展隐藏续跑以及 reload/会话切换/中断不会重复或补造普通报告。
- 已移除自研的 `parallel_develop` 工具及其隔离 worktree/Pi worker 实现；不配置第三方替代品。架构规划后的开发测试任务继续通过顺序 `task_workflow` 执行。
- 默认映射为 `gpt-5.6-sol/max`、`gpt-5.6-luna/max`、`gpt-5.6-luna/medium`，项目可覆盖；`.pi/role-models.json` 保存默认 `workflowMode: "auto"` 和 `workflowExecutor: "local"`。
- 模型安全来自角色和工作流配置中的明确引用而非 Provider 白名单（`1.1.0` 起移除 `providerPolicy`，旧字段被忽略）：角色模型和 `subtask` 工作流配置使用完整 `provider/model` 并要求精确存在；原生 Agent 子代理由 Pi 宿主决定模型，pi-init 不注入、不校验、不拦截其 `model` 参数。原生 `/model` 切换由用户自主决定，扩展不回滚、不拦截（见 `docs/decisions.md`）。`/pi-init config` 候选列表展示全部已注册模型，跨 Provider 选择随时可暂存。
- `workflowExecutor` 支持 `local`（默认）和 `subtask`：后者由主会话调用 `subtask` 工具把当前就绪任务顺序委派到独立的对话 fork，结果经 `subtask-result` custom 消息回到会话后自动推进；主扩展唯一写入工作流状态，严格校验 `pi-init/task-result@1`，缺少工具或无效结果安全阻塞，reload 不自动重新派发非终态任务。旧配置值 `subagents`（已停止接入的 `@tintinweb/pi-subagents` RPC）自动映射为 `subtask`。
- 初始化不再生成 `.pi/agents/*.md` 代理脚手架（pi-subagents 专用，随 RPC 执行器一并移除）；subtask fork 复用主会话角色与工具，不需要额外代理定义。
- 支持简体中文、英文、dry-run 和已有文件覆盖确认。
- 初始化会在中英文 `AGENTS.md` 中记录当前 Pi 宿主系统、CPU 架构和平台相关命令约定；目标环境若不同，需以实际运行环境为准。生成规则同时约束 `read`/`edit` 参数和精确替换失败后的重读流程。
- 初始化提供快速和高级两条路径；快速路径从 `package.json`、包管理器锁文件和目录名推断项目元数据，只需一次确认，并在当前项目完成后自动 reload。高级路径仍可编辑项目名称、语言、描述、测试命令、Skill 名称和职责模型。
- 控制中心现在显示模式、角色、模型和工作流策略/状态卡片，按“初始化/变更/工作流”分组菜单；工作流策略已从“角色与模型”中移到顶层变更入口，主 `pi-init` 状态项也持续显示策略和活动工作流进度；工作流完成或取消后，底部状态恢复为策略、执行器和无活动工作流摘要。标题下有间距、内容统一左右留出 2 格 padding，状态卡片文字与背景之间另有 1 格内边距；首次进入提供简短引导，取消配置会返回上一级菜单，初始化通知默认只显示文件数量和冲突摘要。
- TUI 中“工作流 · 查看任务进度”以及 `/pi-init workflow status` 现在打开居中 overlay 弹窗，使用主题背景色、标题高亮和四边框明确区分弹窗，显示状态、进度、总任务开始时间、总任务已运行时间、执行器、规划、暂停原因和可滚动任务列表；已完成任务的耗时移到任务描述列，避免挤压任务标题，并在窄面板保持可见；RPC 等非 TUI 模式的状态文本也显示总任务开始时间、总任务已运行时间和已完成任务耗时。
- 模型选择在 TUI 中使用带即时筛选的搜索列表，显示模型名称和支持的推理级别，并使用友好的角色和模式名称；Pi 原生 `/model` 与 `Shift+Tab` 仍是会话级临时切换。
- 测试命令为 `npm test`；该命令先执行 `scripts/check-line-count.js`，递归保证受检 JavaScript/TypeScript 文件不超过 500 个物理行，再运行 Node 原生测试。包版本为 `1.1.0`，扩展在工作流策略函数缺失时会报告扩展与 `src/roles.js` 版本不一致，并提示 `pi update --extensions`、`/reload` 或重启 Pi。
- 提供跨平台 `scripts/pi-usage.*` 用量统计命令；Windows PowerShell 安装器会把所需文件复制到 Pi 所在的 npm 可执行目录，POSIX 安装器优先使用 Pi 可执行目录、无写权限时回退到用户 bin 目录。`pi-usage` 普通查询在首次查询、距离上次检查超过 1 小时或跨自然日时自动执行增量检查，其余时间直接读取 DuckDB；`--update` 始终强制检查。日期参数支持 `yesterday`、`Nd`、`YYYY-MM`、单日和两个 `YYYY-MM-DD` 组成的闭区间，跨日统计按日期范围聚合并对 session 去重。报告标题会显示与 `pi-init` 共用的 package 版本号，启动器安装时从 `package.json` 嵌入该版本。`postinstall` 查找 Pi 时会跳过当前 npm 包 `node_modules/.bin` 中的本地 `pi` shim，避免 `pi update --extensions` 把启动器复制到随后会被清理的依赖目录。角色模型和工作流配置变更默认只存在当前会话，执行 `/pi-init save` 才写入 `.pi/role-models.json`。Models 表还可导入 `pi-token-speed` 扩展写入的有效生成时长，按模型展示加权平均 TPS；扩展在 `message_end` 生命周期记录样本，避免等待 `agent_end` 或重复记录。

## 待处理

- `task_workflow` 与 pi-subtask 的真实模型连续多任务端到端演练、fork 生命周期和 reload 后人工恢复尚未执行；当前覆盖纯状态机/协议/脚手架测试和扩展加载检查。
- Linux、macOS 的 CI 矩阵已加入但尚未在本地执行；第三方 `agent-browser` 工具在 Windows 上仍需上游修复 CLI 检测和 `.cmd` 启动兼容性，本项目只能通过 `AGENTS.md` 降低误安装和误用。

## 最近一次更新

- 2026-08-25：`pi-usage` 新增 `yesterday`、`Nd`、`YYYY-MM`、单日和双日期闭区间查询；跨日汇总按源文件去重 session，`npm test` 通过 56 项。
- 2026-08-25：删除会在仓库根目录遗留临时目录的 `test/extension-workflow.test.js`；剩余测试通过，`npm test` 通过 54 项。
- 2026-08-25：活动工作流将同一任务期间连续 interactive/rpc 方向输入按顺序合并为单一 revision，并在任务边界将完整指令交给架构师重规划；新增核心、local 集成和 subtask 边界回归覆盖，删除工作流扩展测试前曾通过 61 项。
- 2026-08-23：工作流进度面板增加总任务已运行时间；已完成任务耗时移到描述列并优化主列宽度，避免窄面板遮挡任务信息。
- 2026-08-22：工作流进度面板增加总任务开始时间，并在已完成任务后显示任务耗时；TUI 与非 TUI 状态展示均已同步。
- 2026-08-22：完成启动优化验证。12 组交替 fresh RPC（24 个新进程）中，无扩展 wall 中位数为 808.2 ms，加载 pi-init 为 824.7 ms，增量 16.5 ms；`PI_TIMING` 的 main TOTAL 中位数为 58.5/79.0 ms，扩展首阶段为 9.0/28.5 ms。相较此前 25.7 ms 增量基线减少约 9.2 ms，超过约 5 ms 保留阈值；完整验证见 `docs/session-log.md`。
- 2026-08-20：完成测试、工作流状态、扩展职责和 pi-usage 的职责拆分；保留 `extensions/index.ts`、`src/workflow.js`、`scripts/pi-usage.js` 公共 facade，并让安装器携带 pi-usage 支持模块。新增 500 物理行数门禁及边界测试；最终验证见 `docs/session-log.md`。
- 2026-08-20：工作流支持普通自然语言方向变更和 revision 审计；任务边界暂停旧计划，由架构师通过 `replan` 提交未完成后续的新计划，local/subtask 和 manual/confirm 边界均安全暂停。README、双语模板和项目记忆已同步。
- 2026-08-19：`workflowExecutor` 从 `subagents`（`@tintinweb/pi-subagents` RPC）切换到 `subtask`（gary149/pi-subtask 对话 fork）：主会话调用 `subtask` 工具派发、`subtask-result` 消息回传后自动推进；旧值 `subagents` 兼容映射为新执行器，不再生成 `.pi/agents/*.md` 脚手架。README、模板和文档同步更新。
- 2026-08-18：TUI 工作流状态查看改为居中 overlay 弹窗，增加主题背景、标题高亮和四边框以强化弹窗识别，并保留非 TUI 通知回退；增加对应回归测试。
- 2026-08-16：移除 fail-closed Provider 白名单，改为精确模型引用：删除 `providerPolicy` 解析、`model_select` 回滚和 `session_start`/输入/provider 请求前守卫，Agent spawn 保留“省略注入完整模型、模糊拒绝、精确存在校验”；`/pi-init config` 展示全部已注册模型；版本更新为 `1.1.0`。
- 2026-08-16：手动模式升级为直连宿主：原生 `/model` 切换不回滚并把活动角色模型直接写回 `.pi/role-models.json`；同步中英文模板、README 和决策文档；版本更新为 `1.0.8`。
- 2026-08-15：新增项目级 Provider fail-closed 锁；默认只允许 `openai-codex`，统一限制角色/工作流/恢复/模型选择和 Agent 子代理，并为旧项目缺少 `providerPolicy` 的情况提供默认策略；版本更新为 `1.0.7`。
- 2026-08-15：修复 `pi update --extensions` 的 npm lifecycle PATH 阴影：`postinstall` 查找 Pi CLI 时跳过当前包 `node_modules/.bin` 的本地 shim，避免把 `pi-usage` 复制到错误目录；版本更新为 `1.0.6`。
- 2026-08-15：完成 `pi-usage` I/O 优化：事件改用 DuckDB Appender 和事务批量写入，JSONL 改为流式 checkpoint 增量导入，未完成尾部可在后续追加后恰好导入一次；无变化时不重建 duration summary，并增加 TTY 刷新摘要。实际本机基准为首次 112 文件导入、后续 112 文件跳过且 `durationDates=[]`。
- 2026-08-15：精简任务和最终工作流报告，移除重复的文件、内部角色 ID、冻结时间及冗余分段；开始/结束时间使用系统本地时区，格式为 `YYYY-MM-DD HH:mm:ss±HH:MM`。
- 2026-08-14：`task_workflow` 最终交付改为冻结工作流整体报告；整体开始/结束时间持久化，耗时覆盖首个任务实际开始至最后任务完成，中间任务仍保持任务级报告，local 与 `subagents` 格式统一。
- 2026-08-14：中英文 `AGENTS.md` 增加 `read`/`edit` 工具参数和精确替换失败处理规则，减少参数混用及引号/空白不一致导致的编辑错误。
- 2026-08-14：工作流完成或取消后，底部状态栏不再显示终态进度，恢复显示初始的策略、执行器和无活动工作流摘要。
- 2026-08-14：任务完成报告的开始时间改为本地任务 `agent_start` 或子代理实际派发时记录，不再沿用模型会话启动或工作流调度时间；兼容旧状态并在首次实际执行时刷新旧时间戳。
- 2026-08-14：补充非工作流 Agent 执行报告；仅跟踪 `interactive`/`rpc` 输入，从首次 `agent_start` 计时到最终 `agent_settled`，使用 `pi-init-run-timing` custom entry 展示时间和耗时，并在活动工作流、隐藏续跑或中断时避免重复/伪造记录。
- 2026-08-14：修复 `task_workflow complete` 的工具结果渲染，完整保留任务摘要、开始/结束时间、总耗时和验证结果，不再只显示工作流进度。

- 2026-08-14：`pi-usage` 增加 package `postinstall` 自动安装逻辑；执行 `pi update --extensions` 后会重新复制对应平台的启动器，找不到 `pi` 或禁用 npm lifecycle scripts 时安全跳过并提示手动安装。
- 2026-08-14：修复 `pi-usage` 模型 token 柱状图的离散化问题；柱状图使用 Unicode 八分之一分数块，接近但不同的 token 数不再被统一显示为相同长度。
- 2026-08-10：`pi-usage` 基于 DuckDB 扫描 Pi JSONL session，按模型汇总调用次数、输入/输出/cache token、费用和近似使用时长；报告移除 Git changes，增加按模型总 token 缩放的柱状图，并在 Overview 显示缓存占比；缺少 DuckDB 时自动安装用户目录运行时；普通查询增加 1 小时缓存和跨自然日自动检查。
- 2026-08-13：`pi-usage` 增量导入 `pi-token-speed` 的自定义 session 采样，按 provider/model 计算 `输出 token / 有效生成秒数` 的加权平均 TPS；旧数据库升级时只回填 `speed_events`，不再重建既有用量和活动数据。
- 2026-08-14：移除自研 `parallel_develop` 及其测试、模板和文档说明，保留 `task_workflow`、`switch_role`、角色配置和脚手架能力。
- 2026-08-14：任务工作流升级为默认 `workflowMode: "auto"` 的 off/on/auto 策略；`auto` 对不超过 2 个任务跳过编排，配置入口为 `/pi-init config workflow`，并兼容旧 `workflowEnabled`。
- 2026-08-14：任务完成报告增加任务 ID、任务内容、角色、涉及文件、开始/结束时间、总耗时、完成摘要和验证结果；耗时从任务实际派发执行到完成计算，历史状态缺少开始时间时显示不可用。
- 2026-08-14：新增默认 `local`/可选 `subagents` 执行器、严格结果协议、持久化任务—代理绑定及受限的 pi-subagents 专用代理脚手架；README 记录安装前提和 reload/孤儿代理边界。
