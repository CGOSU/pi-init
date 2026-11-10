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
| PowerShell 安装器只复制 facade，未安装拆分后的支持模块 | 委托同一个 JS 安装器并传播错误，避免两套安装逻辑漂移。见 [install-launchers.ps1](../scripts/install-launchers.ps1)。真实 Windows 验证仍待办。 |
| 一条验证记录中的“0 errors/no errors”掩盖同条记录中的真实失败 | 只移除否定短语，再判断其余失败信息；保留混合中英文失败回归。见 [workflow-completion-view.ts](../extensions/workflow-completion-view.ts)。 |
| 初始化工具宣称可确认覆盖，但实现只创建缺失文件 | 修正 [project-tool.ts](../extensions/project-tool.ts) 元数据，不新增覆盖能力。 |
| 基线存在三个过时的展示/时序断言 | 删除两个纯“自动”标签断言，保留实际状态隔离检查；把即时 widget 时序断言改为确定性的工作时间持久化与 shutdown 幂等验证，未删除有效恢复测试。 |

文档同步：移除当前状态中的已退役协调/嵌套协议说明、错误的 CI 已加入声明与过期指纹清单；将旧 TODO 标成历史。12 处指向缺失计划的链接已移除或改成明确的历史路径说明，保留现存计划及原决策背景，不伪造档案。`AGENTS.md` 保留维护者的 Fast Path 约定，同时注明插件已无 `/fast` 命令。诊断采集说明区分已修复链接路径与仍未解决的并发/恢复问题。

## 待维护者审阅

优先级表示后续处理顺序；“未验证”不是已确认不兼容，也不是本次执行结果未知。

| 优先级 | 事项、依据与建议 |
| --- | --- |
| **P1：兼容性验收缺口** | [package.json](../package.json) 声明 SDK peers `^1.3.0`，开发测试使用 1.5.0，参考宿主文档为 1.5.2。本次未运行最低 SDK/Node 版本矩阵。先补矩阵，再决定维持下限或有依据地提高要求；不凭版本差异断言不兼容。 |
| **P1：Windows 验收缺口** | 本机无 Windows/PowerShell。win32/Linux 安装资源树已在 Darwin 上作为真实模块运行，但不证明 `.ps1`、`.cmd`、Windows 路径/权限与进程启动行为通过。下一次 Windows 验收需覆盖安装成功/失败和 CLI 调用。 |
| **P2：初始化目录链接策略** | [scaffold.ts](../src/scaffold.ts) 跟随已有 `docs`/`.pi` 目录链接。隔离探针确认 `docs` 链接目标位于项目外时，会在那里创建四个缺失 Markdown 文件；已有文件仍保留。请决定是否支持共享链接目录，或应在写入前拒绝。未擅自改变这一契约。 |
| **P2：诊断恢复与并发** | [runtime-diagnostics.ts](../extensions/runtime-diagnostics.ts) 等记录器在存储/锁失败后停录，需 reload；清理日志不重新启用，现已准确说明。是否提供显式 re-arm 是后续体验决定。[handoff-diagnostics.ts](../extensions/handoff-diagnostics.ts) 只有进程内队列，跨进程轮转保护仍待设计/压测，不能冒充已解决。 |
| **P2：持续验证缺口** | 当前仓库没有 CI workflow。若需要持续保证跨平台/最低 SDK 支持，应补相应矩阵；本机通过不能替代。旧文档“矩阵已加入”已纠正。 |
| **P3：结构建议** | 完整审阅后建议未来为 [workflow-actions.ts](../extensions/workflow-actions.ts) 提取工具动作适配边界，为 [file-review-runtime.ts](../extensions/file-review-runtime.ts) 分离原生读覆盖归属与会话库存/持久化边界。未实施拆分，不因超过 500 行强行重构；其余七个大文件结论为 keep。 |
| **P3：未测量的效率候选** | 可选详细诊断的指纹计算仍有热路径成本；见 [诊断采集边界](diagnostics-collection.md)。先以代表性负载 profile，再决定缓存或降采样；本次没有性能收益测量，不声称优化了它。 |
| **P3：验证数据契约** | 完成报告仍从自由文本识别失败。此次修复混合结果误判，但更可靠的结构化验证结果需要后续公共契约决定，不在审计中偷偷扩展。 |

