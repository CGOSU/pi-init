# 角色交接诊断日志

日志用于观察角色交接、工具调用、文件版本变化及压缩等待，帮助离线分析重复调查、重复验证和状态脱节；不自动判定冗余或 bug，不增加交接次数限制，不修改压缩策略，不自动重试或暂停任务。

## 开启与查看

默认关闭。在启动 Pi 前设置环境变量，且项目必须已被用户信任。

Windows cmd：

```text
set PI_INIT_HANDOFF_LOG=1
pi --no-extensions -e ./extensions/index.ts
```

PowerShell：

```powershell
$env:PI_INIT_HANDOFF_LOG = "1"
pi --no-extensions -e ./extensions/index.ts
```

已安装为 Pi package 时，设置变量后使用原有 Pi 启动命令即可。扩展加载时读取开关；关闭时取消变量或设为 0，再重新加载扩展。

日志写入当前项目的 .pi/logs/handoff.jsonl，每行一个 JSON。约 2 MiB 轮转，保留一个 handoff.jsonl.1 备份。正在发生的问题可用 PowerShell 实时查看：

```powershell
Get-Content .pi/logs/handoff.jsonl -Tail 30 -Wait
```

## 离线统计

在 pi-init 仓库运行（已安装 package 时使用其 scripts/handoff-report.js 的实际路径）：

```sh
node scripts/handoff-report.js /path/to/project/.pi/logs/handoff.jsonl
# 同时分析轮转文件；顺序不限，重复事件按 runtime/session/sequence 去重
node scripts/handoff-report.js /path/to/project/.pi/logs/handoff.jsonl.1 /path/to/project/.pi/logs/handoff.jsonl
```

不传路径时读取当前目录 `.pi/logs/handoff.jsonl`，输出 JSON 到 stdout，不修改日志，不进入模型上下文。输出包含工具调用/执行/错误数、SDK 耗时合计、回合耗时、同角色切换候选、同版本读取重叠候选和角色派发/协调交接延迟。

回合从 before_start 到 settled，排除下一次用户输入前的空闲；未闭合为 null，多次 agent.start 明确警告，不把 run 误当唯一执行实例。缺失片段不推断失败；无效/截断行、重复和日志丢弃均披露。只分析成功且未标记截断的 read 结果中有明确版本与行范围的记录；重叠是请求范围统计，不证明实际返回行数或操作可省略，版本按 stat 观察隔离。SDK 耗时可能重叠或嵌套，不可相减推算模型推理耗时。同角色切换仅列候选，不自动跳过模型配置或恢复操作。

## 排查顺序

1. 按 sessionId、runtimeId 和 sequence 还原顺序，run 表示本次扩展实例中的 Agent 回合编号。
2. 从 routing.model_proposed 查看模型提出的交接（包括随后可能被守卫拒绝的调用）；从 routing.tool_call 查看进入执行入口的 action、目标角色和身份，对照相同 toolCallId 的 routing.tool_result。
3. 对照 workflow.persisted、coordination.persisted，检查 revision、取证 round、任务状态和 handoff 是否持续变化。
4. workflow.schedule、coordination.schedule 记录调度入口及锁状态；workflow.nudge_requested 表示因未提交完成/阻塞结果而请求续跑。
5. agent.continuation 区分内部续跑与非内部回合；handoff.message_consumed 仅代表消息被观察到，实际启动状态以持久状态记录为准。
6. compaction.started、compaction.long_wait、compaction.settled 关联 operationId。只有 started 而无 settled 表示本次压缩尚未观察到收敛；通用 compaction.event 不等价于确认该操作成功。

真实轮内切角新增 role.handoff_prepared、role.handoff_dispatched 事件；同一 handoffId 应从旧 run 交接到新的 run。role.handoff_dispatch_unknown 表示结果未知且不自动重放，role.handoff_discarded 表示身份已过期或中止，role.handoff_blocked_by_recovery 表示恢复门仍未确认。交接元数据还追加到 session 的 pi-init-role-handoff-state 记录；reload 不自动重放该记录。

## 运行时复用与 Provider 诊断

