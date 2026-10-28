# 会话记录

本文件按日期倒序记录每次工作的完成内容、实际验证和遗留问题；新增记录插入对应日期位置，最新条目在前。不记录敏感信息或未经验证的结果。

### 2026-10-28：补齐会话交接面板并精简公共Skill

- 面板：确认此前resume存在但fresh缺少；新增fresh/留原会话选择、默认返回确认、目标导入重核及旧源只读状态。状态面板、命令与控制中心共用入口；fresh后用close-panel关闭旧调用栈，resume/retry共用停止恢复门，不触碰旧ctx。新增UI回归先失败后通过。
- Skill：主文件由6317字符精简为3723字符（JavaScript字符串长度口径，不等于token/费用），具体工具细节按需引用；补充ub-mode适配原则，保留第三方署名，删除角色重复表述。不新增公开Skill或执行器，不安装度量工具，不自动push。
- 验证：`node --test`659项全部通过，`node node_modules/typescript/bin/tsc --noEmit`通过；`git diff --check`与Skill相对引用核对通过。检查包装器的typecheck因npm未知`--listFiles`失败，已直接运行项目编译器确认通过。真实Pi TUI换会话及token/费用收益未实测；未部署、未push，提交以Git记录为准。


### 2026-10-28：实现用户确认的阶段边界换session

- 完成：新增有界交接包、fresh用户命令与完成边界建议；源队列冻结，新session只继续剩余任务。复用原规划/TaskMemory、工具配对和调度器，不调用模型总结或复制工具日志，不修改Pi/SoL配置。
- 来源：历史验证显式标注，仅已声明且属于已完成直接依赖的真实成功来源可定向只读获取，不能充当当前任务验证；连续交接保留原来源。来源文件只读加载到inMemory SessionManager，避免SDK open初始化空文件。
- 验证：真实SDK临时实盘及扩展事件回归覆盖提示/留原会话、确认/取消、源写失败、目标部分写入、重复激活、载荷损坏、安全门、旧branch冻结、历史来源与连续交接；新增15项交接回归；`node --test`全量654项通过，`node node_modules/typescript/bin/tsc --noEmit`及`git diff --check`通过。检查包装器的typecheck因npm未知`--listFiles`失败，已直接运行项目编译器确认通过。
- 边界：尚未部署、未push，提交以Git记录为准；未运行真实Pi TUI换会话或Provider，未验证1–5秒估计或净token/费用收益。


### 2026-10-28：Provider请求失败在可信工具边界续接

- 复现：新增真实扩展事件回归，原实现将纯请求失败改为handoff-outcome-unknown、清除当前交接，先观察到失败后修复。
- 完成：复用workflow-tool-binding中的请求来源，验证唯一锚点、工具根/嵌套生命周期及当前branch持久化配对；index只在SDK最终settled后判断，可信请求失败沿停止开关保全执行身份，用户继续前再校验。没有新增调度器、自动重试、任务schema或历史迁移；UI使用中性暂停表述，旧未知结果与业务block不放松。
- 验证：新增15项回归；`node --test`全量639项通过，`node node_modules/typescript/bin/tsc --noEmit`及`git diff --check`通过。检查包装器的typecheck因npm未知参数`--listFiles`失败，已直接运行项目编译器确认类型检查通过。覆盖纯请求失败、成功工具后失败、缺失/错误/嵌套未结束工具、SDK成功重试、额度/认证错误、手动中止、身份/branch/模型变化、持久化失败及停止再继续绕过、reload、业务阻塞、迟到响应和完成报告兜底。
- 边界：未部署或修改life-and-home及其他项目，未验证真实Provider断网或费用收益；未push，提交以Git记录为准。

### 2026-10-27：取消主动压缩并保留原生恢复门

- 完成：移除主动压缩收益预测、上下文投影估算、工具组预算触发及主动执行管理器；任务和重规划边界直接沿原调度器交接，不再调用ctx.compact。不改变Pi/SoL配置，不启用Online Context Compact。TaskMemory、checkpoint、原生/手动压缩后的职责确认与暂停/未知结果保护继续保留。
- 回归：任务边界原实现会在99%上下文占用时调用compact，新增回归先失败后通过；覆盖同/跨角色、高占用工具组、收益历史、重规划、原生/手动压缩与旧中断边界显式恢复。退役策略的专属测试随实现移除，身份、持久化失败、暂停、取消与未知副作用回归保留并调整为无额外压缩效果的契约。
- 验证：`node --test` 624项全部通过；`node node_modules/typescript/bin/tsc --noEmit`通过。相关测试覆盖原生恢复门、任务身份、持久化失败、暂停、取消及未知副作用；尚未部署，不宣称真实Provider token/费用改善；提交与推送以Git记录为准。

### 2026-10-27：续接职责连续性与安全原文分页任务

