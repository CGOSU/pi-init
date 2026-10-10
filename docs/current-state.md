## 待处理 当前状态

“最近一次更新”列表按日期倒序排列，当前状态正文只描述现状，不按时间排列。

## 项目

- 名称：`pi-init`
- 定位：用于 Pi 的项目初始化扩展，生成 `AGENTS.md`、项目记忆文档和 `.pi/role-models.json`，并随 package 发布公共职责路由 Skill。

## 当前目标

- 维护随 package 发布的公共职责路由 Skill；`.pi/role-models.json` 的 `roleModels` 保存显式模型映射并启用自定义角色，内置标准职责无映射时沿用当前 Pi 会话模型和推理强度。

## 当前已确认事实

- `/fast <任务描述>` 是用户为单次任务显式选择 Fast Path，不持久修改模型或配置，也不因自动资格中的任务类型、规模或修改范围不符而退回普通流程。安全、权限、需求/契约确认、角色职责、上下文恢复门、工作流保护与必要验证仍优先；Agent 忙碌、存在未结束的 running/paused/replanning 工作流或无法恢复的已保存工作流时拒绝派发，终态工作流不阻止独立任务。行为详见 [README.md](../README.md) 和 [公共角色路由 Skill](../skills/pi-init-role-routing/SKILL.md)。
- 项目脚手架生成的中英文 `AGENTS.md` 包含带标记的 Fast Path 收尾约束；`/pi-init sync [目录]` 只更新托管区块、创建缺失的项目记忆文档并保留已有记录，冲突时不写入。控制中心各级角色配置菜单统一支持 `Ctrl+S` 和 `F2` 保存（Windows 终端可能拦截 `Ctrl+S`），保存中、成功或失败会在当前菜单内即时反馈；上一级菜单保存完成后也会更新全局通知，避免残留的“尚未保存”提示；显式保存列表项已移除，非 TUI 和兼容场景保留 `/pi-init save`。TUI session 启动时，若当前模型匹配已配置角色，会显示一条包含角色和精确 provider/model 的就绪通知；非 TUI 和未匹配角色不提示。具体取舍见 [`docs/decisions.md`](decisions.md)。

- Local 工作流的 `complete`/`block` 到达时若交接仍为 `queued`，仅在完整 handoff 身份匹配、活动 session branch 含精确交接消息且当前角色匹配任务角色时，先持久化补记 `executing` 再进行严格验收；身份、branch 或角色不符仍 fail-closed，未知结果仍须显式核对和 retry。身份校验失败以模型可见 JSON 给出 code、差异字段、白名单 expected/received 与下一步；`status`、任务提示和重规划提示展示通过共享构造器生成的可复制 JSON 身份，`status` 保持只读。`task_workflow` TUI 将这些失败诊断按类别、代码、原因、白名单身份差异和下一步分段显示；普通错误与无法解析的诊断仍保留原始错误内容，不改变模型错误 JSON 或失败守卫。该路径不改变恢复时 queued 结果未知的策略，也不确认原始 stale identity 故障的字段根因。
- 控制中心同步当前项目发生实际变更并执行 `ctx.reload()` 后立即结束旧控制中心调用；同步结果通过 `reloaded` 标记向调用方表达，避免 reload 后继续使用失效的旧 `ctx`。无变更或有冲突时不 reload，菜单仍可继续。具体决策与验证见 [`docs/decisions.md`](decisions.md) 和 [`docs/session-log.md`](session-log.md)。
- pi-init 工作流固定为当前主会话内 local 顺序执行；缺省 executor 与旧 `workflowExecutor: "local"` 配置仍可读，执行器不再是控制中心或 schema 选项。`subagents`、`subtask`、`collaboration` 等未知值明确拒绝。当前状态持久化在 `pi.appendEntry` 正常返回后才更新内存状态；append 异常保留旧状态并停止本次调度。`architect` 不得作为执行任务角色，plan/replan 校验拒绝该角色；旧活动计划含 architect 执行任务时不持久化自动修复或派发，仅保留恢复错误供检查；用户显式取消后可另建计划。后续交接身份与恢复边界见 [`docs/plans/durable-workflow.md`](plans/durable-workflow.md)。
- 工作流暂停通知和 block 工具结果使用分区摘要，突出真实原因及恢复建议；纯文本与 TUI 从同一类型化暂停视图独立渲染，不解析已格式化文案。暂停结果不以成功标记呈现，展开后显示完整任务与身份技术状态。未知结果仍须先核对外部副作用，再显式确认 retry；block 工具不另发重复通知。
- 工作流工具 `AbortSignal` 只中止当前工具操作；业务取消需显式持久化 `cancelled`，只有持久化成功才退休所属续跑，且不等同于宿主压缩终止。`acknowledge` 是当前来源匹配告警的易失展示确认，不改变状态/守卫，身份变化、branch 切换及 reload 会重新提醒。`discard-recovery` 仅对明确不可恢复且无可读/待持久化状态的原记录，在可信项目、Agent 空闲、当前 branch 唯一且最新的原 entry ID、session/branch/error 精确匹配并确认未知副作用后，追加版本化引用处置；它不构成任务成功或取消。安全边界见 [`docs/decisions.md`](decisions.md)，用户用法见 [`README.md`](../README.md)。
- 状态、任务完成、最终完成、普通执行计时和操作错误采用各自的只读视图及纯文本/TUI renderer。状态视图服务状态文本、状态栏、进度面板和非暂停工具结果；任务完成只报告当前任务，最终报告使用明确的最终任务并只列明确失败的验证，计时缺失保留不可用语义。`workflowPresentation` 仅附加到瞬时工具结果 `details`，旧结果缺少判别信息时回退原文，不进入 `WorkflowState`/session entry；模型错误 JSON 与 `isError` 保持原契约。详情与取舍见 [`README.md`](../README.md) 和 [`docs/decisions.md`](decisions.md)。
- 旧配置顶层 `runtime` 字段返回 `RUNTIME_CONFIG_RETIRED`，`workflowExecutor: "runtime"` 返回 `WORKFLOW_EXECUTOR_RETIRED`；旧 Runtime executor/authority 或残留 payload 的持久状态返回 `WORKFLOW_STATE_RUNTIME_RETIRED`。状态和动作保留恢复错误，不会静默转为 local、不自动重放/迁移，也不改写或删除原始 session entry；旧配置需由用户检查并手动清理。
- 当前不包含自建外部 Runtime backend，也未接入或核实任何官方 Runtime 接口。历史双轨实现与旧验证记录仅作为历史保留，见 [`docs/decisions.md`](decisions.md) 的退役决策及 [`docs/plans/runtime-migration.md`](plans/runtime-migration.md) 的历史标记。