历史重复实现审计中记录的 control-center `max/off` 偶发失败本次未复现，不称已修复。原生 read 与诊断路径检查也不是操作系统沙箱；未测试同用户恶意并发替换父目录的攻击场景。

## 覆盖、保留与排除

- 全仓清单和当前 251 个第一方 JS/TS 文件纳入 AST/导入/元数据/发布资源检查：89 个 extensions、35 个 src、20 个 scripts、107 个测试/辅助，1451 个导入。手工深读高风险工作流、恢复、上下文、会话、文件系统、用量及安装路径，结合配置、模板、Skill 与相关文档核对。不是声称逐行读完每个小测试和每条历史 Markdown。
- 九个超过 500 行的候选均完整读取并登记当前指纹的结构结论；修改过的两个大文件在最终版本重读。结构登记不是发现所有缺陷的证明，也不适用于未来版本。
- 保留公共 facade/具名导出、Windows 启动入口、动态加载依赖、双语模板/运行时 Skill 资源、宿主原生压缩跟踪与有效恢复回归。未证明另有死代码，不因缺少仓内调用或本机未触发就删除；原有依据见[未使用代码审计](dead-code-audit.md)和[等价实现审计](duplication-audit.md)。
- 排除第三方/vendor、`node_modules`、`.git`、生成物、真实 session/数据库/诊断日志与凭据值。锁文件只检查声明/元数据一致性，不逐行审阅第三方实现；未做线上接口或凭据探测。
- 根 `AGENTS.md` 的 Windows 初始化快照保留其历史来源，不把它改写成当前审计宿主；当前执行环境为 Darwin arm64、Node 26.13.0。

## 实际验证

复用技术任务最终通过的结果：其后未再修改产品源码、测试、依赖或测试配置。文档阶段只做差异、链接与 Git 归属检查，不重复全量测试。

| 检查 | 结果 |
| --- | --- |
| 基线 `npm test` | 933 项：930 通过，3 个上述过时断言失败，均已调查。 |
| 最终 `npm test` | **967/967 通过**，0 失败、取消、跳过或 todo。 |
| `npm run typecheck -- --noUnusedLocals --noUnusedParameters --allowUnreachableCode false --allowUnusedLabels false` | 退出 0；不把静态检查当成动态无死代码的证明。 |
| 原始 HEAD 的回归复现 | 诊断安全 11/11、用量事务/非法行/资源清理 4/4、CLI 链接入口 6/6 均先失败；原生 read、手动安装退出码和混合验证失败另有失败后修复记录。 |
| 全仓静态检查 | 251 文件/1451 导入：无语法、缺失相对导入、包锁元数据或发布资源错误。 |
| 修改范围格式化与 `git diff --check` | 既有 TypeScript 格式引擎只处理变更范围/新代码；最终无剩余格式区域或空白错误。未发明新 formatter 配置。 |
| 文档本地链接检查 | 36 个 Markdown 文件，无缺失的本地链接目标；不代表逐条核验所有标题锚点或外部网址。 |
| `npm pack --dry-run --ignore-scripts --json --cache /tmp/pi-init-audit-npm-cache` | 退出 0，168 个包文件；不运行安装脚本，不发布。后续仅改未发布的项目文档，包内容未变。 |
| `bash -n scripts/install-launchers.sh scripts/pi-usage.sh` | 退出 0。 |
| `node scripts/check-line-count.js` | 退出 0；行数库存不是结构批准或构建门。 |

没有 build/dist 脚本是既定源码直接加载方式，不是漏跑了构建。没有执行真实 Pi reload/TUI、最低版本矩阵、真实 Windows、真实业务数据迁移或性能 benchmark。安装/数据库/链接验证仅使用新建隔离 fixture，未安装或同步本机 Pi package，未 push、部署或发布。
