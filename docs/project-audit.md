# 全项目审计

基线：`f3a0031`。目标是修复可复现、契约明确的问题，并把需要维护者判断的事项留下；不是推断所有异常分支无用，也不承诺已经发现全部缺陷。未升级版本或依赖。

## 已修复

| 问题 | 修复与主要位置 |
| --- | --- |
| 诊断写入跟随已有目录/日志链接，维护页读取也可能越过预期文件边界 | 复用逐段目录检查、普通文件/no-follow 打开；维护页和导出共用有界读取。涉及 [diagnostic-storage.ts](../extensions/diagnostic-storage.ts)、[runtime-diagnostics.ts](../extensions/runtime-diagnostics.ts)、[global-diagnostics.ts](../extensions/global-diagnostics.ts)、[diagnostic-controls.ts](../extensions/diagnostic-controls.ts)。安全回归覆盖目录、文件、备份链接与字节上限。 |
| 原生 read 的空结果或旧正文也能计为读完当前文件 | 校验真实返回正文与当前指纹、范围一致后才计覆盖；拒绝无法核实的单空行证明。见 [file-review-runtime.ts](../extensions/file-review-runtime.ts)、[file-review-read.ts](../extensions/file-review-read.ts)。保留分段、缺口、版本失效和实际 SDK LF/CRLF 回归。 |
| 用量增量刷新先提交事件/游标，后算派生汇总；中断后可能永久遗留旧时长 | 把整个增量刷新置于同一事务，失败保留旧状态，后续可一致恢复。见 [refresh.js](../scripts/pi-usage/refresh.js)。 |
| session 中的 null/原始值导致扫描崩溃，丢失后续有效记录 | 结构化解析拒绝非法行形状，保留原有容错导入语义。见 [core.js](../scripts/pi-usage/core.js)。 |
| DuckDB connect 或连接清理失败时不释放实例 | 两种失败路径均尝试关闭实例。见 [database.js](../scripts/pi-usage/database.js) 与 [pi-usage-recovery.test.js](../test/pi-usage-recovery.test.js)。 |
| 六个独立 CLI 通过符号链接调用时静默不执行 | 使用 Node 原生 `import.meta.main`，清除失效的路径/URL 导入；覆盖 usage、安装器、两种报告、测试运行器及行数 CLI。见 [script-entrypoints.test.js](../test/script-entrypoints.test.js)。该 API 自 Node 22.18 可用，低于声明的 22.19 下限。 |
| 手动安装失败仍退出 0，参数缺失/未知时可能误走自动目标发现 | 在副作用前结构化拒绝非法参数，显式安装失败返回非零；保留无参数 postinstall 的 best-effort 语义。见 [install-launchers.js](../scripts/install-launchers.js)。 |
| PowerShell 安装器只复制 facade，未安装拆分后的支持模块 | 委托同一个 JS 安装器并传播错误，避免两套安装逻辑漂移。见 [install-launchers.ps1](../scripts/install-launchers.ps1)。真实 Windows 未验证，且维护者明确不要求本轮执行该验收；不将其描述为通过。 |
| 自由文本验证结果被猜成通过/失败 | 新输入只接受 `{ check, status, details }` 结构化记录，状态明确为 `passed`、`failed` 或 `not-run`；视图按状态分类，不解析描述文字推断结果。历史字符串按原样保留并显示为“未结构化／未判定”，不作为新验证输入。见 [workflow-verification.ts](../src/workflow-verification.ts)。 |
| 初始化工具宣称可确认覆盖，但实现只创建缺失文件 | 修正 [project-tool.ts](../extensions/project-tool.ts) 元数据，不新增覆盖能力。 |
| 基线存在三个过时的展示/时序断言 | 删除两个纯“自动”标签断言，保留实际状态隔离检查；把即时 widget 时序断言改为确定性的工作时间持久化与 shutdown 幂等验证，未删除有效恢复测试。 |

文档同步：移除当前状态中的已退役协调/嵌套协议说明、错误的 CI 已加入声明与过期指纹清单；将旧 TODO 标成历史。12 处指向缺失计划的链接已移除或改成明确的历史路径说明，保留现存计划及原决策背景，不伪造档案。`AGENTS.md` 保留维护者的 Fast Path 约定，同时注明插件已无 `/fast` 命令。诊断采集说明区分已修复链接路径与仍未解决的并发/恢复问题。

## 已按维护者确认完成的后续事项

以下目标均已实施并完成当前版本相关验证；维护者明确排除的环境/版本检查不是待办，也不表示通过。

