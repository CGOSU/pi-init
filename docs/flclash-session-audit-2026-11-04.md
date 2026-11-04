# FlClash Pi 会话审计（2026-11-04 晚间）

## 范围与证据口径

用户要求分析最近 FlClash Pi 会话的规划、工具错误、`graph: 10 matches` 和多余操作。本次只读调查原始会话、诊断记录及对应源码，不执行历史命令、不重跑业务测试、不修改 FlClash 或安装副本。

会话目录为 `~/.pi/agent/sessions/--Users-cgosu-code-Android-FlClash--/`。下文 A/B/C 加行号均指原始 JSONL 的物理行；时间统一为北京时间。

| 标记 | 文件 | 本次范围 |
| --- | --- | --- |
| A | `2026-11-04T13-21-24-523Z_01a1a6b8-b22b-7498-a898-80cdb6faa916.jsonl` | 前569行，截至11月4日22:07:13；会话仍在进行 |
| B | `2026-11-04T07-47-44-373Z_01a1a587-3674-7531-9ffb-233097bd2fa5.jsonl` | 861行，15:47:44至21:21:24 |
| C | `2026-11-04T05-42-18-522Z_01a1a514-609a-71d0-8b99-50217ff362cf.jsonl` | 仅定向核对较早的 graph 超时 |

A/B 与 `.pi/diagnostics/runtime.jsonl`、轮转备份已在 `/tmp/flclash-session-audit-20261104/` 留本次分析快照；临时目录不作为长期存储承诺。A 的 SHA-256 为 `33a7c482c06014ac00b2e40f1018cd7ab1903c1e494f9b9007f623d6df738f38`，B 为 `8adf6b5cdd16b2ab93dd80529af3af6491805f8e0014edcec91de64b0b10caee`。未将会话正文或日志复制进仓库。

最新运行日志记录 pi-init 2.0.11、SDK 1.5.0、sourceCommit `2f37fc513de55a03a557c1eec586429795453572`、加载时间21:15:43；与本次开始时工作仓及安装仓 HEAD 一致。不能把本轮问题简单归为“还没 reload”。B 前段加载 `576832f`，后段才更新；只看相同的2.0.11版本号不能区分代码。

## 结论与责任边界

最新错误主要来自模型工具使用、执行环境交接和开发验证。pi-init 存在规划策略与提示不一致、checkpoint 来源不易发现及角色空转问题；未发现 A 的调度死循环。最新 graph 调用成功，状态数字不是进度；C 曾真实超时，历史问题不能因后来成功就宣称已修复。

### 最新13个显式工具错误

A 有193个顶层工具结果，13个 `isError=true`；最后一个测试调用尚未返回，不计为已完成结果。此处不重复累加 codemode 内层回执。

| 分类 | 数量 | 来源行号 | 归因 |
| --- | --- | --- | --- |
| 文件不存在 | 6 | 119、244、260、268、390、406 | 猜文件名/目录，部分已知错误仍重复使用 |
| checkpoint 参数或来源无效 | 3 | 199、202、205 | 空 evidenceIds、缺 revision、提交不存在的来源 ID |
| edit 匹配不唯一 | 1 | 446 | oldText 缺唯一上下文；前两项修改已成功 |
| 测试命令超时 | 1 | 364 | 未沿用既有 Go module cache，重新下载依赖 |
| 编译或测试失败 | 2 | 438、494 | 新增测试错误及真实行为回归，需要开发处理 |

另有 A:366 的 Provider `fetch failed`，之后继续出现工具调用；这是独立模型请求错误，不在13个工具结果中，也没有证据证明由 graph 引起。B 有255个顶层工具结果、15个显式失败，另有180秒 WebSocket 空闲超时和一次 aborted；其中包含 context-mode 的项目边界/HTTP命令限制、下载超时、错误工作目录、缺 build tags/linker flags、路径错误和实际测试红灯，不能统一算成 pi-init 故障。

