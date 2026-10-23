## 待处理 当前状态

“最近一次更新”列表按日期倒序排列，当前状态正文只描述现状，不按时间排列。

## 测试组织

- 回归覆盖角色、扁平工作流、任务记忆、恢复/未知结果和诊断；退役功能的专属测试随实现删除，核心安全回归保留，完整结果以本轮实际验证为准。

## 轻量任务规则优化

- 中英文AGENTS托管区块明确默认展示/分组等局部低风险任务的轻量路径，优先避免会话开始的整批历史预读与例行三份记录；实际业务/数据/连接/路由/权限/无障碍变化仍升级，验证和提交保护保留。
- 结构审阅提示改为候选提醒：低风险且不改变职责结构的微调不必仅因超过500行新增完整审阅；候选不消失、不伪报已审，complete仍需当前指纹和全文件读取证据，显式/large保留。
- Skill明确实际路径发现、项目外公共Skill的允许读取方式及短结果直返；恢复提示先指明角色确认步骤，缺凭据不自动换模型。已有项目需同步托管区块，未自动改写其他项目的自定义规则。

## 交付粒度与无效往返收敛

- 架构师按可验收交付物规划目标/非目标/范围/风险匹配验证，执行者自主完成闭环；远期不确定内容在边界细化，不按工具操作机械拆任务。保留同一扁平队列，不恢复正式证据/嵌套协议。
- Provider最终错误或中止后停止当前工作流自动续跑，保留未知结果保护，不用nudge重复请求同一模型；同任务提醒改为非授权continuation消息，保持唯一任务锚点。
- 相同范围、相同成功结果的native只读观察连续重复时先提示，持续重复才请求原暂停路径。真实新内容/范围/非只读活动、身份或branch变化重置；并行/来源不确定不自动暂停，不缓存或跳过实际工具，不推断bash/codemode副作用。
- checkpoint缺失revision与真正陈旧分开报告；工具视图直接给出expectedMemoryRevision。complete可选evidenceIds引用本任务真实成功来源，保存verificationEvidenceIds；后续直接依赖可只读复用历史，不把它算作本任务执行或当前版本有效。仅文档变化不重复全仓验证，高风险失败/恢复检查不省。
- 同一调用的业务拒绝与后续SDK错误结果只计一次问题，保留两段现场。真实新会话成本收益尚待验证，当前未提交/部署。

## 活动任务重读修正

- 真实session重放证实字节投影在SDK低token占用时反复丢弃当前任务过程：151条变18条，原始历史仍在。当前已确认executing身份改用已有SDK token预算/压缩路径，不再额外字节裁剪；同一重放保留全部原任务消息。只读重复观察在近期记忆中去重，命令/写入不合并。此修复尚未部署，真实新会话收益待验证。

## 执行记忆架构

- [执行记忆与上下文重设计](execution-memory-architecture.md) 的简化实现已接通：TaskMemory 与唯一管理模块保存/恢复真实工具来源，现有 task_workflow 支持 checkpoint 与 status 按来源读取，最终上下文固定携带进展。保留扁平队列、唯一 dispatcher 和身份/验收/压缩保护；只改措辞不计证据进展，关键记忆不可用或超限时走原停止边界。尚未部署到正在运行的 Pi，真实重复率/完成率收益待验证。

## 功能收敛

- 已退役正式证据、结构任务契约/澄清、旧嵌套执行和/fast；保留普通调查任务、files/acceptanceCriteria/实际verification、checkpoint及单一扁平队列。旧记录返回WORKFLOW_FEATURE_RETIRED，只在确认副作用后隔离，不自动恢复或重放。
- 详细诊断与黑匣子共用写入、轮转和写失败处理；正常最终回复与确定性兜底共用完成视图；旧角色配置与暂存共用同一归一化边界，只有用户明确保存才改配置。

## 角色交接现状