| 事项 | 已实施结果与固定范围 |
| --- | --- |
| SDK 支持基线 | 当前工作区的 `@earendil-works/pi-ai`、`pi-coding-agent`、`pi-tui` 均为 1.5.0（package 与锁文件一致）；公开 peer 下限已对齐到 `^1.5.0`。不测试或兼容更老 SDK，也不改变锁定的实际依赖版本。`package.json` 的 Node 声明仍是 `>=22.19.0`；当前宿主 Node 为 26.13.0，未建立 Node 版本矩阵。 |
| 排除的验收 | 不要求 GitHub Actions/CI、真实 Windows/PowerShell 验收或旧 SDK/Node 版本矩阵；它们没有通过，也不作为本轮阻塞待办。Windows 安装入口仍保留。 |
| 初始化目录 | 禁止模板输出经项目内目录符号链接写入共享或项目外位置。所有输出父目录链需在首个写入前检查；发现链接即拒绝，保留已有文件/链接不删除、不改写。显式目标根目录的现行解析契约不扩展为沙箱。 |
| 诊断恢复与并发 | `/blackbox resume <project|global|handoff>` 只重新启用所选记录器以接收后续事件；不补写失败期间记录、不重放任务、不改变详细模式、不自动窃取或删除遗留锁。所有记录器追加、轮转、恢复和维护共用目录级跨进程 `runtime.lock`；锁超时 fail-closed，崩溃遗留锁须人工核对。 |
| 结构拆分 | `workflow-actions.ts` 保留原入口和动作编排；命令适配、类型移至 `workflow-command.ts`、`workflow-action-types.ts`。`file-review-runtime.ts` 保留工具编排；session 状态和观察器移至 `file-review-session.ts`、`file-review-observer.ts`。保持入口、契约、行为和恢复保护。 |
| 验证结果契约 | 输入、持久化、视图和直接调用方已迁移为 `{ check, status, details }` 结构化记录；历史自由文本原样保留并标为未结构化/未判定，不推断为通过或失败。历史结构的 `sourceSessionId` 明确标示来源且不计作当前验证。未新增“所有记录通过才可 complete”的规则。 |
| 诊断效率 | 已对代表性隔离负载测量；HMAC 合批收益不稳定且增加缓冲，未保留候选优化，生产实现与测量前逐字节相同。 |

## 实施接缝与实测依据

- 初始化：[`src/scaffold.ts`](../src/scaffold.ts) 在写入前逐段检查模板输出目录，拒绝项目内符号链接/非目录；保留已有文件和链接。目标根目录仍按既有选址契约处理，不是操作系统沙箱。回归见 [`scaffold-boundary.test.js`](../test/scaffold-boundary.test.js)。
- 诊断：[`diagnostic-writer.ts`](../extensions/diagnostic-writer.ts) 收敛有界队列、失败停录与显式恢复；[`diagnostic-storage.ts`](../extensions/diagnostic-storage.ts) 为项目/全局/handoff 的追加、轮转、恢复和维护提供目录级跨进程 `runtime.lock`。状态检查不会证明跨进程健康；锁不会自动窃取。停录后使用 `/blackbox resume <scope>` 仅恢复后续采集。细节见[运行诊断](runtime-diagnostics.md)、[交接日志](handoff-diagnostics.md)。
- 验证：[`src/workflow-verification.ts`](../src/workflow-verification.ts) 集中解析、旧记录恢复、状态分类和显示；contracts/actions/transitions/hydration 与 completion/status 调用方同步迁移。新输入的 `check`、`status`、`details` 必须显式提供；`not-run` 表示尚未执行，不代表操作结果未知。完成判定仍按任务已确认验收，不添加“所有记录都须 passed”的门槛。历史字符串原样保留并标记未分类；带 `sourceSessionId` 的历史结构按来源显示，不计作当前验证；均不据文字推断通过/失败。
- 拆分：[`workflow-command.ts`](../extensions/workflow-command.ts)、[`workflow-action-types.ts`](../extensions/workflow-action-types.ts)、[`file-review-session.ts`](../extensions/file-review-session.ts) 和 [`file-review-observer.ts`](../extensions/file-review-observer.ts) 承担拆出的命令适配、类型、会话状态及事件观察；原工具编排入口保留。恢复守卫、分支归属和原生读取证据边界保持。
- 支持范围：本机当前 Pi SDK 三包均为 1.5.0，peer 下限为 `^1.5.0`；Node 引擎下限维持 `>=22.19.0`，本次宿主 Node v26.13.0 / Darwin arm64。不测试或承诺旧 SDK/Node，不要求 GitHub Actions/CI、真实 Windows/PowerShell、真实 Pi reload/TUI 或真实业务数据迁移；这些均非本轮待办。

### 指纹隔离基准（不是端到端服务基准）