## 已知状态


- 提供统一的 `/pi-init` 控制中心和 `init_project` 模型工具；控制中心包含快速初始化、高级初始化、职责与模型配置、职责切换和会话模式切换。控制中心和脚手架运行时已改为扩展实例内 Promise 缓存的按需加载，工作流恢复从 session branch 末尾直接查找最新状态。
- `pi-usage` 的 session 导入已使用 DuckDB Appender、每文件事务和 1024 行有界 flush；JSONL 使用流式读取并在 `session_files` 保存 offset、行号、cwd、尾部校验和不完整尾部状态。追加内容只读取新增字节，截断、改写或校验失败回退全量重建；duration summary 只刷新受影响日期。schema v3 使用稳定 entry key（Pi id 或 legacy 哈希）跨 fork 文件去重 usage、speed、activity 和 session；schema 不一致时事务化清理并全量重建所有派生表与 checkpoint。
- TTY 下 `pi-usage --update` 以及首次/过期自动刷新会显示扫描统计，重算日期取 session 文件最新修改时间并精确到分钟，另列受影响日期；非 TTY 只输出原有报表。当前本机 112 个 session、约 215,607,665 字节的首次导入统计为 112 个重建文件，实际约 2.3 秒；后续无变化刷新约 65 ms，跳过 112 个文件且不重算日期。
- 默认生成 `AGENTS.md`、`docs/clean-code.md`、四个项目记忆文档和 `.pi/role-models.json`；`AGENTS.md` 引用随 package 发布的 `pi-init-role-routing` Skill，并要求任务开始前先读取 Clean Code 规则。新项目不生成 `.pi/skills/<slug>/SKILL.md`，已有项目级或用户自定义 Skill 不会被自动删除。
- package 发布 `skills/pi-init-role-routing/SKILL.md` 及 `roles/architect.md`、`roles/developer-test.md`、`roles/docs-commit.md`；公共 Skill 集中维护风险分级路由、自主决策边界和共享硬约束，角色说明只保留各自职责/边界/交接，运行时提示只保留当前任务硬约束，不嵌入具体模型值。`architect` 只负责思考、分析、决策、规划和安排；所有仓库、代码、测试、文档和外部事实取证由 `docs-commit` 结构化交接，architect 仅允许 `switch_role` 与 `task_workflow` 的 `plan`/`replan`/`status`，其他工具及 MCP 均由运行时 fail-closed 阻断。目标明确的低风险任务由适合的非 architect 角色调查、实现和验证；复杂/高风险任务仍要求新鲜结构化证据、角色边界、真实验证和授权。
- Git 收尾规则：任务完成并通过适用检查后，默认创建中文 commit，仅纳入明确归属于当前任务的改动；发现无法安全区分的既有/暂存改动时暂停并说明。push 仍须用户明确授权；协作子 Agent/worker 不自行提交或推送，由主控任务收尾。
- 测试和断言遵循全局 Test Value Gate：默认不锁定纯文案、样式、布局、渲染结构、简单存在性和内部临时字段，优先保留权限安全、公共数据、状态流转、持久化、幂等、并发和历史缺陷回归；生成模板关键规则、工具元数据和状态语义仍按稳定契约保留。最近一次完整验证为 `npm test`（执行 `node --test`）247 项通过、0 项失败、0 项跳过；`npm run typecheck` 通过。真实 Pi TUI/E2E、真实 Provider 请求和历史长驻 Pi 实例尚未验证，详见 [`docs/session-log.md`](session-log.md)。
- 公共 Skill 在架构师、开发测试工程师、文档与收尾工程师之间选择最少角色；明确对应某个职责的指令直接从对应角色开始，不明确归类、含糊或跨职责的指令默认从 `architect` 开始；简单只读咨询和低风险开发由适合的非 architect 角色直接完成，凡需仓库、代码、测试、文档或外部事实取证均由 `docs-commit` 收集并交接包含事实、来源、相关符号、调用关系、测试、工作区状态、风险和未确认项的结构化证据包。`architect` 只负责思考、分析、决策、规划和安排，不修改文件、不执行命令、不连接 MCP，除 `switch_role` 与 `task_workflow` 的 `plan`/`replan`/`status` 外不调用工具。开发测试工程师负责自主实现/验证且不写项目 Markdown，文档与收尾工程师不写代码；仅遇到业务/契约冲突、权限/凭据、不可逆或外部状态、已有改动无法安全合并或真实验证阻塞时才暂停。
- `switch_role` 工具和 `/pi-init role` 读取项目默认配置及当前会话暂存覆盖，按 `auto`、`confirm` 或 `manual` 模式切换职责；`/pi-init mode` 和 `/pi-init config` 的运行时变更只影响当前会话，执行 `/pi-init save` 才持久化职责配置。`manual` 模式下原生 `/model` 切换不会被扩展回滚；只有活动角色已有显式映射且项目受信任时才写回该映射。使用会话默认模型的标准职责不会生成固定映射；内部 `/pi-init role` 触发的 `model_select` 不会写回旧角色，无活动角色或非受信任项目只提示不写。外部/普通 `session_compact`、reload/resume/fork/startup 恢复会写入 `pi-init-role-recovery` pending；当前角色自动交接的压缩由专属回调处理。操作绑定 operation、目标角色、session/branch 上下文代次及工作流身份，只有当前操作回调能确认；失败不自动触发任务回合，过期回调不续跑。branch 实际变化使旧 acknowledged 和内存角色确认失效，必须基于当前职责重新确认；manual 模式不能验证当前角色时指引用户执行 `/pi-init role <role>`。new 或空会话不额外上锁。
- `before_agent_start` 通过 `sections.pi_init_runtime` 注入当前有效角色、Provider/模型/推理强度、恢复门和活动工作流摘要；职责已确认且无活动工作流时，简单无工具问答不调用 `task_workflow(status)` 或重复 `switch_role`。恢复 pending 且无活动工作流时允许无需工具或新证据的简单回答，但不自动解除恢复门；需要执行时仍先切换职责。该快速通道不做文本启发式分类、不自动切模型、不削弱 `tool_call` 守卫。
- 自动模式在真实跨角色且上下文使用率达到 50% 时，于 agent 完全 settled 后触发一次定制上下文压缩；同角色连续 Local 任务不再触发 50% 的主动边界压缩，依赖 Pi 原生自动压缩。主动压缩通过 operationId 和 onComplete、onError、session_compact 收敛路径幂等交接；30 秒 watchdog 只发一次长等待软提醒，状态仍为 compacting/in-flight，不判失败、不解锁或自动重派发；仅有效真实开始时间用于显示耗时，真实失败由 `onError` 表达。session shutdown/reload 会清理 watchdog 和瞬态锁。
- Local 工作流状态栏和进度摘要以匹配当前任务/handoff 的真实启动时间作为执行门槛，区分任务交接、等待启动、上下文压缩（软提醒时仍为 compacting）和任务执行中；位置按真实 `tasks` 列表中 `currentTaskId` 的一基索引计算，completed/total 单独表示实际完成数，暂停、重规划、无当前任务和终态不携带旧位置；`/pi-init workflow resume` 仅在没有真实执行、排队续跑或主动压缩时安全重新调度，不会重复已启动任务。
- 已增加架构驱动的 `task_workflow` 顺序任务编排：项目级 `workflowMode` 默认是 `auto`，`off` 拒绝新规划，`on` 始终编排，`auto` 对不超过 2 个任务的规划跳过状态持久化、调度和角色切换，并要求各任务指定角色切换后直接顺序执行；架构角色只规划、不实现。工作流状态 schema v4 通过 Pi Extension `appendEntry` 写入当前 session 并从活动 branch 恢复，记录 workflow/plan/session/recovery generation、task attempt/handoff 与 continuation 身份；这不是 AgentHarness durable operation 集成，不提供事务/fsync 或外部副作用 exactly-once 保证。`complete`/`block`/`replan` 校验当前身份与 branch 消息，旧 attempt、revision、session 或 branch 结果不能推进状态。尚未派发的准备阶段可恢复续接；已经派发或启动、却没有业务验收结果时暂停为结果未知，必须核对后显式 `/pi-init workflow retry <taskId> --confirm-unknown-outcome` 创建新 attempt。缺少身份的 legacy `in_progress` 同样需核对；旧 session entry 不原地改写，已退役 Runtime 状态仍 fail-closed。旧项目缺失 `workflowMode` 时兼容 `workflowEnabled: true/false` 为 `on/off`。中间任务报告只显示当前任务的摘要、实现原因、耗时和明确失败的验证；最终报告只显示最终任务结果与整体进度/耗时，并同样只显示明确失败的最终验证，不重复前序任务。完整 verification 仍持久化，没有失败项时省略验证行。开始/结束时间使用系统本地时区，格式为 `YYYY-MM-DD HH:mm:ss±HH:MM`。
- `task_workflow` 的 `plan`/`replan` 在工具调用入口即要求活动角色为 `architect`，非架构角色会在状态持久化前被阻断；调用摘要标记为“工作流请求”，失败结果保留具体原因，避免把调用预览误认为已创建工作流。
- 任务规划排序采用软约束：先遵守用户明确的优先级、截止要求和硬依赖，再安排可能推翻方案的关键未知项的限时最小验证，其次考虑业务关键路径；只有同层且风险、价值相近时才先易后难。不新增 difficulty/risk 字段，也不自动改写用户提供的 task_workflow 输入顺序。低风险局部工作仍可在 `workflowMode: auto` 下绕过持久工作流，不改变既有任务数量阈值、配置或状态机。
- 内置标准角色不再绑定固定 provider/model/thinkingLevel。缺少配置文件或没有任何显式角色映射（包括 `schemaVersion: 2` 缺少 `roleModels`/映射为空且没有兼容的旧版顶层映射）时，标准职责沿用当前 Pi 会话模型和推理强度；部分映射只覆盖显式配置项，未知自定义角色仍需显式配置。无会话模型、损坏 JSON、未知 schema、无效映射、显式模型不可用或缺少凭据均保持真实错误，不静默 fallback；无映射标准职责在手动模式切换模型时也不会生成固定映射。保存配置使用 `schemaVersion: 2`，并保存默认 `workflowMode: "auto"` 和 `workflowExecutor: "local"`。旧版顶层角色字段仅自动读取兼容，显式 `/pi-init save` 时才规范化；旧项目生成的角色 Skill 需人工确认后删除。回退后的旧实现不会自动迁移此前保存的 `schemaVersion: 3` 分层配置，使用前须由用户单独转换为扁平 `roleModels` 格式。
- 支持简体中文、英文、dry-run 和已有文件覆盖确认。
- 初始化会在中英文 `AGENTS.md` 中记录当前 Pi 宿主系统、CPU 架构和平台相关命令约定；目标环境若不同，需以实际运行环境为准。通用任务执行流程、证据门控、`read`/`edit` 参数、角色交接和真实验证规则由 package 公共 Skill 维护，生成的 `AGENTS.md` 只保留项目特有规则并引用该 Skill。
- 精确文件修改支持会话内逻辑快照：成功 `edit` 且没有其他写入来源时可复用确定的替换结果；每次调用 `edit` 前必须预检每个 `oldText` 并确认精确匹配 1 次、payload 只含 `path` 和 `edits` 且 edits 不重叠，出现 0 次或多次时不得调用；可能发生写入后必须重新读取。`oldText` 零匹配时只允许定向重读、重新确认唯一精确替换并最多重试一次；不生成缓存文件或持久状态。
- `edit` 运行时守卫包装 Pi 内置 definition：合法调用保留原生 schema、提示元数据、renderer、严格匹配、重叠检测和文件变更队列；read-shaped/malformed、重复匹配和重叠调用 fail-closed，不写文件并返回可恢复诊断，未知错误透传。提示预检只降低错误率，不能保证模型永不产生非法调用。
- 初始化提供快速和高级两条路径；快速路径从 `package.json`、包管理器锁文件和目录名推断项目元数据，只需一次确认，并在当前项目完成后自动 reload。高级路径仍可编辑项目名称、语言、描述、测试命令和职责模型，不再询问 Skill 名称或 slug；TUI 中按 Esc 会返回上一个填写属性并保留已填写内容，最终确认返回角色模型步骤。高级初始化首项从控制中心返回控制中心，直接 `/pi-init advanced` 返回调用方；Ctrl+C、显式“取消”和快速/非 TUI 路径仍保持取消或原有行为。
- 控制中心现在显示模式、角色、模型和工作流策略/状态卡片，根菜单按“初始化/变更/同步/工作流”四个顶层分组；初始化和变更分别进入次级菜单，工作流策略位于变更入口，主 `pi-init` 状态项也持续显示策略和活动工作流进度，前置指示点在 Agent 运行时使用主题 accent 高亮、空闲时使用 muted 灰色；工作流完成或取消后，底部状态恢复为策略、执行器和无活动工作流摘要。标题下有间距、内容统一左右留出 2 格 padding，状态卡片文字与背景之间另有 1 格内边距；首次进入提供简短引导，TUI 菜单和初始化文本输入中按 Esc 返回上一级而非触发取消，初始化通知默认只显示文件数量和冲突摘要；TUI 菜单使用宽弹窗，选中项说明独立显示并自动换行，包含保存项的 TUI 菜单支持 `Ctrl+S` 直接保存。
- 非工作流的 `interactive`/`rpc` 外部输入从首次 `agent_start` 计时到最终 `agent_settled`，完成后写入不进入 LLM 上下文的 `pi-init-run-timing` custom entry，普通执行的每轮时长报告与工作流完成报告分开；详细阶段诊断当前关闭。TUI 工作时保留 Pi 原生 `Working`，空闲后的累计 session 工作时间显示在统一 pi-init 活动区，不再使用独立 `Worked for` widget；累计值只计 Agent 实际工作时间、不计闲置。session 恢复时优先从每轮完成后保存的独立累计快照恢复，并兼容只有普通执行记录的旧 session；活动工作流、扩展隐藏续跑和未完成/中断执行不补造普通报告。
- 唯一的 `pi-init-activity` 活动出口将职责、工作流、压缩、公开 Provider 请求/delta 阶段、公开工具类别、缓存 usage 和累计工作时间仲裁为宽度感知的一行。TUI 使用编辑器下方单一 widget，RPC 使用同源简明 status；Pi 原生 footer、working indicator、OSC 7501 不变，JSON/print 不依赖 UI。异常优先，窄宽度先裁辅助信息；完整工作流原因和恢复步骤保留在现有详情视图。工具参数、命令、路径、URL、结果及 MCP/codemode 内部过程不显示或推断。缓存正数按最终 `message_end` usage 显示；请求期间若保留历史最终结果会标为“上次”，只有匹配的最终 assistant `message_end` 是“本次”。旧成功不覆盖本次缺失、无效、来源未确认零值、失败、中止或缺结束事件；规范化零值不声称 Provider 明确报告，也不推断命中率或磁盘/网络 I/O。Pi AI Usage 将缺失缓存计数归一化为零的可复发陷阱见 [`docs/pitfalls.md`](pitfalls.md)。
- TUI 中“工作流 · 查看任务进度”以及 `/pi-init workflow status` 现在打开居中 overlay 弹窗，使用主题背景色、标题高亮和四边框明确区分弹窗，显示状态、已完成数量、独立的一基当前项位置、总任务开始时间、总任务已运行时间、执行器、规划、暂停原因和可滚动任务列表；活动弹窗的摘要每秒刷新，避免后台状态变化时显示旧快照；已完成任务的耗时移到任务描述列，避免挤压任务标题，并在窄面板保持可见；RPC 等非 TUI 模式的状态文本也显示总任务开始时间、总任务已运行时间和已完成任务耗时；状态查询的完成态通过状态视图展示进度并可展开技术详情；`complete` 动作则通过独立的最终完成报告展示明确的最终任务、整体进度和耗时。
- 模型选择在 TUI 中使用带即时筛选的搜索列表，显示模型名称和支持的推理级别，并使用友好的角色和模式名称；Pi 原生 `/model` 与 `Shift+Tab` 仍是会话级临时切换。
- 检查命令为 `npm run typecheck` 与 `npm test`：TypeScript 检查仅覆盖 `extensions/**/*.ts` 和 `src/**/*.ts`（strict/noEmit/NodeNext，`allowJs: false`）；`scripts/` 与 `test/` 保留 JavaScript，未被该 typecheck 检查。`npm test` 运行 Node 原生测试，不以行数硬门禁失败；Pi 中使用 `/large` 手动重扫并报告当前项目超过 500 行的代码文件，不再提供 `npm run check:large-files`。扫描支持 `.js`、`.mjs`、`.cjs`、`.ts`、`.mts`、`.cts`、`.tsx`、`.jsx`、Rust `.rs`、Go `.go`、Python `.py`/`.pyi`、PHP `.php`/`.phtml`；扫描不完整会显示错误及结果可能不完整，不会把结果记为审阅结论。Pi 扩展还在会话启动建立扫描基线，并在公开文件工具结果和 agent settle 后补扫；审阅候选按项目、路径、内容指纹和策略版本跟踪并随当前 session branch 恢复，内容变化后重新待审；`file_review` 仅在 Pi `read` 完整覆盖当前版本且提交有理由的保留/拆分结论后登记完成，不自动修改代码，扫描或持久化失败不清除待审状态。包版本为 `2.0.4`；`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` peer 范围均为 `^1.1.0`，本地 lockfile 安装版本均为 `1.1.0`；Node 最低声明版本为 `22.19.0`。本轮定向测试 25 项通过，`npm run typecheck` 通过；未运行全量测试，`git diff --check` 通过（Git 有 LF/CRLF 转换提示）。最低 Node 版本与真实 Pi TUI/E2E 未验证；先前长驻 Pi 实例导出缺失的根因仍未知，见 [`docs/pitfalls.md`](pitfalls.md)。
- 提供跨平台 `scripts/pi-usage.*` 用量统计命令；Windows PowerShell 安装器会把所需文件复制到 Pi 所在的 npm 可执行目录，POSIX 安装器优先使用 Pi 可执行目录、无写权限时回退到用户 bin 目录。`pi-usage` 普通查询在首次查询、距离上次检查超过 1 小时或跨自然日时自动执行增量检查，其余时间直接读取 DuckDB；`--update` 始终强制检查。日期参数支持 `yesterday`、`Nd`、`YYYY-MM`、单日和两个 `YYYY-MM-DD` 组成的闭区间，跨日统计按日期范围聚合并对 session 去重；TTY 刷新摘要中的重算日期取 session 文件最新修改时间并精确到分钟，同时显示受影响日期。报告标题会显示与 `pi-init` 共用的 package 版本号，启动器安装时从 `package.json` 嵌入该版本；报表还显示 DuckDB 缓存最近更新时间（`YYYY-MM-DD HH:mm`）。`postinstall` 查找 Pi 时会跳过当前 npm 包 `node_modules/.bin` 中的本地 `pi` shim，避免 `pi update --extensions` 把启动器复制到随后会被清理的依赖目录。角色模型和工作流配置变更默认只存在当前会话，执行 `/pi-init save` 才写入 `.pi/role-models.json`。Models 表还可导入 `pi-token-speed` 扩展写入的有效生成时长，按模型展示加权平均 TPS；扩展在 `message_end` 生命周期记录样本，避免等待 `agent_end` 或重复记录。Models 表按模型显示缓存命中率，合计行按总量计算，沿用 `(cacheRead + cacheWrite) / tokens` 口径。`--output <路径>` 会将同一份查询 summary 输出为纵向 SVG 对账单，时间范围继续复用普通查询参数；每个模型显示自身总 Token 和缓存命中率，费用及总览统计保持原样；这些用量均为真实统计值，SVG 仅为可分享的估算凭证，不是实际账单。