- 来源：本项目最新更新的 Pi session `01a17719-70b8-73e3-91dc-f18368df0a5a`；原角色连续性任务已完成，分页任务因宿主旧schema暂停，文档收尾待办。本次读取真实历史后续接代码与文档，不改写原session，不把离线工具测试当成原会话完成证据。
- 完成：核对连续性提示与角色矩阵回归，同步公共Skill、三类角色说明及角色连续性文档；分页读取实现与安全边界见[README](../README.md)。修正排除目录大小写与项目扫描不一致的读取漏洞，补充大小写目录和原生/内置分页混用且留有缺口时拒绝complete的回归。
- 结构复核：`extensions/file-review-runtime.ts` 保留会话/分支代次、授权检查、库存及覆盖接线；原文分页、完整行选择与字节预算已独立到 `extensions/file-review-read.ts`，路径及稳定快照由 `src/file-review.ts` 负责。当前不建议为行数继续机械拆分；此为源码结构复核，不是原Pi session的持久化keep记录。
- 验证：本轮续接前同一工作区已完成 `npm test` 696项全部通过，`node node_modules/typescript/bin/tsc --noEmit` 与 `git diff --check` 通过；相关实现/测试/配置未变，本次仅同步Markdown并复用结果；公共角色说明变更后，定向执行 `node --test test/runtime-routing-context.test.js test/workflow-action-policy.test.js test/architect-boundary.test.js test/scaffold.test.js`，30项全部通过。检查包装器的typecheck步骤因npm未知参数 `--listFiles` 失败，已用直接tsc检查确认类型通过。
- 遗留：已确认Pi使用独立旧安装副本，具体路径与核查见[自举阻塞记录](pitfalls.md#2026-10-27新增审阅读取能力尚未加载时出现自举阻塞)；原Pi宿主须先加载新实现再reload，并通过真实分页读取完成原session的结构登记和工作流恢复；本次未部署、未改写暂停状态，未验证真实Provider/TUI；提交与推送结果以Git记录为准。

### 2026-10-26：稳定活动任务记忆与审阅提示

- 实现：停止在活动执行中随工具观察变化而重复注入任务记忆视图；保留 TaskMemory 持久化、checkpoint、来源查询及身份、恢复、停止和未知副作用保护。移除动态审阅候选库存的 system 注入，保留稳定工具说明以及 `file_review(action="list")`、`/large` 按需查询与现有扫描、指纹和通知行为；不通过状态轮询或反复替换尾部消息恢复动态注入。
- 验证：`node --test test/file-review-runtime.test.js test/file-review.test.js` 25 项通过；`npm test` 681 项通过；`npm run typecheck` 与 `git diff --check` 通过。全量测试与类型检查在文档收尾前对实现/测试完成后执行；本次文档编辑未改动代码或测试。
- 未验证：未运行真实 Provider A/B 或 Pi TUI；未证明缓存读取、成本、时延、重复调查或完成率收益，也未部署到其他正在运行的 Pi 实例。未 push。

### 2026-10-26：调查 clash_foward_rev 缓存 miss 与运行错误

- 完成：检查该项目会话、请求缓存诊断、SoL 配置及 pi-init 上下文投影。确认 SoL-Pi 的成本判断/可压缩前缀投影算法已被改编进 pi-init，但独立 Online Context Compact 未启用；对应会话没有 Pi 原生压缩事件。定位到活动任务记忆视图动态插入历史前部可能缩短可复用提示前缀；此为实施前的诊断，后续已移除该类重复注入。相关计数、离线复现与尚未完成的真实 Provider A/B 见 [`docs/pitfalls.md`](pitfalls.md#2026-10-26动态任务记忆与审阅库存曾改变可复用提示前缀)。
- 错误：会话中 17 次 `fetch failed`，另有额度耗尽、WebSocket error 和 terminated 各 1 次；这些是 Provider/传输失败，不等同缓存 miss。另见精确文本编辑失败、任务 checkpoint 缺少 evidence IDs、部分文件未完整读取和一次重复状态告警。
- 当时验证：读取现存的目标项目诊断/会话记录，运行不修改仓库的离线上下文投影复现；该调查阶段未修改代码、配置或目标工作区，也未运行真实 Provider A/B、测试或构建。减法方案随后在同日完成实现；真实 Provider A/B 仍待验证，见本文件紧邻上方的实现记录。

### 2026-10-25：将 SoL-Pi 成本判断迁入 pi-init 压缩管理器

- 实现：移除固定 50% 主动压缩阈值。按模型 token 价格、真实 workflow task 请求样本、后续可确认的同角色队列和 Pi 原生可压缩投影估算缓存重建/摘要成本与预期收益；未知上下文/价格/未来任务、replan、不同模型投影和未回收压缩成本时拒绝经济型主动压缩。接入 pi-init 唯一压缩管理器，保留任务身份、停止/恢复/未知结果保护与容量保护；不启用 SoL 独立 Online Context Compact 或其 update_plan/续跑状态机。
- 来源与许可：改编 NVIDIA SoL-Pi `economics.ts` 和 `projection.ts`（revision `2195680`，MIT），保留 SPDX 署名及 `THIRD-PARTY-NOTICES` 说明；不修改第三方安装目录。
- 验证：`npm test` 676 项通过；`npm run typecheck` 退出码 0；成本策略及真实工作流边界针对性测试 12 项通过；`git diff --check` 通过。详见下列实际工具检查结果。
- 未验证：未连接真实 OpenAI Provider 或 Pi TUI 测量缓存费用/压缩收益；插件代码修改尚未安装或 reload 到其他 Pi 实例；未修改用户全局 SoL 配置，未 push。

### 2026-10-24：压缩后受限续接角色交接并增加缓存请求诊断

- 完成（交接）：预算压缩管理器仅在本次压缩成功且原角色 handoff ID、session/context、角色代次仍匹配时回到既有调度器；调度器复核 branch、目标角色、恢复/停止门、Agent/宿主忙碌及排队消息。没有创建任务或 attempt。另保留失败压缩撤销边界，避免 settled 后由工作流提醒绕过失败。
- 完成（诊断）：黑匣子按公开 request/stream/assistant hook 观察缓存 usage，区分原始字段显式零、正数、缺失、无效及未观察，并另记 message_end 归一化计数、请求关联、缓存键存在性和运行时 HMAC 指纹。关联不可靠、响应身份缺失/无效、冲突/错位/重叠、失败/中止或 hook 不可用时不推断命中。仅记录允许字段，不落盘提示/请求正文、headers 或完整 payload；不改请求、缓存策略或 Provider 行为。
- 文档：更新 README、运行黑匣子说明、当前状态和本决策记录。明确扩展 hook 观察不等于最终网络请求或服务端缓存事实；transport/full-delta unavailable，未声明真实 Provider/缓存收益。
- 验证（实现阶段实际结果）：角色续接相关测试 68/68、跨恢复/生命周期测试 54/54、追加守卫测试 12/12；缓存/黑匣子/报告/状态测试 107/107；`npm run typecheck` 与 `git diff --check` 均退出码 0。实现与测试在文档编辑期间未变化，收尾复用这些结果；未运行全量测试。
- 未验证：未验证真实 Pi 宿主续接、真实 Provider/网络事件、服务端缓存、token/费用或性能收益；未部署、push。

### 2026-10-24：增加 codemode 异常参数执行前保护并澄清轻量调查边界

- 实现：在现有 `tool_call` 守卫链接入 codemode code 参数检查；仅连续至少 256 行单行空 `text()` 且占非空行至少 90% 时拒绝执行，复用现有停止与未知副作用保护。轻量调查边界明确为软约束，来源路径是优先线索而非硬白名单。
- 能力限制：保护不截断、改写或自动重放，不识别所有异常参数，也不覆盖未到达 `tool_call` 的失败生成或减少已发生的生成耗时。SDK 的 `provider_stream_event` 是只读通知；`ExtensionContext.abort()` 取消整个当前 agent operation，缺少请求专属取消句柄和可靠的流式参数拦截结果契约，因此未实现或验证生成中止，也未修改宿主。
- 验证：六个相关测试文件共 54 项通过，`tsc --noEmit` 通过，`git diff --check` 无诊断；测试及类型检查来自实现阶段，相关实现、测试、依赖和配置在检查后未变化，收尾复用该结果，未重跑全量测试。详细测试范围与日志见任务交接记录。
- 遗留：未验证真实 Pi/Provider 流式中止或生产接口行为；执行前保护不能挽回生成耗时。未 push。

### 2026-10-21：为重复任务回合增加一次纠偏续跑

- 完成：Local 工作流任务连续回合未提交结果时，第一次仍为普通提醒；第二次发送一次纠偏指令，明确停止重复 status/读取/重规划、复用已核实成果并推进当前任务，且不得重放未知副作用；第三次仍无 complete/block 结果则按 `handoff-outcome-unknown` 暂停，后续不再自动续跑。未知结果仍须先核对副作用并经显式 retry 授权，不取消任务、不清除已完成成果。
- 验证：`node --test test/workflow-protocol.test.js test/workflow-start-lifecycle.test.js` 11 项通过，包含“普通提醒 → 单次纠偏 → 暂停且不再派发”的集成回归；`npm run typecheck` 通过。全量 `npm test` 547 项中 536 项通过、11 项失败，仍为此前角色恢复/模型切换与临时目录清理失败；不据此声称全量通过。`git diff --check` 通过。
- 未验证：未在真实 Pi 长任务/Provider/TUI 验证模型是否遵循纠偏提示；旧 session 的 `handoff-outcome-unknown` 未重试或重放。

### 2026-10-21：修复两类无进展循环漏检

- 根因：暂停状态保护在任意非 `task_workflow`/`switch_role` 工具结果后清空连续观察，离线 `statusLoops` 也会被普通工具调用打断；同时，首次诊断把“应用了内容不同的重规划”误计为已核实进展并清空状态历史，可能漏掉 A→B→A 重规划振荡。
- 修复：普通工具结果只记录活动、不重置保护或计作进展；离线状态循环统计跨过普通工具调用，但工作流持久化、输入和 branch 变化仍打断 streak。重规划计划变化不再清空窗口或报告为进展，跨 revision 保留状态快照并检测 A→B→A；只有带摘要和验证的已完成任务计作已核实进展。未修改未知结果的恢复/重试/重放安全门。
- 验证：先新增 3 个回归并确认修改前全部失败；最终 `node --test test/workflow-status-polling.test.js test/workflow-progress.test.js test/handoff-log-report.test.js test/workflow-status-view.test.js` 39 项通过；`npm run typecheck` 通过；`git diff --check` 待提交前执行。全量 `npm test` 546 项中 535 项通过、11 项失败，失败测试标题与本次改动前记录的 11 项一致，主要在角色恢复/模型切换与日志临时目录清理；未据此宣称全量通过或确认其基线根因。
- 遗留：未在真实 Pi 长工作流/TUI 复现混合工具绕过或重规划振荡；旧 session 的 `handoff-outcome-unknown` 是否已取消未核实，本次未重试或重放该旧任务。
- 收尾：commit `e3af451`（`修复工作流循环检测绕过路径`），未 push。

### 2026-10-21：增加工作流无进展循环诊断

- 完成：新增语义状态追踪，识别重复自动回合/显式状态查询、A→B→A 状态往返及不同 revision 重复同一重规划方向；初版将内容变化的重规划记作已核实进展（该判定后续已修正，见上方同日记录）。诊断显示在工作流状态文本与摘要中，不修改持久化工作流状态，不自动中断、暂停、重试或重放任务；外部输入、session/workflow 变化和生命周期边界清空观察。
- 验证：`node --test test/workflow-progress.test.js` 8 项通过；`npm run typecheck` 通过；`git diff --check` 通过。全量 `npm test` 共 544 项，533 项通过、11 项失败；失败集中在角色恢复/模型切换测试及扩展日志临时目录清理，未定位为本次循环诊断失败。
- 未验证：未在真实 Pi 长工作流、TUI 或 Provider 会话确认诊断体验；该功能只提示疑似循环，不承诺阻止自动续跑。
- 收尾：commit `bbbd353`（`增加工作流无进展循环诊断`），未 push。

### 2026-10-19：修复工作流终态无最终报告并收敛子任务 Git 收尾

- 根因与复现：根 complete 和中间任务一样始终 terminate=true，导致文字要求的最终回复不可能执行；新增 root-complete 回归先失败。只读分析既有 session，多个任务均有包含 git status/diff 的 bash 调用，包含实现、验证和交付阶段；未将每次调用都判为冗余，也不把关键词分类当完整 shell 执行审计。
- 实现：仅根终态 complete 保留当前模型回合；新增 workflow-delivery 请求局部收据，提供全部已登记成果/验证/历史限制，保留完整调用组和宿主 system/user 消息。正常回复后不重发；取消/错误/报告阶段再提工具时一次可见报告兜底，不触发新模型回合、不重放任务，派发失败明确未确认。
- Git：公共 Skill、职责说明和任务交接不再把每个子任务完成都当全局 Git 收尾；首次归属基线、必要局部 diff/冲突和提交前最新检查保留，不缓存旧 Git 结果。最终交付只据已登记事实输出，Git 信息缺失如实披露，不补做 Git 来填报告。
- 验证：针对性回归与 `npm run typecheck` 通过；日志开关两种模式各 536 项全量测试通过、0 失败，`git diff --check` 通过。保留中间任务、子流程、身份、恢复及未知副作用回归，不新增用户权限、Git 命令解析器或持久化格式。
- 未验证：未接真实 Provider/Pi TUI 验证新的最终回复体验和 Git 调用下降，不承诺耗时/token 收益；运行中的安装版本未自动替换。未提交或 push。

### 2026-10-19：真实会话回放修复重复历史交接与 system 消息引发的状态空转

- 证据：新 runtime 日志有 12 次 context.projected，均 BRANCH_MISMATCH，10 次同输出 status；不是旧扩展未加载。只读定位同一 session，使用 SDK buildSessionContext 回放发现相同历史 task handoff 持久化两次；修复后继续回放定位宿主 system 历史被误判成 TOOL_PAIR_UNSAFE。
- 修复：仅暂停观察窗口允许同身份历史重复投递并选择最后一次；活动 handoff 唯一门不变。宿主 system 消息原样保留，不与工具配对混淆；当前身份与 updatedAt 未变的 status 观察不因后续提醒失效。
- 防线：新增 workflow-status-polling 运行时保护，连续相同暂停状态的第二次只读查询返回当前状态并结束本回合、明确提示仍暂停；状态变化、真实用户输入、其他工具观察、session/branch 与新回合重置判定。无业务状态写入，不自动恢复/重试/创建续跑。日志和报告新增停止事件与稳定码。
- 回放：同一真实会话的 SDK 投影 1098 条消息修复前只剩 8 条、0 条工具结果；修复后保留 406 条历史状态结果，15 条宿主 system 消息保持原对象且仍 paused，当前与第二次状态观察分别不终止/终止。只读回放未修改用户项目或 session 文件。
- 验证：新增回归修改前失败，修改后定向验证及 `npm run typecheck` 通过；日志关闭/开启的全量测试各 526 项通过、0 失败，`git diff --check` 通过。保留既有 input 处理器顺序，避免重规划输入与模型切换测试被新观察器抢先占位。
- 未验证：未接真实 Provider/TUI 运行新回合；需 reload/重启加载补丁，不能声称已替换正在运行的扩展或从旧日志补出错误正文。未提交或 push。

### 2026-10-19：完成活动与暂停上下文视图的职责拆分

- 完成：原 590 行上下文实现入口收敛为薄分发层；新增 active、paused、protocol 三个模块，分别维护活动窗口、暂停恢复和共享身份/配对/诊断规则。原公开导入、上下文预算与动作策略保持兼容，不修改任何运行策略或持久化格式。
- 校验：迁移的 17 个函数除 export 修饰外逐字比对一致；原有上下文/预算/恢复 35 项定向回归在迁移前后均通过，`npm run typecheck` 通过。复用既有行为测试，不新增锁定文件拆分形式的测试。最终 `npm test` 与 `PI_INIT_HANDOFF_LOG=1 npm test` 各 520 项通过、0 失败，`git diff --check` 通过。
- 未验证：未进行真实 Pi TUI/Provider 回归，不宣称结构拆分本身带来 token 或时延收益。未提交或 push。

### 2026-10-19：修复暂停状态空转并收敛长任务上下文和重规划边界

- 依据：用户提供 pi-graph 项目中的 pi-init 日志，固定分析 sequence 214–1502；观察到暂停下 14 次同指纹 status、最大约 24 万输入 token，以及未退出任务时切角/重规划往返。用独立探针与新增失败回归复现状态观察丢失和边界问题后修复；不把工具失败均归因于 pi-init。
- 运行时：暂停视图依赖最新可信快照，不再要求古老 handoff 全部可见；新增 role-context-budget 与 workflow-action-policy 独立模块，分别负责完整工具组预算检查点和共享下一步决策。当前执行者可登记重规划方向，不获得规划权限；真实结果到边界后由原调度器交接，无未知结果时 block 可进入已申请重规划，未知副作用仍暂停。
- 诊断：新增 context.projected/workflow.action_rejected；离线报告识别状态轮询候选、预算与降级原因、稳定拒绝码。queued/恢复不视作 executing，避免错误拦截合法架构取证。仅有界请求视图变化，不重写历史、不自动重放或降低推理强度，不改 pi-graph。
- 验证：定向回归与 `npm run typecheck` 通过；最终 `npm test` 与 `PI_INIT_HANDOFF_LOG=1 npm test` 各 520 项通过、0 失败，`git diff --check` 通过。
- 边界：受保护内容本身超预算或工具配对损坏时显式记录 overBudget，不靠破坏配对或丢弃用户指令伪称成功压缩。未做真实 Provider/TUI 收益实验；需 reload/重启加载新扩展。未提交或 push。

### 2026-10-19：运行时幂等切角、交接观察复用与 Provider 错误诊断

- 复现：先新增测试，分别确认同角色第二次切换重复设置模型/推理及确认恢复、首个有效交接丢弃成功读取与测试配对、缺少 Provider 观察 hook 三项失败。根因与边界见 [设计决策](decisions.md)。
- 实现：`role-runtime.ts` 单次切角只读一次配置，已确认的同角色/模型/推理组合不再重复设置或递增代次；`role-context-reuse.ts` 在可核对的窗口中按 8 组/32000 字符预算保留完整成功普通工具组，复用说明不授予当前事实或执行身份；旧失败与本轮上下文不受该预算裁减。
- 诊断：SDK 支持的 Provider 阶段、HTTP 状态、assistant stopReason/耗时/token、错误指纹和白名单代码线索进入现有日志；离线报告新增 provider/reuse 指标，不记录 payload、headers 或错误正文，不臆测自动重试和网络根因。用法与局限见 [诊断日志](handoff-diagnostics.md#运行时复用与-provider-诊断)。
- 验证：相关回归与 `npm run typecheck` 通过；最终 `npm test` 与 `PI_INIT_HANDOFF_LOG=1 npm test` 各 503 项通过、0 失败（包含未闭合 Provider 观测回归）。既有身份、branch、恢复、暂停、未知派发、证据和压缩回归均保留。
- 未验证：未连接真实 Provider 或 Pi TUI 做收益对照，未承诺 token/时间下降比例；历史日志无法补出当时缺失的网络错误详情。需要 reload/重启加载新扩展；日志另需原开关。未提交或 push。

### 2026-10-19：收窄取证范围并增加只读编排日志报告

- 完成：公共职责 Skill 增加先定位再精读、历史记忆按关键词读取及可见有效事实/来源版本/范围/验证复用规则；协调交接明确已派发职责与下一步，避免为确认重复 switch_role/status。身份、恢复、证据、安全门及完整读取要求不变；不修改 pi-graph、调度器、推理强度或压缩策略。
- 工具：新增 `scripts/handoff-report.js`，支持多个 JSONL/轮转文件、去重与坏行披露，统计工具错误、SDK 耗时、settled 截止的回合耗时、读取范围重叠及交接延迟。缺失结果、stat 版本局限、多次 agent.start 和日志丢弃均保留真实口径，不自动判定冗余或失败。用法见 [诊断日志文档](handoff-diagnostics.md#离线统计)。
- 验证：新增分析脚本测试先因模块不存在失败，完成实现后 `node --test test/handoff-log-report.test.js test/handoff-diagnostics.test.js test/role-context-view.test.js test/coordination-runtime.test.js` 39 项通过；`npm run typecheck` 通过；两个新增 JS 文件 `node --check` 通过。project check 的 typecheck 封装错误附加 npm 不支持的 --listFiles，已改用项目原始 typecheck 命令验证，未改工具链。
- 样本：对用户提供的既有日志只读运行报告，复现 326 事件、51 次调用/执行、1 次工具错误、SDK 合计 576ms、1 次同角色切换候选及 core.rs 请求范围重叠 378/1153 行。该样本只是基线，不是优化后收益对照。
- 未验证：未运行全量测试、真实 Pi/Provider 回归或收益基准；新提示需 reload/重启后观察后续真实日志。未创建 commit 或 push。

### 2026-10-19：为工作流面板增加背景区分

- 完成：响应用户反馈为面板增加 Pi 主题 `toolPendingBg` 底色与 `borderAccent` 边界；窄终端改用短标题和压缩进度、在任务行内保留标题。鼠标点击边框/留白不触发任务选择；工作流状态、操作、安全确认和分层详情语义不变。
- 验证：`npm test -- test/workflow-panel-actions.test.js` — 13 项通过；`npm run typecheck` — 通过；`git diff --check` — 通过。
- 未验证：未在真实 Pi TUI 中截图或视觉验收；终端未提供可用背景色时由主题边框承担区分。

### 2026-10-19：更新补丁版本至 2.0.9

- 完成：`npm version patch --no-git-tag-version` 将 `package.json` 与 `package-lock.json` 的包版本从 `2.0.8` 同步更新为 `2.0.9`；未创建 tag。
- 验证：`git diff --check` 通过；版本元数据变更未运行测试。
- 收尾：commit `e79675f`（`更新版本至 2.0.9`），未 push。

### 2026-10-19：借鉴 rpiv-todo 优化工作流面板

- 完成：`extensions/workflow-panel.ts` 改为紧凑的无外框任务列表，使用状态符号与进度点列、强调当前任务、弱化并划线已完成任务；任务存在依赖时才显示 ID。保留任务详情、操作菜单、只读技术详情和现有安全确认，不引入第二套 todo 状态。修复分层返回后任务选择丢失，以及鼠标坐标未扣除面板标题/摘要行的问题。
- 测试：扩展 `test/workflow-panel-actions.test.js`，验证操作菜单往返后仍选中原任务，鼠标只在列表行触发任务详情；更新动态进度视图断言适配新行样式。
- 验证：`npm test -- test/workflow-panel-actions.test.js` — 13 项通过；`npm run typecheck` — 通过；`git diff --check` — 通过。
- 未验证：未在真实 Pi TUI 中进行截图或视觉验收；harness 的宽度和鼠标输入检查不代表真实终端呈现。最初的无外框样式已由本文件上方同日“为工作流面板增加背景区分”修订。

### 2026-10-18：清理无调用代码并启用未使用检查

- 完成：删除经引用检查和执行覆盖审计确认无用的代码，移除不再生效的详细计时采集与展示，并开启 `noUnusedLocals` / `noUnusedParameters`。
- 验证：`npm run typecheck` 通过；`npm test` 483 项全部通过；`git diff --check` 通过。
- 遗留问题：未在真实 Pi 会话做回归；本次尚未提交。

### 2026-10-18：优化架构取证复用与交接提示

- 完成：更新 `skills/pi-init-role-routing/SKILL.md` 及 `roles/architect.md`、`roles/docs-commit.md`，将正式证据协作限定在确需架构决策、跨职责协调或用户明确要求的情形；普通明确低风险工作直接按职责完成。更新 `extensions/coordination-messages.ts` 和 `extensions/workflow-messages.ts`，允许同轮集中处理共享来源、按请求分别报告，并仅在已接受证据的来源版本、当前 revision、适用范围或失效状态不再满足、存在明确刷新理由或决策关键缺口时针对性补查。非阻塞未知项如实披露，但不自动补证或绕过关键未决及既有门控。
- 取舍：只改规则和提示文本，复用现有批量能力；保留 request/report/handoff 身份、revision/source-validity、readiness 与任务契约运行时逻辑，不新增字段、持久化、测试断言或性能指标。
- 验证：前置提示修改实际执行 `git diff --check`，通过（退出码 0，无输出）；本次收尾静态核对了完整变更范围、模板插值/身份引用和项目 Git 状态。未运行测试或构建，未进行性能基准，不声称任何提速比例。
- 收尾范围：本工作流包含五个 Skill/角色/提示文件及三份项目记录；提交前未发现其他暂存或未跟踪改动。按项目 Git 身份 `CGOSU <dev@cgosu.com>` 创建中文 commit；不 push。

### 2026-10-16：退役测试价值审阅功能并保留结构审阅

- 完成：移除测试价值候选的领域/运行时、专属测试、共享双维候选与增量通知接线、`file_review` 价值字段/结论和 `/large` 价值派发路径。`file_review` 仅保留超过 500 个物理行的结构审阅、`keep`/`recommend-split`、完整读取门、指纹失效和结构记录恢复；旧非结构 `reviewKind` 明确失败，不传参数和 `structure` 继续支持。历史 `pi-init-test-value-review` session entries 保持原样并忽略，不读取、迁移、写入或删除。
- 保留：通用 Test Value Gate、按行为变化补测的原则及有价值的业务回归；此前已提交的测试整理不回滚，也不据此开展全仓删测。
- 文档：README 与公共职责路由 Skill 仅说明结构审阅和现有通用测试规范；当前状态移除价值审阅待办数量并记录退役状态；本文件与决策文档保留旧结论作为历史，避免把历史数量当作当前队列。
- 验证（实现任务实际结果）：`node --test test/review-candidates.test.js test/review-incremental.test.js test/file-review-runtime.test.js test/large-command.test.js` — 32 项通过；`npm run typecheck` — 通过；`npm test` — 445 项通过；`git diff --check` — 通过。
- 文档收尾实际检查：`npm run typecheck` — 通过；本轮重新执行的针对性命令 `node --test test/review-candidates.test.js test/review-incremental.test.js test/file-review-runtime.test.js test/large-command.test.js` 为 31 项通过、1 项失败，失败用例“旧价值 session 条目原样忽略；旧调用明确失败且结构审阅仍可完成”收到 `ROLE_RECOVERY_PENDING`，与测试分支角色恢复门有关；未修改代码或重试。该失败不覆盖记录的实现任务先前 32 项通过结果，但本轮复跑没有全绿。
- 未验证：未进行真实 Pi reload、TUI/E2E 或 Provider 验证；运行中的旧工具 schema 与提示需 reload 或重启后更新。不执行 push、发布或版本升级。

### 2026-10-16：测试文件归组与重复回归精简

- 范围：只整理测试，不修改产品实现；以本轮实际基线 65 个测试文件、468 项通过为准，不按先前估算强行删除。
- 归组：`handoff-snapshot` 的快照测试与 `role-handoff-recovery` 合入 `role-handoff`，预算测试归入 `workflow-compaction`；`workflow-pause-view` 与 `workflow-completion-view` 合入 `workflow-status-view`，复用同一 theme；`workflow-nesting-view` 合入 `workflow-nesting`；`workflow-live-view` 合入 `workflow-panel-actions`。以上均为 test/ 下的 .test.js 文件。
- 精简 3 个重复用例：custom 交接的新职责注入和消息说明断言并入原切角生命周期测试（不保留仅比较旧 event 对象的弱断言）；基础压缩派发计数由更强的任务边界时序/重复回调测试及无归属 session_compact 保护覆盖；旧 50% 策略用例并入预算兜底测试，保留 49.9、null 与 confirm 分支。
- 保留：持久化失败、未知派发、取消、session/角色代际失配、证据和嵌套恢复等独立安全回归。未因功能稳定或测试年龄删除有效覆盖。
- 结果：65 → 59 个测试文件（减少 6 个，约 9.2%）；468 → 465 项测试。合并后的最大目标文件 441 行，不新增超 500 行聚合文件。历史日志中的旧命令路径保持原记录。
- 验证：定向 63 项通过；最终 npm test 465 项通过、0 失败，npm run typecheck 与 git diff --check 通过。project check 的 typecheck 封装曾错误附加 npm 不支持的 --listFiles；直接执行项目原命令成功，未修改项目工具链。

### 2026-10-16：按测试价值建议整改低收益覆盖

- 目标与边界：落实前一条测试价值审阅提出的 4 项 `rewrite` 建议；仅调整测试，不改变产品行为，不删除混合价值测试，不把审阅建议当作自动修改。保留对权限、持久化、身份、状态和边界行为的回归保护。
- 完成（重复/低判别断言）：`test/line-count.test.js` 移除与 `test/file-review.test.js` 重复的纯行数解析断言及低价值的 package 脚本缺失断言，保留递归扫描排除项、扩展名、500/501 边界和 CLI 候选结果；`test/control-center-menu.test.js` 合并搜索/推理强度两级保存路径的重复文案检查，改为验证完整模型配置实际持久化，同时保留 Ctrl+S/F2、安全错误、上层菜单保存、无陈旧“未保存”状态和选择导航；`test/scaffold.test.js` 从混合套件收窄为脚手架文件、变量替换、角色配置规范化、语言选择、dry-run/冲突保护、既有项目 Skill 保留及 package 发布元数据；移除重复模板长文案/章节与常量断言。
- 完成（按领域归位与判别力）：角色模型过滤/唯一匹配从 scaffold suite 移至 `test/extension-roles.test.js`；auto 两任务计划的真实不编排/不写入/不派发验证移至 `test/workflow-task-count.test.js`；重规划角色边界 smoke test 移至 `test/workflow-replan-directions.test.js` 并校验当前完整身份及 architect 不取证、交由 docs-commit 查证的消息结果；`test/workflow-runtime-exports.test.js` 保留 Pi Jiti 扩展加载，并改用可派发状态证明 stale identity 不派发、有效身份可派发，以及 architect 执行角色返回真实拒绝且不派发。
- 验证：`node --test test/line-count.test.js test/control-center-menu.test.js test/scaffold.test.js test/workflow-runtime-exports.test.js test/extension-roles.test.js test/workflow-task-count.test.js test/workflow-replan-directions.test.js` → 45 项通过、0 失败、0 跳过；`git diff --check` 通过。未运行全量测试、typecheck、构建或真实 Pi/Provider 验证。
- 后续状态：7 个测试文件的内容指纹发生变化，原价值结论按机制失效；当前 `file_review(action="list", reviewKind="test-value")` 显示 7 项待重新审阅，其余 59 条既有当前版本结论有效。测试文件数量不变；7 个文件中的测试用例由 52 项净减至 45 项（部分行为覆盖移入更匹配的已有套件）。不把旧的 `62 keep / 4 rewrite` 统计当作当前版本结论，不自动重审或清空新队列。
- 未执行：未修改生产代码；未运行 `npm test`、`npm run typecheck` 或 build；未 push。

### 2026-10-16：测试价值审阅收敛与结论汇总

- 目标与边界：以当前会话 `file_review(action="list", reviewKind="test-value")` 为唯一待审状态来源，汇总已登记的价值结论与剩余状态；只登记建议，不修改测试、生产代码、依赖或配置，不重跑全量测试/typecheck/构建。不沿用独立空 harness 的旧文件枚举作为当前队列，也不恢复已完成的历史审阅工作流。
- 完成（队列核对）：当前测试价值候选队列为 0。已登记的 66 条价值结论覆盖全部按约定发现的候选（`test/` 下 65 个 `*.test.js` 加共享夹具 `test/helpers.js`），分类为 62 `keep`、4 `rewrite`，无 `merge` 与 `remove`。结论绑定的测试指纹与全部显式关联实现指纹逐条与磁盘当前版本核对，0 失效、0 缺失。
- 完成（有效跳过与失效重登）：其中 21 条在本轮工作流首个批次快照之前即已登记（如 `test/file-review-runtime.test.js`、`review-incremental`、`file-review`、`architect-boundary` 等），本轮未重复登记；`test/file-review-runtime.test.js` 在更早阶段因其指纹变化被重审过一次，属增量实现变更后的失效重登，不是重复结论。
- 完成（重写建议要点）：`rewrite` 分别指向 `test/line-count.test.js`（与 `test/file-review.test.js` 重复的换行计数断言、对 `package.json` 脚本不存在的配置断言价值低，但保留扩展名/排除目录与 500/501 边界）、`test/control-center-menu.test.js`（多个用例重复锁定“正在保存/成功/快捷键/通知”文案）、`test/scaffold.test.js`（模板长文案、章节顺序、Clean Code 标题等展示细节，且混杂角色/工作流行为）、`test/workflow-runtime-exports.test.js`（暂停态 fixture 无法真正判别身份拒绝与角色校验，建议改用可派发的运行状态）。均为审阅建议，未执行任何修改。
- 完成（保留回归重点）：`keep` 覆盖权限 fail-closed、编辑防护、协调身份/证据状态机、工作流持久化与恢复、角色配置持久化与 fallback、usage 真值与去重、运行时退役错误语义等高风险行为；固定文案、布局、schema/形状与重复基础断言等低收益片段已在各条理由中标注为可后续局部精简，未据以删除混合价值文件。
- 完成（维度隔离与审阅盲点）：结构审阅维度独立，仍有 14 个超限候选待审，本轮未顺带登记结构结论。另发现 `test/file-review.test.js` 首个用例标题声称“不跟随链接”，但正文未构造任何 symlink，仅覆盖排除依赖/生成目录；已记录到 [`docs/pitfalls.md`](pitfalls.md)，仅建议未实施。
- 验证：`file_review(action="list", reviewKind="test-value")` 返回“没有该页已发现的测试价值候选；总数 0”，`file_review(action="list")` 返回结构待审 1-14/14；用 SHA-256 逐条比对 66 个已登记测试路径及全部关联实现路径，0 不匹配、0 缺失；`git status --short` 仅 `?? .DS_Store`。
- 未验证/未执行：未运行 `npm test`、`npm run typecheck`、构建或真实 Pi 宿主/Provider 验证；未修改测试或生产代码；价值审阅记录持久化在 Pi session（`pi-init-test-value-review` 条目），不在仓库内。

### 2026-10-16：Pi 1.3 轻量交接

- 完成：SDK peer 下限和本地依赖对齐 1.3.0；角色、任务、重规划和取证交接增加系统派生快照，补充说明可省略，压缩完成后按当前状态重建。
- 完成：任务与取证边界按接收模型窗口估算预算，保留 50% 兜底和现有取消/身份/未知派发保护；新增异步预算检查后重新核对当前身份。
- 验证：类型检查和全量 Node 测试通过；新增快照引用、缺失说明、低占用小窗口交接、压缩后重建以及 custom 启动钩子的回归。未接入真实模型请求测试，不把模拟生命周期验证等同于线上 provider 验证。

### 2026-10-16：增量补测规则与日常增量审阅范围

- 目标与边界：承接用户已要求的“架构分析和实现”，复用已接受报告 `0932faf7-154f-4294-95a4-feac942caa7f`，不重做已有统一审阅。先补齐本次行为变化的增量补测执行规则，再把日常审阅提示收窄为当前会话/branch 基线之后的变化与显式关联失效测试；完整库存继续由 `file_review list` 与 `/large` 承担。不恢复/重放历史工作流，不复用已消费的协调 handoff。
- 完成（增量补测规则）：项目 `AGENTS.md`、`templates/AGENTS.md`、`templates/en/AGENTS.md`、公共 `skills/pi-init-role-routing/SKILL.md` 与 `roles/developer-test.md` 增加同一条规则——补测范围按本次行为变化及必要直接影响划分，不按修改行数机械限定，优先复用/调整已有测试、只为真实风险缺口新增、保留有效长期回归；纯展示/样式/文案默认不补，不生成后再删除，不按年龄、通过时间或覆盖率自动删除。明确该规则不是自动测试生成或自动选测。
- 完成（增量审阅核心）：新增 `src/review-incremental.ts`，用内存 `Map` 维护当前 session/branch 的观察基线与变化集：已有库存不进入日常增量，完整观察到的新增/变化/删除进入范围，部分观察不推断删除；未确认维度保留上次确认上下文。候选版本 `structureVersion`/`valueVersion` 用于通知去重，价值版本同时纳入测试指纹、显式关联实现指纹与策略版本。
- 完成（运行时接入）：`extensions/file-review-runtime.ts` 将会话 state 扩展为携带 `branchIds`、`valueAssociationDecisions` 与 `incremental`；`candidateQueue` 在构建统一队列后刷新增量候选；`runtimeSection` 改为只展示增量候选并明确“日常范围不代表精准任务 Git diff、完整库存走 list/`/large`”；`handleReadResult`、`handleToolResult` 与 `agent_settled` 改用 `unnotifiedIncrementalReviewCandidates` 并在实际送达后 `markIncrementalReviewNotified`。新增 `session_tree` handler（`oldLeafId !== newLeafId` 时 `restore`）；`scanCurrent`/`refreshSpecificFile` 在扫描前后用 `branchIdsContinue`/`branchContinuesFrom` 核验 branch 前缀，过期结果返回 `STALE_SESSION`，`restore` 在异步扫描前后核验 generation、session 与 branch。完整候选队列、`file_review list`、`/large`、安全门、双维独立状态与结构化错误语义未改。
- 完成（测试）：新增 `test/review-incremental.test.js`（6 项）覆盖“已有库存不进增量 / 完整新增变化删除 / 部分观察不推断删除 / 显式关联实现变化进入日常并按版本去重 / 策略变化纳入版本 / 完成后退出且仅完整扫描使关联删除生效 / 未确认维度不消费水位”；`test/file-review-runtime.test.js` 改/增用例覆盖启动库存静默、`session_tree` 与 reload 重建基线、扫描期间 branch 变化拒绝旧结果、settled 只提示新版本且上下文保留、显式关联实现变化使短测试进入日常并按版本去重。
- 验证：`node --test test/file-review-runtime.test.js test/review-incremental.test.js test/file-review.test.js test/review-candidates.test.js test/test-value-review.test.js test/test-value-review-runtime.test.js test/large-command.test.js` 57 项通过、0 失败；`npm test` 469 项通过、0 失败；`npm run typecheck`（`tsc --noEmit`）通过；`git diff --check` 通过。验证使用 Node v26.11.1；`@earendil-works/pi-coding-agent` peer/lockfile 版本为 1.1.0。
- 未验证：未运行真实 Pi TUI/E2E、TUI 实际输入/渲染、真实 Provider 请求或磁盘/进程故障实验；未执行构建或故障注入。“增量范围过滤与 branch/恢复隔离成立”仅由单元/集成测试支持，不代表真实宿主行为已验证。未实现按长期未触达排序、周期自动调度、自动测试生成或自动选测，也未新增跨会话缓存。结构审阅方面，上一轮对 `extensions/file-review-runtime.ts`（771 行 / `86f2137ece1187ee`）与 `test/file-review-runtime.test.js`（527 行 / `4dd9b7123400a126`）的 `keep` 因本轮内容变化已失效，需按新版本重审。

### 2026-10-15：续接统一审阅候选队列——短实现读取、价值维度 `/large` 入口与日志夹具修复

- 目标与边界：只续接已取消补充工作流留在工作区的实现成果，不回滚、不重做已提交的 c51338f。仅修改本轮的 7 个代码/测试文件与直接相关文档，不重写历史记录当时的结果。
- 完成（统一候选模型）：`src/review-candidates.ts` 改为返回结构化总结果（两维候选、`structuralConfirmed`/`testValueConfirmed`、各自的 `structuralError`/`testValueError`、全部 `errors`）。单一维度的扫描/状态校验/候选计算失败时保留另一维已确认候选并显式报错，不再提前返回导致丢失另一维信息；`ok` 仅在无错误时为真，重扫成功不会把尚未解决的状态错误洗成成功。
- 完成（运行时）：`extensions/file-review-runtime.ts` 以 `candidateQueue` 作为单一事实来源重新接线会话状态、恢复、扫描、`list`/`complete`、`/large` 快照与提示注入；持久化失败不更新内存完成状态；短生产实现的成功 `read` 覆盖可分段累积并通过价值完成，读取后实现指纹变化清除旧覆盖并拒绝价值完成。`extensions/test-value-review-runtime.ts` 在恢复时保留可确认的状态结果（`state`），仅在项目/会话不匹配时才回退空状态。
- 完成（`/large` 主动入口）：`extensions/large-command.ts` 的扫描报告与派发请求分别列出结构候选与测试价值候选；仅有测试价值候选（无超限文件）时仍经原有 Agent 空闲/工作流/恢复门安全门派发两维建议审阅；任一维度状态无法确认时警示并不派发，不会误报“没有当前版本待审候选”；两维均确认且无候选才显示无待审。
- 完成（日志夹具修复）：`test/workflow-input-resume.test.js` 改为用 `emitExtensionEvent` 驱动完整 `input` 事件链，并以 `structuredClone` 后的工作流状态快照做 `deepEqual`，不再遍历断言*每个* `input` handler 都返回 `continue`。原断言把“每个被观察到的 handler 都必须返回 continue”当成隐含契约，而 `handoff-diagnostics` 在日志开启时额外注册一个合法返回 `undefined` 的 `input` handler。仅改测试夹具，未修改 `test/helpers.js` 或生产代码；保留显式子流程与追加任务不污染待规划请求的断言。
- 验证：`node --test test/review-candidates.test.js test/workflow-input-resume.test.js test/file-review-runtime.test.js test/large-command.test.js` 35 项通过、0 失败；同一组合在 `PI_INIT_HANDOFF_LOG=1` 下同样 35 项通过、0 失败；`npm test` 446 项通过、0 失败；`PI_INIT_HANDOFF_LOG=1 npm test` 446 项通过、0 失败；`npm run typecheck` 通过；`git diff --check` 通过。验证使用 Node v26.11.1；`@earendil-works/pi-coding-agent` peer/lockfile 版本为 1.1.0。
- 结构审阅：`extensions/file-review-runtime.ts`（771 行，fingerprint `86f2137ece1187ee`）与 `test/file-review-runtime.test.js`（527 行，fingerprint `4dd9b7123400a126`）已按本轮最终内容版本完整读取并登记 `keep`，当前指纹与磁盘逐字一致；其余超限候选不在本轮范围，未机械拆分。
- 未验证：未运行真实 Pi TUI/E2E、TUI 实际输入/渲染、真实 Provider 请求或磁盘/进程故障实验；未执行构建或故障注入实验。“修复已完成、两维候选与错误传播由实现和回归证据支持”仅针对自动化测试，不代表真实宿主行为已验证。

### 2026-10-15：统一审阅候选队列与独立测试价值审阅

- 目标与边界：已确认的契约见 [`docs/decisions.md`](decisions.md) 的 2026-10-15 条目。结构审阅保持 500 物理行阈值与旧 `keep`/`recommend-split` 调用、记录和恢复语义；测试价值审阅独立于行数。不引入第二个工具、重复扫描、AST/语法解析、同名自动关联、跨会话缓存或通用配置平台。
- 完成（领域）：新增 `src/test-value-review.ts` 与 `src/review-candidates.ts`。测试候选按 `test/`、`tests/`、`__tests__/` 目录或 `*.test.*`、`*.spec.*`、`*_test.*` 文件名发现（显式导出发现局限）；价值状态独立于结构状态，记录显式关联实现路径和测试/实现 SHA-256，并按策略版本与当前扫描指纹失效；扫描失败/不完整、路径缺失、状态损坏均返回结构化错误，不以空候选伪装成功。
- 完成（运行时）：`extensions/file-review-runtime.ts` 接入可选 `reviewKind`（`structure`/`test-value`），`list` 按两维各自分页，`complete` 按维度分流；价值 `complete` 要求显式 `implementationPaths` 且测试与每个关联实现都经 Pi `read` 完整覆盖当前版本，记录独立写入 `pi-init-test-value-review` 条目并随当前 session branch 恢复；持久化失败返回 `PERSIST_FAILED` 且不标记完成。结构与价值共用同一 `inventory`/`scanErrors`，但各自决策与持久化条目独立、互不迁移，价值审阅不会消除结构待审。提取 `extensions/file-review-coverage.ts`（read 覆盖合并与完整性判定）和 `extensions/test-value-review-runtime.ts`（价值会话状态、持久化、恢复、候选查询）控制组合根规模；注入提示与 `agent_settled` 通知同时展示两个维度，并明确价值建议不自动修改测试、结构 `keep` 不代表价值通过。省略 `reviewKind` 的旧结构调用保持原语义。
- 已报告失败定位：先前 31 项定向测试中的 3 项失败原因是两类真实缺陷，不是既有基线噪音。（1）`TypeError`：测试用 `handlers.get("tool_result").at(-1)` 取最后注册的 handler，而 `handoff-diagnostics` 在 `file_review` 之后注册的 handler 返回 `undefined`；改为新增 `test/helpers.js` 的 `emitToolResult`，按注册顺序收集并取最后一个非 `undefined` 结果（2）`ENOTEMPTY`：`PI_INIT_HANDOFF_LOG=1` 时诊断日志异步写入 `.pi/logs`，与临时目录清理竞态；为 `withTempDirectory` 的 `rm` 增加 `maxRetries: 10`/`retryDelay: 50`。两者都只在日志开启时出现（关闭时 5/5 干净）；修复前该组合稳定 3 失败，修复后连跑 3 次均 35/35。
- 验证：`PI_INIT_HANDOFF_LOG=1 node --test test/file-review.test.js test/file-review-runtime.test.js test/extension-lifecycle.test.js` 35 通过、0 失败（连跑 3 次均 35/35）；`node --test test/test-value-review.test.js test/review-candidates.test.js test/test-value-review-runtime.test.js` 12 通过、0 失败；七文件组合（含 `handoff-diagnostics`）在日志开/关下均为 55 通过、0 失败；`npm test` 438 通过、0 失败；`npm run typecheck` 通过；`git diff --check` 通过。Rust/Go/Python/PHP 扩展名不在本任务范围，未新增。
- 遗留（已在后续工作修复）：`PI_INIT_HANDOFF_LOG=1 npm test` 为 437 通过、1 失败，唯一失败是 `test/workflow-input-resume.test.js` 的「讨论和纠正不被自动吞成子流程，待规划期间也不污染请求」。已用探针确认它属于同类测试夹具假设问题：日志开启时 `handoff-diagnostics` 额外注册一个返回 `undefined` 的 `input` handler（开日志 2 个、关日志 1 个），而该用例遍历断言*每个* `input` handler 都返回 `continue`。在 HEAD 隔离 worktree 上仅保留 `test/helpers.js` 的 `rm` 修复后仍稳定复现（日志开 2 通过/1 失败，关 3 通过/0 失败；HEAD 原状开日志为 1 通过/2 失败，含 `ENOTEMPTY`）。因此它既不是当时改动引入的，也不是产品行为缺陷；当时涉及文件不在允许范围，未修改也未描述为已解决。后续工作已按测试夹具修复（见上方更新条目），日志开/关全量均为 446 项通过、0 失败。
- 结构审阅：核对当前 session 中已有的 `pi-init-file-review` 条目，最新记录覆盖 `extensions/file-review-runtime.ts`（当前 690 行，fingerprint `7091778c55db6223bec18827ba3e28aba5c76686f0108b94eb1518832394148d`）与 `test/helpers.js`（当前 572 行，fingerprint `9ebd2f4c6d8f79455727a0571cc756ce8b711b35151daabef5f48c305ecffaec`），两条均为 `keep`，且记录的指纹与磁盘当前版本逐字匹配，所以旧审阅仍适用于当前内容。本次收尾完整读取了 `extensions/file-review-runtime.ts`，未重复登记已有结论；`test/helpers.js` 仅定向读取。
- 未验证：未运行真实 Pi TUI/E2E、TUI 实际输入/渲染、真实 Provider 请求或磁盘/进程故障实验；`/large` 主动派发未针对价值维度修改（其不属于本任务允许文件），价值审阅目前只能经由 `file_review` 工具路径获得。未变更 `extensions/large-command.ts` 的 `./large` 文案。
- 收尾：同步 README（两维审阅、`reviewKind`、显式实现关联、发现局限与仅建议语义）、公共职责路由 Skill（`file_review` 两维硬约束）、当前状态、决策实施状态及本文件。以 CGOSU `dev@cgosu.com` 创建中文 commit，仅纳入本工作流产生的代码/测试/文档改动；工作区中 `.gitignore` 新增 `.empryo` 来自无关本地工具产物，无法归属本任务，未纳入提交并保留在工作区。未 push。

### 2026-10-15：目标归属与扁平执行队列

- 完成：新目标通过 request-goal（request-child/旧输入兼容别名）进入同一 workflowId 和任务队列，goals/goalId 只用于归属与展示；不创建新的父子运行栈。调度先满足 dependsOn，再比较 priority（默认0），同级保持原顺序；不会因为创建目标自动加急或强行中断工具。
- 迁移：schema v7 保存目标归属和优先级，v1–v6 旧记录继续读取，旧 parentStack/待规划 nested 请求按兼容协议收尾；不在加载时强制展开、改写任务身份或重放未知结果。分组按真实任务验收/验证汇总，空分组显示无活动任务，不等于根目标完成。
- 队列变更：目标插入明确确认保留全部原 pending 项，发现原任务失效可直接转普通重规划；安全暂停边界也可重规划，不必先 retry。普通 replan 支持空 tasks 配合 retainTaskIds 只保留/撤销任务，最终队列非空且无悬空依赖；被替换任务进入审计。无就绪项时暂停而非卡在 running。
- 安全补充：测试发现未知结果可能借重规划替换绕过 retry 确认，新增任务替换需明确 confirmUnknownOutcome 和 reason 核对说明（已有结构化澄清处置复用原守卫）；superseded 审计仍保留未知标记。当前运行中的工具不会被新增目标强制终止。
- 验证：新增扁平队列领域测试与运行时目标插入/恢复/写盘失败验证，保留旧嵌套兼容测试。node --test 全工作区 460 项通过；npm run typecheck、git diff --check 通过。真实 Pi/TUI、实际进程中断和外部副作用未实机验收；harness 故障注入不等于宿主验收。
- 边界：旧栈不自动转换；新分组无独立执行器，cancel 取消当前共享队列，撤销某个目标通过普通重规划处理依赖。workflow/coordination 跨账本仍无原子事务。未提交或推送，既有 .gitignore 改动保留。

### 2026-10-15：修复正常任务推进后的协调证据绑定漂移

- 根因与复现：complete/block/retry 等递增 workflow recoveryGeneration，但原证据链接未在统一持久化入口同步；新增连续三任务与 block/retry 集成用例先失败，确认第一项结束后下一项被错误链接门阻断。
- 修复：工作流提交成功后统一调用受限同步；工作流/协调调度以及补充取证前补偿已有同 session、同 workflowId、同 planVersion 的落后代次。复用 persistWorkflowLink，不改写审阅或接受证据，不删除严格绑定与来源/契约就绪守卫。
- 故障语义：workflow append 失败不先更新链接；证据 append 失败保留已完成结果、暂不派发，存储恢复后只补关联、不重放完成任务。缺失、其他工作流/计划/session 或未来代次不自动修复，失效来源仍阻断。
- 验证：新增 7 项集成回归；相关文件 11 项通过，全工作区 node --test 共 430 项通过、0 失败；npm run typecheck 与 git diff --check 通过。project check 的类型适配器仍因注入 --listFiles 报 npm EUNKNOWNCONFIG，已用直接类型检查命令验证通过。
- 边界：测试包含故障注入与恢复、错误链接/来源负例，但未进行真实 Pi/TUI 或实际存储故障验收；没有跨账本原子事务保证。未提交/推送，既有无关改动保留。

### 2026-10-15：工作流面板人体工程学交互

- 完成：Enter 打开任务详情，Esc 分层返回；a 打开上下文操作，d 查看技术详情，详情可滚动。刷新保留选中任务和详情滚动，流程切换重定位当前任务；窄终端保留固定返回/操作提示。面板组件与操作确认分离，report 保留持久化和展示适配职责。
- 安全：取消范围与副作用说明明确、默认不执行；未知结果重试需要核对与授权。确认前后校验工作流来源、session 与上下文代次，受信任/空闲与恢复门继续生效；动作经已有 workflowCommand 执行，面板自身不写业务状态。
- 验证：复现并修复 Enter 意外关闭问题，测试发现并修复详情最后一行不可达的滚动边界。node --test 全量 413 项通过；npm run typecheck 和 git diff --check 通过。覆盖确认默认安全、过期操作、未知结果重试、取消命令接线、AI 审阅守卫、分层返回、长详情与 20 列短终端。
- 边界：终端布局为组件/harness 验证，未进行真实 Pi/TUI、鼠标命中或视觉验收；没有自动终止正在执行的外部工具、没有回滚副作用。既有工作区改动保留，未提交或推送。

### 2026-10-15：显式单层子流程与结果验收

- 完成：讨论/纠正不自动写入编排；显式子目标才创建一层子流程，新计划提供输入输出、验收与声明范围契约。子流程完成/取消后父层等待 review-child；输出全部满足且父计划有效才继续，否则 replan 或 block，禁止绕过审阅直接应用计划。复用既有架构交接与证据机制，不引入第二套执行器。
- 取消：命令与工具统一 cancel 当前层、cancel-all 整棵流程；保留父子历史，先提交再撤销原身份续跑。已派发/执行中的取消保留结果未知标记，修复取消后任务仍为 in_progress 导致状态无法恢复的问题；取消待重规划状态时关闭对应 revision 审计，避免持久状态不一致。取消不回滚副作用，也不承诺停止已运行工具。
- 兼容：旧多层记录仍能读取和逐层处置，不再新建递归子流程；旧结果缺失契约不得直接 continue。新增契约、任务验证与审阅历史支持克隆和 hydration，非法继续决定与越界声明被拒绝。
- 验证：node --test 全量 403 项通过、0 失败；npm run typecheck 与 git diff --check 通过。project check 的测试步骤通过，但其类型检查适配器注入 --listFiles 导致 npm EUNKNOWNCONFIG；已用直接 npm run typecheck 验证通过。
- 未验证：未运行真实 Pi/TUI、Provider 或真实磁盘/进程故障实验；验证与父计划有效性来自结构化审阅和实际证据，代码不自动证明模型陈述属实，allowedFiles 不是文件系统沙箱。workflow 与 coordination 账本仍无跨记录事务。
- 收尾：保留既有工作区改动，未提交、未推送。

### 2026-10-15：嵌套工作流进度摘要改为目标树

- 完成：进度面板与状态摘要用树形分支显示父目标、活动子目标和已返回的完成/取消子目标，并附状态与完成数；父层显示等待子目标，当前节点保持当前活动阶段。状态视图补充祖先进度与其子工作流历史，renderer 从关系标识构造只读树；未修改调度、验收、持久化状态或模型可见内容。
- 测试：嵌套视图覆盖活动父子、完成和取消历史，以及“已完成兄弟目标 + 当前子目标 + 孙目标”的多层树顺序；状态面板测试确认单层目标也以树节点显示。
- 验证：最终定向 `node --test test/workflow-nesting-view.test.js test/workflow-live-view.test.js test/workflow-status-view.test.js test/workflow-report.test.js` 17 项通过；最终 `npm test`（执行 `node --test`）369 项通过、0 失败、0 取消、0 跳过；`npm run typecheck` 与 `git diff --check` 通过。
- 未验证：未运行真实 Pi TUI/E2E 或视觉截图检查；测试 harness 不代表真实终端布局验证。
- 收尾：代码、测试及对应项目文档一并纳入本次中文 commit；本次没有新的 push 授权，不执行 push。

### 2026-10-15：优化工作流查看的摘要与详情层次

- 完成：工作流状态和任务/最终完成结果默认显示阶段、进度、目标、当前任务及实际阻塞摘要；技术身份、完整验证、时间和嵌套历史保留在展开详情。非 TUI 状态通知使用摘要文本；TUI 进度面板刷新时保留仍存在的任务选择，只有 workflowId 改变才转至新工作流当前任务。
- 不变量：模型可见完整状态与交接身份保持不变；展示视图不调度任务、不执行验收，也不更改持久化工作流状态。暂停原因及恢复建议仍完整呈现。
- 验证：这些实现与本次协调重开一并通过 `npm test`（执行 `node --test`）369 项、0 失败；`npm run typecheck` 与 `git diff --check` 通过。相关定向测试涵盖工作流完成、状态、live panel 刷新和嵌套历史。
- 未验证：未运行真实 Pi TUI/E2E 或视觉截图检查；harness 测试不等于真实终端布局验证。
- 收尾：先前已提交并 push 证据审阅恢复修复；本次工作流界面改动单独以中文 commit 并按用户授权 push，不混入其他文件。

### 2026-10-15：为阻塞的证据审阅增加受控重开入口

- 目标与边界：按已确认决策新增用户命令 `/pi-init coordination reopen <reportId> <reason>`，解除明确 `block` 后无法继续审阅的卡死；保留原 request/report/review 和来源版本，不重做取证，不自动接受证据或派发 developer-test。旧 handoff 身份不可复用，未知结果不通过重开重放。
- 完成：协调状态 schema 升至 v2，并将 v1 状态迁移为无重开记录；新增追加式 `reviewReopenings` 及复审 `reopeningId` 关联和 hydration 连续性/时间顺序校验。运行时仅允许重开该问题最新的明确阻塞报告，拒绝不可信项目、Agent 忙、恢复错误、活动/结果未知 handoff 与持久化失败；先持久化重开记录，再签发 architect 复审 handoff。复审消息展示原因和此前 block 决定，命令补全包含 reopen。
- 测试：增加领域与运行时测试，覆盖多轮重开、历史保留、身份轮换、session 恢复、无自动 accept/开发派发，以及目标错误、忙碌、不可信、恢复损坏、写入失败和未知结果拒绝；同步更新 role-context 测试 fixture 至当前协调状态 v2。
- 验证：`npm test`（执行 `node --test`）369 项通过、0 失败、0 取消、0 跳过；`npm run typecheck` 通过（exit 0，无错误输出）；`git diff --check` 通过（无输出）。
- 未验证：未执行真实 Pi TUI/Provider 生命周期、真实模型审阅或安装/reload；harness 测试不代表真实宿主链路。
- 收尾：只提交本次重开功能代码、相关测试和决策/状态/用户文档；既有工作流展示优化保留在工作区、不混入本次 commit；未 push。

### 2026-10-15：可递归嵌套持久工作流与协作关联规范化

- 目标：新目标进入独立子工作流，父层计划、进度与返回位置保留；中断后恢复原层级而非重置或盲目重放；动态视图只反映真实持久状态。同时修复已发现的共享协作协议断点。
- 完成（嵌套状态）：新增 `src/workflow-nesting.ts`，实现 `createNestedWorkflowState`（父层到达安全任务边界后快照为 `paused`/`waiting-child-workflow` 的 `parentStack` frame，标记其 revision 为 applied，创建同 session/executor 的新 `workflowId` 子状态，深度上限 32）与 `returnFromNestedWorkflow`（恢复父层、`recoveryGeneration += 1`、写入 `child-completed`/`child-cancelled` continuation，并把子摘要 merge 进 `subworkflowHistory`）。
- 完成（类型与 hydration）：`src/workflow-types.ts` 新增 `WorkflowStateCore`/`WorkflowParentFrame`/`WorkflowSubworkflowSummary`，`WorkflowState = WorkflowStateCore & { parentStack? }`；`src/workflow-model.ts` 状态版本升至 6，`cloneWorkflowStateCore`/`cloneWorkflowParentFrame` 拆出，新增 `child-completed`/`child-cancelled` reason；`src/workflow-hydration.ts` 接受 v1–v6，逐层校验父帧身份/session/暂停原因/parentTaskId/子历史顺序/parentTaskId 归属，且 `parentStack` 仅允许 v6。
- 完成（意图与重规划）：`src/workflow-replan.ts` 新增 `requestWorkflowNestedGoal`、`kind`/`childGoal` 持久化与审计、`applyWorkflowReplan` 对 nested 目标 fail-closed（`WORKFLOW_NESTED_REPLAN_FORBIDDEN`）；新增 `src/workflow-input-intent.ts` 区分明确重规划指令与明确继续短句。
- 完成（动作入口）：`extensions/workflow-actions.ts` 的 `replan` 按 `pendingRevision.kind` 分流创建子工作流，`complete` 在子工作流完成后 `returnFromNestedWorkflow` 并退休子层续跑、重绑协调链接，`cancel` 取消子层后返回父层；`extensions/index.ts` 按 `isExplicitWorkflowReplanInput`/`isWorkflowContinuationInput` 路由普通输入。
- 完成（提示与视图）：`extensions/workflow-messages.ts` 区分父层重规划与子工作流规划提示；`workflow-status-view.ts`/`workflow-status-renderer.ts`/`workflow-completion-view.ts`/`workflow-completion-renderer.ts` 展示嵌套路径与已返回子工作流真实历史；`extensions/workflow-report.ts` 打开的进度面板按 `WORKFLOW_STATUS_REFRESH_MS` 动态重算视图与任务集合并尽量保留当前选择（新增 `handleMouse` 转发）。
- 完成（协作协议）：`extensions/contracts.ts` 的 evidence report `requestId` 改为可选；`extensions/coordination-runtime.ts` 仅在当前 handoff 身份验证成功后补入 requestId，未知结果重试改以 `coordinationHandoffId`/完整身份关联（不再要求模型抄写 requestId），恢复到 blocked 时轮换 `handoffId`；`src/coordination-validation.ts` 将 `report.unresolved`（披露，保留）与 `review.gaps`（阻塞）分离。
- 测试：新增 `test/workflow-nesting.test.js`（3 项：独立持久化与递归 hydrate、nested unknown-outcome fail-closed、grandchild 取消/返回后仍回 root）、`test/workflow-nesting-view.test.js`、`test/workflow-nested-lifecycle.test.js`（端到端：新目标→子工作流→返回父层→继续 `parent-second`，并断言迟到子层结果被拒）、`test/workflow-input-resume.test.js`、`test/workflow-live-view.test.js`、`test/coordination-association-normalization.test.js`；同步更新 `test/coordination-runtime.test.js`、`test/coordination-simplification.test.js`、`test/workflow-core.test.js`、`test/task-contract.test.js`。
- 验证：`npm test`（`node --test`）363 项通过、0 失败、0 取消、0 跳过；`npm run typecheck` 通过（exit 0，无输出）；`git diff --check` 通过（无输出）。定向协调测试 22 项、嵌套相关测试均通过。
- 结构审阅：`extensions/coordination-runtime.ts`、`extensions/index.ts`、`extensions/workflow-actions.ts`、`extensions/workflow-dispatch.ts`、`src/coordination-validation.ts`、`src/workflow-model.ts`、`src/workflow-hydration.ts`、`test/coordination-runtime.test.js`、`test/coordination-simplification.test.js`、`test/extension-lifecycle.test.js`、`test/helpers.js`、`test/pi-usage.test.js` 的当前内容版本均已通过 `file_review` 登记为保留。
- 未验证：未执行真实 Pi TUI/Provider abort 与恢复生命周期、其他 provider 行为与真实模型链路；unknown handoff 的 fail-closed 仅为单元测试。旧报告 `report-fixed-pipeline-follow-up-1` 曾被拒绝并进入 more，本次未创建后续补查请求，也未声明其已接受。`.pi-graph/` 为未跟踪工具产物，不纳入提交。

### 2026-10-14：修复工作流恢复后的协调证据链接代次失配

- 根因：`recoverWorkflowState` 恢复活动 workflow 时推进 `recoveryGeneration`，但 session_start/session_tree 恢复链没有同步 `coordination.workflowLink`。同一 workflow/plan 的既有链接因此落后，`request-evidence` 将活动 workflow 视为未关联并拒绝；重规划的 contract 门也无法利用该协调账本。此前 status 未输出 workflowLink，不能据旧状态单独判断实际是缺失还是过期。
- 修复：workflow 恢复状态成功 append 后通知协调 runtime。只在恢复前后 session、workflowId、planVersion 相同、generation 已递增且既有链接不领先于恢复前状态时同步链接；证据账本的 findings/reviews/handoff 原样保留，不自动接受证据。缺失或身份不符的 link 不自动补绑；协调 append 失败保留旧状态并 fail-closed。协调 status details 与模型可见摘要增加链接 tuple。
- 验证：`node --test test/task-contract-runtime.test.js test/coordination-runtime.test.js test/coordination-simplification.test.js test/workflow-handoff.test.js`，37 项通过、0 失败；`npm run typecheck` 通过；`git diff --check` 通过。回归覆盖旧恢复代次落后时同一链接被同步、正常证据请求继续、审计/接受记录保持不变，以及缺失或指向其他 workflow 的链接继续被拒绝。
- 未验证：未运行全量 `npm test`，未执行真实 Pi 安装/reload、TUI/E2E 或真实 Provider 请求；当前运行中 Pi 与 adapter 迁移 workflow 均未修改或重载。当前会话原始协调 entry 的旧 workflowLink tuple 未被检查；修复仅在新代码加载后执行恢复时生效。

### 2026-10-14：修复 pi-usage PATH 遮蔽用例的跨平台宿主断言

- 背景：`npm test` 长期存在唯一失败 `test/pi-usage.test.js`「npm 生命周期 PATH 中的本地 pi shim 不会遮蔽实际 Pi 目录」，之前只被标记为基线既有问题，未定位根因。
- 现象与根因：该用例在非 Windows 宿主（macOS）上创建真实 POSIX 临时目录，却传 `platform: "win32"` 与 `;` 分隔符。`findPiPath` 因此改用 `path.win32` 拼接候选路径（形如 `\var\folders\...\pi-bin\pi.cmd`），而 `existsSync` 按宿主 POSIX 语义解析，两个真实文件（本地 `node_modules/.bin/pi.cmd` 与实际 `pi-bin/pi.cmd`）都命不中，函数直接返回 `undefined`，`installLaunchers` 返回 `false`，`assert.equal(..., true)` 恒失败。生产路径未受影响：真实 `postinstall` 在宿主上 `platform` 与文件系统一致（已核实 `platform: "linux"` + POSIX 目录返回 `true` 且启动器落在实际 Pi 目录、npm shim 目录不被写入）。
- 修复：只改测试，不改产品代码。该用例的 `platform` 改为 `process.platform`，shim 名（`pi.cmd`/`pi`）与 PATH 分隔符（`;`/`:`）随之选择，使「跳过本地 `.bin`」这一文件系统行为在宿主平台上真实执行，两个平台都保留覆盖。
- 验证：突变测试确认该用例仍具判别力——临时注释掉 `install-launchers.js` 中的 `isInside` 排除分支后用例失败（13 通过/1 失败），还原后 `node --test test/pi-usage.test.js` 14 项全部通过；`npm test` 首次全绿 351 项通过、0 失败；`npm run typecheck` exit 0；`git diff --check` exit 0。产品代码未变（`git status` 仅 `test/pi-usage.test.js` 被修改）。
- 未验证：未在真实 Windows 宿主执行该用例（本地为 macOS），Windows 分支的 shim 名与分隔符选择仍由 CI 矩阵覆盖。

### 2026-10-14：协调协议最小兼容简化（handoff 短引用、去重与重提指引）

- 需求与决策：用户确认在保留职责分离、正式证据接受、防重放门控和现有状态机的前提下做五项输入简化；契约与边界见 [`docs/decisions.md`](decisions.md) 的 2026-10-14 条目，实现状态见 [`docs/plans/role-coordination.md`](plans/role-coordination.md) 的“简化补充”。
- 完成：`extensions/coordination-handoff-validation.ts` 新增 `assertHandoffReference`，只接受与当前运行时已签发 `handoffId` 精确匹配的非空文本，并在解析后递归复用同一条 session/协议版本/恢复代次/角色/kind/请求-报告关联/阶段/branch 守卫（缺失身份 → `COORDINATION_HANDOFF_IDENTITY_MISSING`，空值/类型 → `COORDINATION_HANDOFF_REFERENCE_INVALID`，旧引用 → `..._IDENTITY_STALE`，两种输入冲突 → `COORDINATION_HANDOFF_REFERENCE_CONFLICT`）；`extensions/contracts.ts` 新增可选 `coordinationHandoffId` 并保持 `coordinationIdentity`，`extensions/workflow-actions.ts` 向 request/report/review 透传，request-evidence 的已阻塞路径须精确匹配当前引用才允许显式新 attempt。
- 完成：`src/coordination-validation.ts` 单条 finding 内按规范化 `id`/`location`/`version` 无损合并来源并保留首次顺序，同 `id` 不同版本/位置分别为 `COORDINATION_SOURCE_VERSION_CONFLICT`/`COORDINATION_SOURCE_LOCATION_CONFLICT`；`acceptedEvidence` 只合并完全一致三元引用；`src/coordination-types.ts`、`src/coordination.ts` 与 `extensions/coordination-runtime-protocol.ts` 仅在尚未持久化的报告输入校验失败上标记 `retryable` 并给出就地重提指引；`extensions/architect-boundary.ts` 单一导出 `ARCHITECT_ALLOWED_TASK_WORKFLOW_ACTIONS`/`ARCHITECT_ALLOWED_ACTIONS_TEXT`，运行时 reason、工具 description/promptGuidelines 与角色交接指导共用同一份；`extensions/contracts.ts` 与 `extensions/index.ts` 显式说明 contract 与协调状态的双向门控。未重做状态机，未新增配置/依赖/第二套协议/自动接受，未改持久化格式与版本、handoff 生成/恢复策略、内部 `details` 完整身份及 `workflowMode=auto` 2 任务阈值。
- 测试：新增 `test/coordination-simplification.test.js`（792 行，11 项）覆盖来源无损合并与冲突、acceptedEvidence 去重与未决缺口拒绝、报告输入就地重提及旧身份不能再消费、schema 暴露 `coordinationHandoffId`、短引用 report/review 闭环与冲突/缺失/过期拒绝、短引用驱动补查后完成带契约规划、来源版本过期阻断、角色/branch/阶段守卫与跨 session 短引用，并新增 `startEvidenceHandoff`/`completeEvidenceRound`/`startCurrentHandoff`/`runtimeReport` 复用夹具；`test/architect-boundary.test.js` 新增“单一定义同时驱动运行时边界与工具/契约指导”；`test/task-contract-runtime.test.js` 新增双向门控诊断断言。
- 验证：`npm run typecheck` 通过（exit 0，无输出错误）；`node --test test/coordination-domain.test.js test/coordination-runtime.test.js test/task-contract-runtime.test.js test/coordination-simplification.test.js test/architect-boundary.test.js test/task-contract.test.js test/handoff-diagnostics.test.js test/role-context-view.test.js` 53 项通过、0 失败；`npm test` 351 项中 350 通过、1 失败；`git diff --check` exit 0（有 LF/CRLF 转换提示）。结构审阅已按最终内容版本登记：`extensions/coordination-runtime.ts`、`extensions/index.ts`、`extensions/workflow-actions.ts`、`extensions/workflow-dispatch.ts`、`src/coordination-validation.ts`、`test/coordination-runtime.test.js`、`test/coordination-simplification.test.js` 均为保留；本任务同时完整读取并保留 `test/pi-usage.test.js`。
- 基线失败与未执行：唯一失败 `test/pi-usage.test.js`「npm 生命周期 PATH 中的本地 pi shim 不会遮蔽实际 Pi 目录」为基线既有问题——本次改动未触及 `scripts/` 与 `test/pi-usage.test.js`，单独运行该文件仍复现同一断言失败（`test/pi-usage.test.js:98`，`installLaunchers(...) !== true`），与前次记录一致，与本任务无关。未在真实 Pi 会话验证 `coordinationHandoffId` 的模型遵循，未执行 TUI/E2E、真实 Provider 调用或 MCP 验证；当前运行中的 Pi 实例仍持有本会话已加载的旧工具 schema/指导，须 reload 或重启后才能加载更新后的扩展，未声称安装副本已更新。
- 环境与 Git：本仓库 Git 身份为 `CGOSU` / `dev@cgosu.com`；只暂存本工作流的代码、测试与必要文档，预存 `.pi-graph/` 不修改、不暂存，未 push、未部署、未更新版本号或模型配置。

### 2026-10-14：取消工作流任务数量 12 的硬限制，改为规划规模软建议

- 需求：用户确认将 12 从硬限制改为建议，同时保留其余全部校验和现有串行状态机；契约与边界记录在 [`docs/decisions.md`](decisions.md) 的 2026-10-14 条目。
- 完成：`src/workflow-model.ts` 将 `WORKFLOW_MAX_TASKS` 重命名为 `WORKFLOW_RECOMMENDED_TASKS`（值仍为 12，仅用于提示），删除 `validateWorkflowPlan` 的数量拒绝分支并保留非空校验；`src/workflow-replan.ts` 删除 `normalizeReplanPlan` 的单次新增数量拒绝和 `applyWorkflowReplan` 的合并后活动任务数量拒绝，保留 ID 唯一性、历史 ID 禁止复用、依赖存在且无环、角色边界等校验；`extensions/contracts.ts` 的 `tasks` 移除 `maxItems` 并保留 `minItems: 1`；`extensions/index.ts` 工具 description 和 `extensions/control-center.ts` 的 `on` 策略文案改为建议语义。未新增配置、依赖、调度器、嵌套工作流或自动续批，未改状态 schema 版本、local 串行执行和 `auto` 的 2 任务阈值。
- 测试：删除旧超限拒绝用例与纯常量断言，5 个文件移除 `WORKFLOW_MAX_TASKS` 解构/再导出，新增 `test/workflow-task-count.test.js`（8 项）覆盖 16 任务初始规划与依赖顺序、工具 schema 无 `maxItems` 且空任务/缺字段仍被拒、经工具入口的 14 任务真实规划、单次新增 14 且总数 27 的重规划保留已完成摘要/实现原因/验证/依赖、无保留全量替换后仍超 12、16 任务状态 hydrate 恢复且版本与依赖不变、超 12 时空任务/重复 ID/悬空依赖/architect 执行角色仍被拒、超 12 时历史 ID 复用与缺失身份仍被拒。仅断言 schema 无 `maxItems` 与非法任务被拒，不锁定描述文案或建议常量数值。
- 验证：`node --test test/workflow-core.test.js test/workflow-protocol.test.js test/workflow-task-count.test.js test/extension-lifecycle.test.js test/scaffold.test.js` 46 项通过、0 失败；`node --test test/workflow-task-count.test.js` 8 项通过、0 失败；`npm run typecheck` exit 0；`npm test` 338 项中 337 通过、1 失败；`git diff --check` exit 0。
- 未验证与基线失败：唯一失败 `test/pi-usage.test.js`「npm 生命周期 PATH 中的本地 pi shim 不会遮蔽实际 Pi 目录」为基线既有问题——用 `git stash` 移除本次全部改动后单独运行该文件仍失败，与本任务改动无关。未在真实 Pi 安装/reload、TUI/E2E 中验证，也未对异常规模任务测量串行执行时间与状态体积（移除 12 后不再有替代容量上限，风险已在决策条目披露）。
- 环境与 Git：为运行测试执行了 `npm ci --ignore-scripts` 安装 gitignored 的 `node_modules`，`package.json` 与 `package-lock.json` 未修改；未 push，未自动更新已安装 package、模型配置或版本号。

### 2026-10-14：修复 POSIX 手动安装后的 pi-usage 缺失支持模块

- 用户报告：macOS 上出现“大文件扫描不完整”提示（355 个路径无法扫描），并且 `pi-usage` 无法使用。
- 已确认：大文件提示来自项目目录扫描器报告的文件/目录错误；当前仅有错误计数，没有首批诊断中的错误码和路径，因此 macOS 上具体失败位置及其原因未确认。权限/TCC 或扫描目录范围只能作为待核对假设，详见 [`docs/pitfalls.md`](pitfalls.md)。
- 修复：POSIX 安装脚本原先只复制 shell 启动器与 `pi-usage.js`，未复制该 CLI 导入的 `pi-usage-lib` 支持模块。现在脚本委托共享 Node 安装器，并传入已选定的目标目录，保证复制完整模块和嵌入版本信息。
- 验证：`node --test test/pi-usage-installer.test.js` 1 项通过；`git diff --check` 通过。另尝试 `node --test test/pi-usage-installer.test.js test/pi-usage.test.js`，新测试通过，但 `test/pi-usage.test.js` 在执行前因缺少 peer dependency `@earendil-works/pi-coding-agent` 导入 `extensions/index.ts` 失败；Node 版本为 v26.11.1。
- 未执行：未运行全量测试、未安装/更新实际 Pi 启动器、未 reload Pi；用户 macOS 扫描提示仍需首批错误码和路径才能精确诊断。未 push。

### 2026-10-13：修复轮内切角后的职责系统提示不同步

- 现象与复现：用户日志中同一 Agent run 内 architect/docs-commit 往返六次，重规划未推进。独立 harness 确认 switch_role 更新了角色，但旧 before_agent_start 系统段仍写架构职责，只有新的 Agent run 才刷新；这不证明该缺陷是实际往返的唯一原因。
- 完成：新增 extensions/role-handoff.ts；真实轮内角色或模型切换先保存绑定身份的交接记录，再用 terminate 结束旧回合，agent_settled 后仅派发一次新职责续跑。工作流/协调结果验收身份与计划保持不变；同职责确认、闲置切角不额外启动回合，也不触发压缩。
- 恢复与观测：session/branch、角色或业务身份变化会丢弃旧交接；保存失败、派发结果未知或恢复门未确认不自动重放。新增 role.handoff_* 日志事件及 pi-init-role-handoff-state 会话记录，reload 不自动重放该记录。内部续跑沿用原外部请求计时，不在切角时提前报告完成。
- 文档：同步 README、公共职责 Skill、当前状态、交接日志说明、设计决策和踩坑记录。
- 验证：npm test 329 项通过、0 失败、0 跳过；npm run typecheck 通过；git diff --check 通过（存在 LF/CRLF 转换提示）。回归覆盖新职责提示、replanning 不重复派发、同职责/闲置行为、过期身份、失败不重放及计时连续性。
- 未验证：未在用户实际 Pi/Provider 会话重放、未执行真实 Pi TUI/E2E；不宣称已消除所有角色往返或修复底层压缩无回调。
- 授权：用户明确要求更新文档、commit 和 push；仅纳入本任务改动，保留既有 .gitignore 与 .pi-graph/。

### 2026-10-12：修复 Agent 活跃但活动栏看似空闲

- 完成：活动栏在 `agent_start` 后、`agent_settled` 前显示通用 Agent 运行状态；Provider、工具、压缩和工作流状态仍优先显示。用户提供的消息排队现象说明界面空闲外观与宿主队列状态不一致；没有修改 Pi 原生 Working 控件。
- 验证：`node --test test/activity-lifecycle.test.js test/activity-status.test.js`（18 项通过）、`npm run typecheck`、`git diff --check` 均通过。未在真实 Pi TUI 中复现或执行 E2E。
- 遗留：需在用户实际 Pi 会话确认新活动栏是否消除此种界面误判；队列可能来自 Agent streaming 或 compaction，未获取当时宿主事件日志以判定具体分支。

### 2026-10-12：完成架构师主导的持久化角色协作闭环

- 完成：新增可恢复的取证请求/报告/审阅状态、版本化开发任务契约和证据就绪门、身份绑定的 developer 澄清/replan 回路，以及公开 Pi `context` hook 上的角色/任务局部输入视图。复用既有 Local workflow、session append/branch 和恢复身份；不增添 executor、不改写 session 原文。具体协议、模块和行为边界集中记录在 [`docs/plans/role-coordination.md`](plans/role-coordination.md)。
- Context 边界：通过扩展 harness 测试实际 context 返回值、工具调用/结果配对、后续用户指令以及 session/branch 保持；不可靠边界时保留完整输入并返回诊断。Pi 的 system/tool 状态由宿主保留，未使用 `context_with_system`。
- 验证：`npm test` 300 项通过、0 失败；`npm run typecheck` 通过；`git diff --check` 通过（Git 提示工作区文件下次写入时可能从 LF 转为 CRLF）。
- 未验证：未调用真实 Provider/MCP，未执行 Pi TUI/E2E，未测量跨模型缓存命中或费用收益；harness 结果不代表真实宿主/provider 链路。
- Git 收尾：六个 EOF 空行已由 developer-test 移除并重新暂存；`git diff --cached --check`、`git diff --check` 与提交内容检查均通过。仅将本次角色协作成果创建为中文 commit；既有 `/large` 文件及共用文件原有 hunks 保持未提交；未 push。

### 2026-10-10：修复工作流任务启动事件顺序并简化底部活动栏

- 完成内容：已安装 Pi 1.1.0 源码确认 agent_start 先于初始任务消息处理，扩展 message_end 回调又先于 custom 消息写入 branch；因此 Local 工作流改为仅在当前 Agent run 窗口内，按 `message_start` 实际消费的任务消息及完整 workflow/plan/session/recovery/task/attempt/handoff 身份记录启动。统一启动状态持久化失败时仍保持原状态；结果验收时已有 branch 补记路径和 complete/block 身份、branch、角色守卫及 unknown-outcome/retry 语义不变。底部 `workflowStatusBar` 仅移除完成数，内部统计、状态查询、控制中心和报告保留。
- 文档：更新 README、当前状态、决策实施状态和 durable 工作流说明；新增事件顺序陷阱记录。此陷阱描述 Pi 源码与测试 harness 观察，不表示已在真实 Pi TUI/E2E 或模型链路验证。
- 验证：`node --test test/workflow-start-lifecycle.test.js test/workflow-handoff.test.js test/workflow-status-view.test.js test/workflow-persistence.test.js test/workflow-runtime-retirement.test.js test/workflow-compaction.test.js test/workflow-report.test.js test/role-recovery.test.js test/extension-lifecycle.test.js test/file-review-runtime.test.js test/large-command.test.js`，106 项通过；最终 `node --test test/workflow-start-lifecycle.test.js` 5 项通过；`npm run typecheck` 通过；`git diff --check` 通过，仅输出 LF/CRLF 转换提示。未运行全量 `npm test`，未验证真实 Pi TUI/E2E、真实模型链路或长驻实例。
- 收尾：按项目身份创建中文本地 commit，未 push；既有 `/large` 未提交增量保留且未纳入本次提交。

### 2026-10-10：为 Pi `/large` 增加主动结构审阅派发

- 完成内容：`/large` 手动重扫后，仅在完整扫描且存在当前内容版本待审候选时，通过 Pi 用户消息入口尝试派发一次命令专属 AI 审阅。没有候选（包括同版本已审）、扫描失败/不完整、Agent 忙、未结束或恢复异常工作流、职责恢复持久化失败时只报告扫描，不派发、排队或抢占。手动扫描不受职责恢复 pending 或 architect 身份限制，但不确认恢复状态或放开 Agent 工具守卫；AI 审阅仍遵守 developer-test 默认职责、架构证据升级和 auto/confirm/manual 角色切换。默认自动扫描、提示注入及 `file_review` 行为不变。
- 验证：`node --test test/large-command.test.js test/file-review-runtime.test.js test/extension-lifecycle.test.js`，30 项通过；`npm run typecheck` 通过；`git diff --check` 通过（Git 显示 LF/CRLF 转换提示）。
- 遗留：未验证真实 Pi TUI/E2E、Pi 用户消息派发后的真实模型审阅或结论登记；测试覆盖扩展 harness 中的派发与保护逻辑。未运行全量 `npm test`。
- 收尾：本任务文档单独创建中文本地 commit；未 push。

### 2026-10-10：用 Pi `/large` 命令替代大文件扫描 npm 脚本

- 完成内容：移除 `package.json` 中的 `check:large-files` 脚本，新增 `/large` 手动重扫命令，报告当前项目所有超过 500 行的代码文件；复用既有跨语言扫描，保留扫描不完整的错误提示及 architect/职责恢复限制。README、当前状态、决策和测试同步更新；文件审阅状态不会因 `/large` 自动完成。
- 验证：`node --test test/file-review-runtime.test.js test/extension-lifecycle.test.js test/line-count.test.js`，25 项通过、0 失败；`npm run typecheck` 通过；`git diff --check` 通过（有 LF/CRLF 转换提示）。未运行全量 `npm test`，未验证真实 Pi TUI/E2E。
- 收尾：按项目规则创建本任务中文本地 commit；未 push。

### 2026-10-10：更新提交授权规则

- 完成内容：同步全局规则、项目 `AGENTS.md`、中英文生成模板及公共职责路由 Skill：任务完成并通过适用检查后默认以中文创建本任务 commit；只纳入明确归属当前任务的改动，无法区分既有/暂存改动时暂停。push 仍需用户明确授权；协作子 Agent/worker 不独立提交或推送。更新当前状态和决策记录，并澄清知识库 push 的授权要求。
- 验证：静态核对规则文件之间的提交/push语义；`git diff --check` 通过。未运行测试（仅修改规则和文档）。
- 收尾：按新规则创建中文本地 commit；未 push，等待用户明确授权。

### 2026-10-09：扩展大文件结构审阅的语言覆盖

- 完成内容：扫描器和单文件审阅路径新增 Rust `.rs`、Go `.go`、Python `.py`/`.pyi`、PHP `.php`/`.phtml`；为避免把依赖/构建产物当作项目代码，同时排除 `target`、`vendor`、`.venv`、`venv`、`__pycache__` 与 `.tox`。阈值、指纹、持久化状态和审阅结论语义不变。
- 验证：`node --test test/file-review.test.js test/file-review-runtime.test.js` 14 项通过；`npm test` 258 项通过、0 失败、0 跳过；`npm run typecheck` 通过；`npm run check:large-files` 以 0 退出，报告 `extensions/index.ts`（507 行）、`test/helpers.js`（547 行）、`test/pi-usage.test.js`（509 行）为原始超限候选；`git diff --check` 通过（仅有 LF/CRLF 转换提示）。
- 未执行：未在真实 Pi 进程 reload 或验证 TUI/E2E；未提交或推送。语言扩展在下次加载更新后的扩展后生效。

### 2026-10-09：可信工作流阶段、cache来源与压缩长等待软提醒收尾

- 完成内容：状态视图统一供活动栏、状态工具/面板和控制中心使用；当前项位置按真实任务列表与 currentTaskId 计算一基索引，completed/total 保持实际完成数，执行阶段要求匹配 handoff 及真实启动证据。活动 cache 按 session、context generation 和 model 隔离；请求期间历史最终结果标为“上次”，仅匹配最终 assistant message_end usage 显示“本次”，零来源未确认、缺失、无效、失败、中止和缺少结束事件不被旧成功覆盖。30 秒 compaction watchdog 只发一次软提醒，阶段仍为 compacting/in-flight，不判失败、不解锁、不重派发；有效开始时间用于耗时展示，真实错误继续由 onError 表达。
- 验证：`node --test test/workflow-compaction.test.js test/workflow-runtime-retirement.test.js test/workflow-status-view.test.js test/workflow-report.test.js test/activity-status.test.js`，44 项通过；`npm test`，257 项通过、0 失败、0 跳过；`npm run typecheck` 通过；`git diff --check` 通过（Git 输出 LF/CRLF 转换提示）。
- 未验证/收尾：未执行真实 Pi TUI/E2E、Provider 请求或最低支持 Node 版本验证；没有耗时分布用于评价 30 秒阈值或性能。原范围本地里程碑提交 `e0e71cf03d72026dbaa61371f07e3a1833ea84cb` 保持 HEAD；后续阶段、cache、watchdog 和本次文档修改留在工作区，不再提交；未 push、发布或部署。最终 `git status --short` 显示 22 个修改路径（README、3 份项目记忆、18 个后续源码/测试文件），没有未跟踪文件；HEAD 仍是原范围提交。未执行后续 commit、push、发布或部署。详细当前事实见 [`docs/current-state.md`](current-state.md)。

### 2026-10-09：工作流终态、历史恢复隔离与告警确认闭环

- 完成内容：显式工作流取消（`/pi-init workflow cancel` 或 `task_workflow(action="cancel")`）在 `cancelled` 状态成功持久化后才退休对应续跑和提示；工具 `AbortSignal` 只中止本次工具操作，工作流状态保持不变，终态操作也不宣称 Pi 宿主压缩已终止。恢复诊断按白名单区分可隔离、可恢复和 blocked；`discard-recovery` 只对无可读/待持久化状态的不可恢复原记录，在受信任项目、Agent 空闲、精确原 entry/session/branch/error 匹配并显式确认未知外部结果后，追加版本化引用处置；原记录不改写或删除，处置失败保留恢复阻塞。`/pi-init workflow acknowledge` 只收起当前 session/branch/workflow/recovery/reason/attempt 匹配告警的前台突出提示，不改变 workflow 状态、诊断或守卫；问题身份变化、branch 切换和 reload 会重新提醒，终态清除所属标记。Pi 原生压缩、Provider 请求、工具和 cache 活动保持独立。
- 用户文档：README 新增 `cancel`、工具中止、告警确认和历史隔离的区别、使用边界及权限/未知副作用要求。项目记忆更新当前事实和决策；未发现需要新增到 pitfalls 的可复发陷阱。
- 验证：`node --test test/activity-status.test.js test/workflow-report.test.js test/workflow-status-view.test.js test/workflow-runtime-retirement.test.js test/workflow-persistence.test.js`，35 项通过；`npm test`（执行 `node --test`），247 项通过、0 失败、0 跳过；`npm run typecheck` 通过；`git diff --check` 通过（Git 有 LF/CRLF 转换提示）。
- 未验证/收尾：未运行真实 Pi TUI/E2E、Provider 请求或旧长驻 Pi 实例；在本次文档收尾时尚未提交或推送。原范围的本地里程碑提交由后续独立授权任务核对并执行；不推送、发布或部署。

### 2026-10-09：将大文件行数硬门禁改为 Pi 运行时结构审阅

- 完成内容：移除 `npm test` 的 500 行硬门禁；统一扫描策略和 SHA-256 内容指纹，新增超限文件扫描、错误诊断、项目/session/策略绑定的审阅状态，以及 Pi 扩展运行时队列。会话启动扫描既有超限文件，文件工具结果与 `agent_settled` 补扫；`file_review` 分页列出候选，只有完整读取当前文件版本并提交有理由的“保留”或“建议拆分”后才登记完成，内容变化后重新待审。审阅不自动修改代码，不绕过角色恢复门；扫描和持久化失败保持显式。
- 决策：500 个物理行是结构审阅阈值而非写入上限；`npm run check:large-files` 保留为手动候选报告，扫描错误仍失败。JS/TS 与 JSX 是首版范围，排除依赖、VCS 和明确生成目录；新决策替代旧的行数门禁决策及迁移计划中的硬性拆分要求，详见 [`docs/decisions.md`](decisions.md)。
- 验证：`npm test` 228 项通过、0 失败；`npm run typecheck` 通过；`npm run check:large-files` 以 0 退出并报告 `extensions/index.ts`（505 行）及 `test/pi-usage.test.js`（509 行）为待审候选；`git diff --check` 通过（有 LF/CRLF 转换提示）。
- 未执行：未 reload Pi 或运行真实 TUI/E2E；两个扫描候选尚未通过新运行时工具完成结构审阅，待 Pi 加载更新后的扩展后进入待审队列；未提交或推送。
- 详细当前状态见 [`docs/current-state.md`](current-state.md)。

### 2026-10-09：统一活动区、公开 I/O 观察与缓存 usage 语义

- 完成内容：将角色、工作流、压缩、公开 Provider 请求/delta、工具类别、cache usage 和累计 session 工作时间合并到唯一宽度感知活动状态；TUI 保留 Pi 原生 footer/working indicator/OSC 7501，只用一条活动 widget，RPC 使用同源 status，详细工作流信息仍在原详情入口。工具仅按公开事件和白名单类别呈现，不展示参数、命令、路径、URL 或结果，不推测 MCP/codemode 内部过程。
- Cache 边界：Pi 1.1.0 的公开 `Usage` 将 cache 字段定义为数值，Provider adapter 可能把缺失计数规范化为 `0`。活动区因此将全零标为“来源未确认”，不宣称 Provider 明确报告零或推断命中/未命中；结构化解析区分 usage/字段缺失、类型/格式/范围/精度/溢出错误、正数、零、请求失败、中止及缺少 `message_end`。`cacheRead`/`cacheWrite` 仍仅表示 Provider token usage，不代表磁盘/网络 I/O；字段完整有效才呈现正数，部分字段作为 usage 不完整处理且不显示部分结果。
- 依赖：三个 Pi peerDependencies 均为 `^1.1.0`；本地锁定安装的 `pi-ai`、`pi-coding-agent`、`pi-tui` 均为 `1.1.0`。累计工作时间仍按实际 Agent 工作区间累计并从 session 恢复，不计闲置。
- 验证：`node --test test/cache-status.test.js test/activity-status.test.js` 20 项通过；最终 `node --test` 214 项通过、0 失败；`npm run typecheck` 通过；`npm ls @earendil-works/pi-ai @earendil-works/pi-coding-agent @earendil-works/pi-tui --depth=0` 显示三包均为 `1.1.0`；`git diff --check` 通过（仅有 LF/CRLF 转换提示）。`npm test` 在执行 Node 测试前被 500 行数门禁阻断：既有 `test/pi-usage.test.js` 为 509 行；单独的 `node --test` 已运行完整测试集。
- 未执行：真实 Pi TUI/E2E、真实 Provider 请求、全局 Pi 更新、提交或推送。测试只验证本地 Pi 1.1.0 依赖下的扩展 harness 和公开 API 类型/实现边界。
- 当前事实见 [`docs/current-state.md`](current-state.md)，已确认的范围约束见 [`docs/decisions.md`](decisions.md)；可复发的 cache usage 归一化陷阱见 [`docs/pitfalls.md`](pitfalls.md)。

### 2026-10-09：工作流状态、完成、计时与错误展示结构化重构

- 完成：为工作流状态、单任务完成、最终完成、普通执行计时和操作错误拆分类型化视图与纯文本/TUI renderer。状态视图供状态文本、状态栏、进度面板和工具结果使用，刷新/菜单交互仍留在运行层；完成报告保留明确最终任务选择和失败验证筛选；计时保留时区与不可用语义。错误解析以结构化 Result 区分普通错误、非文本/缺失详情、损坏 marker/JSON 及诊断字段错误，只把白名单身份差异和允许标量带入有效视图。
- 边界：瞬时 `workflowPresentation` 只附加到工具结果 `details`；既有 WorkflowState/session schema、状态机与守卫未改。模型侧错误 marker/JSON 和 `isError` 保持原状；缺少展示元数据的旧结果使用原始工具文本回退。500 行单文件限制按用户授权暂免，但未改门禁，既有 `test/pi-usage.test.js` 为 509 行；未运行 `npm test`。
- 验证：定向 `node --test test/tool-render-errors.test.js test/workflow-handoff.test.js test/workflow-report.test.js test/workflow-completion-view.test.js test/run-timing.test.js test/workflow-status-view.test.js test/workflow-protocol.test.js`：37 项通过；最终 `node --test`：196 项通过、0 失败；`npm run typecheck` 通过；`git diff --check` 通过（Git 提示部分工作文件下次写入时会做 LF/CRLF 转换）。最终全量测试覆盖了定向回归之后增加的错误 marker/输入边界断言。
- 收尾：未改版本、依赖或行数门禁；未调用真实模型/API、未 reload，未提交或推送。工作区保留本轮未提交改动。
- 决策见 [`docs/decisions.md`](decisions.md)，当前事实见 [`docs/current-state.md`](current-state.md)。

### 2026-10-09：工作流暂停展示改为类型化视图与双渲染器

- 完成内容：新增只读 `WorkflowPauseView`，结构化表达暂停原因、阻塞原因和恢复动作；纯文本通知与 TUI 结果分别读取视图渲染，移除通过 `split`/中文前缀从摘要中推断段落和颜色的逻辑。保留原报告调用接口、折叠/展开详情与安全恢复提示；未更改状态流转和 retry 守卫。
- 决策：展示信息与文案/主题样式分离，详见 [`docs/decisions.md`](decisions.md)“工作流暂停结果分离人类摘要与技术详情”。
- 验证：`node --test test/workflow-pause-view.test.js test/workflow-report.test.js test/tool-render-errors.test.js` 7 项通过、0 失败；`npm run typecheck` 通过；`git diff --check` 通过（有 LF/CRLF 转换提示）。未运行完整测试套件。
- 未执行：未调用模型、未 reload、未执行外部写入、未提交或推送。

### 2026-10-09：工作流暂停结果分区展示

- 完成内容：暂停工具结果改为分区摘要，突出进度、阻塞任务、原因和分步恢复操作；自动通知和 block 结果也采用同一分区结构。暂停结果不再以成功标记呈现，完整身份与任务技术状态仅在展开结果中显示。对未知暂停原因使用保守说明；未知执行结果仍先核对外部副作用，再显示显式确认 retry 命令。未改状态流转、身份校验或 retry 行为。
- 决策：摘要面向人类，身份与完整任务状态放在展开详情；详见 [`docs/decisions.md`](decisions.md)“工作流暂停结果分离人类摘要与技术详情”。
- 验证：`node --test test/workflow-report.test.js` 3 项通过、0 失败；`npm run typecheck` 通过；`git diff --check` 通过（有 LF/CRLF 转换提示）。未运行完整测试套件。
- 未执行：未调用模型、未 reload、未执行外部写入、未提交或推送。

### 2026-10-09：工作流失败 TUI 展示与 2.0.4 版本更新

- 完成内容：`task_workflow` 失败结果增加人类可读的分段分类显示，提供错误类别/代码、原因、白名单身份差异和安全下一步；普通错误与损坏诊断保留真实原文。模型可见 `[PI-INIT_WORKFLOW_ERROR]` JSON、错误状态和工作流守卫未变。将 `package.json` 与 `package-lock.json` 根包版本从 `2.0.3` 更新为 `2.0.4`。
- 决策：TUI 格式化与模型诊断协议分离；身份字段只按白名单展示。详见 [`docs/decisions.md`](decisions.md)。
- 验证：`npm run typecheck` 通过；`node --test test/tool-render-errors.test.js test/workflow-handoff.test.js` 12 项通过；`node --test` 177 项通过、0 失败；`git diff --check` 通过（有 LF/CRLF 转换提示）。`npm test` 在运行 Node 测试前被 `scripts/check-line-count.js` 阻断，因 `test/pi-usage.test.js` 为 509 行；`git show HEAD:test/pi-usage.test.js` 确认该文件已在既有 `8a4129f` 提交中且未被本次修改。遵照用户要求暂不处理此限制，未将 `npm test` 描述为通过。
- 未执行/遗留：未调用模型、未 reload 当前 Pi、未发布。本地 `master` 原已领先 `origin/master` 一个无关提交 `8a4129f`；推送当前分支会一并包含该提交，因此先完成本地提交，推送范围待用户明确确认。

### 2026-10-08：pi-usage 按模型展示缓存命中率和账单 Token

- 完成内容：终端 Models 表新增每模型缓存命中率列，合计行按总量计算；SVG 对账单在每模型明细中增加总 Token 和缓存命中率，并扩展模型行间距及画布高度。比例复用 `(cacheRead + cacheWrite) / tokens`，零 Token 显示 0；用量采集和查询语义未变。
- 决策：见 [`docs/decisions.md`](decisions.md)“pi-usage 统计页与账单按模型显示缓存命中率和 Token”。
- 验证：`node --test test/pi-usage.test.js`，14 项通过、0 失败。
- 遗留：工作流状态工具持续拒绝与 `status` 完全一致的基础身份，任务无法通过工作流接口完成交接；实现与测试已完成，未提交或推送。

### 2026-10-08：完成 src JavaScript 到 TypeScript 迁移与最终验证

- 完成内容：将 `src` 的 11 个实现迁为唯一 `.ts` 实现：计时工具、角色配置、工作流模型/恢复/转换/重规划/handoff/入口，以及脚手架和模板同步；新增 `role-types.ts`、`workflow-types.ts`、`scaffold-types.ts`。同步 extensions、内部源码与测试的直接导入，删除对应 `.js` 与旧 `.d.ts`，未保留转发层。`tsconfig.json` 使用 strict/noEmit/NodeNext 等设置，`allowJs: false`，仅检查 `extensions/**/*.ts` 和 `src/**/*.ts`；scripts/tests 保持 JS，不增加构建步骤或运行器。
- 验证：`npm run typecheck` 通过；`npm test`（含行数门禁）176 项通过、0 失败；`git diff --check` 通过（有 LF/CRLF 转换提示）。`node --test test/workflow-runtime-exports.test.js` 1 项通过；Node v24.14.1 原生直接导入 TypeScript 并执行工作流角色/身份检查通过。Pi 1.1.0 隔离 RPC 加载当前扩展并发现 `/fast`、`/pi-init`，未发送 prompt 或调用模型。`npm pack --dry-run --ignore-scripts --json` 核对 68 个包文件，14 个迁移实现/共享类型均包含，`test/` 未打包；旧 `.js` 导入搜索无匹配。
- 未确认/未执行：Node `>=22.19.0` 最低版本未实测。先前长驻 Pi 进程不可检查；静态 Jiti 调度与新 Pi RPC 均通过，但不能证明旧进程已恢复，导出函数缺失的历史根因（包括是否为缓存、旧 package 或不同代码副本）未确认，详见 [`docs/pitfalls.md`](pitfalls.md)。未执行真实模型请求、扩展 reload、commit 或 push。

### 2026-10-08：关闭工作流角色死锁与压缩续跑风险

- 完成内容：工作流 plan/replan 拒绝 `architect` 作为执行角色；旧活动计划中的非法角色保留原记录、报告恢复错误并阻止自动派发，可由用户显式取消或另建计划。压缩续跑绑定 operation、目标角色、角色/上下文代次、session/branch 及当前 workflow/replan 身份；只有该操作自己的 callback 能完成交接，过期 callback 和无归属 `session_compact` 不续跑。普通角色切换不再额外触发空回合；压缩失败排入 `triggerTurn: false` 的模型可见诊断。branch 改变会使旧角色确认失效；恢复提示按 auto/confirm/manual 模式提供相符操作，manual 无法验证角色时指引 `/pi-init role`。
- 实现取舍：未放宽 architect、身份、branch、attempt 或未知结果保护；未自动重命名旧角色、重放旧 attempt、自动 retry 或用新身份绑定旧结果。已取消的旧工作流没有恢复或重放。
- 验证：定向 `node --test test/workflow-protocol.test.js test/workflow-handoff.test.js test/workflow-compaction.test.js test/role-recovery.test.js`，42 项通过；`node --test test/extension-lifecycle.test.js`，12 项通过；最终 `npm test`（含 500 行检查）173 项通过、0 失败、0 跳过；`git diff --check` 通过。
- 未执行：真实 Pi 压缩 callback/跨 branch/reload E2E、扩展安装或 reload、TypeScript 单独检查；原 stale identity 故障的实际失配字段仍未知。未提交或推送。

### 2026-10-08：修复 queued 工作流交接的结果验收闭环

- 完成内容：`complete`/`block` 提交时若当前 handoff 仍处于 `queued`，只有基础身份与任务 attempt/handoff 身份匹配、活动 branch 含精确交接消息且当前角色符合任务角色，才由 dispatch 记录真实任务开始并重新执行严格 `executing` 校验。身份拒绝以模型可见 JSON 返回稳定 code、字段差异、白名单 expected/received 与安全下一步；status、任务提示和重规划提示通过共享身份构造器提供可直接复用的 JSON，status 保持只读。dispatching、身份过期、branch 缺失、角色不符及未知结果仍被拒绝，未全局放宽验收权限。
- 根因边界：复现了结果调用面对 queued handoff 会因尚未标记 executing 而被拒绝；缺少原始 stale identity 调用参数和事件时序，未确认该 stale 错误的具体字段或根因。没有证据要求改变恢复时未知结果策略。
- 验证：`node --test test/workflow-handoff.test.js test/workflow-report.test.js test/workflow-protocol.test.js test/workflow-replan-directions.test.js`，16 项通过；`npm test`，165 项通过、0 项失败、0 项跳过（含行数检查）。
- 未执行：真实 Pi 会话 E2E、扩展安装/reload、原故障会话重放；未提交或推送。

### 2026-10-08：完成编排可靠性最终验证与文档收尾

- 完成内容：以实际最终验证结果更新 `docs/plans/durable-workflow.md` 和 `docs/current-state.md`，注明全量测试结果及未执行的真实 Pi E2E/安装/reload/依赖升级边界。
- 阶段提交：持久化一致性 `bb46a7afb85fa752c168c145065333145035e2b1`（`修复工作流状态持久化失败一致性`）；可恢复交接及其文档 `85bb460a1e30ee4ad8974611acd24d0dc2dcbe1`（`完成可恢复工作流交接与结果隔离`）。未 push。
- 验证：`npm test` 已通过 `scripts/check-line-count.js`，Node 测试 162 项全部通过，0 失败、0 跳过。
- 遗留限制：未运行真实 Pi E2E，未安装/reload、升级依赖或接入 AgentHarness durable operation；当前实现只提供 Pi Extension session entry/branch 范围的状态恢复，不承诺外部副作用 exactly-once。

### 2026-10-08：完成工作流可恢复交接与执行尝试隔离

- 完成内容：工作流持久状态升级至 v4，记录 workflow/plan/session/recoveryGeneration 身份、task attempt/handoff 和 replan continuation；通过当前 session branch 校验 `complete`/`block`/`replan`，在 `agent_start` 持久化真实启动身份。可证明未派发的准备阶段可恢复续接；已派发/启动但无业务结果、legacy `in_progress` 或执行身份缺失时 fail-closed 暂停，未知结果需先核对再显式 retry。保持 local 顺序执行、`task_workflow` 唯一验收权威、旧 Runtime 退役错误及旧 entry 不原地改写。
- 文档：README、公共 `pi-init-role-routing` Skill、current-state、decisions、pitfalls 与本计划记录恢复契约、工具身份、未知副作用限制和 Pi durable API 边界；不宣称已接入 AgentHarness durable execution 或保证 exactly-once。
- 验证：`node --test test/workflow-core.test.js test/workflow-handoff.test.js test/workflow-compaction.test.js test/workflow-persistence.test.js test/workflow-protocol.test.js test/workflow-replan-directions.test.js test/workflow-report.test.js test/workflow-runtime-retirement.test.js test/extension-lifecycle.test.js`，45 项通过；`node scripts/check-line-count.js` 通过；`git diff --check` 通过，仅有 Windows 工作区 LF/CRLF 转换提示。
- 遗留：全量 `npm test` 留待最终交付验证；未运行真实 Pi E2E，未升级依赖、安装/reload 或 push；本阶段按授权独立使用中文 commit 信息提交。

### 2026-10-08：修复工作流状态持久化失败时的提前提交

- 完成内容：将 `persistWorkflowState` 的内存提交移至 `pi.appendEntry` 正常返回之后；启动状态持久化失败恢复调度标志并传播错误，暂停状态写入失败释放 dispatch 锁并明确报错。测试 harness 支持注入 append 异常，新增三个持久化一致性回归测试。
- 持久化边界：不声称 session entry append 提供磁盘事务/外部操作 exactly-once；Pi 新 durable 执行接口和后续交接恢复范围见 [`docs/plans/durable-workflow.md`](plans/durable-workflow.md)。
- 验证：`node --test test/workflow-persistence.test.js`，3 项通过；`node --test test/workflow-persistence.test.js test/workflow-compaction.test.js test/workflow-protocol.test.js test/workflow-report.test.js`，16 项通过；`node scripts/check-line-count.js`、`git diff --check` 和新增测试文件的 whitespace 检查通过（仅有 LF/CRLF 转换提示）。
- 遗留：尚未实现交接阶段持久化和 attempt/revision 旧结果隔离；全量 `npm test` 留待最终交付；未执行真实 Pi E2E、依赖升级或 push。

### 2026-10-06：退役 pi-init 自建外部 Runtime 工作流

- 完成内容：移除 Runtime 专用客户端、配置、wire、Graph/事件投影、执行与恢复接线及其专用测试；工作流执行固定为当前主会话内的 local 顺序流程。显式旧 Runtime 配置/状态以结构化退役错误 fail-closed；查询和动作保留错误，不本地重放或改写旧 session entry。保留会话默认模型、角色/恢复安全边界、上下文压缩和精简暂停报告。
- 文档：README、当前状态、公共角色路由 Skill 和中英文项目模板改为 local-only；删除已退役的 Runtime client 使用指南，将迁移计划标记为历史并由退役决策替代。
- 决策：见 [`docs/decisions.md`](decisions.md)“退役 pi-init 自建 Runtime 工作流集成”。旧配置请用户手动检查清理；pi-init 不自动更改配置或 session 数据。未接入/核实官方 Runtime 接口。
- 验证：`node --test test/extension-lifecycle.test.js test/workflow-core.test.js test/workflow-protocol.test.js test/workflow-replan-directions.test.js test/workflow-report.test.js test/workflow-runtime-retirement.test.js test/workflow-compaction.test.js test/role-model-persistence.test.js`，39 项通过；`node --test test/role-recovery.test.js`，14 项通过；`npm test`，152 项通过、0 失败、0 跳过；`node scripts/check-line-count.js` 与 `git diff --check` 通过。
- 未执行：真实 Pi E2E、安装/更新/reload、外部 Runtime/官方接口集成。未提交或推送。

### 2026-10-06：移除内置角色模型预设并精简工作流暂停输出

- 完成内容：移除标准职责的固定 provider/model/thinkingLevel 预设。没有项目配置或没有任何显式角色映射（包括 schema v2 缺少 `roleModels`/映射为空且无兼容旧版顶层映射）时，标准职责使用当前 Pi 会话模型和推理强度；显式映射优先，未知自定义角色仍需配置。无会话模型、损坏/无效配置、显式模型不可用或凭据缺失保持真实错误，不静默 fallback。无映射标准职责的手动模型切换不生成映射；Runtime 创建时将实际模型和推理强度冻结到 `profile_snapshot`。
- 完成内容：暂停通知和 `task_workflow block` 结果改用精简摘要，保留每项真实阻塞原因及 retry/replan 建议，避免原因/建议重复及把已完成任务的长描述、摘要重复倾倒到暂停输出。block 工具不再并行发送相同 toast；显式 status/TUI 查询及持久化状态仍保留完整详情。
- 修改范围：`src/roles.js`、角色运行时/Runtime 快照调用、工作流报告与派发/工具动作、对应回归测试及 README、当前状态、决策和公共 Skill；未修改用户 `.pi/role-models.json`。
- 决策：见 [`docs/decisions.md`](decisions.md)“工作流暂停输出采用精简摘要并避免重复通知”和“移除内置角色模型预设并回退到会话默认”。
- 验证：`node --test test/extension-lifecycle.test.js test/session-model-fallback.test.js`，16 项通过；`node --test test/workflow-report.test.js test/workflow-protocol.test.js test/workflow-compaction.test.js`，最终 13 项通过。该工作流测试首次因 harness 未设为受信任而有 1 项失败，修正测试夹具后重跑通过。
- 验证：`npm test`，167 项中 164 项通过、0 项失败、3 项跳过（需先构建 `runtime-daemon` 或设置 `AGENT_RUNTIME_DAEMON`）；`node scripts/check-line-count.js` 通过；`git diff --check` 通过，仅有 LF 将转为 CRLF 的提示。
- 遗留：未安装/更新 package、未执行 `/reload`、未在真实 Pi 会话进行 E2E；3 项 Runtime daemon 测试未执行。未提交或推送。

### 2026-10-06：让 `/fast` 手动进入单次精简流程

- 完成内容：`/fast` 现在表示用户为本次任务显式选择 Fast Path，不再重复检查自动资格中的任务类型、规模和修改范围；同步命令提示、中英文脚手架规则、公共角色路由 Skill、README 和项目当前状态。保留忙碌 Agent/未结束工作流保护，并明确安全、职责、上下文恢复和必要验证仍优先。
- 决策：见 [`docs/decisions.md`](decisions.md) 的“`/fast` 手动启用单次精简流程”。
- 验证：`node --test test/extension-lifecycle.test.js test/scaffold.test.js`，25 项全部通过。
- 遗留问题：未运行全量测试；尚未在真实 Pi 会话确认 slash command 的交互及模型对新提示的遵循效果。未提交或推送。

### 2026-09-30：新增一次性 `/fast` 命令

- 完成内容：新增 `/fast <任务描述>`，通过 user message 为本次任务请求 Fast Path；不是持久模式或强制执行保证。只在符合既有 Fast Path 条件时请求直接定位、读取最小上下文、实现和风险匹配的最小核对；权限、安全、项目规则、architect 边界与必要验证仍优先。Agent 忙碌或工作流处于 running、paused、replanning 时拒绝派发；completed/cancelled 不阻止新的独立任务。
- 修改范围：`extensions/index.ts`、`test/helpers.js`、`test/extension-lifecycle.test.js`、`README.md`、`docs/current-state.md`、`docs/session-log.md`。
- 验证：`node --test test/extension-lifecycle.test.js`，12 项通过；`npm test`，158 项中 155 项通过、0 项失败、3 项跳过（需先构建 `runtime-daemon` 或设置 `AGENT_RUNTIME_DAEMON`）；测试脚本中的 500 行约束通过。
- 遗留问题：未在真实 Pi 交互会话中确认 slash command UI，也未验证模型对提示的实际遵循效果；命令本身仅传达用户请求，不能强制 Fast Path。

### 2026-09-30：回退角色模型 v3 分层配置

- 完成内容：按用户确认执行 `git revert --no-commit 80710e8`，恢复旧的扁平 `roleModels` / `schemaVersion: 2` 实现；未改写已推送历史、未推送回退提交，也未触碰 `AGENTS.md` 原有工作区修改。
- 完成内容：测试验证期间发现角色模型选择器测试默认使用仓库 cwd，会读取当前项目配置；将其隔离到临时目录。将公共 Skill frontmatter 断言改为兼容 CRLF。未读取、修改或删除任何项目 `.pi/role-models.json`。
- 修改范围：反向回退 `80710e8` 涉及的 `docs/`、`extensions/`、公共 Skill、`src/`、`test/` 文件，并在 `test/extension-roles.test.js`、`test/scaffold.test.js` 增加测试隔离与换行规范化。
- 验证：角色配置、scaffold、控制中心及持久化针对性测试 52 项通过；`npm test` 157 项中 154 项通过、0 项失败、3 项跳过（需先构建 `runtime-daemon` 或设置 `AGENT_RUNTIME_DAEMON`）；`git diff --check` 与 `git diff --cached --check` 无空白错误。
- 遗留问题：此前保存的 schema v3 分层 `.pi/role-models.json` 不会自动迁移，需用户单独转换为扁平 `roleModels` 格式；3 项 Runtime daemon 测试未执行；回退提交尚未推送。

### 2026-09-24：修复上一级菜单 Ctrl+S 后的未保存提示

- 完成内容：上一级控制中心菜单按 `Ctrl+S` 保存后，通过全局通知同步报告成功或失败，避免角色配置已写入项目文件后仍留下此前的“尚未保存”提示；新增从角色配置菜单返回上一级再保存的回归测试。
- 修改范围：`extensions/control-center.ts`、`test/control-center-menu.test.js`、`docs/current-state.md`、`docs/session-log.md`。
- 验证：`npm test`，152 项通过、3 项跳过；`git diff --check` 通过。
- 遗留问题：未在真实 Pi TUI 会话中人工确认通知展示。

### 2026-09-23：TUI 启动时提示当前角色模型

- 完成内容：session 启动完成角色匹配后，仅在 TUI 中通过一条简短 info 通知展示当前匹配角色和精确 provider/model；非 TUI 或当前模型未匹配项目角色时不输出通知。
- 修改范围：`extensions/index.ts`、`test/role-model-persistence.test.js`、`docs/current-state.md`、`docs/session-log.md`。
- 验证：`node --test test/role-model-persistence.test.js test/extension-lifecycle.test.js`，14 项通过；`node scripts/check-line-count.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实 Pi TUI 中人工确认通知布局；未提交或推送。

### 2026-09-23：让 Ctrl+S 保存反馈留在菜单内

- 完成内容：控制中心各级菜单和角色模型搜索/推理强度菜单在 Ctrl+S 后立即显示保存中状态，并在操作完成后展示成功或失败结果；角色配置保存统一返回结构化结果，`/pi-init save` 命令仍通过通知反馈。
- 修改范围：`extensions/contracts.ts`、`extensions/index.ts`、`extensions/role-runtime.ts`、`extensions/ui.ts`、`test/control-center-menu.test.js`、`test/role-model-persistence.test.js`、`docs/current-state.md`、`docs/session-log.md`。
- 验证：`node --test test/control-center-menu.test.js test/role-model-persistence.test.js`，8 项通过；`npm test`，146 项通过、3 项跳过。
- 遗留问题：未在真实交互式 Pi TUI 会话中人工确认；未提交或推送。

### 2026-09-22：为 pi-usage 增加 SVG 对账单生成

- 完成内容：新增 `scripts/pi-usage/bill.js`，按现有查询 summary 生成参照示例风格的中文纵向 SVG；`pi-usage` 使用通用的 `--output <路径>` 导出 SVG，不增加独立账单模式参数，原有文本报表保持不变。
- 完成内容：对账单时间范围完全复用普通查询参数，展示真实费用、模型明细、Token、输入/输出、缓存命中率和会话数，加入 API 等值估算/非实际账单说明；新增动态文本 XML 转义、空数据、时间范围、输出路径和安装器支持文件回归测试。
- 修改范围：`README.md`、`scripts/pi-usage.js`、`scripts/pi-usage/cli.js`、`scripts/pi-usage/bill.js`、`test/helpers.js`、`test/pi-usage.test.js`、`docs/current-state.md`、`docs/decisions.md`、`docs/session-log.md`。
- 验证：`node --check scripts/pi-usage/bill.js`、`node --check scripts/pi-usage/cli.js`、`node --check scripts/pi-usage.js`；`node --test test/pi-usage.test.js`，13 项通过；`npm test`，147 项中 144 项通过、3 项跳过；`node scripts/check-line-count.js` 和 `git diff --check` 通过。
- 遗留问题：当前输出为无新增依赖的 SVG，不直接生成 PNG；尚未执行 package 安装或 reload。

### 2026-09-21：按 Test Value Gate 清理低收益测试

- 完成内容：重新梳理测试和断言，移除普通计时报告、session 时间展示、菜单布局、状态样式、Prompt 文案、通知文案、简单渲染存在性和内部临时字段的低收益断言；保留状态、数据、持久化、权限、安全、Runtime 协议、幂等派发和生成模板关键规则验证；删除仅验证 Runtime 执行器菜单文案的 `test/workflow-runtime-menu.test.js`。
- 修改范围：`test/architect-boundary.test.js`、`test/cache-status.test.js`、`test/control-center-menu.test.js`、`test/edit-guard.test.js`、`test/extension-lifecycle.test.js`、`test/extension-roles.test.js`、`test/pi-usage-range.test.js`、`test/pi-usage.test.js`、`test/role-model-persistence.test.js`、`test/role-recovery.test.js`、`test/run-timing.test.js`、`test/session-work-time.test.js`、`test/workflow-compaction.test.js`、`test/workflow-protocol.test.js`、`test/runtime-integration.test.js`、`test/workflow-runtime-backend.test.js`、`test/scaffold.test.js`。
- 验证：`npm test`，141 项通过、3 项跳过；`node scripts/check-line-count.js` 通过；`git diff --check` 通过。
- 遗留问题：本次修改尚未提交或推送。

### 2026-09-20：关闭详细阶段耗时监控

- 完成内容：关闭 Provider 请求、工具执行和 Agent 生命周期的逐次耗时采集与报告展示；保留普通 `pi-init-run-timing` 总耗时及 session `Worked for` 所需的基础计时。
- 验证：`node --test test/run-timing.test.js`，2 项通过；`npm test`，159 项中 156 项通过、3 项跳过；`node scripts/check-line-count.js` 和 `git diff --check` 通过。
- 遗留问题：详细监控保留为关闭状态，后续如需再次定位 Provider/工具延迟可重新打开开关；未提交、未推送。

### 2026-09-20：增加简单无工具问答快速通道

- 完成内容：新增 `extensions/runtime-routing-context.ts`，在 `before_agent_start` 的 `sections.pi_init_runtime` 注入当前有效职责、Provider/模型/推理强度、恢复门和活动工作流摘要；同步调整职责恢复提示，区分无活动工作流与活动工作流。
- 完成内容：无活动工作流且 `roleRecoveryPending` 时允许无需工具或新证据的简单回答，但不自动写入 acknowledged；活动工作流仍要求先查看状态，执行类工具继续受原有恢复门和 architect 守卫保护。
- 约束落实：不做用户文本启发式分类、不自动切换模型、不自动确认职责、不修改 `selectedTools`，不替代 `tool_call` 硬守卫。
- 验证：`node --test test/role-recovery.test.js`，11 项通过；`npm test`，158 项中 155 项通过、3 项跳过；`node scripts/check-line-count.js` 和 `git diff --check` 通过。
- 遗留问题：尚未在真实压缩恢复后的 Pi 会话中确认简单问答是否减少 Provider 回合；未提交、未推送。

### 2026-09-20：增加首次执行阶段耗时诊断

- 完成内容：新增 `extensions/run-timing-diagnostics.ts`，在不改变 Agent 生命周期的前提下记录外部执行的 `input`、`before_agent_start`、`agent_start`、Provider 请求、首个 assistant `message_update`、`message_end`、`agent_end`、工具执行和 `agent_settled` 时间点，并记录每次 Provider/工具耗时、Provider 请求、Agent run、工具次数及工具名称。
- 完成内容：将诊断状态从 `extensions/index.ts` 拆出，并补充运行计时测试，避免主扩展和报告文件超过项目 500 行代码限制；旧报告没有新增字段时保持原格式。
- 验证：`node scripts/check-line-count.js` 通过；`npm test` 通过 153 项、跳过 3 项；`node --test test/run-timing.test.js` 2 项通过；`git diff --check` 通过。
- 遗留问题：尚未在真实交互式 Pi 中收集新的 Agent/工具阶段数据；未提交、未推送。

### 2026-09-20：对齐 Pi 0.86.0 依赖

- 完成内容：从 npm registry 确认 `@earendil-works/pi-coding-agent` 最新版为 `0.86.0`；将 Pi 相关 peer 依赖对齐到 `^0.86.0`，`typebox` 对齐到 `^1.3.27`，Node 最低版本提升到 `22.19.0`，并刷新 `package-lock.json`。本地依赖已安装为 `pi-coding-agent/pi-ai/pi-tui 0.86.0`、`typebox 1.3.34`。
- 验证：`npm install --ignore-scripts` 成功；`npm ls @earendil-works/pi-coding-agent @earendil-works/pi-ai @earendil-works/pi-tui typebox --depth=0` 无 invalid 依赖；`npm test` 通过 153 项、跳过 3 项；`git diff --check` 通过。
- 遗留问题：尚未执行 `pi update --extensions`、当前 Pi `/reload` 或重启；未提交、未推送。

### 2026-09-18：修复 Local 工作流任务交接假死

- 完成内容：将主动压缩生命周期拆分为独立控制器；同角色连续 Local 任务跳过主动边界压缩；以 operationId 幂等处理压缩完成、失败和 `session_compact` 信号；watchdog 只告警，session shutdown/reload 清理定时器和瞬态锁。
- 完成内容：Local 状态栏和进度摘要以 `executionStartedAt` 区分真实 Agent 执行与任务交接/等待启动/压缩阶段；`/pi-init workflow resume` 增加安全 kick，保护已启动、已排队或压缩中的任务不重复派发。
- 验证：`node --test test/workflow-compaction.test.js`，9 项全部通过；`npm test`，156 项全部通过并通过 500 行代码行数检查；`git diff --check` 通过，仅有 Windows 工作区预期的 LF/CRLF 转换提示。
- 遗留问题：尚未在真实交互式 Pi 长工作流中复现并进行性能/压缩时序观测；`compact()` 无扩展层取消句柄，watchdog 停滞后仍需等待 Pi 完成或 reload 后再 resume；未安装 package、未 reload/重启当前 Pi、未提交或推送。

### 2026-09-17：修复模板同步 reload 后使用旧 ctx

- 完成内容：同步完成后由 `syncProject` 返回 `reloaded` 状态；控制中心当前项目发生变更并 reload 后直接结束旧菜单调用，避免 `continue` 重新使用失效的 command context；增加菜单不再二次进入的回归断言。
- 验证：`node --test test/control-center-menu.test.js`，9 项通过；`npm test`，149 项通过；`git diff --check` 通过（仅 Windows LF/CRLF 转换警告）。
- 遗留问题：未安装 package、未在真实 Pi 会话中 reload/重启、未提交或推送；当前未增加真实交互式 reload E2E。

### 2026-09-15：将 Worked for 改为 session 累计工作时间

- 完成内容：保留普通工作报告中的每轮耗时；新增 session 级 Agent 实际工作时间累计，Pi 工作时清除空闲提示并使用原生 `Working`，空闲后在编辑器上方显示累计的 `─ Worked for ... ─`；每次 `agent_settled` 持久化累计快照，恢复 session 时优先读取快照并兼容已有普通执行记录。
- 验证：`node --test test/session-work-time.test.js test/run-timing.test.js`（6 项通过）；`npm test`（149 项通过）。
- 遗留问题：本轮修正尚未提交或推送；未执行安装、reload；真实交互式 TUI 视觉效果未在终端中手工确认。

### 2026-09-15：将普通执行完成态改为 Worked for 分隔线（已被本条替代）

- 完成内容：复用既有普通执行计时和 `pi-init-run-timing` session entry；Pi 空闲后将 TUI 展示从多行时间报告改为类似用户截图的 `─ Worked for ... ─` 横向分隔线，保留完整计时数据。
- 验证：`node --test test/run-timing.test.js test/extension-lifecycle.test.js`（13 项通过）；`npm test`（144 项通过）。
- 遗留问题：未执行安装、reload、commit 或 push；真实交互式 TUI 视觉效果未在终端中手工确认。

### 2026-09-15：优化控制中心分组菜单和窄屏说明显示

- 完成内容：将控制中心根菜单调整为“初始化/变更/同步/工作流”四个顶层入口；初始化、变更进入次级菜单，同步和工作流保留直接操作；TUI 选择菜单改用宽弹窗，选中项说明在列表下方自动换行；同步更新 README 和项目记忆。
- 验证：`node --test test/control-center-menu.test.js test/extension-roles.test.js`（24 项通过）；`npm test`（144 项通过）。
- 遗留问题：未执行安装、reload、commit 或 push。

### 2026-09-15：完成模板同步与统一 Ctrl+S 保存

- 完成内容：补充 README 的 `/pi-init sync`、托管区块、历史保留、冲突语义和统一 `Ctrl+S` 保存说明；同步记录模板状态、决策取舍和实际验证结果。
- 验证：`node --test test/control-center-menu.test.js test/extension-roles.test.js test/extension-lifecycle.test.js test/scaffold.test.js test/scaffold-sync.test.js`，50 项全部通过；`npm test`，142 项全部通过；`git diff --check` 通过（仅 Windows LF/CRLF 转换警告）。
- 遗留：未安装 package、未 reload/重启当前 Pi、未提交、未推送。

### 2026-09-15：将 Fast Path 约束加入项目脚手架模板

- 完成内容：中英文 `templates/AGENTS.md` 增加 Fast Path 会话收尾优先级、退出条件、文档目标例外和用户显式要求例外；更新脚手架测试覆盖生成内容及章节顺序。
- 验证：`node --test test/scaffold.test.js`，13 项全部通过。
- 遗留：未运行全量测试；未安装 package、reload 当前 Pi、提交或推送。

### 2026-09-15：明确 Fast Path 的文档同步边界

- 完成内容：全局 `AGENTS.md` 增加 Fast Path 的通用最小同步原则和直接关联内容例外；项目 `AGENTS.md` 明确无新事实、重要决策、遗留问题、关键验证结果或可复发陷阱时，可跳过四类项目记忆文档更新。
- 验证：定向读取并核对全局与项目 `AGENTS.md` 的相关章节；`git diff -- AGENTS.md` 已确认项目规则变更。
- 遗留：未运行测试；未执行 Git commit、push 或 package 安装/reload。

### 2026-09-14：移除 subagents、subtask、collaboration 委派执行链路

- 完成内容：工作流执行器收窄为 `local`/`runtime`；删除 subtask 结果协议、collaboration Agent 进程/registry/消息/overlay/reservation/session-tail 工具链、控制中心选项、调度分支、超时与结果消费；删除对应测试和第三方源码声明。历史 local/runtime 状态中的 delegation 字段仍可读取，但不再推进委派状态。
- 验证：`npm test`，132 项全部通过；`node --check` 覆盖修改后的扩展、核心模型和转换模块，全部通过；`git diff --check` 通过（仅 Windows LF/CRLF 转换警告）。
- 遗留：未更新已安装 Pi package、未 reload/重启当前 Pi、未提交、未推送；历史文档中的旧执行器记录仅作为历史保留。

### 2026-09-14：新增保存 Ctrl+S 快捷键

- 完成内容：TUI 中包含保存项的菜单（控制中心及“角色与模型”菜单）支持按 `Ctrl+S` 直接触发保存，并显示快捷键提示；新增对应回归测试。
- 验证：`node --test test/extension-roles.test.js`，16 项全部通过。
- 遗留：未执行 Git commit、push、安装 package 或 reload。

### 2026-09-14：为 Windows 终端补充保存快捷键

- 完成内容：部分 Windows 终端可能拦截 `Ctrl+S`，角色配置菜单新增 `F2` 保存回退方式，并更新菜单提示和 README；`/pi-init save` 命令保持不变。
- 验证：`node --test test/control-center-menu.test.js`，11 项全部通过。
- 遗留：未在用户实际 PowerShell/Pi TUI 终端复现或端到端确认按键传递；未安装 package、reload、提交或推送。

### 2026-09-13：确认第二 Provider 的安全边界并完成 Runtime 回归

- 完成内容：确认 Codex CLI 取证尚不足以实现 Runtime `AgentProvider` 生命周期，保持真实 adapter blocked；agent-runtime 只提供无模型 `command-fixture`，pi-init Runtime client 保持 backend-agnostic，不猜测 CLI 参数或增加本地 fallback。Runtime 双轨迁移的 `cutover-ready` 仍为否。
- 验证：`node --test test/runtime-client.test.js test/workflow-runtime-backend.test.js test/runtime-integration.test.js`，16 项通过；Rust workspace 与 execution/daemon focused 回归由 agent-runtime 会话记录维护。
- 遗留：真实 Codex lifecycle/认证/重连和生产隔离仍需固定版本官方证据；真实 Pi 继续显式 ignored；未更新已安装 package、未 reload/重启、未提交、未推送。

### 2026-09-13：完成 Runtime 双轨联调、恢复投影和旧链路切换清单

- 完成内容：新增 `test/runtime-integration.test.js`，用实际 `runtime-daemon` development direct-host fixture 和无模型 Pi RPC fixture 验证同一计划的 local/runtime authority 差异、role execution、Graph submit、Result/event ack、cancel/retry、重复 request、context compaction、terminal daemon restart、branch reload 和 client reconnect；Runtime workflow 不发送本地 task message。新增 `docs/plans/runtime-migration.md`，逐符号记录旧 scheduler/transition/dispatch 的直接调用方、保留/迁移/删除条件；旧链路未删除，cutover-ready 保持否。
- 验证：`cargo build -p agent-runtime-daemon -p agent-runtime-worker` 通过；`cargo test -p agent-runtime-worker --test control_lifecycle -- --nocapture`，1 项通过；`AGENT_RUNTIME_DAEMON=D:/cargo-target/debug/runtime-daemon.exe node --test test/runtime-integration.test.js`，3 项通过；`AGENT_RUNTIME_DAEMON=D:/cargo-target/debug/runtime-daemon.exe node --test --test-concurrency=1`，158 项全部通过；`cargo test --workspace`，workspace 全部通过；`git diff --check` 通过（仅 Windows LF/CRLF 转换警告）。`node scripts/check-line-count.js` 与 `npm test` 仍在执行前被既有 `test/extension-roles.test.js` 505 行门禁阻塞，本次未修改该文件。
- 遗留：pi-init integration 当前是 development direct-host，active broker recovery/worker reconnect 依赖 agent-runtime 层证据，真实 Pi 仍是显式 ignored gate；未删除旧 scheduler，未更新已安装 package、未 reload/重启当前 Pi，未提交、未推送。

### 2026-09-13：修复非架构角色触发工作流规划的误导反馈

- 完成内容：在 `tool_call` 入口提前阻断非 `architect` 角色的 `task_workflow` `plan`/`replan`；规划调用摘要改为“工作流请求”，失败结果保留具体原因；扩展提示明确规划前必须先 `switch_role(role=architect)`；新增边界和渲染回归测试。
- 验证：`node --test test/architect-boundary.test.js`，7 项通过；`node --test test/extension-roles.test.js`，15 项通过；`node --test`，142 项通过；`git diff --check` 通过（仅 Windows LF/CRLF 转换警告）。`npm test` 仍被既有基线文件 `test/extension-roles.test.js` 的 505 行物理行数门禁阻塞，本次未修改该文件。
- 遗留：未更新已安装 Pi package，未 reload/重启当前 Pi 进程，未提交、未推送。

### 2026-09-12：修复 subtask 派发角色错位和无反馈卡住

- 完成内容：subtask 派发前自动切换到任务角色；architect 角色任务由 subtask 执行器明确阻塞；新增 architect 边界失败回写、30 秒启动超时、派发/后台运行状态和用户通知；补充角色切换、边界失败与超时回归测试。
- 验证：`node --test test/workflow-dispatch.test.js --test-concurrency=1`，3 项通过；`node --test --test-concurrency=1`，140 项通过；`git diff --check` 通过（仅 Windows LF/CRLF 转换警告）。`node scripts/check-line-count.js` 仍被基线文件 `test/extension-roles.test.js` 的 505 行阻塞，本次未修改该无关文件。
- 遗留：未更新已安装 Pi package，未 reload/重启当前 Pi 进程，未提交、未推送；尚未进行真实 subtask fork 的交互式 E2E。

### 2026-09-12：明确工作流完成态的工具结果文案

- 完成内容：`task_workflow` 工具结果在工作流状态为 `completed` 时显示“✓ 工作流已完成”，不再显示任务分数；其他状态继续使用原有进度文案。
- 验证：`node --test test/extension-roles.test.js`，15 项全部通过；`git diff --check` 通过（仅 Windows LF/CRLF 转换警告）。
- 遗留：未更新已安装 Pi package，未 reload/重启当前 Pi 进程，未提交、未推送。

### 2026-09-12：修复手动模式角色模型被内部切换误写

- 完成内容：确认 `pi.setModel` 会等待 `model_select` 扩展处理器；`applyRole` 切换模型期间新增内部事件抑制，避免手动模式把目标模型写入旧活动角色；原生 `/model` 写回行为保持不变。新增 `test/role-model-persistence.test.js` 回归覆盖。
- 验证：`node --test test/extension-roles.test.js`，16 项通过；`npm test`，137 项通过；`node scripts/check-line-count.js`、`git diff --check` 通过（仅 Windows CRLF 转换警告）。
- 遗留：尚未 reload/重启当前已安装 Pi package；未提交、未推送。

### 2026-09-12：修复 pi-usage 扫描 SoL-Pi 归档导致的 DuckDB 事务失败

- 完成内容：`listSessionFiles` 跳过 session 目录下的 `sol-pi` 子树，避免将 SoL-Pi 的 `observation-pack/ledger.jsonl` 等内部归档误当作 Pi session；新增回归测试覆盖归档排除。根因与复现细节见 [`docs/pitfalls.md`](pitfalls.md)。
- 测试：`node --test test/pi-usage.test.js test/pi-usage-range.test.js`，19 项通过；`node scripts/check-line-count.js` 通过；`git diff --check` 通过（仅 CRLF 转换警告）；使用工作区源码执行 `node scripts/pi-usage.js --update` 成功完成更新。
- 遗留：PATH 中的全局 `pi-usage.cmd` 仍指向已安装旧版本，直接执行仍会复现旧错误；需更新全局 package 或改用工作区脚本后再运行。

### 2026-09-12：恢复严格 architect 边界

- 完成内容：将 `architect` 运行时守卫收紧为仅允许 `switch_role` 与 `task_workflow` 的 `plan`/`replan`/`status`；读取、搜索、浏览器、shell、编辑、写入、脚本、协作、MCP/mcpScript、直连 MCP 和未知工具均 fail-closed。同步扩展注册提示、工作流消息、公共 `pi-init-role-routing` Skill、`roles/architect.md` 和 README，明确 architect 只负责思考、分析、决策、规划和安排，证据取证由 `docs-commit` 结构化交接。
- 测试：初次针对性测试在文档断言同步后为 18/18 通过；随后补齐恢复门和 architect 协作 profile 的遗漏，最终 `npm test` 135/135 通过，`node --test test/architect-boundary.test.js test/role-recovery.test.js` 13/13 通过，`node --test test/collaboration-core.test.js test/scaffold.test.js --test-concurrency=1` 29/29 通过；静态 7 文件检查、`node scripts/check-line-count.js` 和 `git diff --check` 均通过（仅 CRLF 转换警告）。
- 遗留：本次未更新已安装 package、未 reload/重启 Pi、未提交、未推送。

### 2026-09-11：修复 collaboration 超时与终止结果误判

- 完成内容：将共享协作 Agent 默认总时限从 5 分钟调整为 30 分钟，支持 `PI_COLLAB_TIMEOUT_MS` 的 1 秒至 24 小时覆盖，并把实际时限写入运行记录和启动通知。超时、取消、外部 killed 分别记录；code=0 不再覆盖终止状态。终止时尽力解析 stdout、session 和 `agent_end` 结果作为诊断，但不向工作流交付 `resultText`，保持严格 `pi-init/task-result@1` 门。
- 验证：`npm test`，133 项全部通过；其中超时生命周期专项 6 项通过；`node scripts/check-line-count.js`、`git diff --check` 通过。
- 遗留：尚未执行真实远程长时任务、进程树终止和 reload 恢复 E2E；当前已安装 Pi exec 的 per-run `env` 传递能力仍需单独核实。

### 2026-09-11：优化 collaboration 后台工作流交互反馈

- 完成内容：后台委派后在独立状态栏显示运行阶段、任务进度和实时耗时，启动与原始结果回传使用可区分的用户通知；TUI 工作流进度弹窗摘要和 `/agents` 面板支持定时刷新；supervisor 每 5 秒刷新运行记录心跳，减少把正常等待误判为 stale。协作任务在实际委派时记录 `startedAt`，补齐任务耗时和整体耗时口径。
- 验证：`npm test`，127 项全部通过；`node scripts/check-line-count.js`、`git diff --check` 通过（Windows 工作区仅有预期的 LF/CRLF 转换提示）。
- 遗留：尚未在真实交互式 Pi TUI 中进行视觉验收；心跳反映 supervisor 对子进程的管理状态，不提供子 Agent 工具级实时输出；未执行真实远程连续多任务 workflow。

### 2026-09-11：完成 Windows collaboration CLI 启动安全修复

- 完成内容：`extensions/collaboration-spawn.ts` 仅在确认 `cli.js` 与 Pi 运行标记后复用 `process.execPath + process.argv[1]`，相对入口按父进程 cwd 解析；fallback 使用 `cmd.exe /d /s /c pi.cmd`，并将多行 system prompt/任务内容写入随机临时文件，只传递安全相对路径。带 shell 特殊字符的 CLI 路径或固定参数 fail-closed；`test/collaboration-core.test.js` 增加入口校验、文件传输、特殊字符和 Windows shim 边界测试。
- 验证：`node --test test/collaboration-core.test.js`，14 项全部通过；`node scripts/check-line-count.js`、`git diff --check` 通过；实际以 fallback 参数启动 `pi.cmd --version` 返回 `0.85.1`。
- 遗留：尚未执行真实远程模型驱动的连续多任务 collaboration workflow；当前没有活动 `task_workflow`，因此未执行 retry 或 replan。

### 2026-09-11：补充工作流次级菜单文档

- 完成内容：更新 `README.md` 和 `docs/current-state.md`，说明控制中心分组、`/pi-init config workflow` 的“策略 → 执行器”两级选择、Esc/返回取消语义、当前会话暂存与 `/pi-init save` 持久化边界，并明确 `collaboration` 不自动并发。
- 验证：人工对照 `extensions/control-center.ts` 的实际菜单流程；未运行测试或构建（仅 Markdown 文档更新）。
- 遗留：无。

### 2026-09-11：修复工作流执行器菜单缺少 collaboration 选项

- 完成内容：在 `extensions/control-center.ts` 的工作流执行器菜单加入 `collaboration` 选项，说明共享 cwd、独立 Agent、消息和 reservation 的行为；新增菜单回归测试。
- 验证：`npm test`，123 项全部通过；本次未修改执行器语义，未执行提交前后的真实 E2E。
- 遗留：已安装的 Pi package 和当前进程需执行 `pi update --extensions` 后 `/reload`，或重启 Pi，才能加载该菜单修复。

### 2026-09-11：完成共享工作区协作迁移和旧并发链路退役

- 完成内容：接入共享 cwd Agent、registry、消息、session tail、`/agents` Overlay、reservation 和 `collaboration` 工作流；角色/模型由 pi-init `roleModels` 精确解析；删除 `parallel_batch`、gmc、worktree/integration 专用实现及测试。旧 parallel batch session entry 会被忽略，不自动恢复或重派。
- 验证：`npm test`，122 项全部通过；`node scripts/check-line-count.js`、相关 `node --check` 和 `git diff --check` 通过。Windows 临时目录真实双 Agent process E2E 使用 `openai-codex/gpt-5.6-luna`，两个进程均 code=0、有最终 assistant 结果并完成 registry 清理。
- 遗留：cmux pane、真实远程模型连续多任务 workflow、reload 后人工恢复和凭据失败注入尚未执行；本次未提交、未推送或发布。

### 2026-09-11：确认共享工作区协作隔离并保存迁移计划

- 完成内容：根据用户确认，规划后续采用 fork 的共享工作目录、独立 Agent 进程/session、文件 reservation、消息和 session 观察；保留 pi-init 的角色/模型配置、`task_workflow`、上下文恢复和精确编辑守卫。明确当前 gmc worktree 并发实现暂不删除，待适配和验证完成后再替换。
- 验证：仅更新 `docs/decisions.md`、`docs/current-state.md` 和本记录；未修改代码，未运行测试或构建。
- 遗留：尚未提供 fork 仓库地址或本地路径；共享工作区下取消/失败的部分修改、reservation 与 shell 写入边界，以及真实多 Agent 链路仍待实现和验证。

### 2026-09-11：并行批次 worker 改为后台执行并区分终止原因

- 完成内容：`parallel_batch` 的 start/retry 不再同步等待 Pi worker，返回 `running` 后可通过 status 查看并通过 cancel 中止；终态通过 follow-up 消息通知主会话。后台结果按生命周期、batch/attempt 校验，session_tree、reload、shutdown 后旧 worker 不得写入当前分支。worker 被 timeout/取消时优先报告终止原因；未被终止但只有 `toolUse` 时归类为缺少最终 assistant 结果，不再误报 provider 失败。
- 验证：`npm test`，138 项全部通过；`git diff --check` 通过（Windows 工作区存在预期的 LF/CRLF 转换提示）。
- 遗留：尚未执行真实双 worker + gmc + 远程模型 E2E。

### 2026-09-11：修复并行 worker 卡住和诊断不足

- 完成内容：移除 worker 的 `--offline`，避免 Pi 关闭 model network；追加结构化结果 system prompt；兼容 `agent_end` 最终消息；保留同批次已成功 worker；在批次摘要显示阻塞原因；worker stderr 诊断限制长度并脱敏。新增对应回归测试。
- 验证：在 `D:\\Code\\Javascript\\pi-init` 执行 `npm test`，134 项全部通过；执行 `git diff --check` 通过（仅有 Windows 工作区预期的 LF/CRLF 转换提示）。
- 遗留：尚未执行真实双 worker + gmc + 远程模型 E2E；未执行 Git commit 或 push。

### 2026-09-10：修复 parallel_batch 空状态显示

- 完成内容：修复 `parallel_batch(action="status")` 在当前会话没有批次时把空对象交给结果渲染器，导致显示“批次 undefined · undefined”的问题；现在返回未定义详情并显示“当前没有并行批次”。
- 验证：`node --test test/parallel-extension.test.js`，4 项全部通过；`git diff --check` 通过（仅有 Windows 工作区预期的 LF/CRLF 转换提示）。
- 收尾：按用户授权执行本次提交并推送；未修改 parallel_batch 状态协议或 gmc/worker 流程。

### 2026-09-10：确认简单任务采用最小验证策略

- 决定：用户确认简单、局部、低风险任务只做实现，不创建 `task_workflow`，不启动 `subtask`/`parallel_batch`，不默认运行全量测试、类型检查或构建；纯文档、文案、注释和样式修改只做必要的差异/静态核对。高风险边界、安全措施、输入校验、数据不丢失处理、无障碍基础和用户明确要求的验证继续保留。
- 同步：已更新 `docs/decisions.md`、公共 `pi-init-role-routing` Skill、`developer-test` 角色说明、README 和当前状态；未修改工作流、subtask 或 parallel_batch 协议。
- 验证与遗留：本次为规则/文档修改，未运行 npm 命令；后续简单任务须明确报告未执行的验证，不得将其描述为通过。当前修改尚未提交或推送。

### 2026-09-10：定位 Pi worker “退出”问题

- 事实：此前全量临时 E2E 的 `code=1` 不是 gmc worktree 创建失败。测试脚本使用 `child_process.execFile` 包装 Pi，超时异常的 `error.code` 为字符串/null，被脚本映射为数字 1；首次脚本还没有显式关闭 stdin。另一次 PowerShell here-string 向 Node 传递中文任务时出现 `?`，Pi 因任务/验收不可解析返回 `blocked`。
- 验证：读取 Pi 0.85.1 `dist/core/exec.js` 确认生产 `pi.exec` 使用 `spawn(..., stdio: ["ignore", "pipe", "pipe"])`；使用真实生产路径 `pi.exec`、`pi-coding-agent` CLI、`openai-codex/gpt-5.6-luna` 和最小只读任务的临时扩展测试返回 `outcome: complete`。此前直接 `execFile` 路径反复超时，不能作为生产 worker 结论。
- 修复：worker prompt 明确列出允许的 JSON key，禁止 `status/state/success` 等额外字段；无最终文本时保留 Pi provider/stopReason 诊断，再区分普通退出和取消/终止。生产 worker 继续通过 `pi.exec`，并设置 5 分钟超时、取消同批次其他 worker。
- 遗留问题：真实双 worker + gmc 完整 E2E 尚未重新执行；本次已证明单 worker 的生产 Pi 子进程路径可完成，但不把单 worker 结果扩写成双 worker 成功。未提交、未推送、未发布。

### 2026-09-10：完成 parallel_batch 实现与交付文档同步

- 完成内容：接入 `parallel_batch` 工具和独立状态展示；支持 start/status/cancel/retry/integrate/complete，使用 gmc v0.10.1 临时空配置创建 worker 与 integration worktree。最多两个 worker 并发启动，结果严格绑定 batch/task/attempt/base；候选改动按顺序进入独立 integration worktree，关联 local `task_workflow` 时不自动完成原任务。同步公共 Skill、README、当前状态和踩坑记录。
- 安全与恢复：受信任项目和当前职责校验、范围不重叠、gmc hooks/shared resources 拒绝、固定基线、实际 integration git diff 校验、非零退出/坏结果显式阻塞；worker 不加载扩展、不调用 task_workflow、commit 或 push。session_start/session_tree 不自动重派，session_shutdown 会中止并记录未知状态阻塞。
- 验证：`npm test`，130 项全部通过；`node --check` 新增/修改 JS/TS 文件通过；`node scripts/check-line-count.js` 通过；新增 gmc client、批次状态、worker、扩展集成测试通过。官方 gmc v0.10.1 Windows x64 二进制在临时 Git 仓库中完成真实 add/list/promote 隔离验证，主工作区保持未修改。`npm pack --dry-run --json` 显示 `pi-init@2.0.3` 包含 parallel_batch 扩展、worker、gmc client、批次核心和公共 Skill；README/Skill/项目记忆 UTF-8 检查与 `git diff --check` 通过。
- 未完成项与遗留问题：真实 Pi worker 模型调用已用 auth ready 的 `openai-codex/gpt-5.6-luna` 做最小尝试，但 `pi.cmd --mode json -p --no-session --no-extensions --offline ...` 90 秒无输出超时；批次尝试随后以 worker code=1 结束，未将其写成成功。需在可用的模型网络/运行环境中重新做双 worker 端到端；gmc 未全局安装，未提交、未推送、未发布。

### 2026-09-10：完成 gmc v0.10.1 并行隔离层外部契约取证

- 完成内容：从 gmc v0.10.1 GitHub release 下载 Windows x86_64 官方 zip 到系统临时目录，使用 release `checksums.txt` 做 SHA-256 校验；未安装到全局，也未修改本项目或用户配置。读取了 Pi 0.85.1 的完整 `docs/extensions.md` 及官方 subagent 示例，确认可通过 `pi.exec()` 执行外部命令、通过 `pi.appendEntry()` 持久化扩展状态、通过 `session_start`/`session_shutdown` 恢复和清理，以及通过独立 `pi` 子进程实现并行 agent。
- 事实：临时普通 Git 仓库的基线 commit 为 `deae3e6174d0100921db4817d6db3206c1ee6643`；`gmc --output json wt list` 返回路径、分支、commit、status；`gmc wt add agent-a -b main` 创建 sibling worktree 并保持相同基线；`gmc wt dup 2 -b main` 创建 `.dup-1`/`.dup-2` 和 `_dup/main/...` 临时分支；`--task TASK.md` 会复制任务文件；`wt promote --dry-run` 只预览，真实 promote 将候选未提交改动应用到父工作区但不提交；无效 remove 返回退出码 1。gmc v0.10.1 release 明确包含 Windows x86_64 构建。
- 实现边界：v1 应只调用 `gmc wt add`/`wt dup`、`--output json wt list` 和经过用户授权的 promote/清理路径；不调用 `wt share`，不默认共享 `.env`、`node_modules`、数据库或构建输出；不启用 gmc 的自动准备/共享规则；worker 使用固定 `cwd` 的独立 Pi 进程并由主扩展唯一记录状态。Pi 的 `tool_result` 抛错才会标记工具失败，`ctx.signal` 可用于取消外部进程；`session_shutdown` 必须清理子进程，reload/resume 不能根据持久状态自动重派未终态 worker。
- 风险与未确认项：gmc README 的 `wt promote <temp> <name>` 重命名描述与 v0.10.1 源码/实际行为不一致，实际行为应以“应用候选改动到父工作区”为准；gmc CLI 默认配置路径是 `$XDG_CONFIG_HOME/gmc/config.yaml`，本证据命令未调用共享或配置写入。尚未完成真实 Pi worker 模型调用、主项目并行批次端到端、并发取消和集成冲突验证。
- 验证：下载脚本输出 `sha256_match=True`、`version=gmc version 0.10.1`；临时仓库执行 `gmc wt add`、`wt dup`、`--task`、`--output json wt list`、`wt promote --dry-run/real`，均获得上述真实结果；无效 `gmc wt remove missing-agent` 输出错误且 `invalid_remove_code=1`；本次文档修改后的 `git diff --check` 待本任务结束前执行。

### 2026-09-09：统一项目记忆文档的时间记录顺序

- 完成内容：确认并记录项目记忆文档的倒序约定；同步项目文档、中文/英文生成模板、协作规则和 `docs-commit` 角色说明。`session-log.md`、`decisions.md`、`pitfalls.md` 的日期条目以及 `current-state.md` 的“最近一次更新”列表均以最新条目在前，静态规则文档不纳入时间排序。
- 验证：`git diff --check` 通过。
- 遗留问题：其他既有项目不会通过脚手架或包更新自动重排其本地历史记录。

- 完成内容：将 `package.json`、`package-lock.json` 和当前状态中的 package 版本从 `2.0.2` 更新为 `2.0.3`。按现有版本策略采用 patch 版本：本次没有修改 API、配置 schema 或工作流状态机。
- 验证：版本更新后的 `npm test`、`npm pack --dry-run --json` 和 `git diff --check` 均已执行并通过；包清单显示 `pi-init@2.0.3`。
- 提交/推送：按用户明确授权提交并推送到 `origin/master`。

### 2026-09-09：按风险分级放宽自主执行与 architect 只读边界

- 完成内容：记录用户确认的风险分级自主执行决策；同步公共 `pi-init-role-routing` Skill、`architect`/`developer-test`/`docs-commit` 角色说明、项目 `AGENTS.md`、中英文模板和当前用户全局 `C:\Users\gorou\.pi\agent\AGENTS.md`。低风险只读咨询和目标明确的日常开发不再因普通技术选择、排查顺序或恢复既定行为的 bug 强制询问、工作流或正式 docs-commit 交接；复杂/高风险证据、授权、真实验证和角色边界继续保留。
- 完成内容：architect 工具守卫现在只放行 `read`、`grep`、`find`、`ls`、`ffgrep`、`fffind`，以及 browser 的单条 `open`、`snapshot`、`get`、`wait`、`scroll`、`screenshot` 观察命令；拒绝 `edit`/`write`/初始化写入、shell、MCP、脚本、browser 交互/持久化/关闭/命令串联和未知工具。同步扩展注册提示与工作流重规划提示，新增放行/拒绝回归。
- 约束与取舍：未修改模型映射、全局 `settings.json`、workflow API/schema/状态机、`workflowMode` 阈值、manual/confirm 行为、恢复门或精确编辑保护；browser 放行不是 shell/MCP 沙箱，且仍未允许任意 browser 命令。
- 验证：`node --test test/architect-boundary.test.js test/role-recovery.test.js test/scaffold.test.js`，26 项全部通过；`npm test`，112 项全部通过；`git diff --check` 通过，仅有 Windows 工作区预期的 LF/CRLF 转换提示；规则/文档 9 个文件 UTF-8 fatal 解码通过；包内容检查待本次收尾执行。
- 未执行项与遗留问题：尚未进行真实 Pi 模型驱动的路由、效率对照、长工作流和 subtask 端到端演练；未执行 package 安装/更新、`/reload`、提交、推送或发布。当前运行中的 Pi 进程和已安装 Git package 需在后续更新并 reload/重启后才获得新规则。

### 2026-09-07：版本更新至 2.0.2

- 完成内容：将 `package.json`、`package-lock.json` 和当前状态中的 package 版本从 `2.0.1` 更新为 `2.0.2`，作为本次兼容性保持的规则精简变更的 patch 版本。
- 验证：`npm test`，111 项全部通过；`git diff --check` 通过（仅有 Windows 工作区的 LF/CRLF 转换提示）。
- 提交/推送：已按用户授权提交并推送到 `origin/master`；本次无其他未执行项。

### 2026-09-07：精简角色与编排规则

- 完成内容：将公共 `pi-init-role-routing` Skill 作为唯一的路由语义入口；三个角色说明改为只保留职责、边界和交接，运行时提示只保留当前任务硬约束，并同步 README 的角色路由与读取策略说明。
- 完成内容：保留三角色、roleModels、证据门控、精确编辑安全边界、恢复门、architect 工具守卫、真实验证、complete/block、重规划和 subtask 协议；未修改工作流 API、schema、状态机或执行器。
- 验证：`node --test test/extension-lifecycle.test.js test/scaffold.test.js`，25 项全部通过；`npm test`，111 项全部通过；`git diff --check` 通过（仅有 Windows 工作区的 LF/CRLF 转换提示）。
- 未执行项与遗留问题：尚未进行真实 Pi 模型驱动的路由、长工作流和 subtask 端到端演练；本次未提交、未推送、未发布。更新已安装 package 后需执行 `pi update --extensions`，再 `/reload` 或重启 Pi。

### 2026-09-07：不明确编排指令默认从架构师开始

- 完成内容：记录用户确认的路由决策；公共 `pi-init-role-routing` Skill 和 `task_workflow` 运行时提示明确“明确对应角色直接路由，不明确、含糊或跨职责从 `architect` 开始”，并保留代码位置、实现或调用链证据不清时先切换 `docs-commit` 的约束。
- 完成内容：新增扩展注册提示的回归断言；未修改角色职责边界、工作流状态机或任务 schema。
- 验证：`git diff --check` 通过（仅有 Windows 工作区的 LF/CRLF 转换提示）；`npm test`，111 项全部通过。
- 未执行项与遗留问题：尚未进行真实 Pi 模型驱动路由和长工作流端到端演练；本次未提交、未推送、未发布。当前已安装 package 和运行中的 Pi 进程需执行 `pi update --extensions` 后 `/reload` 或重启 Pi，才会加载更新后的 Skill/提示。

### 2026-09-06：任务规划采用依赖与风险优先、同层先易后难的软排序

- 完成内容：在 `docs/decisions.md` 记录用户确认的排序决策，并同步公共 `pi-init-role-routing` Skill、`architect` 角色说明和 README、当前状态说明。
- 完成内容：规划现在优先遵守用户明确的优先级、截止要求和硬依赖，再处理可能推翻方案的关键未知项的限时最小验证和业务关键路径；只有同层且风险、价值相近时才先易后难。未新增任务字段或改变 `task_workflow` 输入顺序。
- 验证：`node --test test/scaffold.test.js`，14 项通过；`npm test`，111 项全部通过；`git diff --check` 通过，仅有 Windows 工作区的 LF/CRLF 转换提示。
- 未执行项与遗留问题：尚未进行真实 Pi 模型驱动规划和长工作流效果评估；本次未提交、未推送、未发布。当前已安装 package 和运行中的 Pi 进程需执行 `pi update --extensions` 后 `/reload` 或重启，才会加载更新后的公共 Skill。



### 2026-09-05：补充工作流阻塞原因和解决建议

- 完成内容：工作流阻塞状态在状态报告、TUI 弹窗、`task_workflow` 工具结果和暂停通知中统一显示真实阻塞原因，并提示解决后 retry 或由架构师 replan。
- 完成内容：新增阻塞状态报告回归测试；未修改工作流状态机、重试和重规划语义。
- 验证：`npm test`，111 项全部通过；`git diff --check` 通过（仅有 Windows 下预期的 LF/CRLF 转换警告）。
- 遗留问题：真实 Pi 工作流、subtask fork 生命周期和 TUI 视觉验收仍未执行；本次未提交或推送。

### 2026-09-05：分离架构前置证据收集与架构分析

- 完成内容：公共 `pi-init-role-routing` Skill 明确架构任务先由 `docs-commit` 收集并交接结构化证据包，`architect` 仅负责根因分析、逻辑关系、关键决策、方案和计划；`docs-commit` 可读取和追踪代码/配置/测试但不修改代码，`developer-test` 的实现与验证读取能力不受 architect 守卫影响。
- 完成内容：新增 architect 工具 allowlist 守卫，仅放行 `switch_role` 和 `task_workflow`；更新工作流规划/重规划提示及 README、当前状态说明。现有已安装 package 和当前 Pi 进程需执行 `pi update --extensions` 后 `/reload` 或重启，才会使用新 Skill/守卫。
- 验证：`node --test test/architect-boundary.test.js test/extension-lifecycle.test.js test/scaffold.test.js`，28 项通过；`npm test`，110 项全部通过；`git diff --check` 通过（仅有 Windows 下预期的 LF/CRLF 转换警告）。
- 遗留问题：尚未进行真实模型驱动的 docs-commit → architect 证据交接和真实交互式 TUI/端到端演练；本次未提交或推送。


### 2026-09-04：增加实时缓存状态栏高亮

- 完成内容：新增 `extensions/cache-status.ts` 并接入扩展生命周期；状态栏通过独立 `pi-cache` 状态项显示请求阶段和缓存结果，`accent` 加粗表示 `↑Input`/`↓Output` 当前阶段，`success` 表示 Provider 明确报告的 Cache Read/Write；最终 `message_end` usage 覆盖流式暂态，错误、中止、缺少结束事件和新会话不会遗留活动高亮。
- 完成内容：新增缓存状态回归测试，覆盖缓存判定延迟、读、写、读写、零值不推断、最终值覆盖、重复 update 去重、错误/中止清理及与 `pi-init` 状态共存；未替换默认 Footer，未写入 session 或 DuckDB。
- 文档：同步 `README.md`、`docs/current-state.md` 和 `docs/decisions.md`；本次没有发现需要新增到 `docs/pitfalls.md` 的隐蔽可复发问题。
- 验证：`node --check extensions/cache-status.ts`、`node --check extensions/index.ts`、`node --check test/cache-status.test.js`、`node scripts/check-line-count.js` 通过；`node --test test/cache-status.test.js test/extension-lifecycle.test.js test/extension-roles.test.js`，35 项通过；`npm test`，107 项全部通过；`git diff --check` 通过（仅有 Windows 下预期的 LF/CRLF 转换警告）。
- 遗留问题：尚未在真实交互式 Pi TUI 中进行视觉验收；尚未提交或推送。


### 2026-09-04：显示 pi-usage 缓存更新时间

- 完成内容：`pi-usage` 汇总读取 DuckDB `usage_state.checked_ms` 并返回 `updatedAt`；报表显示 `Cache updated: YYYY-MM-DD HH:mm`，无缓存状态时显示“未知”。新增缓存查询与报表回归测试。
- 验证：`node --test test/pi-usage.test.js test/pi-usage-range.test.js`，18 项通过；`npm test`，98 项通过；`git diff --check` 通过（仅有 Windows 下预期的 LF/CRLF 转换警告）。
- 遗留问题：尚未提交或推送。


### 2026-09-02：实现上下文压缩后的职责恢复门

- 完成内容：新增 `extensions/role-recovery.ts`。所有 `session_compact` 都持久化 `pi-init-role-recovery` pending，不依赖 `fromExtension`；恢复提示改由每次 `context` 事件注入，移除 `session_before_compact` 返回值用法。普通压缩和 reload/resume/fork/已有上下文 startup 后重新上锁，new/空会话不额外上锁；pi-init 明确完成角色/任务交接时在续跑前记录 acknowledged。
- 完成内容：恢复门 fail-closed，只放行读取、`task_workflow(action="status")` 和 `switch_role`，阻断结果不终止 Agent；auto/confirm/manual 的成功、失败、取消、模型不匹配和凭据失败路径，以及 branch-local/session_start/session_tree 生命周期均补齐回归测试。
- 验证：`node --test test/role-recovery.test.js test/extension-roles.test.js test/extension-lifecycle.test.js test/workflow-compaction.test.js`，37 项通过；相关 `node --check`、`node scripts/check-line-count.js` 和 `git diff --check` 通过。`npm test` 共 97 项，96 项通过；唯一失败为 Windows DuckDB 临时数据库文件锁定的既有 `pi-usage` 流式 checkpoint 测试。串行全量测试同样 96/97，仅出现既有 DuckDB 锁定失败。
- 遗留问题：未提交或推送；真实 Pi 模型在压缩后跨职责恢复、workflow/subtask fork 生命周期和 reload 后人工恢复仍未执行。

### 2026-09-01：完成 edit 运行时守卫文档收尾

- 完成内容：公共 Skill 保留完整的 edit 参数、唯一匹配、非重叠、逻辑快照和运行时 fail-closed 规则；developer-test 角色说明、README 和中英文工作流提示改为简短引用。明确提示预检只降低错误率，运行时保证无效或歧义调用不写文件并返回可恢复诊断，不能保证模型永不产生非法调用。
- 完成内容：工作流 policy 字符串按 JavaScript 文本字符统计，从实施前 2,034 字符压缩为 1,370 字符，减少 664 字符（32.6%）；合法成功路径继续复用内置 edit definition，不新增 schema、模型调用或成功路径提示。
- 验证：本次文档修改后的 `npm test`，89 项全部通过；`git diff --check` 通过（仅有 Windows 下预期的 LF/CRLF 转换警告）。
- 遗留问题：尚未提交或推送。

### 2026-09-01：为精确编辑增加参数和重叠预检

- 完成内容：公共 Skill、开发测试角色说明、工作流运行时提示和 README 明确要求 `edit` payload 只包含 `path`、`edits`，不混入 `read` 的 `offset`/`limit`，并在调用前确认各 edits 不重叠；重叠改动先合并。
- 完成内容：新增中文/英文运行时提示和 Skill 回归断言；未修改 Pi 内置 `read`/`edit` 协议，也未修改目标业务代码。
- 验证：`npm test`，78 项全部通过；`git diff --check` 通过（仅有 Windows 下预期的 LF/CRLF 转换警告）。
- 遗留问题：无。

### 2026-09-01：为精确编辑增加多重匹配预检

- 完成内容：公共 Skill、开发测试角色说明、工作流运行时提示和 README 明确要求在调用 `edit` 前逐项预检 `oldText` 的精确出现次数；出现 0 次或多次时不调用 `edit`，先定向读取并补充唯一上下文。
- 完成内容：新增运行时提示和 package Skill 的回归断言；未修改 Pi 内置 `read`/`edit` 协议，也未修改目标业务代码。
- 验证：`npm test`，78 项全部通过；`git diff --check` 通过（仅有 Windows 下预期的 LF/CRLF 转换警告）。
- 遗留问题：无。

### 2026-09-01：统一角色配置保存状态提示

- 完成内容：保存成功时统一提示“角色配置已保存”；角色配置暂存后统一提示“角色配置已修改，尚未保存”，并同步更新控制中心菜单说明。
- 验证：`npm test`，78 项全部通过；`git diff --check` 通过，仅有 Windows 下预期的 LF/CRLF 转换警告。

### 2026-08-31：增加精确编辑的会话内逻辑快照规则

- 完成内容：公共职责路由 Skill、developer-test 角色说明以及 local/subtask 工作流提示新增逻辑快照规则；成功 `edit` 后在无其他写入来源时复用确定结果，快照失效后重新读取；`oldText` 零匹配仅允许定向重读并最多安全重试一次，不使用模糊匹配或持久缓存。
- 完成内容：新增公共 Skill、角色说明和运行时提示的回归断言；未修改 Pi 内置 `read`/`edit` 协议，也未生成缓存文件或持久状态。
- 文档：同步 `README.md`、`docs/current-state.md` 和 `docs/decisions.md`；未修改 `docs/pitfalls.md`，本次没有发现新的可复发陷阱。
- 验证：`node --test test/extension-lifecycle.test.js test/scaffold.test.js`，25 项通过；`npm test`，78 项通过；`git diff --check` 通过（仅有 Windows 下预期的 LF/CRLF 转换警告）。
- 遗留问题：尚未提交或推送。

### 2026-08-31：pi-usage 重算日期精确到分钟

- 完成内容：TTY 刷新摘要将“重算日期”改为 session 文件最新修改时间 `YYYY-MM-DD HH:mm`，并保留受影响自然日；不再把扫描完成时间误作数据更新时间。
- 完成内容：新增分钟格式化和刷新时间回归测试。
- 验证：`node --check scripts/pi-usage/refresh.js`、`scripts/pi-usage/report.js`、`scripts/pi-usage/cli.js` 通过；`node --test test/pi-usage.test.js test/pi-usage-range.test.js`，17 项通过；`npm test`，78 项通过；`git diff --check` 通过（仅有 Windows 下预期的 LF/CRLF 转换警告）。
- 遗留问题：尚未提交或推送。

### 2026-08-31：状态栏运行时指示点高亮

- 完成内容：`pi-init` 状态栏指示点使用主题 `muted`/`accent` 颜色，在 Agent 空闲/运行状态间切换；新增生命周期和颜色回归测试，并补齐测试桩的 `isIdle()` 与主题接口。
- 验证：`npm test`，77 项全部通过；`git diff --check` 通过，仅有 Windows 下预期的 LF/CRLF 转换警告。
- 遗留问题：尚未提交或推送。

### 2026-08-31：补充公共 Skill 说明并发布 2.0.1

- 完成内容：更新 README，明确公共 `pi-init-role-routing` Skill 的发布位置、按需加载的角色说明、职责边界，以及 Skill、扩展和项目 `roleModels` 配置之间的分工；同步将 package 版本更新为 `2.0.1`。
- 文档：同步 `docs/current-state.md`；本次没有新增设计决策或可复发陷阱。

### 2026-08-31：将通用执行规则集中到公共 Skill

- 完成内容：公共 `pi-init-role-routing` Skill 新增完整的证据与工具调用规则；中英文生成模板和项目根 `AGENTS.md` 删除重复的任务执行流程、证据规则和工作流细节，改为引用公共 Skill，仅保留项目特有规则。
- 完成内容：README、当前状态和设计决策同步说明集中维护策略、Skill 按需加载限制，以及既有项目需要重新初始化或手动迁移的边界；`docs/pitfalls.md` 未修改，本次没有新的可复发陷阱。
- 验证：`node --test test/scaffold.test.js`，14 项全部通过；最终文档修改后的全量 `npm test`，76 项全部通过；`git diff --check` 通过，仅有 Windows 下预期的 LF/CRLF 转换警告。
- 遗留问题：既有项目的 `AGENTS.md` 不会自动迁移；真实 Pi 模型连续工作流、subtask fork 生命周期和 reload 后人工恢复仍未端到端演练；Linux/macOS CI 尚未在本地执行；本次未提交或推送。

### 2026-08-30：采用有限探索并同步运行时提示

- 历史基线：抽样分析历史 30 次 `task_workflow(plan)`，规划耗时中位数 183.5 秒、工具轮次中位数 7.5、工具结果约 98 KB、输出约 6,446 tokens；该基线用于评估重复确认读取的规划开销。
- 完成内容：将规划、任务执行、重规划和 `subtask` 的读取规则统一为新鲜证据门控；充分证据使用 0 轮，局部缺口使用 1 轮，未知位置通常最多 2 轮。高风险改动继续检查最新实现、调用方和测试，精确编辑失败后才定向重读。
- 完成内容：`auto` 模式下不超过 2 个任务继续跳过持久工作流，但绕过提示改为按任务指定角色切换后顺序执行，架构角色不直接实现；README、项目状态、设计决策、角色 Skill、双语模板与运行时提示保持一致。未新增 lazy-read 配置、Context Packet 状态结构、哈希缓存或运行时依赖。
- 文档：未修改 `docs/pitfalls.md`，本次没有发现新的可复发陷阱。
- 验证：`node --test test/extension-lifecycle.test.js test/scaffold.test.js`，25 项全部通过；`node --check` 覆盖 3 个运行时 TypeScript 文件和 2 个回归测试文件，全部通过；`node scripts/check-line-count.js`（由 `npm test` 执行）通过；`npm test`，76 项全部通过；`git diff --check` 通过，仅有 Windows 下预期的 LF/CRLF 转换警告。
- 遗留问题：真实 Pi 模型连续多任务、subtask fork 生命周期和 reload 后人工恢复仍未端到端演练；Linux/macOS CI 尚未在本地执行；本次未提交或推送。

### 2026-08-30：长工作流任务边界增加上下文压缩检查

- 完成内容：活动工作流的非最终任务在完成后，于 `agent_settled` 检查上下文使用率；自动模式达到 50% 时复用既有压缩和续跑链路，覆盖 local、subtask、同角色任务和最终任务不重复压缩。
- 文档：同步 `README.md`、`docs/current-state.md`、`docs/decisions.md` 和 `docs/pitfalls.md`。
- 验证：`node --test test/workflow-compaction.test.js`，3 项通过；`node --check` 覆盖修改的 JS/TS 文件；`node scripts/check-line-count.js` 通过；`npm test`，73 项全部通过。
- 遗留问题：尚未提交或推送。

### 2026-08-30：完成报告仅显示失败验证

- 完成内容：工作流中间任务和最终完成报告过滤验证结果，仅显示带明确失败语义的条目；全部成功时省略验证行，工作流状态仍保留完整 verification 数组。local 与 subtask 继续共用报告格式化逻辑。
- 文档：同步 `README.md`、`docs/current-state.md` 和 `docs/decisions.md`；未修改 `docs/pitfalls.md`，本次没有新增可复发陷阱。
- 验证：`node --test --test-name-pattern='task_workflow 区分中间任务和最终工作流报告并保留样式' test/extension-roles.test.js`，1 项通过；`node --check extensions/workflow-report.ts` 通过；`node scripts/check-line-count.js` 通过；`npm test`，70 项全部通过。
- 遗留问题：未提交或推送。

### 2026-08-30：大版本更新至 2.0.0

- 完成内容：将 `package.json`、`package-lock.json` 和当前状态文档中的包版本更新为 `2.0.0`，标记角色配置与工作流报告协议的破坏性升级。
- 验证：`npm test`，70 项全部通过；版本一致性检查确认 `package.json`、`package-lock.json` 根版本和 lock package 版本均为 `2.0.0`；`git diff --check` 通过，仅有 Windows 下预期的 LF/CRLF 转换提示。
- 遗留问题：未提交或推送。

### 2026-08-30：精简任务流报告并增加实现原因

- 完成内容：中间任务报告只保留任务、摘要、实现原因、耗时和验证；最终工作流报告只保留目标、进度、最终任务结果、整体时间和最终验证，不再重复前序任务或完整状态。验证改为单行，完成报告移除灰色 bullet 辅助输出。
- 完成内容：`task_workflow.complete` 增加必填 `implementationRationale`，local 和 subtask 完成路径均持久化并展示该字段；旧工作流状态缺少该字段时仍可读取，重试会清理旧原因。
- 文档：同步 `README.md`、`docs/current-state.md` 和 `docs/decisions.md`，解释报告取舍和实现原因的用途；未修改 `docs/pitfalls.md`，本次没有新增可复发陷阱。
- 验证：`node --test test/workflow-core.test.js test/workflow-protocol.test.js test/workflow-replan-directions.test.js test/extension-roles.test.js`，26 项全部通过；`npm test`，70 项全部通过；相关 JS/TS `node --check` 全部通过；`git diff --check` 通过，仅有 Windows 下预期的 LF/CRLF 转换提示。
- 遗留问题：未提交或推送。

### 2026-08-30：迁移到 package 公共角色 Skill 和动态 roleModels

- 完成内容：新增随 package 发布的 `skills/pi-init-role-routing/` 公共 Skill 及三个角色说明；脚手架和高级初始化不再生成或询问项目级角色 Skill/slug，项目已有 Skill 不自动删除。README、当前状态和设计决策补充了 `schemaVersion: 2`、`roleModels` 动态启用、添加新角色的两步流程，以及旧配置和旧项目 Skill 的迁移边界。
- 文档：更新 `README.md`、`docs/current-state.md`、`docs/decisions.md`；未修改 `docs/pitfalls.md`，本次没有新增可复发陷阱。
- 验证：`node --test test/scaffold.test.js test/extension-roles.test.js test/extension-lifecycle.test.js`，36 项全部通过；`npm test`，70 项全部通过；`node --check` 覆盖本次修改的 JS/TS 文件，全部通过；`npm pack --dry-run` 显示 package 包含公共 Skill 主文件和三个角色文件；最终 `git diff --check` 通过，仅有 Windows 下预期的 LF/CRLF 转换提示。
- 遗留问题：未提交或推送；真实 Pi 模型连续工作流、subtask fork 生命周期和跨平台 CI 仍按当前状态文档记录的范围待执行。

### 2026-08-30：完成高级初始化 TUI 的逐级 Esc 导航

- 完成内容：恢复文本输入时将光标移到末尾；自定义角色模型在模型、推理强度和角色之间逐级返回并保留选择；高级初始化最终确认区分确认、显式取消和 Esc 返回角色模型步骤。控制中心消费首项 MENU_BACK 后重新显示自身，直接高级命令传播 MENU_BACK 返回调用方；快速初始化和非 TUI 确认行为保持原有路径。
- 文档：同步当前状态和设计决策。
- 验证：`npm test`，64 项全部通过；`node --check extensions/scaffold-runtime.ts`、`node --check extensions/control-center.ts`、`node --check test/extension-roles.test.js` 通过；`git diff --check` 通过，仅有 Windows 下 Git 的 LF/CRLF 转换提示。
- 遗留问题：尚未在真实交互式 Pi TUI 中进行视觉验收；尚未提交或推送。

### 2026-08-30：初始化向导 Esc 返回上一个属性

- 完成内容：高级初始化改为按步骤导航；TUI 文本输入和属性菜单按 Esc 返回上一个属性，已输入内容保留，首个属性返回上级菜单。
- 验证：新增初始化向导回退回归测试；`node --check` 通过；`npm test`，61 项全部通过；`git diff --check` 通过。
- 遗留问题：尚未提交或推送。

### 2026-08-30：明确职责跨类交接边界

- 完成内容：更新项目 Skill 及生成模板，明确开发测试工程师不写文档、文档与收尾工程师不写代码；两者遇到疑问、困惑不解或需求分析切换到架构师，代码与文档交叉工作切换到对应职责。
- 文档：同步当前状态和设计决策。
- 验证：检查 Skill 与模板的精确修改及 `git diff --check`；未运行代码测试（本次仅修改职责文档）。
- 遗留问题：尚未提交或推送。

### 2026-08-30：TUI 菜单按 Esc 返回上一级

- 完成内容：通用 TUI 菜单、角色模型搜索和高级初始化文本输入使用独立返回结果；Esc 返回父级菜单，Ctrl+C 和显式“取消”继续保持取消语义。角色、工作流配置和高级初始化调用方均安全处理返回结果。
- 文档：同步当前状态和设计决策。
- 验证：新增菜单和文本输入 Esc 回归测试，`node --check` 通过；`npm test`，60 项全部通过；`git diff --check` 通过。
- 遗留问题：尚未在真实交互式 Pi TUI 中进行视觉验收；尚未提交或推送。

### 2026-08-26：修复 pi-usage fork 历史重复统计

- 完成内容：为 usage、speed、activity 事件改用跨 session 文件稳定 entry key；schema 升级到 v3，首次升级事务化清理并重建 DuckDB 派生事件、duration summary 和 session checkpoint，session JSONL 保持只读。
- 完成内容：查询边界按稳定 key 去重 usage、speed、activity 和 session；fork 后新 entry 继续计入，纯复制文件不再增加 token、费用、TPS、时长或 session。
- 验证：临时 DuckDB fork/复制数据回归核对通过；`node --test test/pi-usage-range.test.js test/pi-usage.test.js` 16 项通过；`npm test` 58 项通过；`git diff --check` 通过（仅有 Windows LF/CRLF 转换提示）。
- 遗留问题：尚未提交或推送。

### 2026-08-25：为 pi-usage 增加自然日范围查询

- 完成内容：新增 `yesterday`、`Nd`、`YYYY-MM`、单日和双日期闭区间语法；跨日查询聚合 token、费用、调用次数、加权 TPS 和逐日时长，并按源文件去重 session。保留无参数和单日查询兼容行为，不修改 DuckDB schema。
- 文档：同步 README、当前状态和设计决策。
- 验证：`node --test test/pi-usage-range.test.js`，2 项通过；`node --check scripts/pi-usage/core.js`、`scripts/pi-usage/refresh.js`、`scripts/pi-usage/cli.js`、`test/pi-usage-range.test.js` 通过；`npm test`，56 项全部通过；实际 CLI `node scripts/pi-usage.js 2026-08-24 2026-08-25 --db <临时数据库>` 输出范围标题正确。
- 遗留问题：尚未提交或推送。

### 2026-08-25：删除遗留临时目录的扩展工作流测试

- 完成内容：按用户要求删除 `test/extension-workflow.test.js`；该测试使用相对路径创建 `pi-init-extension-tests-*` 临时目录且未清理，会污染仓库根目录。
- 验证：`npm test`，54 项全部通过；Git 状态确认该测试文件已删除。
- 遗留问题：此前产生的空临时目录和 `pi-init-dbg-*` 调试目录尚未删除。

### 2026-08-25：合并任务执行期间连续方向输入并在边界重规划

- 完成内容：新增 `appendWorkflowReplanDirection`，把同一任务期间连续的普通 `interactive`/`rpc` 输入按顺序合并到单一 `pendingRevision`/审计 revision；扩展通知和架构重规划提示均展示完整指令，任务边界前不启动旧后续任务。新增核心合并、持久化重载、local 集成和 subtask 边界回归测试；为满足 500 行门禁将核心合并测试拆到 `test/workflow-replan-directions.test.js`。
- 文档：同步 README、中英文生成模板、当前状态和设计决策，明确连续指令合并及新计划应用前的暂停语义。
- 验证：`npm test`，61 项全部通过；`node --check` 覆盖本次修改的 JS/TS 文件；`git diff --check` 通过（仅 Windows LF/CRLF 转换提示）。
- 遗留问题：真实 Pi 模型连续多任务和交互式 TUI 视觉验收仍未执行；工作区保留用户已有的 `.pi/role-models.json` 未提交修改，未覆盖或提交该文件。

### 2026-08-23：工作流进度面板显示总任务已运行时间并优化任务列布局

- 完成内容：工作流面板增加总任务已运行时间；活动工作流按当前时间计算，已完成/暂停/取消状态按最后有效时间边界计算。任务耗时移到描述列，配合主列宽度约束，避免窄面板遮挡任务标题。
- 验证：定向运行 `node --test --test-name-pattern='工作流状态使用弹窗|非 TUI 工作流状态|活动工作流状态显示当前已运行时间' test/extension-roles.test.js`，3 项通过；`npm test`，59 项全部通过；`node --check extensions/workflow-report.ts`、`node --check test/extension-roles.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实交互式 Pi TUI 中进行视觉验收。

### 2026-08-22：工作流进度面板显示整体开始时间和已完成任务耗时

- 完成内容：工作流 TUI 进度弹窗和非 TUI 状态文本增加总任务开始时间；已完成任务条目追加基于任务开始/结束时间计算的耗时，历史缺失时间戳时沿用不可用提示。
- 验证：定向运行 `node --test --test-name-pattern='TUI 工作流状态使用弹窗并显示任务进度|非 TUI 工作流状态继续使用通知文本' test/extension-roles.test.js`，2 项通过；`npm test`，58 项全部通过；`node --check extensions/workflow-report.ts`、`node --check test/extension-roles.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实交互式 Pi TUI 中进行视觉验收。

### 2026-08-22：完成 pi-init 启动优化验证

- 完成内容：将控制中心和脚手架运行时改为扩展实例内 Promise 缓存的按需加载；工作流恢复改为使用 branch 的 `findLast`，避免复制和 reverse 整个 session branch；新增对应 dryRun 和最新状态回归测试。
- 基准方法：在 Windows 当前环境使用 fresh `pi.cmd` 进程，交替执行 12 组（共 24 个进程），命令分别为 `pi.cmd --no-session --no-extensions --no-skills --mode rpc` 与 `pi.cmd --no-session --no-extensions --no-skills -e ./extensions/index.ts --mode rpc`，每次输入 `{"id":"commands","type":"get_commands"}`，同时设置 `PI_TIMING=1`。
- 实际结果：无扩展 wall 中位数 808.2 ms，main TOTAL 中位数 58.5 ms，扩展首阶段（llama.cpp factory）9.0 ms；加载 pi-init wall 中位数 824.7 ms，main TOTAL 79.0 ms，`extensions/index.ts` module import 28.5 ms；wall 增量 16.5 ms。此前同机基线为 769.8/795.5 ms、增量 25.7 ms，本次增量改善约 9.2 ms，因此保留按需加载，未回退。
- 验证：`npm test`，58 项全部通过；`node --test test/extension-workflow.test.js`，6 项通过；`node scripts/check-line-count.js` 通过；`git diff --check` 通过，仅有 Windows 下 Git 的 LF/CRLF 转换提示。
- 遗留问题：尚未完成真实交互式 TUI 首屏、正常网络、离线和慢网络场景的分阶段基准；网络刷新仍由 Pi 核心管理。

### 2026-08-20：移除原生 Agent 模型守卫并保留 subtask

- 完成内容：删除 pi-init 对原生 `Agent`/`agent` tool_call 的模型注入、模糊名称回退和注册表校验；保留普通 Agent 的计时生命周期，以及 `workflowExecutor: "subtask"` 的派发、结果协议、状态持久化和旧 `subagents` 兼容。
- 完成内容：同步 README、中英文生成模板和项目记忆，明确原生 Agent 由 Pi 宿主选择模型，subtask 仍由 pi-init 管理。
- 验证：`node --test test/extension-roles.test.js test/extension-lifecycle.test.js` 14 项通过；`node scripts/check-line-count.js` 通过；`git diff --check` 通过（仅 Windows 换行转换警告）。
- 遗留问题：完整 `npm test` 和本次变更的提交/推送尚未执行。

### 2026-08-20：Agent 模糊模型名继承当前会话模型

- 完成内容：Agent 工具调用现在将未带 `/` 的非空模型名（如 `haiku`、`sonnet`）改为当前会话完整 `provider/model`，并发送提示；完整 `provider/model` 仍要求注册表精确匹配，不存在时阻止。
- 完成内容：更新 README、中英文生成模板和项目记忆，明确 Explore 等 Agent 预设的继承行为和跨 Provider 边界。
- 验证：`node --test test/extension-roles.test.js` 8 项通过；`npm test` 57 项全部通过；`node scripts/check-line-count.js` 通过；`git diff --check` 通过（仅 Windows 换行转换警告）。
- 遗留问题：尚未提交或推送本次模型继承变更。

### 2026-08-20：完成代码拆分、物理行数门禁和最终验证

- 完成内容：将 2389 行单体测试拆为职责测试文件和共享 harness；将 `src/workflow.js`、`extensions/index.ts` 与 `scripts/pi-usage.js` 拆为职责模块，同时保留三个公共 facade。pi-usage 安装器会携带 `scripts/pi-usage/` 支持文件，Windows/POSIX 启动行为保持不变。
- 完成内容：新增 `scripts/check-line-count.js` 和 `test/line-count.test.js`，递归检查指定 JavaScript/TypeScript 扩展名，排除 `.git`/`node_modules`，并由 `npm test` 在 Node 测试前执行 500 行门禁。测试覆盖 LF、CRLF、CR、无末尾换行，以及 500/501 行边界和 CLI 违规报告。
- 验证：`node scripts/check-line-count.js` 通过；`npm test` 57 项全部通过；`node --test test/line-count.test.js` 3 项全部通过；`node --check scripts/check-line-count.js && node --check test/line-count.test.js` 通过；`npm pack --dry-run` 通过；`git diff --check` 通过（仅 Windows 换行转换警告）。
- 遗留问题：真实 Pi 模型连续工作流、subtask fork 生命周期、reload 后人工恢复以及 Linux/macOS 本地验证仍未执行；未提交或推送。

### 2026-08-20：接入活动工作流方向变更和 revision 重规划

- 完成内容：普通 `interactive`/`rpc` 自然语言输入在活动工作流中记录 `revisionId` 和用户方向；当前任务完成或 subtask 结果回传后进入重规划边界，不启动旧计划的下一个任务。架构师通过 `task_workflow(action="replan")` 提交新计划后才恢复调度。
- 完成内容：补充 local、subtask、reload 以及 manual/confirm 角色边界测试；subtask fork 不由 pi-init 自动终止或重新派发，立即停止仍使用既有 cancel 流程。README、双语生成模板和项目决策/状态文档已同步。
- 验证：`npm test`，53 项全部通过；`node --check test/scaffold.test.js` 通过；`git diff --check` 通过（仅 Windows 换行转换警告）。
- 遗留问题：真实 Pi 模型连续工作流、subtask fork 生命周期和 reload 后人工恢复仍未端到端演练。

### 2026-08-19：`subagents` 执行器替换为 pi-subtask 对话 fork

- 完成内容：`workflowExecutor` 可选值改为 `subtask`（`gary149/pi-subtask` 对话 fork），旧值 `subagents` 自动映射兼容；删除 `@tintinweb/pi-subagents` 的 `pi.events` RPC 通道（spawn/stop/completed/failed）、request 序列与绑定清理、`WORKFLOW_SUBAGENT_TYPES`。
- 完成内容：模型驱动接入——主会话调用 `subtask` 工具派发（`pi-init-subtask-dispatch` custom 消息，`display:false`），fork 结果经 `subtask-result` custom 消息回传；`src/subtask.js` 提供 `pi-init/task-result@1` 严格解析（剥 markdown 围栏、complete 需非空验证、blocked 需原因）；`scheduleWorkflow` 改为派发/消费两分支，`details.task` 与派发提示词逐字相等才归属。
- 完成内容：删除 `.pi/agents/*.md` 代理脚手架（scaffold TEMPLATE_FILES 与 `templates/agents/`），fork 复用主会话角色与工具；派发前探测 `pi.getActiveTools()`，缺少 `subtask` 工具安全阻塞；取消/阻塞不再发送 stop RPC。
- 完成内容：同步中英文模板、README、决策/当前状态/陷阱/会话记录；版本号保持 `1.1.0`。
- 验证：`node --check extensions/index.ts`、`node --check src/subtask.js`、`node --check src/workflow.js`、`node --check src/roles.js`、`node --check src/scaffold.js`、`git diff --check` 通过；`npm test` 全部通过。
- 遗留问题：真实 pi-subtask 模型驱动连续任务、fork 生命周期和 reload 后人工恢复尚未演练；未提交或推送。

### 2026-08-18：将工作流进度查看改为 TUI 弹窗

- 完成内容：`/pi-init workflow status` 以及控制中心的“查看任务进度”在 TUI 中改为居中 overlay 弹窗，使用主题背景色、标题高亮和四边框明确区分弹窗，显示状态、进度、执行器、规划、暂停原因和可滚动任务列表；RPC 等非 TUI 模式继续使用原有通知文本。
- 完成内容：增加 TUI 弹窗和非 TUI 回退测试，覆盖 overlay 配置、四边框和任务状态展示。
- 验证：`npm test`，46 项全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实交互式 Pi TUI 中进行视觉验收。

### 2026-08-16：以精确模型引用替代 fail-closed Provider 白名单，升级版本

- 完成内容：确认历史“模型随意切换”根因为 Agent 子代理模糊模型名（`haiku`/`sonnet`）、agent 类型默认模型解析和宿主跨 Provider fallback，主会话无自动 fallback；据此移除 `providerPolicy` 整套机制。
- 完成内容：`src/roles.js` 删除 `resolveProviderPolicy`/`isProviderAllowed`/`isModelAllowed`/`assertProviderAllowed`/`assertModelAllowed`，`resolveRoleConfig` 不再输出 `providerPolicy`；扩展删除 `enforceProviderPolicy`/`restoreAllowedModel`/`configuredFallbackModel` 和 `model_select` 回滚、输入/provider 请求前守卫，manual 写回不再联动 allowlist。
- 完成内容：Agent spawn 保留精确引用纪律（省略注入完整 `provider/model`、模糊名称拒绝、注册表精确存在校验，全模式统一）；`/pi-init config` 候选列表展示全部已注册模型；修复 `model_select` 后状态栏不刷新——现在所有模式、所有路径（含 manual 写回被跳过的情况）统一刷新底部状态。
- 完成内容：同步中英文模板、README、决策/当前状态文档；版本从 `1.0.8` 升级到 `1.1.0`。
- 验证：`npm test`，44 项全部通过（覆盖无回滚、写回、spawn 纪律、全量候选和 roles 单元语义）；`git diff --check` 通过。
- 遗留问题：完全限定的跨 Provider 引用不再被拦截；未在真实 Pi TUI 中端到端演练。

### 2026-08-16：手动模式直连宿主并写回配置，升级版本

- 完成内容：澄清 README 中 fail-closed Provider 策略的歧义表述（配置修改途径分条列出，fallback 与临时解锁单独成段）。
- 完成内容：`mode: "manual"` 语义升级为直连宿主：`enforceProviderPolicy` 在 manual 下直接放行（覆盖 `session_start`、输入、provider 请求前守卫），Agent `tool_call` 门禁不再注入继承模型；`model_select` 在 manual 下改走 `writeBackManualModelSelection`，把活动角色的模型写回 `.pi/role-models.json` 并按需追加 Provider 允许列表，同值切换幂等跳过，无活动角色或非受信任项目仅提示。
- 完成内容：新增测试覆盖守卫旁路、写回（含允许列表扩展）、幂等、无活动角色提示和 Agent 门禁放行；同步中英文 `AGENTS.md`/`SKILL.md` 模板、README 模式说明和 Provider 锁定章节、根 `AGENTS.md`。
- 完成内容：版本从 `1.0.7` 升级到 `1.0.8`。
- 验证：`npm test`，44 项全部通过（含 2 项新增）；`git diff --check` 通过。
- 遗留问题：未在真实 Pi TUI 会话中端到端演练 manual 写回；`/pi-init config` 选择列表仍按允许列表过滤，manual 下暂不放开。

### 2026-08-15：报告时间改为系统本地时区

- 完成内容：报告时间从固定 UTC+8 改为使用运行 Pi 的系统本地时区，并显示数值时区偏移；持久化 Unix 时间戳保持不变。
- 验证：`npm test`，42 项全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。

### 2026-08-15：精简工作流报告并改用东八区时间

- 完成内容：精简任务和最终工作流报告，移除重复的文件列表、内部角色 ID、冻结时间和冗余分段，保留交付摘要、时间、耗时与验证信息。
- 完成内容：开始/结束时间改为 `YYYY-MM-DD HH:mm:ss+08:00`，持久化时间戳保持不变；普通执行时间报告同步使用该格式。
- 验证：`npm test`，42 项全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实长上下文模型会话中进行端到端演练。

### 2026-08-15：避免角色切换重复触发已完成的自动压缩

- 完成内容：定位 `Already compacted` 为 Pi 内置自动压缩与角色切换定制压缩在 `agent_settled` 边界重复执行；扩展现在检测 branch 尾部的 `compaction` entry 后直接续跑。
- 完成内容：增加角色切换回归测试，确认不会再次调用 `ctx.compact()` 或显示该警告。
- 验证：`npm test`，42 项全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实长上下文模型会话中进行端到端演练。

### 2026-08-15：增加项目级 Provider fail-closed 锁并升级版本

- 完成内容：新增默认只允许 `openai-codex` 的 `providerPolicy`；旧项目缺少策略字段时同样锁定。角色、模型选择/循环、会话恢复、工作流和 Agent 子代理共用策略，省略 Agent model 继承当前模型，`haiku`/`sonnet` 和 OpenRouter 参数在 spawn 前拒绝。
- 完成内容：针对当前 Pi 0.84 的通知型 `model_select` 增加 awaited 安全模型恢复，并在 `session_start`、输入、provider 请求前增加 fail-closed 守卫；同步中英文模板、README、决策、踩坑和当前状态文档。
- 完成内容：版本从 `1.0.6` 升级到 `1.0.7`，同步 `package-lock.json`。
- 验证：`npm test`，41 项全部通过。
- 验证：`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、`node --check src/roles.js`、package/package-lock 版本一致性检查和 `git diff --check` 通过；Git 仅提示 Windows 下的 LF/CRLF 转换警告。
- 验证：使用 `node --input-type=module` 实例化最小 ExtensionAPI harness，`init-project.ts` RPC 扩展加载成功。
- 遗留问题：Pi 核心尚未提供可取消的 `before_model_select`；当前实现依赖切换后立即回滚和请求前守卫，未来可接入核心事件进一步前移拦截。

### 2026-08-15：修复 npm lifecycle 中 pi-usage 安装目标错误并升级版本

- 完成内容：修复 `postinstall` 在 `pi update --extensions` 中误选当前包 `node_modules/.bin/pi.cmd` 的问题；安装器现在跳过该本地 shim，选择 PATH 中后续的实际 Pi CLI 目录。
- 完成内容：增加 npm lifecycle PATH 优先级回归测试，版本从 `1.0.5` 升级到 `1.0.6`，同步 `package-lock.json`。
- 验证：`node --test --test-name-pattern='本地 pi shim|自动刷新 pi-usage' test/scaffold.test.js`，2 项通过。
- 验证：`node --check scripts/install-launchers.js`、`node --check test/scaffold.test.js` 通过。
- 验证：手动执行安装器后，`%APPDATA%\\npm\\pi-usage.js` 的嵌入版本更新为 `1.0.6`，执行 `pi-usage 2026-08-15` 输出 `v1.0.6`。
- 验证：`npm test`，37 项全部通过。
- 验证：`node --check scripts/install-launchers.js`、`node --check test/scaffold.test.js`、`git diff --check` 通过，仅有 Git 的 LF/CRLF 环境警告。
- 遗留问题：无。

### 2026-08-15：角色配置改为会话暂存并升级版本

- 完成内容：运行时角色切换、角色模型配置和工作流配置改为当前会话草稿；`/pi-init config` 不再直接写 `.pi/role-models.json`，新增 `/pi-init save` 作为显式保存入口。
- 完成内容：更新控制中心、命令补全、中文/英文 README、AGENTS 和 Skill 模板；版本从 `1.0.4` 升级到 `1.0.5`，同步 `package-lock.json`。
- 完成内容：增加回归测试，验证配置保存前文件不变、显式保存后才更新。
- 验证：`npm test`，36 项全部通过；命令输出显示 `pi-init@1.0.5`。
- 验证：`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、`node --check scripts/pi-usage.js`、`node --check scripts/install-launchers.js` 通过。
- 验证：`git diff --check` 通过，仅有 Git 将 LF 转换为 CRLF 的环境警告。
- 遗留问题：无。

### 2026-08-15：同步 pi-init 与 pi-usage 版本并显示版本号

- 完成内容：`pi-usage` 以 `package.json` 的 `version` 作为仓库运行时版本来源，报告标题追加 `v<version>`；安装器复制脚本时将同一版本嵌入独立启动器，避免脱离 package 目录后版本丢失。
- 完成内容：增加版本一致性、报告输出和安装器嵌入版本的回归测试。
- 验证：`node --test --test-name-pattern='pi-init 与 pi-usage 共用版本|Pi package 更新时自动刷新' test/scaffold.test.js`，2 项通过。
- 验证：`node --check scripts/pi-usage.js`、`node --check scripts/install-launchers.js`、`node --check test/scaffold.test.js` 通过。
- 验证：`npm test`，35 项全部通过。
- 验证：`git diff --check` 通过。
- 遗留问题：无。

### 2026-08-15：完成 pi-usage JSONL 导入 I/O 优化

- 完成内容：将 usage/activity/speed 事件改为 DuckDB Appender 批量写入；每文件的删除、写入和 checkpoint 更新使用事务；speed schema 回填使用单个全量重建事务。
- 完成内容：将 JSONL 解析改为字节流读取，`session_files` 保存 offset、下一行号、cwd、尾部校验和 EOF 不完整状态；追加只处理新字节，截断、改写或校验失败全量回退；duration summary 只刷新受影响日期。
- 完成内容：增加可选刷新进度回调和 TTY 摘要；README 补充追加 checkpoint、回退和自动/手动刷新进度说明；增加不完整尾部、补全、同尺寸改写和无变化刷新测试。
- 验证：`npm test`，34 项全部通过。
- 验证：`node --test --test-name-pattern='流式 checkpoint'`，目标测试通过。
- 验证：本机 112 个 session 文件实际进度检查，首次 `filesRebuilt=112`、`bytesRead=215607665`，独立计时约 2.3 秒；第二次 `filesSkipped=112`、`filesChanged=0`、`durationDates=[]`，独立计时约 65 ms。
- 验证：`git diff --check` 通过，仅有 Git 将 LF 转换为 CRLF 的环境警告。
- 遗留问题：尚未在真实 TTY 终端观察进度文本，也未在 Linux/macOS 上执行；变更文件的全量回退仍需读取该文件全部内容，这是正确性优先的边界。

### 2026-08-14：将最终摘要改为整体工作总结与复盘

- 完成内容：最终报告保留冻结规划作为“工作流目标”，新增“整体工作总结”“工作复盘”“汇总验证”；总结和验证按任务顺序从持久化状态确定性汇总，复盘使用已有冻结时间、整体实际执行区间和总耗时，不增加模型调用。更新 local/subagents 共用报告的 TUI 样式和回归测试。
- 验证：`npm test`，33 项通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：真实模型连续多任务、subagents 生命周期和交互式 TUI 视觉验收仍未执行。

### 2026-08-14：增加冻结工作流整体完成报告

- 完成内容：持久化工作流级实际开始/完成时间；最终 `task_workflow` 报告使用冻结的 `state.plan.summary`，汇总全部任务和验证结果，并展示从首个任务实际开始到最后任务完成的整体耗时。中间任务仍使用任务级报告，local 与 `subagents` 完成路径统一格式和醒目 TUI 样式。
- 验证：`npm test`，33 项通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：真实模型连续多任务、subagents 生命周期和交互式 TUI 视觉验收仍未执行。

### 2026-08-14：修复 task_workflow 完成报告显示

- 完成内容：修复 `task_workflow complete` 的 `renderResult`，不再让工作流进度摘要覆盖完整任务完成报告；现在会显示任务摘要、开始时间、结束时间、总耗时和验证结果。
- 验证：`npm test`，33 项通过；`node --check extensions/init-project.ts`；`node --check test/scaffold.test.js`；`git diff --check` 均通过。
- 遗留问题：真实交互式 TUI 视觉验收仍未执行。

### 2026-08-14：增加非工作流 Agent 执行时间报告

- 完成内容：新增普通执行计时模型和扩展生命周期接入；`interactive`/`rpc` 输入从首次 `agent_start` 计时到最终 `agent_settled`，完成后写入 `pi-init-run-timing` custom entry，并在 TUI 展示来源、开始/结束时间、总耗时和不等同于任务完成的计时口径。活动工作流、扩展隐藏续跑、subagents 和中断路径不会重复或伪造普通报告。
- 完成内容：新增核心边界、扩展 harness、custom entry renderer 和工作流计时回归测试。
- 验证：`npm test`，32 项通过；`node --check test/scaffold.test.js`；`git diff --check` 均通过。
- 遗留问题：尚未在真实交互式 TUI 和真实模型连续工作流中进行端到端视觉/生命周期演练。

### 2026-08-14：修正任务完成报告的开始时间

- 完成内容：不再在工作流预调度阶段写入任务开始时间；本地任务在 `agent_start` 生命周期记录实际模型执行开始时间，子代理任务在发起执行前记录开始时间，并用持久化标记避免提醒回合重复刷新。旧状态的过时时间会在首次实际派发时刷新。
- 验证：`npm test`，29 项通过；`node --check src/workflow.js`、`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 均通过。
- 遗留问题：真实模型连续任务仍未演练。

### 2026-08-14：修复工作流终态后的底部状态显示

- 完成内容：工作流完成或取消后，底部 `pi-init` 状态改为显示初始的策略、执行器和无活动工作流摘要；保留控制中心和状态命令中的终态数据。
- 验证：`npm test`，29 项通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、扩展 RPC 加载和命令发现、`git diff --check` 均通过。
- 遗留问题：尚未在真实交互式 TUI 中观察完成后状态栏的视觉效果。

### 2026-08-14：补充 read/edit 工具调用约束

- 完成内容：在项目及中英文生成模板的 `AGENTS.md` 中增加 `read`/`edit` 参数边界、编辑前重读、精确复制 `oldText` 和匹配失败后重新读取规则。
- 验证：检查相关文件 diff；未运行代码测试，因为本次仅修改协作规则文档。
- 遗留问题：无。

### 2026-08-14：增加任务完成时间和结构化完成报告

- 完成内容：工作流任务进入 `in_progress` 时记录开始时间，完成时记录结束时间；新增任务耗时计算，旧状态缺少开始时间时保持兼容并报告不可用。
- 完成内容：本地 `task_workflow complete` 和 subagents 完成事件统一输出任务完成报告，包含任务 ID、任务内容、角色、涉及文件、开始/结束时间、总耗时、完成摘要和验证结果；同步中英文生成模板及 README 说明。
- 验证：`node --test --test-concurrency=1 test/scaffold.test.js`，29 项通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、扩展 RPC 加载和命令发现、`git diff --check` 均通过。
- 遗留问题：真实 subagents 模型驱动完成报告端到端演练仍未执行；未提交或推送。

### 2026-08-14：完成 pi-subagents 工作流集成和受限脚手架

- 完成内容：新增默认 `local`、可选 `subagents` 的工作流执行器；通过 `pi.events` RPC 顺序委派并持久化 request/agent 绑定，严格验证 `pi-init/task-result@1`，对 RPC/扩展/结果错误安全阻塞，取消/阻塞发送 stop 请求，reload 不自动重生已绑定代理。
- 完成内容：脚手架生成 `.pi/agents/pi-init-developer-test.md` 与 `.pi/agents/pi-init-docs-commit.md`，仅开放 read/bash/edit/write，关闭 extensions、skills 和嵌套子代理；中英文 AGENTS/Skill 与 README 已记录安装前提、共享工作区、状态所有权、结果协议和孤儿代理边界。
- 验证：`npm test`，29 项通过；`node --check src/scaffold.js`、`node --check test/scaffold.test.js` 通过；`node --test --test-concurrency=1 test/scaffold.test.js`，29 项通过；扩展 RPC 加载和命令发现检查成功；`git diff --check` 通过，仅有预期的 CRLF 转换警告。
- 遗留问题：尚未使用真实 `@tintinweb/pi-subagents` 运行模型驱动的连续任务、生命周期事件和 reload 后人工恢复演练；未提交或推送。

### 2026-08-14：修复工作流运行时版本错误并外显工作流状态

- 完成内容：当时将 `(0, _roles.shouldOrchestrateWorkflow) is not a function` 解释为 Pi package 更新/reload 后扩展与相邻 `src/roles.js` 版本不一致；增加缺失函数时 fail-closed 的诊断、升级到 `1.0.4`，并在 README 记录 `pi update --extensions`、`/reload` 和本地重启建议。后续证据表明原长驻进程的实际加载路径未记录，具体 package/模块版本、缓存或副本原因没有被隔离；详见 [`docs/pitfalls.md`](pitfalls.md)。
- 完成内容：将工作流策略配置移出“变更 · 角色与模型”子菜单，增加控制中心顶层入口；主 `pi-init` 状态项和控制中心摘要显示工作流策略及活动工作流进度。
- 验证：`npm test`，24 项通过；`node --check src/roles.js`、`node --check src/workflow.js`、`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、`git diff --check` 通过；RPC 扩展加载和命令发现成功。
- 遗留问题：尚未在真实交互式 TUI 中截图验收；当前项目配置 `.pi/role-models.json` 的 `workflowMode` 仍为用户手动改成的 `off`，未覆盖。

### 2026-08-14：提高 pi-usage 柱状图对接近数值的辨识度

- 完成内容：模型 token 柱状图从整格四舍五入改为支持 Unicode 八分之一分数块；接近但不同的 token 数会显示不同的柱长，保留数字标签和最大值满格行为。
- 完成内容：增加回归测试，覆盖 100 与 99 token 不再渲染为相同柱状图。
- 验证：`node --test --test-name-pattern='柱状图使用分数块' test/scaffold.test.js` 通过；`node --check scripts/pi-usage.js`、`git diff --check` 和 `npm test`（25 项通过）通过。
- 遗留问题：未提交或推送。

### 2026-08-14：pi-usage 随 Pi package 更新自动重装启动器

- 完成内容：新增跨平台 `scripts/install-launchers.js`，并配置 package `postinstall`；`pi update --extensions` 触发 npm 安装流程时，会根据当前平台重新复制 `pi-usage` 启动器和脚本。
- 完成内容：找不到 `pi` 或 npm 禁用 lifecycle scripts 时不阻断 package 更新；补充 README 和安装回归测试。
- 验证：`node --check scripts/install-launchers.js`、`node --check scripts/pi-usage.js`、`git diff --check` 和 `npm test`（26 项通过）通过。
- 遗留问题：尚未提交或推送。

### 2026-08-14：增加 task_workflow 全局开关

- 完成内容：新增顶层 `workflowEnabled` 配置，默认关闭；`/pi-init config workflow` 可持久启用或关闭，`task_workflow(action=plan)` 关闭时拒绝，既有工作流收尾操作不受影响。
- 完成内容：同步中英文 `AGENTS.md`、Skill、README、当前项目配置和设计决策，明确启用前提及直接编辑 `.pi/role-models.json` 的路径。
- 验证：`npm test`，24 项测试全部通过；`node --check extensions/init-project.ts`、`git diff --check` 和 RPC 扩展命令发现检查通过。
- 遗留问题：尚未在真实交互式 TUI 中演练开关菜单；该设计随后由下方 off/on/auto 策略取代。

### 2026-08-14：任务工作流升级为 off/on/auto 策略

- 完成内容：将规范配置字段升级为默认 `workflowMode: "auto"`，配置中心支持 `off`、`on`、`auto`；`auto` 对不超过 2 个任务跳过工作流状态、调度和角色切换，`on` 保留完整编排，`off` 继续拒绝新规划。
- 完成内容：保留旧 `workflowEnabled` 的读取兼容，并同步当前项目配置、双语 AGENTS/Skill 模板、README、当前状态和设计决策。
- 验证：`npm test`，24 项测试全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、`git diff --check` 通过；RPC 扩展加载和命令发现成功。
- 遗留问题：真实模型连续多任务端到端演练和真实交互式 TUI 菜单演练仍未执行；未提交或推送。

### 2026-08-14：移除自研 parallel_develop

- 完成内容：删除 `parallel_develop` 运行时工具及 `src/parallel.js`、`src/parallel-runner.js`；清理 README、模板、项目 Skill、AGENTS.md 和测试中的自研并行开发说明、导入、fixture 与契约断言。保留 `task_workflow`、`switch_role`、角色模型配置和脚手架生成。
- 验证：`npm test`，24 项测试全部通过；`node --check test/scaffold.test.js` 通过；退休实现引用扫描无结果；`git diff --check` 通过，仅有预期的 CRLF 转换警告。
- 遗留问题：未配置第三方并行开发替代品；`task_workflow` 真实模型连续多任务端到端演练仍未执行；未提交或推送。

## 记录格式

每次记录应包含日期、完成内容、实际执行的验证及遗留问题。

## 会话

### 2026-08-14：增加架构拆分和自动连续任务工作流

- 完成内容：新增 `src/workflow.js` 状态机，支持架构计划、任务依赖、角色、文件范围、验收标准、完成、阻塞、审阅暂停、恢复、重试、取消和未完成提醒。
- 完成内容：扩展新增 `task_workflow` 工具、工作流状态栏、session custom entry 恢复、自动角色切换和隐藏续跑消息；架构审阅仅由初始 `reviewRequired` 明确触发，默认自动进入下一个任务。
- 完成内容：中英文 `AGENTS.md` 和项目 Skill 模板补充连续流水线、任务拆分、暂停条件和 `task_workflow` 使用规则。
- 验证：`node --check src/workflow.js`、`node --check extensions/init-project.ts`、`node --test --test-concurrency=1`，34 项通过；`git diff --check` 通过；RPC 扩展命令发现和加载检查成功。
- 遗留问题：真实模型驱动的连续多任务端到端演练尚未执行；尚未提交或推送。
### 2026-08-13：修复 pi-usage TPS schema 升级导致更新变慢

- 完成内容：schema 从旧版本升级时只扫描 session JSONL 中的 `pi-token-speed` 样本并回填 `speed_events`，不再强制删除和重导全部 `usage_events`、`activity_events`。
- 完成内容：增加回归测试，确认迁移会保留已有 usage 数据并恢复平均 TPS；修正当前状态、设计决策和踩坑记录。
- 验证：89 个 session、约 161 MB 数据的旧库迁移基准从约 60 秒降至约 2.2 秒；`npm test` 29 项通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js`、`git diff --check` 通过；实际 `node scripts/pi-usage.js --update` 成功。
- 遗留问题：未提交或推送。

### 2026-08-13：展示按模型统计的平均 token 速度

- 后续修正：发现 `done` assistant stream event 发生在扩展的 `message_end` 之前，而 Pi 会在 `message_end` 后才持久化最终消息；改为在 assistant `message_start` 开始计时、`message_end` 使用最终 provider usage 立即写样本，`agent_end` 仅作兼容兜底并防重复。
- 后续修正：为 TypeScript 扩展内部导入补充 `.ts` 扩展名和 `allowImportingTsExtensions`，确保 Pi 运行时与 `tsc` 的模块解析一致。

- 完成内容：`pi-token-speed` 在 assistant `message_end` 时写入不进入上下文的 `pi-token-speed` 自定义 session entry，保存 provider/model、provider 输出 token 和排除 prompt-processing tool 时间后的有效生成时长；避免 `message_update` 的 done/error 与 `agent_end` 重复记录。
- 完成内容：`pi-usage` 新增 `speed_events` DuckDB 表和 schema 版本迁移，按模型显示加权 `Avg TPS`，Total 行也显示整体加权速度；无历史采样的模型显示 `--`。
- 完成内容：补充 `pi-token-speed` 引擎测试和 `pi-usage` 集成测试，更新两个项目 README。
- 验证：`pi-token-speed` 执行 `npm test`，4 项通过；`npx tsc -p tsconfig.json --pretty false` 通过；RPC 扩展加载检查通过。
- 验证：`pi-init` 执行 `node --check scripts/pi-usage.js`、`node --test --test-concurrency=1`，28 项通过；并运行 `git diff --check`。
- 遗留问题：`pi-init` 默认并发 `npm test` 的 Windows CLI 启动测试仍有环境相关偶发失败；串行测试通过。未提交或推送。

### 2026-08-12：移除 pi-fast 和 pi-update

- 完成内容：删除 `pi-fast`、`pi-update` 的 Windows/POSIX 脚本，移除安装器复制逻辑，并清理 README、当前状态和测试引用。
- 验证：`bash -n scripts/*.sh`、`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js`、`git diff --check` 通过；`npm test` 26/27 通过，现有 Windows Pi CLI 启动测试偶发失败。
- 遗留问题：无。

### 2026-08-10：优化 pi-usage 模型用量展示

- 完成内容：移除 Git changes 的扫描、数据库汇总和报告展示；增加按模型总 token 缩放的 Unicode 柱状图。
- 完成内容：在 Overview 增加缓存占比结果，按 `(Cache R + Cache W) / Total` 计算并显示缓存 token、总 token和百分比；补充 pi-usage 回归断言。
- 验证：`node --test test/scaffold.test.js`，27 项测试全部通过；`node --check scripts/pi-usage.js` 和 `git diff --check` 通过。完整测试在 `npm test` 下偶发 Windows Pi CLI 启动测试失败（26/27），单独重跑该测试通过；`node --test --test-concurrency=1` 全部通过。
- 遗留问题：`npm test` 的 Windows Pi CLI 启动测试仍有环境相关偶发失败；尚未提交或推送。

### 2026-08-09：增加 pi-usage 日用量统计命令

- 完成内容：新增跨平台 `pi-usage` 启动器和 Node.js 汇总脚本，支持默认当天或指定 `YYYY-MM-DD`，按模型统计调用次数、input/output/cache token、总 token 和费用；摘要调用单列为 `Tools/summaries`。
- 完成内容：更新 Windows/POSIX 安装器、README 和相关测试。
- 验证：`npm test`，24 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js`、`bash -n scripts/*.sh`、`git diff --check` 和 `npm pack --dry-run` 通过；脚本实际读取当前 session JSONL 并输出汇总。
- 遗留问题：尚未提交或推送。

### 2026-08-09：将 pi-usage 改为 DuckDB 统计并加入 Git 变化

- 完成内容：引入 `@duckdb/node-api`，将 JSONL usage 导入 `~/.pi/agent/pi-usage.duckdb`；缺少依赖时自动安装用户目录运行时。
- 完成内容：按 session `cwd` 关联 Git 仓库，增加当天 commit 变化和当前已跟踪未提交变化统计；README、安装说明和测试同步更新。
- 验证：`npm test`，24 项测试全部通过；`node --check scripts/pi-usage.js`、`bash -n scripts/*.sh`、`git diff --check` 通过；实际运行 DuckDB 汇总、临时目录自动安装 DuckDB fallback 均通过。
- 遗留问题：尚未提交或推送。

### 2026-08-09：优化 pi-usage 终端输出

- 完成内容：重排标题、模型统计和 Git 变化分区，改为左对齐名称、右对齐数值，缩短表头和仓库路径，去除重复列和行尾空格。
- 验证：`npm test`，24 项测试全部通过；`node --check scripts/pi-usage.js`、`git diff --check` 通过。
- 遗留问题：尚未提交或推送。

### 2026-08-09：增加颜色和使用时长统计

- 完成内容：交互终端增加 ANSI 标题/分区颜色，支持 `NO_COLOR=1`；新增活跃时长、模型等待时长和 session 跨度，并写入 DuckDB 的 `duration_summaries`。
- 完成内容：命令执行期间在交互终端显示扫描、DuckDB 和 Git 统计进度；补充等待原因说明和颜色/时长测试。
- 验证：`npm test`，24 项测试全部通过；`node --check scripts/pi-usage.js`、ANSI 输出检查和 `git diff --check` 通过。
- 遗留问题：尚未提交或推送。

### 2026-08-09：改为数据库查询并支持 session 增量更新

- 完成内容：默认 `pi-usage` 只查询 DuckDB，新增 `--update` 扫描 JSONL；通过 `session_files` 的大小和修改时间跳过未变化文件，变化或删除的 session 会同步更新/清理 usage 和 activity 数据。
- 完成内容：新增 `activity_events` 持久化，为增量更新后的时长计算提供完整事件来源；无数据时提示执行 `pi-usage --update`。
- 验证：`npm test`，24 项测试全部通过；覆盖数据库缓存查询、颜色、时长、增量导入、`node --check scripts/pi-usage.js` 和 `git diff --check`。
- 遗留问题：尚未提交或推送。

### 2026-08-09：修复角色切换与上下文压缩的生命周期竞争

- 完成内容：定位 `turn_end` 中调用 `ctx.compact()` 会 abort 仍处于活动状态的 agent run，导致会话先记录 `This operation was aborted`；将待处理角色压缩改为在 `agent_settled` 事件启动。
- 完成内容：补充回归测试，确保角色切换压缩监听 `agent_settled` 而不是 `turn_end`；同步更新踩坑、当前状态和设计决策文档。
- 验证：`npm test`，25 项测试全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：真实模型端到端角色切换压缩续跑尚未演练；本次改动尚未提交或推送。

### 2026-08-09：统一 pi-usage 表格和颜色输出

- 完成内容：将 Overview、Models、Time 和 Git changes 的数据统一为对齐表格；交互终端为表头、分隔线和 Total 行增加 ANSI 颜色，非 TTY 与 `NO_COLOR=1` 保持纯文本。
- 完成内容：补充表格布局和颜色回归断言，并修正 README 中角色压缩触发时机的过期描述。
- 验证：`npm test`，25 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-09：初始化模板内置 Clean Code 规则

- 完成内容：新增 `templates/docs/clean-code.md` 和英文模板副本，生成项目时输出 `docs/clean-code.md`；中英文 `AGENTS.md` 均要求任务开始时优先读取该规则文件。
- 完成内容：保留来源 URL、版权和 MIT 许可说明，并补充初始化产物、测试和设计决策文档。
- 验证：`npm test`，25 项测试全部通过；`node --check src/scaffold.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-09：补充 pi-usage 表格边框

- 完成内容：为 Overview、Models、Time 和 Git changes 四个数据表增加完整的 Unicode 外框、列分隔线和表头/表尾分隔线，颜色继续只在 TTY 中启用。
- 验证：`npm test`，25 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-09：同步当前项目配置到新版 pi-init 模板

- 完成内容：根据当前 `.pi/role-models.json` 重新生成项目级 `AGENTS.md` 和 `.pi/skills/pi-init/SKILL.md`，补入宿主环境、Clean Code 入口、精确替换规则，并同步架构师 `medium` 推理强度。
- 完成内容：补入当前项目缺失的 `docs/clean-code.md`；同步模板 Skill 中的 `agent_settled` 压缩生命周期描述。
- 验证：`npm test`，25 项测试全部通过；配置解析、`node --check src/scaffold.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-09：按 Clean Code 规则清理 pi-usage

- 完成内容：修复默认日期范围从当前时刻开始的问题，改为本地当天 `00:00`；删除数据库增量导入后已无调用方的旧 JSONL 扫描函数。
- 完成内容：为默认日期边界补充回归测试，避免 Git 当日统计漏掉午夜至当前时刻之间的提交。
- 验证：`npm test`，26 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送；大型模块拆分暂不执行，待有明确边界或维护痛点时再处理。

### 2026-08-09：为 pi-usage 增加一小时自动检查

- 完成内容：普通查询首次、距上次检查超过一小时或跨自然日时自动执行增量检查；未过期时直接读取 DuckDB，`--update` 仍然强制检查。
- 完成内容：新增 `usage_state` 检查状态，并让文件变化影响的历史日期一并刷新派生汇总。
- 验证：`npm test`，27 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。
### 2026-08-06：为生成的 Skill 增加精确字符串替换说明

- 完成内容：中英文 Skill 模板增加类似 Claude Code Edit 的精确 `oldText` → `newText` 替换规则，覆盖唯一匹配、最小上下文、多个非重叠替换和修改后 diff 检查。
- 完成内容：补充中英文脚手架生成测试。
- 验证：`npm test`，23 项测试全部通过；`git diff --check` 通过。
- 遗留问题：尚未提交或推送。

### 2026-08-06：增加跨平台离线启动和扩展更新脚本

- 完成内容：新增 Windows `.cmd`、POSIX `.sh` 启动器，以及 PowerShell/POSIX 安装器；启动和升级分别控制 `PI_OFFLINE`，脚本纳入发布包。
- 完成内容：Windows 安装器将脚本复制到 `pi.cmd` 所在的 npm 可执行目录，修复脚本只存在于未持久 PATH 的用户 bin 导致 PowerShell 无法识别的问题。
- 验证：`npm test`，23 项测试全部通过；`bash -n scripts/*.sh`、`node --check test/scaffold.test.js`、`git diff --check`、`npm pack --dry-run` 通过；PowerShell 下 `pi-fast.cmd --version` 实际返回 `0.84.1`。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-06：恢复会话角色状态以支持跨日压缩

- 完成内容：`session_start`、resume 和 reload 时，根据当前 provider/model 与实际推理强度唯一匹配并恢复角色；重复配置或无法匹配时保持未知。
- 完成内容：补充角色恢复单元测试，避免会话重启后第一次真实跨角色被误判为首次选角。
- 验证：`npm test`，22 项测试全部通过；`node --check src/roles.js`、`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 通过。
- 遗留问题：尚未使用真实模型验证跨日 resume 后的自动压缩续跑。

### 2026-08-06：修复并行 worker 跨平台兼容性

- 完成内容：Windows Node/Bun 备用入口改为通过 `cmd.exe` 安全转义启动 `pi.cmd`；POSIX worker 使用独立进程组，Windows 使用 `taskkill /t /f`，取消和超时均终止整个进程树。
- 完成内容：文件范围校验读取 Git `core.ignorecase`，统一处理 Windows/macOS 默认大小写不敏感文件系统；新增 Ubuntu、macOS、Windows GitHub Actions 测试矩阵。
- 验证：`npm test`，21 项测试全部通过；`node --check src/parallel.js`、`node --check src/parallel-runner.js` 和 `git diff --check` 通过；Windows `.cmd` 备用入口实际启动 Pi CLI 成功。
- 遗留问题：Linux、macOS CI 尚未在本地执行，待 GitHub Actions 验证。

### 2026-08-06：自动角色切换增加上下文压缩

- 完成内容：自动模式下，真实跨角色且切换前上下文使用率达到 50% 时，在当前回合结束后触发一次定制压缩；摘要保留目标、决策、进度、文件、验证结果和下一步，成功后通过隐藏续跑消息自动继续任务。
- 完成内容：确认、手动、首次选角、同角色重复切换和未知上下文不触发额外压缩；压缩失败只提示，不回滚已切换角色。
- 验证：`npm test`，17 项测试全部通过；`node --check src/roles.js`、`node --check test/scaffold.test.js`、`node --check extensions/init-project.ts`、`git diff --check` 和 RPC 扩展命令发现检查通过。
- 遗留问题：尚未使用真实模型端到端验证压缩后的自动续跑流程。

### 2026-08-06：状态卡片增加文字内边距

- 完成内容：状态卡片每行文字左右增加 1 格内边距，避免背景色紧贴文字；保留控制中心整体 2 格 padding。
- 验证：`node --check extensions/init-project.ts`、`npm test`（16 项通过）和 `git diff --check` 通过。
- 遗留问题：尚未在真实交互式终端中进行截图验收。

### 2026-08-06：版本 1.0.3 发布并补充角色关系图

- 完成内容：版本从 `1.0.2` 更新为 `1.0.3`，在 README 增加角色、模型、模式关系 Mermaid 图，并同步使用角色相关用户文案。
- 验证：`npm test` 16 项通过，`git diff --check` 通过。
- 收尾：已提交并推送到 `origin/master`。

### 2026-08-06：控制中心留白和角色文案调整

- 完成内容：使用 Pi 原生 `Box` 和 `Spacer` 为控制中心内容增加标题间距及统一 2 格左右 padding；将用户界面的“职责”文案调整为“角色”，并将主菜单分组改为“变更 · 角色与模型 / 切换角色 / 切换模式”。
- 验证：`node --check extensions/init-project.ts`、`npm test`（16 项通过）、`git diff --check` 和 RPC 扩展加载检查均通过。
- 遗留问题：尚未在真实交互式终端中进行截图验收。

### 2026-08-06：版本 1.0.2 发布

- 完成内容：发布第二轮控制中心 UI 优化，版本从 `1.0.1` 更新为 `1.0.2`。
- 验证：`npm test` 16 项通过，RPC 检查和 `git diff --check` 通过。
- 收尾：已提交并推送到 `origin/master`。

### 2026-08-06：第二轮 TUI 展示优化

- 完成内容：增加控制中心状态卡片、初始化/职责分组标签、图标、首次使用引导、紧凑初始化通知和返回上一级行为；模型列表显示可用推理级别，状态摘要使用当前实际模型并兼容窄终端换行。
- 验证：`npm test`，16 项测试全部通过；`node --check extensions/init-project.ts` 和 `git diff --check` 通过；RPC 命令发现和 `/pi-init mode auto` 执行成功。
- 遗留问题：尚未在真实交互式终端中进行截图验收。

### 2026-08-06：版本 1.0.1 发布准备

- 完成内容：将 `package.json` 版本从 `1.0.0` 更新为 `1.0.1`，同步整理 README 的初始化流程说明。
- 遗留问题：提交已完成，推送待本次会话完成后执行。

### 2026-08-06：记录宿主系统和跨平台命令约定

- 完成内容：`init_project` 生成的中英文 `AGENTS.md` 增加初始化宿主系统、CPU 架构和平台命令约定；Windows 规则覆盖 `where.exe`、`.cmd` shim、`pi.exec` 直接启动进程及安装前复核 CLI。
- 完成内容：补充 README 使用建议，并在当前用户的 `~/.pi/agent/AGENTS.md` 写入 Windows 全局宿主环境规则。
- 验证：`npm test`，14 项测试全部通过；`node --check src/scaffold.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 验证：`printf '{"id":"commands","type":"get_commands"}\\n' | pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc`，扩展加载和命令发现成功。
- 验证：Windows 下 `where.exe agent-browser` 能找到 npm 全局 CLI 及 `.cmd` shim；`cmd.exe` 方式可执行 `agent-browser --version`。当前 `agent-browser` 工具仍提示未安装，说明其检测/执行链与当前 Windows CLI 环境不一致，未在本仓库伪造修复第三方工具。

### 2026-08-06：调整开发测试模型

- 完成内容：将开发测试工程师的默认模型改为 `openai-codex/gpt-5.6-luna`，Pi 推理强度改为 `max`，并同步中英文模板、README、默认配置与测试。
- 验证：`npm test`，4 项测试全部通过。
- 验证：独立检查 `src/roles.js` 与 `.pi/role-models.json`，开发测试映射均为 `openai-codex/gpt-5.6-luna/max`。
- 遗留问题：暂无。

### 2026-08-06：增加并行开发测试编排

- 完成内容：新增 `parallel_develop` 工具；架构规划后可为 2 至 4 个文件范围不重叠的任务创建隔离 Git worktree，使用 `developer-test` 的 Luna/max 模型并发执行，并自动合并补丁。
- 完成内容：同步中英文项目 Skill、README、项目状态与设计决策；新增任务范围校验和测试。
- 验证：`npm test`，5 项测试全部通过。
- 验证：TypeScript 5.9.3 以 `strict`、`noEmit` 检查 extension 通过。
- 验证：`pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc` 的命令发现检查通过。
- 遗留问题：尚未进行真实 LLM 子代理端到端演练；当前已覆盖任务校验、扩展加载和编译检查。

### 2026-08-06：增加职责切换模式

- 完成内容：增加项目级 `mode` 配置和 `/role-mode` 会话命令，支持 `auto`、`confirm`、`manual`；确认模式默认接受自动建议，手动模式要求先执行 `/role`。
- 完成内容：`switch_role` 与 `parallel_develop` 遵守当前模式，避免手动模式下静默覆盖用户选择。
- 验证：`npm test`，5 项测试全部通过。
- 验证：TypeScript 5.9.3 以 `strict`、`noEmit` 检查 extension 通过。
- 验证：RPC 命令发现包含 `role-mode`，手动模式下执行 `/role architect` 后模型为 `gpt-5.6-sol/max`。
- 遗留问题：暂无。

### 2026-08-06：加固并行开发执行链路

- 完成内容：将并行 worktree、子代理执行和补丁合并移至 `src/parallel-runner.js`；改用 Pi 文本输出模式，移除 JSON 事件解析；传递已生效的开发测试模型；未受信任项目拒绝并行执行，子代理使用 `--no-approve`。
- 完成内容：关闭 Git 重命名检测以阻止文件范围绕过；手动职责模式现在会核对当前 provider、model 和 thinking level；删除无用职责模式 Schema。
- 完成内容：并行执行通过状态栏和工具进度显示已启动子代理数量（`x/y`），最终结果也显示总数。
- 验证：`npm test`，7 项测试全部通过，包含两个确定性 worktree/补丁合并测试和重命名范围测试。
- 验证：TypeScript 5.9.3 以 `strict`、`noEmit` 检查 extension 和 runner 通过。
- 验证：`pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc` 的命令发现检查通过。
- 遗留问题：尚未执行真实 LLM 子代理端到端演练。

### 2026-08-06：配置职责模型、初始化选择和运行时持久修改

- 完成内容：初始化和 `init_project` 支持按职责配置 provider、model、thinkingLevel；生成的中英文 Skill 表格与实际 `.pi/role-models.json` 同步。
- 完成内容：新增 `/role-config [role]`，从当前可用模型及其支持的推理强度中选择，写回项目配置并立即应用；Pi 原生 `/model` 与 `Shift+Tab` 保持会话级临时切换。
- 完成内容：并行编排器未返回结果；已检查两个隔离 worktree 的补丁、手动合并并清理 worktree。
- 验证：`npm test`，10 项测试全部通过。
- 验证：`printf '{"id":"commands","type":"get_commands"}\n' | pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc`，命令发现包含 `role-config`。
- 验证：尝试执行 TypeScript 检查失败，环境未安装 TypeScript 编译器；未将其记录为通过。
- 遗留问题：真实交互式初始化和 `/role-config` 选择流程尚未端到端演练。

### 2026-08-06：职责模型选择增加搜索过滤

- 完成内容：初始化和 `/role-config` 的职责模型选择增加搜索输入，支持按 provider、model ID 或模型名称过滤后再选择；无匹配时给出提示，不写入配置。
- 完成内容：新增模型过滤单元测试，覆盖大小写、provider、名称、空搜索和无匹配。
- 验证：`npm test`，13 项测试全部通过。
- 验证：`git diff --check` 和 `node --check src/roles.js` 通过。
- 遗留问题：暂无。

### 2026-08-06：统一控制中心和紧凑 TUI

- 完成内容：将用户命令统一为 `/pi-init`，提供控制中心、快速/高级初始化、职责与模型配置、职责切换和会话模式切换；删除四个旧的独立命令注册。
- 完成内容：快速初始化从 `package.json`、锁文件和目录名推断项目元数据；当前项目生成成功后自动调用 `ctx.reload()`；状态栏改为模式、职责、模型和推理强度的紧凑摘要。
- 完成内容：TUI 菜单使用 Pi 原生边框、选择列表和主题；模型配置增加即时搜索列表；初始化、职责切换和并行开发工具增加紧凑的自定义结果渲染；将 `@earendil-works/pi-tui` 声明为运行时 peer dependency。
- 验证：`npm test`，16 项测试全部通过；`node --check extensions/init-project.ts`、`node --check src/roles.js`、`git diff --check` 和 `npm pack --dry-run` 通过。
- 验证：RPC 扩展加载和命令发现成功，仅发现 `pi-init`（另有环境中的 `llama` 扩展）；`/pi-init mode auto` 执行成功。
- 验证：Windows 临时项目 RPC 流程执行 `/pi-init init .`，自动确认后生成 `AGENTS.md`，项目元数据和测试命令推断成功；Pi 子进程在自动 reload 后正常退出，验证脚本删除临时工作目录时遇到 Windows `EBUSY` 文件锁。
- 遗留问题：尚未在真实交互式终端中进行视觉截图验收；当前环境未安装 `tsc`，未执行独立 TypeScript 类型检查。

### 2026-08-06：并行子代理性能和传输错误处理优化

- 完成内容：默认并发从任务数上限调整为 2，超过并发数的任务排队；高频模型进度更新按 250ms 节流。
- 完成内容：修正终态 worker 耗时统计，增加每个 worker 及准备、worker、合并阶段的耗时、turn/token/cache/cost/自动重试指标。
- 完成内容：识别子代理 JSON 中 `stopReason: error`，将 `terminated` 等传输错误交给已有基础设施重试链路，避免退出码为 0 时误判为成功。
- 验证：`npm test`，15 项测试全部通过。
- 验证：`node --check src/parallel-runner.js`、`node --check src/parallel.js` 和 `git diff --check` 通过。
- 验证：RPC 命令发现成功，`parallel_develop` 扩展加载正常。
- 遗留问题：尚未进行真实 LLM 子代理端到端 A/B 性能测试；传输协议仍由 Pi 全局设置控制。

### 2026-08-06：并行子代理实时可观察性和故障接管

- 完成内容：worker 改用 Pi JSON 事件流，实时上报模型输出、工具调用、任务状态、耗时和心跳；主界面状态栏显示完成/运行/失败任务及当前活动。
- 完成内容：基础设施错误自动重试一次；代码或测试错误不盲目重试，失败时提示主开发测试工程师接管；失败 worktree、prompt 和 stdout/stderr 日志保留。
- 验证：`node --check src/parallel-runner.js` 通过。
- 验证：`npm test`，12 项测试全部通过，包含 JSON 事件解析、实时事件、心跳、自动重试和失败现场保留测试。
- 验证：RPC 命令发现仍包含 `role-config`，扩展加载成功。
- 遗留问题：尚未进行真实 LLM 子代理端到端演练。

### 2026-08-04

- 完成内容：修正中文模板中的知识库与 Git 身份表述；统一中英文策略；压缩项目级 Skill；补全本项目上下文；增强双语关键规则测试和工具调用指引。
- 验证：`npm test`，3 项测试全部通过。
- 验证：`pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc` 的命令发现检查通过。
- 验证：`npm pack --dry-run` 成功，发布包预览包含 16 个预期文件。
- 遗留问题：暂无。

### 2026-08-04：智能职责路由与全自动模型切换

- 完成内容：在中英文项目 Skill 中增加架构师、开发测试工程师、文档与提交工程师三类职责；新增 `.pi/role-models.json`、`switch_role` 工具和 `/role` 命令，在职责边界自动切换具体模型与 Pi 推理强度。
- 验证：`npm test`，4 项测试全部通过，覆盖中英文职责、默认映射、项目覆盖和无效配置。
- 验证：TypeScript 5.9.3 以 `strict`、`noEmit` 检查 extension 通过。
- 验证：RPC 依次切换 `architect`、`developer-test`、`docs-commit`，会话状态分别为 `gpt-5.6-sol/max`、`gpt-5.6-terra/high`、`gpt-5.6-luna/medium`。
- 验证：生成临时项目后通过 `pi --no-session --no-extensions --no-skills --skill <path> --mode rpc` 发现 `skill:role-demo`。
- 验证：`npm pack --dry-run` 成功，发布包预览包含 17 个预期文件。
- 遗留问题：暂无。