按合成输入/结果大小、缓存请求规模、自动/详细 handler 和 stat 摘要测量，并用固定 HMAC key、相同 VM 对照候选语义。small/medium/40 KiB/节点预算负载的合批结果约为快 7.1%、快 0.9%、慢 1.7%、快 16.3%；收益不稳定且增加临时缓冲，因此撤回候选。生产指纹实现与测量前逐字节相同，不宣称提速。完整负载构造、命令、结果、采样口径及限制统一见[会话记录](session-log.md#2026-11-11按当前运行时测量审计后续并统一验证)。

历史重复实现审计中记录的 control-center `max/off` 偶发失败本次未复现，不称已修复。原生 read 与诊断路径检查也不是操作系统沙箱；未测试同用户恶意并发替换父目录的攻击场景。

## 覆盖、保留与排除

- 首轮审计基线 `f3a0031` 的全仓清单包含 251 个第一方 JS/TS 文件并纳入 AST/导入/元数据/发布资源检查：89 个 extensions、35 个 src、20 个 scripts、107 个测试/辅助，1451 个导入。后续实现按当前任务直接范围另行修改、测试和验证，没有重复扫描所有历史文件。不是声称逐行读完每个小测试和每条历史 Markdown。
- 首轮审计时九个超过 500 行的候选均完整读取并登记当时指纹的结构结论；后续职责拆分改变相关文件结构，首轮结论不自动延伸为新版本审阅或发现所有缺陷的证明。
- 保留公共 facade/具名导出、Windows 启动入口、动态加载依赖、双语模板/运行时 Skill 资源、宿主原生压缩跟踪与有效恢复回归。未证明另有死代码，不因缺少仓内调用或本机未触发就删除；原有依据见[未使用代码审计](dead-code-audit.md)和[等价实现审计](duplication-audit.md)。
- 排除第三方/vendor、`node_modules`、`.git`、生成物、真实 session/数据库/诊断日志与凭据值。锁文件只检查声明/元数据一致性，不逐行审阅第三方实现；未做线上接口或凭据探测。
- 根 `AGENTS.md` 的 Windows 初始化快照保留其历史来源，不把它改写成当前审计宿主；当前执行环境为 Darwin arm64、Node 26.13.0。

## 实际验证

复用技术任务最终通过的结果：其后未再修改产品源码、测试、依赖或测试配置。文档阶段只做差异、链接与 Git 归属检查，不重复全量测试。

| 检查 | 结果 |
| --- | --- |
| 基线 `npm test` | 933 项：930 通过，3 个上述过时断言失败，均已调查。 |
| 首轮审计后 `npm test` | 967/967 通过；随后本次完整后续实现最终 `npm test` **1051/1051 通过**，0 失败、取消、跳过。首轮为 1050/1051，更新 init_project Result 的直接调用测试后重跑通过。 |
| `npm run typecheck -- --noUnusedLocals --noUnusedParameters --allowUnreachableCode false --allowUnusedLabels false` | 退出 0；不把静态检查当成动态无死代码的证明。 |
| 原始 HEAD 的回归复现 | 诊断安全 11/11、用量事务/非法行/资源清理 4/4、CLI 链接入口 6/6 均先失败；原生 read、手动安装退出码和混合验证失败另有失败后修复记录。 |
| 全仓静态检查 | 251 文件/1451 导入：无语法、缺失相对导入、包锁元数据或发布资源错误。 |
| 修改范围格式化与 `git diff --check` | 既有 TypeScript 格式引擎只处理变更范围/新代码；最终无剩余格式区域或空白错误。未发明新 formatter 配置。 |
| 本轮修改文档链接检查 | 9 个 Markdown 文件、254 个本地链接，目标文件与检查范围内的标题锚点均存在；不检查外部网址。 |
| `npm pack --dry-run --ignore-scripts --json --cache /tmp/pi-init-followup-npm-cache` | 退出 0，174 个包文件，6 个新增源码模块全部包含，missing=[]；不运行安装脚本、不发布。 |
| `bash -n scripts/install-launchers.sh scripts/pi-usage.sh` | 退出 0。 |
| `node scripts/check-line-count.js` | 退出 0；行数库存不是结构批准或构建门。 |

没有 build/dist 脚本是既定源码直接加载方式，不是漏跑了构建。性能采样仅为隔离合成负载。未执行真实 Pi reload/TUI、真实 Windows/PowerShell、GitHub Actions/CI、旧 SDK/Node 矩阵或真实业务数据迁移；这些均非本轮验收要求，未宣称通过。安装/数据库/链接验证仅使用新建隔离 fixture，未访问真实 Provider、安装或同步本机 Pi package，未 push、部署或发布。