- `role.reused`：本次已重新读取/解析配置，确认角色、实际模型和推理强度一致且恢复门已解除；不重复 setModel/setThinkingLevel、确认持久化或递增角色代次。配置变化、不可用的显式模型、恢复/持久化待确认仍走原校验；不跨调用缓存配置。
- `context.reused`：只在当前 branch 上身份可靠的相邻交接窗口复用完整普通工具组，最多 8 组/32000 字符，优先较新组；首个 handoff 仅取最近用户请求后的观察。不复制旧 switch_role/task_workflow 身份，不修改历史。retainedGroups/retainedChars/omittedGroups 是当前视图统计，不能累计当作节省调用数。超预算可按需重读；旧失败、当前窗口和用户新指令不受复用预算裁减。历史工具结果不证明当前文件未变或测试仍有效，也不构成执行授权。
- `provider.request`、`provider.headers`、`provider.response`：分别观察请求 payload 钩子、headers 钩子、HTTP 响应，完全不记录 payload/headers/stream 正文。status 为宿主报告的 HTTP 状态；observedElapsedMs 用单调时钟从请求钩子计时，包含中间处理，不能称为纯网络耗时或首 token 时间。requestNumber 只是在本运行实例顺序观察到的关联号，不是 SDK 原生请求 ID；缺失、换 branch/session、跨回合或新请求覆盖时不保证完整关联。
- `assistant.result`：记录宿主的 stopReason、可用的 durationMs、token usage 和 errorHash。errorCodeHint 只提取错误文本中的少量白名单连接/超时代码（如 ECONNRESET、ETIMEDOUT），只是线索，不证明根因；未知错误仍仅保留指纹，不写错误正文或模型回复。
- `provider.unfinished`：请求被新观察覆盖，或 settled 时尚未观察到 assistant 结果；reason 区分 superseded、aborted、settled-without-assistant。缺少收敛不等于网络错误，压缩请求/日志缺失等也可能没有普通 assistant 完成事件。`agent.settled` 保留 aborted。

离线报告新增 provider 与 reuse 区块；provider.unclosedRequests 列出有起点但未观察到可关联的 assistant 结果或 unfinished 终止记录的请求，含轮转缺失或切换 branch/session 后丢失关联的情形，不计作失败。HTTP 错误与 assistant 错误可能属于同一请求，不能相加当失败请求数；SDK assistant 耗时不等于网络耗时。公开 ExtensionAPI 不暴露 AgentSession 的自动重试事件，因此不统计/推断真实重试次数，也不增加自动重试或修改连接/超时策略。旧日志 `provider.available=false` 表示缺少这些观测，绝不等于没有网络错误。

修改后需 reload 或重启 Pi，且仍需 `PI_INIT_HANDOFF_LOG=1` 才收集诊断；角色幂等与上下文复用本身不依赖日志开关。收益需后续真实会话对照，不能从测试 harness 或历史日志推算。

## 工具与文件观察

除原有 routing.* 事件外，普通工具也记录 tool.model_proposed、tool.call、tool.result。提议、进入观察器和结果是不同阶段，用 toolCallId 关联，不要把它们统计成三次执行。model_proposed 可保留被前置守卫阻断的提议；tool.call 仅表示调用到达诊断处理器，不代表所有守卫已经授权。

- tool.execution_start / tool.execution_end 记录 SDK 执行生命周期，parentToolCallId 关联嵌套工具，durationMs 使用 SDK 的执行耗时。SDK 未提供耗时时不补算，不仅凭 start 判断执行成功或获得授权；缺少结果也可能是日志丢弃、强退或截断，不直接认定被阻断。
- inputHash、commandHash、outputHash 分别标识输入、命令和结果内容；相同指纹用于定位重复候选，不等于操作冗余或可安全省略。路由错误继续提供 errorHash。
- 文件工具记录项目相对路径、offset/limit 或批量 ranges，以及观察时的 bytes 和 version。versionKind=stat 表示版本由设备、inode、大小、mtime 和 ctime 元数据生成，不读取源码、不等于内容哈希，也不证明两个文件语义相同。调用和结果阶段分别采样，可观察编辑前后变化；不扫描任意 shell 命令可能修改的全部文件。
- 每条输入最多采样 16 个文件，每个文件最多保留 16 个范围，fileCount/filesTruncated 和 rangesTruncated 标识截断。项目外路径、超过 256 字符的相对路径只保存路径指纹；项目外文件不采样元数据。采样失败记录 statCode，不中断工具。
- isError 保留宿主工具错误标志；details.ok（无 details 时取 structuredContent.ok）另记为 businessOk，避免把 isError=false 的业务拒绝误认为成功。结构化错误码、退出码、结果文本长度及可用的读取截断信息一并记录，但不记录正文。
- 每条事件仍带运行状态快照；任务额外记录 outcomeUnknown、executionStartedAt，协调状态记录 workflowLink，锁状态包含恢复持久化失败和待持久化恢复标志。可对照暂停状态与后续 edit/bash 事件排查状态脱节，不自动放行或阻断操作。

问题、范围、缺口、方向、澄清、工具输入和结果正文只保存指纹，不保存用户提示、模型回复、源码、工具命令或结果正文。项目内文件路径、读取范围、标识符和模型名称仍会记录；分享日志前请检查敏感信息。指纹不是加密，不能保证低熵内容不可猜测。跨重启的指纹可比较，但重启会创建新 runtimeId。

日志异步写入，不触发模型回合，也不进入会话上下文。待写记录最多 128 条，超过时丢弃，后续记录的 dropped 字段报告丢弃数。写入失败只提醒一次并停止后续收集，不阻止任务执行。正常 shutdown 等待已排队日志写入；进程强制退出可能丢失末尾记录。