## 待处理

- `extensions/index.ts` 当前内容版本已通过 `file_review` 完成结构审阅并建议保留；`test/pi-usage.test.js` 仍是待审候选。Pi 扩展运行时的队列状态尚未通过 reload 核实。
- Linux、macOS 的 CI 矩阵已加入但尚未在本地执行；第三方 `agent-browser` 工具在 Windows 上仍需上游修复 CLI 检测和 `.cmd` 启动兼容性，本项目只能通过 `AGENTS.md` 降低误安装和误用。

## 最近一次更新

- 2026-10-10：移除 `npm run check:large-files`，新增 Pi `/large` 手动重扫命令，支持既有跨语言文件扫描；同步 README、当前状态和决策。定向测试 25 项通过，`npm run typecheck` 和 `git diff --check` 通过；未运行全量 `npm test` 或真实 Pi TUI/E2E。详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-09：大文件结构审阅新增 Rust `.rs`、Go `.go`、Python `.py`/`.pyi`、PHP `.php`/`.phtml` 支持，并排除 `target`、`vendor`、Python 虚拟环境/缓存目录；既有阈值、状态和审阅行为不变。`npm test` 258 项通过，typecheck 通过；手动扫描以 0 退出，当前报告 3 个原始超限候选。详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-09：在原范围本地里程碑之后，完成可信工作流阶段/当前项位置、本次与上次 Provider cache 来源、30 秒压缩长等待软提醒；后续源码/测试与文档收尾状态见 [`docs/session-log.md`](session-log.md)。
- 2026-10-09：完成工作流终态收尾、不可恢复历史的显式隔离和会话内告警确认闭环。终态写入失败保持旧状态，AbortSignal 不等于工作流取消，历史隔离不伪造业务成功，告警确认不改变详细诊断或守卫。最终 `npm test` 247 项通过、`npm run typecheck` 通过；未验证真实 Pi TUI/E2E、真实 Provider 请求或历史长驻实例。实现与验证详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-09：将 500 物理行从行数硬门禁改为 Pi 运行时结构审阅阈值。会话启动建立基线，文件工具结果与 Agent 回合边界补扫；审阅状态绑定内容指纹并随 session branch 恢复，确认前要求完整读取和有理由的结论，不自动修改。`npm test` 228 项、typecheck 均通过；手动扫描报告 `extensions/index.ts`（505 行）和 `test/pi-usage.test.js`（509 行）为审阅候选，不因超限失败。详细实现和验证见 [`docs/session-log.md`](session-log.md)。
- 2026-10-09：完成统一活动区、公开工具/Provider 活动及缓存 usage 结构化状态，并将三个 Pi peer 范围更新为 `^1.1.0`。cache 全零保留来源未确认语义；缺失、无效、失败、中止与缺少结束事件不冒充成功或无数据。最终 `node --test` 214 项通过，`npm run typecheck` 和 `git diff --check` 通过；`npm test` 仍被既有 509 行测试文件门禁阻断。真实 Pi TUI/E2E 未验证。详细实现和验证见 [`docs/session-log.md`](session-log.md)。
- 2026-10-09：工作流状态、任务/最终完成、普通执行计时和操作错误均已迁移为语义独立的类型化视图与纯文本/TUI renderer；展示元数据仅存在瞬时工具结果，持久化状态和模型错误协议未变。最终 `node --test` 196 项通过、`npm run typecheck` 与 `git diff --check` 通过；`npm test` 未运行，既有 `test/pi-usage.test.js` 509 行门禁不在本轮处理范围。详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-09：工作流暂停展示改为类型化视图模型与独立纯文本/TUI renderer；恢复动作使用结构化步骤表达，移除 TUI 从格式化中文内容推断结构的逻辑。未知结果仍要求先核对外部副作用，再显式确认 retry。暂停视图/报告与错误渲染定向测试 7 项通过，`npm run typecheck` 与 `git diff --check` 通过；详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-09：将工作流动作失败的 TUI 展示分段并分类，保留模型 JSON、原始错误与安全建议；包版本更新至 `2.0.4`。`npm run typecheck` 通过，针对性测试 12 项通过，完整 `node --test` 177 项通过；`npm test` 在既有 `test/pi-usage.test.js` 509 行门禁处停止（该文件来自 HEAD `8a4129f`，未修改），详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-08：完成 `src` 11 个 JavaScript 实现到 TypeScript 的迁移，并同步直接调用方；新增共享类型模块，关闭 `allowJs`，保留 scripts/tests 为 JavaScript，无构建产物或运行器。`npm run typecheck` 通过，`npm test` 176 项通过；Node 22.19.0 最低版本未实测，Pi 长驻进程故障根因未确认，详见 [`docs/session-log.md`](session-log.md) 与 [`docs/pitfalls.md`](pitfalls.md)。
- 2026-10-08：关闭架构执行任务死锁、过期压缩续跑和 branch 职责确认漏洞：禁止 architect 作为计划/重规划的执行角色，旧活动计划不自动改写或派发；压缩回调绑定 operation、角色代次、session/branch 上下文及当前 workflow/replan 身份，失败不自动唤起新回合；branch 改变后重新建立职责恢复门，manual 模式提示使用 `/pi-init role`。`npm test` 173 项通过、0 失败、0 跳过，`git diff --check` 通过；未执行真实 Pi E2E、安装/reload，未重放旧故障或提交/推送。
- 2026-10-08：修复工作流 queued 结果验收闭环并补齐身份诊断：`complete`/`block` 仅对匹配身份、角色和活动 branch 的 queued handoff 补记开始；身份失败以 JSON 返回字段差异和安全建议；status 与任务/replan 提示提供共享构造的可复制身份。`npm test` 165 项全部通过；真实 Pi E2E、安装/reload 与原 stale identity 故障现场核对未执行，字段根因仍未知。
- 2026-10-08：完成可恢复任务交接与执行尝试隔离：工作流身份绑定当前 session、plan、recovery generation、task attempt/handoff 与 replan revision；恢复仅续接可证明尚未派发的准备阶段，对已派发/启动但无业务验收结果的任务 fail-closed 暂停，并要求人工核对后显式 retry。定向测试 45 项通过；最终 `npm test`（含 500 行检查）162 项全部通过、0 失败、0 跳过。代码分阶段提交为 `bb46a7a` 和 `85bb460`。Pi Extension session append 与 AgentHarness durable operation 的区别、实现约束及验证边界见 [`docs/plans/durable-workflow.md`](plans/durable-workflow.md)；未运行真实 Pi E2E、安装/reload 或依赖升级。
- 2026-10-08：编排可靠性优化第一阶段已修复 session entry 写入失败时的内存状态提前推进和调度锁残留；故障注入与工作流相关测试 16 项通过。
- 2026-10-06：移除 pi-init 自建外部 Runtime workflow executor、客户端、配置、wire、Graph/事件投影和运行时接线；保留 local 顺序工作流。旧 Runtime 配置和 session entry 明确 fail-closed，不静默 fallback 或改写原数据；`npm test` 152 项全部通过，500 行检查及 `git diff --check` 通过。未接入官方接口或执行真实 Pi E2E、安装与 reload，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-06：`/fast` 改为用户显式单次选择精简流程，不再按自动任务类型、规模和修改范围复核资格；安全、职责、工作流保护和必要验证仍优先。扩展生命周期与中英文脚手架定向测试 25 项通过；未运行全量测试，尚未在真实 Pi 会话确认模型遵循效果。
- 2026-10-06：移除内置标准角色模型预设，允许 schema v2 缺少 `roleModels` 时沿用会话模型，并精简暂停报告；`npm test` 为 167 项（164 通过、3 项因 Runtime daemon 环境缺失跳过），详见 [`docs/session-log.md`](session-log.md)。未执行 package 安装或真实 Pi reload/E2E。
- 2026-09-30：新增 `/fast <任务描述>` 一次性 Fast Path 请求命令；非强制、不持久更改配置，拒绝忙碌 Agent 与未结束工作流；扩展生命周期定向测试和 `npm test` 均通过（155 项通过、3 项因 runtime-daemon 未构建而跳过）。
- 2026-09-30：按用户确认撤销角色模型 v3 分层改造，恢复扁平 `roleModels` / `schemaVersion: 2` 配置；此前保存的 v3 配置不自动迁移。针对性测试 52 项通过；`npm test` 154 项通过、0 项失败、3 项跳过。
- 2026-09-24：修复角色配置变更后在上一级菜单按 `Ctrl+S` 保存时，旧“尚未保存”全局提示仍显示的问题；成功或失败都会发布保存结果通知。`npm test` 152 项通过、3 项跳过。
- 2026-09-23：TUI session 启动时新增当前匹配角色及精确 provider/model 的单条就绪通知；非 TUI 或未匹配角色时静默，相关测试 14 项通过。
- 2026-09-23：控制中心和角色模型配置菜单在 `Ctrl+S` 后即时显示保存进度及成功/失败结果；`/pi-init save` 保留命令通知，`npm test` 146 项通过、3 项跳过。
- 2026-09-22：`pi-usage` 支持通过 `--output <路径>` 将查询结果输出为参照示例样式的中文纵向 SVG；输出复用 `yesterday`、`Nd`、`YYYY-MM`、单日和闭区间查询时间参数；新增费用汇总、动态文本 XML 转义、空数据和 CLI 参数测试；`npm test` 144 项通过、3 项跳过。
- 2026-09-21：按 Test Value Gate 清理低收益测试和断言，移除纯展示/样式/Prompt/布局断言及重复内部字段检查；保留数据、状态、安全和持久化验证；`npm test` 141 项通过、3 项跳过。
- 2026-09-20：关闭详细阶段耗时监控，仅保留普通执行总耗时和 `Worked for` 所需的基础计时；`npm test` 156 项通过、3 项跳过。
- 2026-09-20：增加基于运行状态的简单问答快速通道；`before_agent_start` 注入职责/工作流 section，无活动工作流时不再为确认空状态调用 `task_workflow(status)`，恢复 pending 的无工具简单回答不解除恢复门；`npm test` 155 项通过、3 项跳过。
- 2026-09-20：扩展普通外部执行阶段诊断，增加 `message_end`、`agent_end`、Provider 请求次数/逐次耗时、工具执行次数/名称/逐次耗时和 Agent run 次数，进一步区分模型生成、Provider 往返、工具调用、重试和 settled 收尾；`npm test` 156 项通过、3 项跳过。
- 2026-09-20：从 npm registry 确认 `@earendil-works/pi-coding-agent` 最新版为 `0.86.0`；`@earendil-works/pi-ai`、`@earendil-works/pi-tui` 和 `typebox` peer 范围同步到 Pi 0.86 兼容线，Node 最低版本同步为 `22.19.0`，依赖锁定并完成 `npm test`（153 项通过、3 项跳过）。
- 2026-09-18：修复 Local executor 任务交接假死：同角色任务跳过主动边界压缩，压缩生命周期改为幂等收敛并增加只告警 watchdog；状态展示改用 `executionStartedAt` 区分交接和真实执行，running 工作流支持安全 resume，`npm test` 156 项通过。
- 2026-09-17：修复控制中心首次同步 reload 后继续使用旧 `ctx` 的问题；同步结果显式返回 `reloaded`，当前项目变更后退出旧菜单，`npm test` 149 项通过。
- 2026-09-15：`Worked for` 改为当前 session 的累计 Agent 工作时间；工作中清除该提示并显示 Pi 原生 `Working`，空闲后在编辑器上方显示累计时长，每次 `agent_settled` 持久化累计快照，普通工作报告仍保留每轮耗时，`npm test` 149 项通过。
- 2026-09-15：控制中心根菜单提升为“初始化/变更/同步/工作流”四个顶层分组；初始化和变更保留逐级返回，TUI 菜单改用宽弹窗并将选中项说明独立换行显示，`npm test` 144 项通过。
- 2026-09-14：TUI 控制中心及“角色与模型”菜单新增 `Ctrl+S` 保存快捷键，并补充针对性回归测试。
- 2026-09-14：按用户反馈移除 subagents、subtask、collaboration 三条委派执行链路及其专用扩展、协议、Agent registry/overlay/reservation、进程启动和测试；当前仅保留 local/runtime，`npm test` 132 项通过。历史记录仍保留在本文件后部，不再作为当前可用能力。
- 2026-09-13：Runtime backend 继续保持 provider-agnostic：agent-runtime 的第二真实 Provider（Codex）因生命周期/结果/恢复接口未核实而 blocked，pi-init Runtime client 不猜测 CLI 参数、不读取模型凭据、不增加本地 fallback；Rust 侧仅有无模型 command fixture，双轨迁移清单仍为 `cutover-ready: 否`。
- 2026-09-13：修复非架构角色触发工作流规划的误导反馈：`plan`/`replan` 在工具调用入口提前阻断，调用摘要改为“工作流请求”，失败结果显示具体原因；验证明细见 [`docs/session-log.md`](session-log.md)。
- 2026-09-12：`task_workflow` 工具结果的完成态改为仅显示“工作流已完成”，不再显示任务分数；针对性测试见 [`docs/session-log.md`](session-log.md)。
- 2026-09-12：`pi-usage --update` 现在跳过 session 目录下的 SoL-Pi 内部归档 JSONL，避免重复活动事件触发 DuckDB 主键事务失败；实现与验证见 [`docs/session-log.md`](session-log.md)。
- 2026-09-12：完成 architect 职责边界调整及验证收尾；当前事实见本节，决策与实现验证分别见 [`docs/decisions.md`](decisions.md) 和 [`docs/session-log.md`](session-log.md)。
- 2026-09-13：完成 Runtime backend 双轨联调与切换清单：实际 runtime-daemon development fixture 覆盖同计划 local/runtime authority、Pi role execution、result/event ack、cancel/retry、context compaction、terminal daemon restart、client reconnect 和重复 request；worker reconnect 复用 agent-runtime 的实际 worker fixture，真实 Pi 仍需显式 gate。旧调度符号逐项清单见 `docs/plans/runtime-migration.md`，cutover-ready 仍为否；`npm test` 被既有 `test/extension-roles.test.js` 505 行门禁阻塞。
- 2026-09-11：确认 fork `CGOSU/pi-collaborating-agents` 固定 commit `acd50d0ec091deb03bb90b57b694131cff0c297d`，保存迁移计划和第三方 MIT 来源说明；实现前旧 gmc/worktree 链路保持不变，详见 [`docs/plans/collaborating-agents-migration.md`](plans/collaborating-agents-migration.md)。
- 2026-09-10：按用户确认增加简单任务的最小验证策略：不创建工作流或启动 worker，不默认运行全量测试、类型检查或构建；高风险边界和明确验证要求不受影响。已同步决策、公共 Skill、developer-test 角色和 README，尚未再次提交或推送。
- 2026-09-10：复核 Pi worker 退出问题并修正诊断/提示；确认生产 `pi.exec` + Pi CLI 路径可完成最小 worker，`npm test` 130 项通过。此前临时 E2E 的 `execFile` 包装器把超时/子进程退出映射为 code=1，PowerShell 管道还会将中文任务转换为问号；双 worker + gmc 完整 E2E 仍待在稳定终端链路复测，详见 `docs/session-log.md`。
- 2026-09-10：完成 gmc v0.10.1 Windows x64 外部契约取证；确认固定基线、独立 worktree、任务文件复制、JSON 列表、候选 promote 和非零错误退出行为。未执行本项目安装或源码实现；详见 `docs/session-log.md`。
- 2026-09-09：项目记忆文档的日期记录统一按倒序排列，最新条目在前；已同步 `session-log.md`、`decisions.md`、`pitfalls.md`、`current-state.md`、中英文模板、协作规则和 `docs-commit` 角色说明。静态规则文档不纳入时间排序，其他既有项目不会通过脚手架或包更新自动重排本地历史记录。
- 2026-09-09：按风险分级放宽自主执行：低风险只读咨询和日常实现不再强制一般技术选择、重复角色交接或正式工作流；architect 运行时允许受限只读工具及单条 browser 观察命令，拒绝写入、shell、MCP、脚本、交互、持久化、命令串联和未知工具。已同步公共 Skill、角色说明、运行时提示、AGENTS 模板和全局宿主 AGENTS；`npm test` 112 项通过。未修改模型映射、workflow API/schema/状态机、恢复门、精确编辑保护或全局 settings；未进行真实模型效率对照，未更新已安装 package。

