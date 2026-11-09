# 当前状态

本文件只维护后续工作需要的当前事实和未完成事项，不追加更新历史；历史依据按需查阅[会话记录](session-log.md)。

## 恢复推进与工作流交接

- 恢复提示直接给出当前或下一任务角色；等待调度时同角色恢复确认交还既有调度器，重规划沿 SDK token 预算保留上下文。请求失败后的完整只读观察不阻断原任务续接。
- 已知阻塞任务可保留状态跨 session 交接；长工作流使用源快照引用，保持源冻结、完整状态与验证来源。操作见 [README](../README.md)，边界见[连续性说明](role-continuity.md)，验证见[会话记录](session-log.md)。
- 交接准备指导已明确checkpoint不暂停任务；用户要求交接时按需保存进展并如实block，已blocked遇reload只确认所需执行职责、不先retry业务。具体顺序及其余交接条件见公共[操作参考](../skills/pi-init-role-routing/references/runtime-operations.md#检查点与历史来源)。
- 任务handoff-outcome-unknown与跨session交接分别处理；职责确认/复用及清除自动停止均不解除未知任务结果。用户核对副作用后沿原确认retry入口恢复，具体说明见公共[恢复参考](../skills/pi-init-role-routing/references/runtime-operations.md#暂停与未知结果恢复)，真实日志边界见[踩坑记录](pitfalls.md)。

## 运行日志审阅修复

- 已修复pi-init恢复/报告投影触发的system历史折叠；实现与历史调查边界见[缓存审计后续修复](flclash-cache-audit-2026-11-06.md#后续修复)，实际验证见[会话记录](session-log.md#2026-11-06保留上下文投影中的system历史边界)。尚未安装/同步本机副本，真实缓存收益及连续多轮低命中的其余原因仍待验证。
- [FlClash晚间审计](flclash-session-audit-2026-11-04.md)保留当时证据；后续已实现auto小计划显式编排、checkpoint来源/revision指引及角色/执行环境交接提示优化，行为见[README](../README.md)和公共[操作参考](../skills/pi-init-role-routing/references/runtime-operations.md)。提示能否减少真实会话误用与重复读取仍需后续观察，不将历史graph超时计作本轮修复。
- 已实现等待调度上下文、模型可见审阅清单、v2 增量审阅记录、session 扫描范围、状态摘要、测试 Agent 目录隔离、故障窗口封口与加载身份。边界与使用方式见 [README](../README.md)、[运行诊断](runtime-diagnostics.md)；实际验证统一记录在[会话记录](session-log.md)。
- 同一审阅任务连续执行，真实新设计决定按模块集中交接；同角色重复确认明确返回无需切换，已有无进展轮询保护继续保留。角色指导不能保证模型每次遵循，不能当作新增执行权限。
- 磁盘安装一致不证明长驻实例已加载；本轮安装状态以交付记录为准，真实 Provider 费用与端到端时延收益仍需新实例对照。

## 测试组织

- 公共验证规则区分当前代码交付、目标环境验证和系统/发布验收；关键假设尽早验证，后续人工待办不扩大为每项任务前置，既定验收不自行降低。各业务共用公共[执行与验证](../skills/pi-init-role-routing/SKILL.md#执行与验证)，不按平台名称默认真机或全链路检查。
- 测试入口默认仅匹配 `test/**/*.test.js`，支持显式文件和名称过滤，辅助模块不再独立执行；重复锁超时用例使用测试侧可控时钟，真实文件锁与多进程回归仍保留。日常选测及开发期仅改源码的规则见 [AGENTS](../AGENTS.md)，命令见 [README](../README.md#开发与测试)，真实验证见[会话记录](session-log.md)。
- 回归覆盖角色、扁平工作流、任务记忆、恢复/未知结果和诊断；退役功能的专属测试随实现删除，核心安全回归保留，完整结果以本轮实际验证为准。
- 扩展入口 `extensions/index.ts` 只保留生命周期与共享运行时状态，命令和工具适配拆至独立模块；`pi-usage` 的查询聚合位于 `scripts/pi-usage/query.js`。测试辅助已拆至 `test/support/`，用量测试按 CLI、报告及原有主题分组，旧 `test/helpers.js` 已删除，调用方直接导入具体辅助/生产模块。
- 已清理经入口与测试引用核对的孤立身份输出文件、遗留私有常量和固定根节点不可达分支；公开、动态与测试使用边界继续保留。删除证据、保留清单和逐批验证统一见[未使用代码审计](dead-code-audit.md)。
- 已合并行为一致的纯函数、基础校验和测试查询辅助；存在输入、返回、错误或时序差异的路径保留。唯一实现位置、调用索引、未合并差异及逐批验证见[等价重复实现审计](duplication-audit.md)。

## 项目描述与插件规范所有权

- 新AGENTS只记录项目定位、目录职责、环境、命令、项目具体约束与记忆位置；初始化只补缺失，已有AGENTS、记忆、角色配置及符号链接均保留，独占创建防止竞态覆盖，无变更不reload。
- 公共执行规则/角色职责由pi-init包维护，每回合加载固定公共section和当前角色section，切角替换而不叠加旧职责；不改写项目AGENTS。Clean Code细则归包内references，不再生成项目副本。
- 托管模板同步引擎、基线状态生成、同步菜单及旧sync命令入口均已移除；旧托管块、状态文件和自定义clean-code原样保留，维护者确认后自行整理。升级插件并reload更新插件规则，项目具体约束及原安全门保持有效。
- 轻量路径、短结果直返、结构候选不等于必审等规则集中在公共Skill；不再要求每个项目同步这些通用描述。

## 交付粒度与无效往返收敛

- 已实现阶段checkpoint进展刷新续跑计数、超限后按工具收敛区分普通暂停与真实unknown，并明确直接关联文件的实现自主权；旧unknown不自动解除，只读业务完成诊断不变。具体边界见[设计决策](decisions.md#2026-11-06按真实阶段进展判断停滞并保留目标不变时的实现自主权)，实际结果统一维护于[会话记录](session-log.md)。
- 架构师按可验收交付物规划目标/非目标/范围/风险匹配验证，执行者自主完成闭环；远期不确定内容在边界细化，不按工具操作机械拆任务。保留同一扁平队列，不恢复正式证据/嵌套协议。
- Provider最终错误后停止自动请求；当前实例内已确认请求身份、工具收敛及原文结果持久化的请求失败保留原task/attempt/handoff，用户“继续”后接着做，不重试任务。中止、工具结果未知、业务阻塞、持久化失败、身份变化及reload仍受原恢复门保护；同任务提醒保留唯一授权锚点。细则见[请求失败续接](role-continuity.md#模型请求失败后的续接)。
- 相同范围、相同成功结果的native只读观察连续重复时先提示，持续重复才请求原暂停路径。真实新内容/范围/非只读活动、身份或branch变化重置；并行/来源不确定不自动暂停，不缓存或跳过实际工具，不推断bash/codemode副作用。
- checkpoint缺失revision与真正陈旧分开报告；工具视图直接给出expectedMemoryRevision。complete可选evidenceIds引用本任务真实成功来源，保存verificationEvidenceIds；后续直接依赖可只读复用历史，不把它算作本任务执行或当前版本有效。仅文档变化不重复全仓验证，高风险失败/恢复检查不省。
- 同一调用的业务拒绝与后续SDK错误结果只计一次问题，保留两段现场。真实新会话成本收益尚待验证，加载状态需核对运行身份。

## 活动任务重读修正

- 真实session重放证实字节投影在SDK低token占用时反复丢弃当前任务过程：151条变18条，原始历史仍在。当前已确认executing身份改用已有SDK token预算/压缩路径，不再额外字节裁剪；同一重放保留全部原任务消息。只读重复观察在近期记忆中去重，命令/写入不合并。真实新会话收益及实例加载状态待验证。

## 执行记忆架构

- [执行记忆与上下文重设计](execution-memory-architecture.md) 的简化实现已接通：TaskMemory 与唯一管理模块保存/恢复真实工具来源，现有 task_workflow 支持 checkpoint 与 status 按来源读取，最终上下文固定携带进展。活动执行中不再随每次工具观察把变化的任务记忆投影插入既有消息前部；保留持久化、边界恢复摘要、扁平队列、唯一 dispatcher 和身份/验收/压缩保护。关键记忆不可用或超限时走原停止边界。动态审阅库存也不再注入 system，改由稳定工具说明与按需 `file_review(action="list")`、`/large` 查询。自动回归通过，真实 Provider A/B、重复率/完成率及缓存成本收益待验证；磁盘更新不代表长驻实例已加载。

## 职责连续性

- 显式任务角色优先、同一交付物保持职责；活动工作流复用原角色守卫，无工作流仅提示指导，不新增硬绑定状态机。完整规则见[连续任务与轻量角色交接](role-continuity.md#角色选择与连续性)。

## 大文件扫描缓存排除

- 已在源码中精确排除 `.pi-graph` 与 `.pi/diagnostics`，保留 `.pi` 下扩展代码；扫描失败通知展示前三个错误的路径、错误码和原因。历史相关回归通过；安装与实例加载状态以当前运行身份核对。验证及原始告警未复现的边界见 [会话记录](session-log.md#2026-10-31修复大文件扫描缓存排除与错误诊断)。

## 安全原文分页

- `file_review(action="read", path, offset, limit)` 提供无原生 read 时的安全原文读取：从 1 开始，默认 100/最多 200 行，每页原文最多 16 KiB，只登记完整返回行。分页职责独立在 `extensions/file-review-read.ts`，复用路径校验、稳定快照/指纹与覆盖区间；原生 read 可混用，list 返回当前扫描范围内的项目相对路径库存，complete 保留当前版本全文校验。失败、取消、内容变化或会话/分支变化不产生错误覆盖。

## 功能收敛

- 已退役正式证据、结构任务契约/澄清、旧嵌套执行和/fast；保留普通调查任务、files/acceptanceCriteria/实际verification、checkpoint及单一扁平队列。旧记录返回WORKFLOW_FEATURE_RETIRED，只在确认副作用后隔离，不自动恢复或重放。
- 详细诊断与黑匣子共用写入、轮转和写失败处理；正常最终回复与确定性兜底共用完成视图；旧角色配置与暂存共用同一归一化边界，只有用户明确保存才改配置。

## 上下文压缩现状

- pi-init已取消主动压缩：不按角色/任务/重规划边界、工具组结束、经济收益或容量预测调用压缩，相关策略、投影估算、预算检查器及主动执行管理器已移除。Pi原生自动容量保护与手动压缩保持原样，未修改宿主或SoL配置。
- TaskMemory、checkpoint及原生/手动压缩后的职责恢复门保留；不会从摘要自动重放副作用或解除暂停。旧中断边界仍需显式resume，恢复后直接交接，不再重试主动压缩。SoL ObservationPack可独立使用，Online Context Compact不自动启用。

## 公共Skill精简与开发原则

- 运行时公共规范已增加通用能力的复用调查约束，通过既有pi_init_policy section提供给使用pi-init的项目会话；规则集中见[执行与验证](../skills/pi-init-role-routing/SKILL.md#执行与验证)，不改写项目AGENTS。本次未安装或同步本机副本，现有实例需更新并reload后加载新规则。
- 公共Skill已去重精简，具体分页/检查点参数移至按需操作引用；保留职责、授权、真实验证、身份与恢复底线。Clean Code引用增加前提复核、先减后加、边界类型、单写入者、幂等及样本先行的批量修改原则；不默认安装度量工具、不强制指标或逐操作日志，不新增公开Skill/执行引擎，push仍须用户明确授权。

## 容量提醒与会话交接

- 容量观测使用宿主 `getContextUsage()` 百分比，与状态栏同源；70%仅软提醒，不阻断请求、不暂停队列、不主动压缩/摘要，也不因 cache miss 自动创建或切换session。交接和缓存提醒是否已加载需核对实例身份。详细用户边界见[README](../README.md#容量提醒与手动新会话)。
- 普通会话无需工作流；当前已确认的非architect执行角色可用 `session_handoff` 准备来源绑定、有界的历史背景，再由用户执行 `/pi-init fresh` 预览确认。可选 `decisions` 将跨角色有效的关键决定/建议/未验证假设及其理由写入正文，完整性检查仅为指导，旧快照兼容；新字段仍计入既有32 KiB上限。普通与托管工作流共用fresh入口，未结束工作流仍走原安全路径；新会话只带选定背景，不自动恢复身份、进度或执行。已接收交接的目标无新准备时，`fresh` 只幂等核对并说明本次未创建session；较新的有效准备可发起下一次转出，检查旧导入和源锁后再建目标，准备失效不回退旧成功提示。普通会话收敛检查不再因已完整配对的历史 `isError` 工具结果永久阻塞；Pi写入branch的合法 `system` 消息保留在历史中但不参与工具配对验证。仍拒绝活动/不确定工具、缺失调用结果和真实未收敛的嵌套回执；SDK对 `error/aborted` 生成回合承诺不会调度工具，只有无矛盾执行证据的失败提案才不需虚构结果，矛盾仍拒绝；仅因参数过长而省略正文的 `complete:false` 回执也需核验结构、子调用终态及省略阈值。交接准备、fresh及快照恢复共用该宿主生命周期语义。该检查只判断工具是否收敛，不表示失败操作成功或没有副作用；未确认结果仍须保留在交接的未知项中，不得重复执行。缓存失配单次估算额外成本严格超过$0.50时，若同session已有缓存使用报告且当前UI可见，最多提醒一次；通知显示本次及本session累计额外成本估算，状态栏显示已持久化的合格Miss样本数与累计值（示例 `Miss 2 次 ≈$1.85`），不是成功提醒数。恢复时按当前session及阈值匹配的有效样本重建次数；金额只含单次估算额外成本严格超过$0.50且成功观测并持久化的样本，等于或低于门槛的不统计。金额不是账单。pi-usage统计输出显示插件版本和来源Git HEAD；安装启动器固化安装时的来源HEAD，非Git安装只显示版本号。磁盘安装与运行实例是否一致需核对加载身份。边界及验证见[设计决策](decisions.md)、[README](../README.md#容量提醒与手动新会话)和[会话记录](session-log.md)。
- 托管工作流上下文投影只形成请求局部视图，不改写原 session；保留用户约束、失败/恢复/未知记录、完整工具调用结果配对及活动任务后缀，结构或身份无法核实时保留完整输入。Pi宿主管理的system状态不由扩展改写。决策见[设计决策](decisions.md)，实际验证及限制见[会话记录](session-log.md)。

## 诊断现状

- 已有独立的 pi-init 本地诊断采集入口，支持显式项目 runtime、关联 session 和可选详细日志的来源核对、去重、加载版本分组与 JSON/Markdown 报告；运行时补齐 execution_end 和 SDK 退出码观察。耦合评估、使用与仍待改进的存储边界统一见[本地诊断采集](diagnostics-collection.md)，验证见[会话记录](session-log.md)。
- 项目黑匣子日志为 `<项目>/.pi/diagnostics/runtime.jsonl`，本机全局 pi-init 日志位于 SDK `getAgentDir()/diagnostics/pi-init/runtime.jsonl`；各自最多当前文件和 `.1`，项目文件超过 2 MiB 轮转，全局文件上限 1 MiB 且保留 7 天。查看、脱敏导出与确认清理可从控制中心或 `/blackbox` 完成；导出不上传，清理不涉及会话/工作流数据。详细边界见[运行黑匣子](runtime-diagnostics.md)。

## 角色交接现状

- 主动预算压缩与回调续接已退役；普通角色交接仍经原调度器复核身份、停止、恢复、branch、宿主忙碌和排队状态。按请求缓存usage诊断及其限制见[运行黑匣子](runtime-diagnostics.md)。
- 根工作流完成后保留模型最终回复机会，并有一次不触发新回合的可见确定性报告兜底；交付阶段不再执行工具/Git，中间任务交接语义不变。文档/Git 收尾默认按全工作流统一安排，必要归属和提交前检查保留。规则及诊断见 [最终报告](handoff-diagnostics.md#根工作流最终报告)。

- 状态轮询无进展保护现覆盖暂停、恢复确认、调度等待、任务等待、压缩停滞及工作流恢复错误：同一session/branch/runtime身份下首次只读观察照常返回，第二次语义状态未变则结束当前Agent回合；不修改工作流、不确认恢复、不完成或重放任务。用户输入、身份/branch/状态变化或进入真实派发/执行阶段使旧观察失效。运行策略派生的状态视图明确展示阻断原因与下一步，调度入口仍独立执行恢复授权检查。详见[设计决策](decisions.md)与[会话记录](session-log.md)。
- 活动工作流新增易失的疑似无进展诊断：比较语义状态、自动回合边界和显式状态查询，识别重复状态、A→B→A 循环、重复重规划方向；普通工具结果和重规划计划变化均不计作已核实进展。只有已验收的任务完成才重置进展窗口；诊断仅展示疑似线索，不自动暂停、终止或重试任务。
- 诊断层的疑似无进展循环观察仍仅提供线索，不自动暂停或重试；有限终止由独立的等待态status轮询守卫执行。status终止不授予恢复权；只有通过既有职责确认后，调度器才可安全派发。普通角色交接在恢复门处丢弃旧消息的既有行为保持不变，不自动重放。
- 长任务按可核对的阶段进展判断续跑；无进展达到上限时，工具已收敛则普通暂停，未收敛或存在不确定结果则保留未知保护。具体规则见公共[单一扁平工作流](../skills/pi-init-role-routing/SKILL.md#单一扁平工作流)。

- 上下文视图按活动执行、暂停恢复和共享协议分工；工具组解析与配对校验统一由 `role-context-protocol.ts` 处理，历史复用、预算和失败保留仅选择已有分组，不再各自维护一套配对状态。暂停、分支/身份和 TaskMemory 的保护继续保留。

- 暂停恢复已修复最早历史 handoff 缺失导致 status 结果丢失的路径；长任务增加独立有界检查点，工作流方向登记、执行者结果与 architect 重规划在安全边界衔接。统一动作策略、投影/拒绝指标及局限见 [诊断日志](handoff-diagnostics.md#上下文检查点与安全重规划)；尚未验证真实 token/时延收益。

## 项目

- 名称：`pi-init`
- 定位：用于 Pi 的项目初始化扩展，生成 `AGENTS.md`、项目记忆文档和 `.pi/role-models.json`，并随 package 发布公共职责路由 Skill。

## 当前目标

- 维护随 package 发布的公共职责路由 Skill。模型策略默认按职责映射（`roles`），标准职责未映射时沿用当前 Pi 会话模型与推理强度；可选 `auto` 策略固定模型并在用户配置的支持范围内自适应推理强度，期间保留但不使用原职责映射。两种策略的控制方式、任务边界和安全约束见 [README](../README.md) 与 [设计决策](decisions.md#2026-04-09固定模型-auto-策略独立于职责分工)。

## 当前已确认事实

- codemode 的异常参数拒绝只在 `tool_call` 阶段检查 code：连续至少 256 行单行空 `text()` 且占非空行至少 90% 才拒绝执行；不覆盖未到达工具调用的生成失败，不截断、改写或自动重放，也不减少已发生的生成耗时。SDK 的 `provider_stream_event` 是只读通知，`ExtensionContext.abort()` 会取消整个当前 agent operation，缺少请求专属取消句柄及可靠的流式参数拦截结果契约；当前未实现或验证生成中止。调查边界为软约束，来源路径只是优先线索而非硬白名单。实现及验证细节见 [`docs/session-log.md`](session-log.md)。

- 协调证据链接在工作流统一持久化入口提交成功后同步执行代次，并在工作流/协调调度及补充取证前受限补偿同 session、同 workflowId、同 planVersion 的已有落后链接；正常 complete/block/retry 不再因遗漏同步而误报 COORDINATION_WORKFLOW_LINK_MISMATCH。工作流写入失败不先更新证据，证据写入失败保留已完成结果且暂不派发，存储恢复后只补关联、不重放任务。缺失、其他计划/session、未来代次与失效证据仍 fail-closed。

- 工作流进度面板已分离为只读分层浏览与受保护操作：Enter 查看任务详情，Esc 分层返回，a 打开状态相关操作，d 查看技术详情；长详情滚动、刷新保留选择与滚动、窄终端固定底部提示。取消范围明确且默认返回；未知结果重试必须核对副作用。确认前后检查状态来源与会话/上下文，操作最终复用已有命令，不新增状态写入入口；等待 AI 审阅不可直接放行父任务。

- 新目标采用“目标归属 + 扁平任务队列”：request-goal（request-child 兼容别名）只追加目标分组与任务，所有任务保持同一 workflowId；按已满足依赖、显式 priority 和稳定顺序选择，不压入新父子运行栈。新分组默认不加急，不强行中断当前任务，完成分组不等于根目标成功。插入须明确保留原 pending 项，替换/撤销通过普通 replan；阻塞态可在安全边界直接规划，未知副作用不自动重试。schema v7 兼容 v1–v6 原状态，旧栈和旧嵌套请求保留兼容收尾，不自动展开或重放。

- Local 工作流的调度决策与任务/重规划交接阶段集中到 `src/workflow-orchestrator.ts`：纯事件转换返回新状态和发送效果；消息层先持久化派发意图再发送，重复派发事件、过期身份和迟到 queued 不推进状态。执行中提醒是独立事件；完成、阻塞、重试、恢复与取消通过统一生命周期事件转换，命令和工具共用提交入口。嵌套完成/取消只在状态持久化成功后撤销旧身份续跑，写入失败不撤销。压缩、协调就绪门、真实启动验收及未知结果恢复继续沿用现有安全边界；规划、重规划应用与协调账本尚未统一迁移。设计与验证范围见 [`docs/plans/workflow-orchestration.md`](plans/workflow-orchestration.md)。

- 工作流状态结果默认以摘要突出阶段、进度、目标、当前任务与暂停原因；嵌套工作流的进度面板和状态摘要树状展示父目标、当前子目标、父层等待状态及已完成/取消的子目标。展开后保留完整状态、身份和嵌套历史。完成结果默认呈现简短任务/最终结果摘要，展开后保留验证与时间。TUI 进度面板刷新时保留仍有效的任务选择，workflowId 改变时转到新工作流当前任务；模型可见状态文本和调度/验收行为不受展示影响。详情见 [README.md](../README.md)。

- `/pi-init coordination reopen <reportId> <reason>` 仅重开最新且明确 `block` 的证据审阅：追加关联原报告、阻塞审阅与理由的重开记录，持久化成功后才签发新的 architect 复审 handoff；原取证/审阅记录和来源版本保留，不自动接受证据、不派发开发。协调状态 schema v2 迁移读取 v1；项目不可信、Agent 忙、恢复异常或存在未完成/结果未知 handoff 时 fail-closed，旧 handoff 身份不复用。验证及真实 Pi/TUI 未覆盖项见 [`docs/session-log.md`](session-log.md)。

- Local 工作流的 `complete`/`block` 到达时若交接仍为 `queued`，仅在完整 handoff 身份匹配、活动 session branch 含精确交接消息且当前角色匹配任务角色时，先持久化补记 `executing` 再进行严格验收；身份、branch 或角色不符仍 fail-closed，未知结果仍须显式核对和 retry。身份校验失败以模型可见 JSON 给出 code、差异字段、白名单 expected/received 与下一步；`status`、任务提示和重规划提示展示通过共享构造器生成的可复制 JSON 身份，`status` 保持只读。`task_workflow` TUI 将这些失败诊断按类别、代码、原因、白名单身份差异和下一步分段显示；普通错误与无法解析的诊断仍保留原始错误内容，不改变模型错误 JSON 或失败守卫。该路径不改变恢复时 queued 结果未知的策略，也不确认原始 stale identity 故障的字段根因。
- pi-init 工作流固定为当前主会话内 local 顺序执行；缺省 executor 与旧 `workflowExecutor: "local"` 配置仍可读，执行器不再是控制中心或 schema 选项。`subagents`、`subtask`、`collaboration` 等未知值明确拒绝。当前状态持久化在 `pi.appendEntry` 正常返回后才更新内存状态；append 异常保留旧状态并停止本次调度。`architect` 不得作为执行任务角色，plan/replan 校验拒绝该角色；旧活动计划含 architect 执行任务时不持久化自动修复或派发，仅保留恢复错误供检查；用户显式取消后可另建计划。后续交接身份与恢复边界见 [`docs/plans/durable-workflow.md`](plans/durable-workflow.md)。
- 工作流暂停通知和 block 工具结果使用分区摘要，突出真实原因及恢复建议；纯文本与 TUI 从同一类型化暂停视图独立渲染，不解析已格式化文案。暂停结果不以成功标记呈现，展开后显示完整任务与身份技术状态。未知结果仍须先核对外部副作用，再显式确认 retry；block 工具不另发重复通知。
- 工作流工具 `AbortSignal` 只中止当前工具操作；业务取消需显式持久化 `cancelled`，只有持久化成功才退休所属续跑，且不等同于宿主压缩终止。`acknowledge` 是当前来源匹配告警的易失展示确认，不改变状态/守卫，身份变化、branch 切换及 reload 会重新提醒。`discard-recovery` 仅对明确不可恢复且无可读/待持久化状态的原记录，在可信项目、Agent 空闲、当前 branch 唯一且最新的原 entry ID、session/branch/error 精确匹配并确认未知副作用后，追加版本化引用处置；它不构成任务成功或取消。安全边界见 [`docs/decisions.md`](decisions.md)，用户用法见 [`README.md`](../README.md)。
- 状态、任务完成、最终完成、普通执行计时和操作错误采用各自的只读视图及纯文本/TUI renderer。状态视图服务状态文本、状态栏、进度面板和非暂停工具结果；任务完成只报告当前任务，最终报告使用明确的最终任务并只列明确失败的验证，计时缺失保留不可用语义。`workflowPresentation` 仅附加到瞬时工具结果 `details`，旧结果缺少判别信息时回退原文，不进入 `WorkflowState`/session entry；模型错误 JSON 与 `isError` 保持原契约。详情与取舍见 [`README.md`](../README.md) 和 [`docs/decisions.md`](decisions.md)。
- 旧配置顶层 `runtime` 字段返回 `RUNTIME_CONFIG_RETIRED`，`workflowExecutor: "runtime"` 返回 `WORKFLOW_EXECUTOR_RETIRED`；旧 Runtime executor/authority 或残留 payload 的持久状态返回 `WORKFLOW_STATE_RUNTIME_RETIRED`。状态和动作保留恢复错误，不会静默转为 local、不自动重放/迁移，也不改写或删除原始 session entry；旧配置需由用户检查并手动清理。
- 当前不包含自建外部 Runtime backend，也未接入或核实任何官方 Runtime 接口。历史双轨实现与旧验证记录仅作为历史保留，见 [`docs/decisions.md`](decisions.md) 的退役决策及 [`docs/plans/runtime-migration.md`](plans/runtime-migration.md) 的历史标记。

## 已知状态

## 待处理

- `extensions/coordination-runtime.ts`、`extensions/workflow-actions.ts`、`extensions/workflow-dispatch.ts`、`src/coordination-validation.ts`、`src/workflow-model.ts`、`src/workflow-hydration.ts`、`test/coordination-runtime.test.js` 与 `test/coordination-simplification.test.js` 的当前内容版本已通过 `file_review` 完成结构审阅并建议保留；`extensions/file-review-runtime.ts` 已对移除功能后的当前内容完整读取并登记结构 `keep`。此后修改过的 `extensions/index.ts`、`test/pi-usage.test.js`、`test/extension-lifecycle.test.js` 和 `test/file-review-runtime.test.js` 不沿用旧 fingerprint 结论；旧 `test/helpers.js` 已删除。运行中的旧 Pi 工具 schema/提示尚未通过 reload 核实，需 reload 或重启后更新。
- Linux、macOS 的 CI 矩阵已加入但尚未在本地执行；pi-usage 的 PATH 遮蔽用例已在 macOS 宿主验证，但未在真实 Windows 宿主执行。第三方 `agent-browser` 工具在 Windows 上仍需上游修复 CLI 检测和 `.cmd` 启动兼容性，本项目只能通过 `AGENTS.md` 降低误安装和误用。