**外层成功不代表内部检查通过。** A:442 的 codemode 显示 `Script completed`，内部 bash 却返回 `exit_code:1` 和失败断言。A:248、304、506 的 shell 输出有路径错误，但最后一条命令成功使外层成功。C 的两次 graph 超时也被 `Promise.allSettled` 转成字符串并置于成功的父结果中。因此13只是显式外层失败数，不是全部失败事件数；黑匣子同一 issue 的初始/封口记录及累计 count 也不能直接相加。

## graph 状态与历史故障

- A 中7次 `graph_locate` 均显式指定 `limit:10`，各返回10个符号；6次 `graph_inspect` 也全部成功，无 warning。7次 locate 共70个不同 symbol，不是同一组结果死循环。
- 最后一次 locate 为21:27:01（A:155）。`graph: 10 matches` 只保存最近一次 locate 的返回数量，不是累计调用数、全仓符号数、索引进度或错误数。
- 安装源码 `pi-graph/src/pi/extension.ts:119` 在 locate 成功后设置该状态；inspect 不更新，session_start 没有显式清除；`/graph status` 则显示 symbols。`src/core/retrieval.ts:137` 默认limit为6、上限10。本次无需执行状态命令或重建索引来证明语义。
- 文案缺少“上次查询”与时间/版本，容易让用户误认成实时进度；这是可改进的展示，不是数字必须递增的缺陷。
- 检索仍有边界：A:86 查询 ServicePlugin 时前两名是生命周期测试；A:97 的 scope 把真实位于 `android/app` 的插件排除在外；A:119 读取的错误 `android/service/.../ServicePlugin.kt` 路径不是 graph 返回的路径。
- 当前支持 Dart、Go、Kotlin，但关系属于保守的同文件语法关系，不具备编译器类型解析及 Flutter/Android 跨语言调用链保证。不能将“不支持语言”作为本轮原因。

C:121、127 分别在14:48:15、14:50:42出现 `Graph request timed out after 120 seconds`；对应本次 runtime 快照第46、58行的 count=1、2是累计记录，共两次。日志不足以判定冷索引、worker 排队、数据规模或其他阻塞哪个是根因。当前 `src/core/engine.ts:175` 先 refresh 再应用 scope，说明缩小检索 scope 不保证减少全仓索引成本，但这只是机制解释。后续15:06查询成功但有 Kotlin parser warning，15:30成功且无warning，均不能证明所有超时已解决。

pi-graph 工作仓和安装仓本次均为 `476a5a42a470bf87b7b934979d0bb9804a427686`，入口源码与 dist 中状态逻辑一致；这是磁盘核对，不冒充长驻实例的加载指纹。

## pi-init 规划与 checkpoint

### auto 两任务判断与计划契约冲突

B:118 将 route/DNS/hosts/FakeIP/resources/完整 candidate/PreparedPolicy 和大量验证压成一个实施任务，再加一个交接任务。B:119 因 auto 且任务数不超过2而跳过编排，没有活动工作流；计划第二项验收却要求“工作流检查点”和“block暂停”。A 的 incoming handoff 已诚实注明改走普通交接，没有伪称工作流完成。

[工具提示](../extensions/workflow-tool.ts)写的是“valid low-risk plan with at most two tasks”，但[运行入口](../extensions/workflow-actions.ts)第353行及[数量策略](../src/roles.ts)第321行实际只判断 mode/taskCount，没有风险判断。这是可确认的提示与机制不一致，加上计划把大任务压缩为两项，使期望的持久化执行能力被跳过。应先明确策略契约并对齐提示与执行，不靠增加无意义任务绕过阈值，也不在本次审计中擅自修改策略。

A 的规划已有改善：A:52 初始3项，调查完成后 A:224 重规划，保留已完成调查共9项，按 DNS、平台输入、完整 candidate、Flutter facade、Android facade、入口、集成验证和统一文档拆分。A 的 task_workflow 共7次：plan一次、checkpoint三次、request-replan一次、complete一次、replan一次；status和file_review均为0。调查正常完成并交回重规划，之后进入 DNS 实施，不能据此认定旧轮询死锁复发。

### checkpoint 三连失败