- 2026-09-07：精简角色与编排规则：公共 Skill 作为路由入口，角色说明和运行时提示按职责分层保留最小必要内容；README、回归断言和共享 Skill 已同步，`npm test` 111 项全部通过。未改变角色、工作流协议、恢复门或运行时守卫。

- 2026-09-06：任务规划排序采用软约束：优先遵守用户明确的优先级、截止要求和硬依赖，再安排关键未知项的限时最小验证和业务关键路径，同层且风险与价值相近时才先易后难；未新增任务字段或改变 `task_workflow` 输入顺序。

- 2026-09-02：完成上下文压缩与会话恢复后的职责恢复门：所有 `session_compact` 默认 pending，普通压缩和 reload/resume/fork/已有上下文 startup 需重新确认，明确交接续跑前由运行时 acknowledged；定向恢复测试 37 项通过，行数检查和 diff 检查通过。全量 `npm test` 为 96/97，剩余失败是 Windows DuckDB 临时数据库文件锁定。
- 2026-09-01：统一角色配置保存状态提示：已保存时显示“角色配置已保存”，有会话草稿时显示“角色配置已修改，尚未保存”；`npm test` 通过 78 项。
- 2026-08-31：`pi-usage` TTY 刷新摘要中的重算日期取 session 文件最新修改时间并显示为 `YYYY-MM-DD HH:mm`，另列受影响日期；`npm test` 通过 78 项。
- 2026-08-31：通用任务执行、证据门控、工具调用和角色交接规则集中到公共 Skill；生成的中英文 `AGENTS.md` 仅保留项目特有规则，`npm test` 通过 76 项。
- 2026-08-30：采用新鲜证据门控的有限探索和简单任务 fast path；运行时提示、双语模板与角色规则已同步，`npm test` 通过 76 项。
- 2026-08-30：完成报告中的验证仅显示明确失败项，成功项省略且完整 verification 仍持久化；`npm test` 通过 70 项。
- 2026-08-30：完善高级初始化 TUI 的逐级 Esc 返回、恢复值光标、角色模型草稿和最终确认；控制中心首项返回控制中心，直接高级命令返回调用方；`npm test` 通过 64 项。
- 2026-08-26：修复 Pi fork/branch 复制历史 entry 导致的重复统计；schema v3 按稳定 entry key 去重 usage、speed、activity、session 和 duration，首次升级事务化重建 DuckDB 派生缓存；`npm test` 通过 58 项。
- 2026-08-25：`pi-usage` 新增 `yesterday`、`Nd`、`YYYY-MM`、单日和双日期闭区间查询；跨日汇总按源文件去重 session，`npm test` 通过 56 项。
- 2026-08-25：删除会在仓库根目录遗留临时目录的 `test/extension-workflow.test.js`；剩余测试通过，`npm test` 通过 54 项。
- 2026-08-23：工作流进度面板增加总任务已运行时间；已完成任务耗时移到描述列并优化主列宽度，避免窄面板遮挡任务信息。
- 2026-08-22：工作流进度面板增加总任务开始时间，并在已完成任务后显示任务耗时；TUI 与非 TUI 状态展示均已同步。
- 2026-08-22：完成启动优化验证。12 组交替 fresh RPC（24 个新进程）中，无扩展 wall 中位数为 808.2 ms，加载 pi-init 为 824.7 ms，增量 16.5 ms；`PI_TIMING` 的 main TOTAL 中位数为 58.5/79.0 ms，扩展首阶段为 9.0/28.5 ms。相较此前 25.7 ms 增量基线减少约 9.2 ms，超过约 5 ms 保留阈值；完整验证见 `docs/session-log.md`。
- 2026-08-20：完成测试、工作流状态、扩展职责和 pi-usage 的职责拆分；保留 `extensions/index.ts`、`src/workflow.js`、`scripts/pi-usage.js` 公共 facade，并让安装器携带 pi-usage 支持模块。新增 500 物理行数门禁及边界测试；最终验证见 `docs/session-log.md`。
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
- 2026-08-14：移除自研 `parallel_develop` 及其测试、模板和文档说明，保留 `task_workflow`、`switch_role`、角色配置和脚手架能力。
- 2026-08-14：任务工作流升级为默认 `workflowMode: "auto"` 的 off/on/auto 策略；`auto` 对不超过 2 个任务跳过编排，配置入口为 `/pi-init config workflow`，并兼容旧 `workflowEnabled`。
- 2026-08-14：任务完成报告增加任务 ID、任务内容、角色、涉及文件、开始/结束时间、总耗时、完成摘要和验证结果；耗时从任务实际派发执行到完成计算，历史状态缺少开始时间时显示不可用。
- 2026-08-14：新增默认 `local`/可选 `subagents` 执行器、严格结果协议、持久化任务—代理绑定及受限的 pi-subagents 专用代理脚手架；README 记录安装前提和 reload/孤儿代理边界。
- 2026-08-13：`pi-usage` 增量导入 `pi-token-speed` 的自定义 session 采样，按 provider/model 计算 `输出 token / 有效生成秒数` 的加权平均 TPS；旧数据库升级时只回填 `speed_events`，不再重建既有用量和活动数据。
- 2026-08-10：`pi-usage` 基于 DuckDB 扫描 Pi JSONL session，按模型汇总调用次数、输入/输出/cache token、费用和近似使用时长；报告移除 Git changes，增加按模型总 token 缩放的柱状图，并在 Overview 显示缓存占比；缺少 DuckDB 时自动安装用户目录运行时；普通查询增加 1 小时缓存和跨自然日自动检查。