- 根工作流完成后保留模型最终回复机会，并有一次不触发新回合的可见确定性报告兜底；交付阶段不再执行工具/Git，中间任务交接语义不变。文档/Git 收尾默认按全工作流统一安排，必要归属和提交前检查保留。规则及诊断见 [最终报告](handoff-diagnostics.md#根工作流最终报告)。

- 暂停状态连续查询另有运行时无进展保护：历史同身份重复交接和宿主 system 投影不再清空状态结果，未变更的暂停状态连续查询第二次会返回当前状态并结束该回合；工作流不被完成、恢复或重放。用法与限制见 [诊断日志](handoff-diagnostics.md#暂停轮询的运行时终止保护)。
- 活动工作流新增易失的疑似无进展诊断：比较语义状态、自动回合边界和显式状态查询，识别重复状态、A→B→A 循环、重复重规划方向；普通工具结果和重规划计划变化均不计作已核实进展。只有已验收的任务完成才重置进展窗口；诊断仅展示疑似线索，不自动暂停、终止或重试任务。
- 暂停轮询保护不会因普通工具结果清空；相同暂停状态的重复 status 仍会在同一 Agent 回合终止轮询。离线状态循环统计也跨过普通工具调用；实际输入、工作流持久化或 branch 变化仍会重置观察。
- 运行中的任务连续未提交结果时，第一次发送普通续跑提醒，第二次发送一次纠偏提示，要求停止重复查询/读取、直接完成当前任务；仍无结果的第三次暂停并标记结果未知，不再自动续跑或重放。纠偏提示要求复用已验证成果，不重复结果未知或副作用不明的操作。

- 上下文视图按活动执行、暂停恢复和共享协议分工；工具组解析与配对校验统一由 `role-context-protocol.ts` 处理，历史复用、预算和失败保留仅选择已有分组，不再各自维护一套配对状态。暂停、分支/身份和 TaskMemory 的保护继续保留。

- 暂停恢复已修复最早历史 handoff 缺失导致 status 结果丢失的路径；长任务增加独立有界检查点，工作流方向登记、执行者结果与 architect 重规划在安全边界衔接。统一动作策略、投影/拒绝指标及局限见 [诊断日志](handoff-diagnostics.md#上下文检查点与安全重规划)；尚未验证真实 token/时延收益。

## 项目

- 名称：`pi-init`
- 定位：用于 Pi 的项目初始化扩展，生成 `AGENTS.md`、项目记忆文档和 `.pi/role-models.json`，并随 package 发布公共职责路由 Skill。

## 当前目标

- 维护随 package 发布的公共职责路由 Skill；`.pi/role-models.json` 的 `roleModels` 保存显式模型映射并启用自定义角色，内置标准职责无映射时沿用当前 Pi 会话模型和推理强度。

## 当前已确认事实

- 协调证据链接在工作流统一持久化入口提交成功后同步执行代次，并在工作流/协调调度及补充取证前受限补偿同 session、同 workflowId、同 planVersion 的已有落后链接；正常 complete/block/retry 不再因遗漏同步而误报 COORDINATION_WORKFLOW_LINK_MISMATCH。工作流写入失败不先更新证据，证据写入失败保留已完成结果且暂不派发，存储恢复后只补关联、不重放任务。缺失、其他计划/session、未来代次与失效证据仍 fail-closed。

- 工作流进度面板已分离为只读分层浏览与受保护操作：Enter 查看任务详情，Esc 分层返回，a 打开状态相关操作，d 查看技术详情；长详情滚动、刷新保留选择与滚动、窄终端固定底部提示。取消范围明确且默认返回；未知结果重试必须核对副作用。确认前后检查状态来源与会话/上下文，操作最终复用已有命令，不新增状态写入入口；等待 AI 审阅不可直接放行父任务。

- 新目标采用“目标归属 + 扁平任务队列”：request-goal（request-child 兼容别名）只追加目标分组与任务，所有任务保持同一 workflowId；按已满足依赖、显式 priority 和稳定顺序选择，不压入新父子运行栈。新分组默认不加急，不强行中断当前任务，完成分组不等于根目标成功。插入须明确保留原 pending 项，替换/撤销通过普通 replan；阻塞态可在安全边界直接规划，未知副作用不自动重试。schema v7 兼容 v1–v6 原状态，旧栈和旧嵌套请求保留兼容收尾，不自动展开或重放。

- Local 工作流的调度决策与任务/重规划交接阶段集中到 `src/workflow-orchestrator.ts`：纯事件转换返回新状态和发送效果；消息层先持久化派发意图再发送，重复派发事件、过期身份和迟到 queued 不推进状态。执行中提醒是独立事件；完成、阻塞、重试、恢复与取消通过统一生命周期事件转换，命令和工具共用提交入口。嵌套完成/取消只在状态持久化成功后撤销旧身份续跑，写入失败不撤销。压缩、协调就绪门、真实启动验收及未知结果恢复继续沿用现有安全边界；规划、重规划应用与协调账本尚未统一迁移。设计与验证范围见 [`docs/plans/workflow-orchestration.md`](plans/workflow-orchestration.md)。

- 工作流状态结果默认以摘要突出阶段、进度、目标、当前任务与暂停原因；嵌套工作流的进度面板和状态摘要树状展示父目标、当前子目标、父层等待状态及已完成/取消的子目标。展开后保留完整状态、身份和嵌套历史。完成结果默认呈现简短任务/最终结果摘要，展开后保留验证与时间。TUI 进度面板刷新时保留仍有效的任务选择，workflowId 改变时转到新工作流当前任务；模型可见状态文本和调度/验收行为不受展示影响。详情见 [README.md](../README.md)。

- `/pi-init coordination reopen <reportId> <reason>` 仅重开最新且明确 `block` 的证据审阅：追加关联原报告、阻塞审阅与理由的重开记录，持久化成功后才签发新的 architect 复审 handoff；原取证/审阅记录和来源版本保留，不自动接受证据、不派发开发。协调状态 schema v2 迁移读取 v1；项目不可信、Agent 忙、恢复异常或存在未完成/结果未知 handoff 时 fail-closed，旧 handoff 身份不复用。验证及真实 Pi/TUI 未覆盖项见 [`docs/session-log.md`](session-log.md)。

- Local 工作流的 `complete`/`block` 到达时若交接仍为 `queued`，仅在完整 handoff 身份匹配、活动 session branch 含精确交接消息且当前角色匹配任务角色时，先持久化补记 `executing` 再进行严格验收；身份、branch 或角色不符仍 fail-closed，未知结果仍须显式核对和 retry。身份校验失败以模型可见 JSON 给出 code、差异字段、白名单 expected/received 与下一步；`status`、任务提示和重规划提示展示通过共享构造器生成的可复制 JSON 身份，`status` 保持只读。`task_workflow` TUI 将这些失败诊断按类别、代码、原因、白名单身份差异和下一步分段显示；普通错误与无法解析的诊断仍保留原始错误内容，不改变模型错误 JSON 或失败守卫。该路径不改变恢复时 queued 结果未知的策略，也不确认原始 stale identity 故障的字段根因。
- 控制中心同步当前项目发生实际变更并执行 `ctx.reload()` 后立即结束旧控制中心调用；同步结果通过 `reloaded` 标记向调用方表达，避免 reload 后继续使用失效的旧 `ctx`。无变更或有冲突时不 reload，菜单仍可继续。具体决策与验证见 [`docs/decisions.md`](decisions.md) 和 [`docs/session-log.md`](session-log.md)。
- pi-init 工作流固定为当前主会话内 local 顺序执行；缺省 executor 与旧 `workflowExecutor: "local"` 配置仍可读，执行器不再是控制中心或 schema 选项。`subagents`、`subtask`、`collaboration` 等未知值明确拒绝。当前状态持久化在 `pi.appendEntry` 正常返回后才更新内存状态；append 异常保留旧状态并停止本次调度。`architect` 不得作为执行任务角色，plan/replan 校验拒绝该角色；旧活动计划含 architect 执行任务时不持久化自动修复或派发，仅保留恢复错误供检查；用户显式取消后可另建计划。后续交接身份与恢复边界见 [`docs/plans/durable-workflow.md`](plans/durable-workflow.md)。
- 工作流暂停通知和 block 工具结果使用分区摘要，突出真实原因及恢复建议；纯文本与 TUI 从同一类型化暂停视图独立渲染，不解析已格式化文案。暂停结果不以成功标记呈现，展开后显示完整任务与身份技术状态。未知结果仍须先核对外部副作用，再显式确认 retry；block 工具不另发重复通知。
- 工作流工具 `AbortSignal` 只中止当前工具操作；业务取消需显式持久化 `cancelled`，只有持久化成功才退休所属续跑，且不等同于宿主压缩终止。`acknowledge` 是当前来源匹配告警的易失展示确认，不改变状态/守卫，身份变化、branch 切换及 reload 会重新提醒。`discard-recovery` 仅对明确不可恢复且无可读/待持久化状态的原记录，在可信项目、Agent 空闲、当前 branch 唯一且最新的原 entry ID、session/branch/error 精确匹配并确认未知副作用后，追加版本化引用处置；它不构成任务成功或取消。安全边界见 [`docs/decisions.md`](decisions.md)，用户用法见 [`README.md`](../README.md)。
- 状态、任务完成、最终完成、普通执行计时和操作错误采用各自的只读视图及纯文本/TUI renderer。状态视图服务状态文本、状态栏、进度面板和非暂停工具结果；任务完成只报告当前任务，最终报告使用明确的最终任务并只列明确失败的验证，计时缺失保留不可用语义。`workflowPresentation` 仅附加到瞬时工具结果 `details`，旧结果缺少判别信息时回退原文，不进入 `WorkflowState`/session entry；模型错误 JSON 与 `isError` 保持原契约。详情与取舍见 [`README.md`](../README.md) 和 [`docs/decisions.md`](decisions.md)。
- 旧配置顶层 `runtime` 字段返回 `RUNTIME_CONFIG_RETIRED`，`workflowExecutor: "runtime"` 返回 `WORKFLOW_EXECUTOR_RETIRED`；旧 Runtime executor/authority 或残留 payload 的持久状态返回 `WORKFLOW_STATE_RUNTIME_RETIRED`。状态和动作保留恢复错误，不会静默转为 local、不自动重放/迁移，也不改写或删除原始 session entry；旧配置需由用户检查并手动清理。
- 当前不包含自建外部 Runtime backend，也未接入或核实任何官方 Runtime 接口。历史双轨实现与旧验证记录仅作为历史保留，见 [`docs/decisions.md`](decisions.md) 的退役决策及 [`docs/plans/runtime-migration.md`](plans/runtime-migration.md) 的历史标记。

## 已知状态

## 待处理

- `extensions/index.ts`、`test/pi-usage.test.js`、`extensions/coordination-runtime.ts`、`extensions/workflow-actions.ts`、`extensions/workflow-dispatch.ts`、`src/coordination-validation.ts`、`src/workflow-model.ts`、`src/workflow-hydration.ts`、`test/coordination-runtime.test.js`、`test/coordination-simplification.test.js`、`test/extension-lifecycle.test.js` 与 `test/helpers.js` 的当前内容版本均已通过 `file_review` 完成结构审阅并建议保留；`extensions/file-review-runtime.ts` 和 `test/file-review-runtime.test.js` 已对移除功能后的当前内容完整读取并登记结构 `keep`。运行中的旧 Pi 工具 schema/提示尚未通过 reload 核实，需 reload 或重启后更新。
- Linux、macOS 的 CI 矩阵已加入但尚未在本地执行；pi-usage 的 PATH 遮蔽用例已在 macOS 宿主验证，但未在真实 Windows 宿主执行。第三方 `agent-browser` 工具在 Windows 上仍需上游修复 CLI 检测和 `.cmd` 启动兼容性，本项目只能通过 `AGENTS.md` 降低误安装和误用。

## 最近一次更新

- 2026-10-21：工作流状态视图增加易失的无进展循环诊断；修复普通工具活动绕过暂停轮询保护、离线循环统计断 streak，以及重规划计划变化误清循环观察窗口的问题。运行任务现有一次纠偏续跑，仍无结果则暂停为未知，不自动重放副作用。
- 2026-10-19：工作流面板借鉴轻量 todo 清单采用主题底色和强调边框区分终端背景，显示状态符号、进度与分层任务列表；窄终端收紧摘要、保留任务标题。任务详情、操作确认和只读技术详情入口保留。
- 2026-10-19：包版本从 `2.0.8` 升至补丁版本 `2.0.9`，同步 `package.json` 与 `package-lock.json`。

- 2026-10-18：架构取证提示和职责规则已收敛为按决策关键问题集中核查，支持复用满足来源版本、当前 revision、范围及失效条件的已接受证据；非阻塞未知项需披露但不自动触发补证。实现细节与限制见 [`docs/decisions.md`](decisions.md) 和 [`docs/session-log.md`](session-log.md)。

- 2026-10-16：测试价值审阅功能已从当前产品实现与说明中退役，仅保留超过 500 物理行的大文件结构审阅（`keep`/`recommend-split`）；历史旧价值 session entries 原样忽略，通用 Test Value Gate、增量补测规则和有价值的业务回归保留。本次移除任务针对性测试 32 项、全量测试 445 项通过，`npm run typecheck` 与 `git diff --check` 通过（实际执行结果见 [`docs/session-log.md`](session-log.md)）。未进行真实 Pi reload/TUI/Provider 验证，当前已加载的旧工具/提示需 reload 或重启后更新。此前价值审阅汇总及其队列数量作为历史事实保留，不构成当前待办；此前测试整理提交不回滚。

- 2026-10-16：测试价值审阅原始结论为 66 项（62 `keep`、4 `rewrite`）；随后按四项 rewrite 建议整改 7 个测试文件，将被重复的计数/菜单文案/模板细节覆盖精简，并把角色匹配、auto 两任务计划与重规划身份覆盖移到职责更匹配的测试套件。7 个文件中的测试用例净减 7 项（52→45），同批定向测试 45/45 通过；未修改生产代码，测试文件数量仍为 65 个 `*.test.js` 加 `test/helpers.js`。因测试指纹变化，这 7 项旧价值结论已失效、当前重新进入待审队列；其余 59 项结论仍有效。结构候选是独立维度，仍有 14 项待审。详细内容与验证见 [`docs/session-log.md`](session-log.md)。

- 2026-10-16：明确增量补测范围与日常/维护审阅分流，并落地日常增量审阅范围。补测按本次行为变化及必要直接影响划分，不按行数机械限定，优先复用/调整已有测试、保留有效长期回归，纯展示默认不补，不引入自动测试生成/选测或自动删除；同步项目 `AGENTS.md`、中英文模板、公共 Skill 与 `developer-test` 角色规则。日常提示（系统提示 section、文件工具结果附加通知、`agent_settled` 通知）改为只呈现当前 session/branch 观察基线之后实际观察到的变化候选及显式关联实现失效测试，不声称任务 Git 归属，完整库存继续由 `file_review list` 与 `/large` 承担；基线/通知水位仅限当前会话/branch，`session_tree`/reload 重建，通知按候选有效版本去重，未送达不提前消费，部分失败保持未确认。新增 `src/review-incremental.ts` 及 `test/review-incremental.test.js`，并扩展 `extensions/file-review-runtime.ts` 与 `test/file-review-runtime.test.js`。验证：`node --test` 定向 7 文件 57 项通过、0 失败，`npm test` 469 项通过、0 失败，`npm run typecheck` 与 `git diff --check` 通过。真实 Pi TUI/E2E、真实 Provider 请求未验证，详见 [`docs/session-log.md`](session-log.md)。

- 2026-10-15：续接统一审阅候选队列工作，补齐短实现读取与价值维度 `/large` 主动入口并修复日志夹具。统一候选模型（`src/review-candidates.ts`）现在同时返回两维候选、各自确认状态与错误：单维扫描/状态/候选计算失败时保留另一维已确认候选并显式报错，不返回貌似成功的空队列，重扫成功不洗白未解决的状态错误；持久化失败不更新内存完成状态。短生产实现的成功 `read` 覆盖可分段累积并通过价值完成，读取后实现指纹变化会清除旧覆盖并拒绝价值完成；仅有测试价值候选（无超限文件）时 `/large` 仍经原有安全门派发两维建议审阅，状态无法确认时不误报无候选。`test/workflow-input-resume.test.js` 改为用 `emitExtensionEvent` 驱动完整输入链并对克隆后的状态快照做深比较，不再断言每个 `input` handler 都返回 `continue`，从而在 `PI_INIT_HANDOFF_LOG=1` 下通过。`npm test` 446 项通过、0 失败，`PI_INIT_HANDOFF_LOG=1 npm test` 446 项通过、0 失败（早先的既有夹具失败已修复），`npm run typecheck` 与 `git diff --check` 通过。真实 Pi TUI/E2E、真实 Provider 请求未验证，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-15：统一审阅候选队列并隔离结构审阅与测试价值审阅。结构审阅仍为超过 500 物理行的 `keep`/`recommend-split`；测试价值审阅独立于行数，使用 `reviewKind="test-value"`、结论 `keep`/`merge`/`rewrite`/`remove`，要求显式 `implementationPaths` 及测试与全部关联实现的 Pi `read` 完整读取，独立持久化并随 session branch 恢复，任一版本变化即失效重审，仅登记建议不自动修改测试。`npm test` 438 项通过、0 失败；`PI_INIT_HANDOFF_LOG=1 npm test` 437 通过、1 失败的既有用例（经 HEAD 隔离确认）；类型检查与 `git diff --check` 通过。真实 Pi TUI/E2E 未验证，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-15：工作流进度面板与状态摘要直接以树状显示嵌套目标，包含父层等待、当前目标进度及已完成/取消子目标；只改变展示，不改变工作流状态或验收。全量测试 369 项通过，类型检查通过，最终定向测试 17 项通过，差异检查通过；真实 Pi TUI/E2E 未验证，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-15：优化工作流查看渐进披露：默认突出阶段、进度、目标、当前任务和暂停原因；完成与状态工具结果支持展开查看完整技术详情，进度面板刷新保留有效任务选择、切换工作流重置到当前项。测试 369 项通过、类型检查和差异检查通过；真实 Pi TUI/E2E 未验证，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-15：新增显式证据审阅重开命令，仅对最新明确 block 报告创建保留审计链的新审阅轮次；协调状态 v2 可迁移读取 v1，持久化重开记录后才派发新 architect handoff，拒绝忙碌/不可信/恢复异常/未知结果状态。`npm test` 369 项通过、`npm run typecheck` 与 `git diff --check` 通过；真实 Pi TUI/Provider 生命周期未验证，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-15：可递归嵌套的持久工作流与协作关联规范化：新目标创建独立子工作流并保留父层计划/进度/返回位置，子层完成或取消后逐层返回父层原位置，未知结果仍保留层级并 fail-closed；状态 schema 升至 v6（`parentStack` 仅 v6，v1–v5 可迁移读取），状态与完成视图展示嵌套路径与真实子流程历史，进度面板动态刷新；协作侧将 evidence report 的 requestId 改为可选（仅在 handoff 身份验证成功后补入）、未知结果重试用 `coordinationHandoffId`/完整身份关联并在恢复时轮换 handoffId、`report.unresolved` 披露与 `review.gaps` 阻塞分离。`npm test` 363 项通过、0 失败，`npm run typecheck` 与 `git diff --check` 通过；未验证真实 Pi TUI/Provider abort 与恢复生命周期，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-14：修复工作流恢复后协调证据链接代次落后：恢复后的工作流 entry 成功持久化后，同步可证明属于同一 session/workflow/plan 的既有链接；缺失或身份不符仍 fail-closed，status 可见链接 tuple。定向 37 项测试、`npm run typecheck` 与 `git diff --check` 通过；未运行全量测试或真实 Pi reload/E2E，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-14：修复 pi-usage PATH 遮蔽用例的跨平台宿主断言：该用例在 macOS 上用 POSIX 真实目录配 `platform: "win32"`，`findPiPath` 用 `path.win32` 拼出的路径宿主无法命中，导致 `installLaunchers` 恒返回 `false`。现已改为 `platform: process.platform` 并随平台选择 shim 名与分隔符，只改测试、未改产品代码；突变验证确认用例仍有判别力。`npm test` 首次全绿 351 项、0 失败，`npm run typecheck` 与 `git diff --check` 通过。未在真实 Windows 宿主执行，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-14：协调协议最小兼容简化：新增可选输入 `coordinationHandoffId` 短引用（精确匹配当前 handoff，完整 `coordinationIdentity` 保持兼容），单条 finding 内完全一致的来源与完全一致的 `acceptedEvidence` 三元引用无损去重（冲突仍拒绝），报告输入校验失败可在同一有效 handoff 就地重提，architect 允许动作与 contract 前置条件改为单点声明。定向测试 53 项、`npm run typecheck` 与 `git diff --check` 通过；`npm test` 当时 351 项中 1 项基线失败已由本条修复。未验证真实 Pi 会话中的短引用遵循、TUI/E2E 与真实 Provider，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-14：取消工作流任务数量 12 的硬限制，改为仅用于提示的规划规模软建议：删除初始规划、单次重规划和重规划累计三处拒绝分支，移除工具 schema 的 `maxItems`，重命名常量为 `WORKFLOW_RECOMMENDED_TASKS`，其余非空/字段/ID/依赖/角色/契约/身份校验及 `auto` 2 任务阈值不变。定向测试 46 项、新增 `test/workflow-task-count.test.js` 8 项、`npm run typecheck` 与 `git diff --check` 通过；`npm test` 338 项中 1 项失败为基线既有问题（`test/pi-usage.test.js` 在 `git stash` 后仍失败）。未验证真实 Pi 安装/reload、TUI/E2E 及大规模任务性能，详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-14：修复 POSIX 手动安装脚本未复制 `pi-usage` 支持模块的问题：现委托共享 Node 安装器写入完整 CLI 文件集。定向安装器测试通过；扩展依赖缺失导致相关旧测试文件无法加载。macOS 扫描不完整提示的具体错误路径和原因仍待诊断，详见 [`docs/session-log.md`](session-log.md) 与 [`docs/pitfalls.md`](pitfalls.md)。
- 2026-10-13：修复轮内 switch_role 后职责系统段不更新：保存交接并 terminate，settled 后单次新职责续跑；同职责确认/闲置不增加回合，过期或未知结果不重放。全量测试 329 项、类型检查及差异检查通过；未验证真实 Pi/Provider/E2E，详见 [`docs/session-log.md`](session-log.md)。

- 2026-10-12：修复自动角色切换/压缩后活动栏缺少 Agent 运行标记的问题；状态在 `agent_start` 至 `agent_settled` 期间显示通用运行标记，具体 Provider、工具、压缩和工作流状态优先。18 项定向测试、类型检查和差异检查通过；未进行真实 Pi TUI/E2E。详见 [`docs/session-log.md`](session-log.md)。
- 2026-10-12：完成 architect 主导的证据协作、任务契约/澄清与 Pi `context` 请求视图；协调任务通过版本化证据就绪门，context 边界不确定时保留完整输入并诊断，原 session 不修改。`npm test` 300 项、`npm run typecheck`、`git diff --check` 通过；真实 Provider、Pi TUI/E2E、跨模型缓存和费用收益未验证。实现状态见 [`docs/plans/role-coordination.md`](plans/role-coordination.md)，验证记录见 [`docs/session-log.md`](session-log.md)。
- 2026-10-10：工作流任务启动改由当前 Agent run 的任务消息消费证据触发，避免 agent_start 早于初始任务消息时等待状态滞留；底部活动栏移除完成计数，保留内部统计、其他进度展示与结果验收。定向 106 项测试、最终生命周期 5 项回归、`npm run typecheck` 和 `git diff --check` 通过；未验证真实 Pi TUI/E2E。
- 2026-10-10：完成 Pi `/large` 主动结构审阅派发；完整扫描且有待审当前版本时，在 Agent/工作流/恢复保护允许后发送命令专属请求。手动扫描与 AI 派发分层，默认自动扫描、提示注入和 `file_review` 行为不变。定向测试 30 项通过，`npm run typecheck` 与 `git diff --check` 通过；真实 Pi TUI/E2E 和模型实际审阅未验证。详见 [`docs/session-log.md`](session-log.md)。
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
- 2026-10-18：角色交接简化为连续任务与按需证据，身份由运行时绑定；删除无调用代码并开启未使用检查；`npm test` 483 项通过，详见 [`docs/session-log.md`](session-log.md)。真实 Pi 会话回归仍未执行。
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