1. A:198–199（21:30:47）：`accomplished.evidenceIds=[]`，schema正确拒绝。
2. A:201–202（21:31:15）：提交一个 `obs_…` ID但漏 `expectedMemoryRevision`；运行时明确返回当前revision为0。
3. A:204–205（21:31:27）：补revision后仍使用同一ID，因当前branch没有真实来源而拒绝。

该 `obs_…` ID在完整A中只出现于两次提交参数，从未由工具返回；真实 observation 已在A:196等 `pi-init-task-memory` 记录中，以session entry ID保存。没有证据支持“pi-init丢失了真实来源”，守卫不应放宽。

可发现性仍可改进：[工具说明](../extensions/workflow-tool.ts)虽提供 `status(detail="full")` 入口，但 checkpoint 指引没有直接讲清“首次需要时读取一次full status，从observations取得真实ID与revision”。custom记录持久化不代表模型能直接看到。可在工具参数说明/失败反馈中给出来源获取步骤，避免猜ID；不应每个工具后强制status或checkpoint。此次调查马上complete并提交成果，额外checkpoint并非必须，三次均未保存也未阻断随后正常complete/replan。

## 可避免的操作与真实验证

- **空转切角：** A:20→30→41为architect→docs-commit→architect；docs阶段没有执行任何调查，随后才建立调查任务并再派发docs。可保留首次调查意图或直接安排必要调查，省去无产出往返。B的9次switch不能全部视为冗余，其中有reload和职责恢复确认。
- **重复预读与输出截断：** A:67已读project/commands/rules/core-platform，A:239、251又整批读取，后两次仅隔约32秒，A:267再次读取；首次代码写入在A:283，之前并非文件变化。A:240、252、256、268四批codemode输出被截断；A:240标记原输出约21,047 tokens。此标记不是账单token，也不能据截断结果声称全文已读。
- **知道真实路径后仍猜错：** A:248已经提示`matcher_dns.go`不存在，A:252列出、A:256读过`dns_match.go`，A:268仍再次读错误名称。compat真实文件已在A:248列出，A:260仍猜`types.go`。应该复用路径发现结果并定向读取。
- **批量部分成功：** A:244、260、268均是前面读取成功、后面一个ENOENT使codemode报错；A:446两次edit成功、第三次失败，不具事务回滚。随后定向读取修正是合理恢复，未见该处盲目重放全部写操作。
- **执行环境交接不完整：** B的handoff和A:5保留Go路径及pinned Tags/LinkerFlags，却漏`GOMODCACHE`。A:363只设PATH，A:364在200秒超时；A:370/378显示重新下载依赖，A:374显示默认cache；A:381改回`/tmp/flclash-toolchains/gomodcache`并设`GOPROXY=off`，A:382约24.4秒四包通过。支持“缓存环境遗漏引发本次多余下载”的判断。交接应保留已验证完整命令及必要环境，而不只记录工具链版本。
- **测试失败不全是浪费：** A:438含unused import及YAML测试夹具错误；A:442另揭示租约检查/目录夹具问题；A:494是hosts、FakeIP启动与UDP路由等实际行为失败。修改后A:538的相关mobile定向测试通过；A:569发起的五包race回归在截取点还没有结果。代码和测试已有变化，这些重跑有理由，不能报告最终全部通过，也没有证据支持“本轮机械重复全仓测试”。

## 后续优先级与验证边界

1. 对齐auto跳过策略与提示，避免高风险大任务因人为压成两项失去计划期望的checkpoint/block能力；这涉及策略确认，本次不改行为。
2. 改善checkpoint的真实来源发现和错误指引，省去不必要的checkpoint及空转切角；保留来源、revision及职责守卫。
3. 交接带上完整已验证命令和必要环境；执行时复用已有路径/规则，减少大批截断，检查每个内层退出码。
4. graph状态标明“最近一次查询”的语义；历史超时需有新的可复现现场或耗时分段才能进一步归因，不凭状态数字重建索引。

上述是审计发现与建议，不是已实施修复。验证仅包括JSONL离线解析、调用/结果配对、错误分类、相关源码与安装/运行身份对照及文档静态检查。没有启动Pi、发送Provider请求、重放session、构建FlClash或运行本仓测试；业务最终完成状态超出本次固定时间窗口。
