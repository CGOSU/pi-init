# pi-init

Pi 扩展：为项目生成 AI Coding 协作上下文，并提供角色编排。

## 功能

- 生成项目级 `AGENTS.md`、记忆文档和 `.pi/role-models.json`。
- 随 package 发布公共 `pi-init-role-routing` Skill，集中维护角色职责、路由、交接、证据门控和工作流规则；新项目不再生成项目级角色 Skill。
- 按风险分级执行：只读咨询和目标明确的低风险开发直接自主推进，不为一般技术选择、排查顺序或恢复既定行为的 bug 反复询问或交接；用户要求简单任务只做实现时，不默认运行全量测试、类型检查或构建，只保留最小必要核对并说明未执行项；复杂/高风险任务仍保留结构化证据、角色边界、真实验证和授权。
- 通过统一的 `/pi-init` 控制中心完成初始化、角色配置和模型切换。
- 根据任务在公共 Skill 定义的职责之间切换模型；项目通过 `roleModels` 映射配置显式模型并启用自定义角色，内置标准职责无映射时沿用当前会话模型。
- 支持 `auto`、`confirm`、`manual` 三种角色切换模式。
- 活动 Agent 回合内的真实角色或模型切换会保存交接记录并结束旧回合，等 settled 后仅派发一次新职责续跑，重新生成当前职责的系统提示；同职责确认、闲置切角不额外启动回合。交接绑定 session、branch/角色代次及业务身份，过期交接不续跑，保存失败或派发结果未知不自动重放。
- 提供项目级任务工作流策略，默认 `workflowMode: "auto"`：`off` 拒绝新规划，`on` 始终编排，`auto` 对不超过 2 个任务的规划跳过编排，由各任务指定角色切换后直接顺序执行。`architect` 只规划且不能作为执行任务角色；plan/replan 会拒绝该角色，旧活动计划不会自动换角或派发。可通过 `/pi-init config workflow` 选择。兼容旧配置中的 `workflowEnabled`，缺失 `workflowMode` 时 `true/false` 映射为 `on/off`。
- 任务规划排序采用软约束：先遵守用户明确的优先级、截止要求和硬依赖，再安排可能推翻方案的关键未知项的限时最小验证，其次考虑业务关键路径；只有同层且风险、价值相近时才先易后难。不新增 difficulty/risk 字段，也不自动改写 task_workflow 输入顺序。
- pi-init 工作流仅在当前主会话内按顺序执行（local）；缺省配置和旧 `workflowExecutor: "local"` 配置仍可用。已退役的 Runtime 配置与持久状态不会静默回退或自动迁移，细节见“已退役的旧 Runtime 数据”。
- 未进入 `task_workflow` 的普通外部 Agent 执行会在 TUI 中显示开始时间、结束时间和总耗时报告，并与工作流任务完成报告分开。
- 统一 pi-init 活动区将角色、工作流进度、上下文压缩、可观测的模型请求/输出阶段、工具类别、缓存 token usage 和 session 累计工作时间合并到单一宽度感知信息。TUI 只显示一条位于编辑器下方的活动 widget；RPC 使用同源简明 status，JSON/print 不依赖 UI。Pi 原生 footer、working indicator 和 OSC 7501 保持原样；详细工作流原因与恢复步骤仍可从现有详情入口查看。
- 工作流状态工具、活动栏、进度面板和控制中心共用同一阶段/进度投影。当前项位置只从真实 `tasks` 列表中的 `currentTaskId` 计算一基索引；底部活动栏显示阶段、当前项位置和真实耗时，不重复显示“已完成 x/y”，内部完成统计仍供状态查询、控制中心和完成报告使用。Local 工作流只有在当前 Agent run 的 `message_start` 实际消费与当前 handoff 完整身份匹配的任务消息后才记录启动；“任务执行中”不凭 Agent 忙碌或 Provider 响应推断。
- 可观测性只基于公开 Provider 和工具生命周期事件：不推测 MCP/codemode 内部 I/O；未知工具以通用类别显示，不展示工具参数、命令、路径、URL 或结果。`cacheRead`/`cacheWrite` 是 Provider token usage，不代表磁盘或网络 I/O；完整有效 usage 中的正数按对应字段显示，部分/无效字段不补零或伪装为成功。Pi 1.1.0 可能已将 Provider 未报告的计数归一化为零，因此全零显示为“来源未确认”，不代表 Provider 明确报告零，也不推断缓存命中或未命中。缺失、无效 usage、请求失败、中止和缺少结束事件分别保留状态语义。新 Provider 请求期间，若保留先前完整结果会明确标为“上次”；只有同一请求匹配的最终 assistant `message_end` usage 才显示为“本次”，旧成功不会覆盖本次缺失、无效、未确认零值或错误。
- [运行黑匣子](docs/runtime-diagnostics.md)在可信项目默认启用：正常只保存回合摘要，异常自动留证、同类问题合并，使用 `/blackbox` 查看。`PI_INIT_HANDOFF_LOG=0` 完全关闭；`=1` 保留原[详细诊断日志](docs/handoff-diagnostics.md)模式。采集不调用模型、不自动重试任务。
- Pi API peer dependencies：`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`@earendil-works/pi-tui` 均要求 `^1.3.0`；本地以 `1.3.0` 验证，peer 范围声明不修改已安装的全局 Pi 版本。
- 自动模式将压缩放在任务交接边界：先保存完成结果与交接身份；达到 50% 兜底阈值，或按接收模型窗口估算的输入、输出预留与 4096 token 交接增量放不下时，先压缩，再切换角色和派发。同角色后续任务也判断预算；预算数据缺失沿用原阈值，不新增确认门槛。普通 `switch_role` 不触发压缩；失败或恢复时未确认收敛则暂停，核对后显式 resume。
- 角色、任务、重规划和取证交接均从当前状态生成轻量快照：携带身份、状态、下一步和按需读取的契约/验证/审阅引用，不要求模型填写交接表，不复制证据全文。补充说明缺失不阻塞；引用失效或证据不足先读取当前状态并补查/验证，不猜测旧身份。压缩后重新生成快照，保留现有身份、持久化和未知派发保护。
- 记录项目宿主环境和平台相关命令约定。

## 安装与启动

直接在本仓库启动扩展：

```bash
pi --no-extensions -e ./extensions/index.ts
```

然后在 Pi 中执行：

```text
/pi-init
```

可以直接从 GitHub 安装为 Pi package：

```bash
pi install https://github.com/CGOSU/pi-init
```

也可以使用 Git shorthand：

```bash
pi install git:github.com/CGOSU/pi-init
```

仅当前会话临时使用：

```bash
pi -e https://github.com/CGOSU/pi-init
```

本地开发时，也可以从当前目录安装：

```bash
pi install .
```

`init_project` 工具的 `targetDir` 默认为当前工作目录，支持 `dryRun: true` 预览而不写入文件。

### 可选：用量统计

仓库提供跨平台的 `pi-usage` 命令，用于查看 Pi 的模型用量。正常情况下无需单独安装：首次 `pi install` 或执行 `pi update --extensions` 时，package `postinstall` 会自动把启动器和所需支持模块安装到 Pi 可执行目录，之后直接运行：

```bash
pi-usage
```

只有自动安装因找不到 `pi` 或 npm 禁用了 lifecycle scripts 而跳过时，才需要手动补装：

Windows PowerShell：

```powershell
pwsh -File .\scripts\install-launchers.ps1
```

POSIX shell（Linux/macOS/WSL）：

```bash
sh ./scripts/install-launchers.sh
```

- `pi-usage` 默认查询 DuckDB；首次查询、距离上次检查超过 1 小时或跨自然日时，会自动扫描并增量导入 session JSONL。追加写入只读取已保存 checkpoint 之后的新字节；文件截断、改写或尾部校验失败时自动回退为全量重建。使用 `pi-usage --update` 可强制立即检查，日期参数支持 `yesterday`、`7d`/`30d`、`YYYY-MM`、单个 `YYYY-MM-DD`，以及两个日期组成的闭区间（如 `pi-usage 2026-08-01 2026-08-25`）；也可用 `--db <路径>` 指定数据库。默认数据库为 `~/.pi/agent/pi-usage.duckdb`，未安装 DuckDB 时会自动安装到用户目录。Pi fork/branch 复制的历史 entry 按稳定 entry id 跨 session 文件去重；schema v3 首次升级会事务化重建 DuckDB 派生缓存，原始 JSONL 不会修改。报表会显示 DuckDB 缓存的最近更新时间（`YYYY-MM-DD HH:mm`）。
- `pi-usage` 还显示活跃时长、模型等待时长和 session 跨度；Models 表按模型显示 `Avg TPS`（`输出 token 总数 / 有效生成秒数`），采用加权吞吐量而不是简单平均；没有 `pi-token-speed` 采样的历史模型显示 `--`。Overview、Models 和 Time 使用带边框的对齐表格，并额外显示按模型总 token 缩放的柱状图及整体缓存占比（`(Cache R + Cache W) / Total`）。交互终端默认使用 ANSI 颜色，设置 `NO_COLOR=1` 可关闭。活跃时长只连接间隔不超过 5 分钟的事件，避免空闲时间被计入。
- 使用 `pi-usage [时间范围] --output <路径>` 可将查询结果输出为参照每日 AI 对账单样式的纵向 SVG 图片；时间参数与普通查询完全一致，支持 `yesterday`、`7d`/`30d`、`YYYY-MM`、单个 `YYYY-MM-DD`，以及两个日期组成的闭区间。`--output` 目前要求 `.svg` 路径，未指定时仍输出原有文本报表。图片中的费用、模型、Token、缓存命中率和会话数均来自同一份 summary；SVG 不增加图像渲染运行时依赖，也不等同于实际账单。
- `--update` 会强制扫描 session JSONL 并更新 DuckDB 派生表；自动检查只在上述缓存过期时执行，未过期的普通查询直接读取数据库。TTY 下手动更新和首次/过期自动检查都会显示扫描、追加、重建、移除、取 session 文件最新修改时间且精确到分钟的重算日期，以及受影响日期摘要；非 TTY 保持原有报表输出，不额外写入进度信息。session 很多或首次自动安装 DuckDB 时会短暂等待。
- 更新结束后在当前 Pi 会话执行 `/reload`，或重启 Pi，使已加载扩展使用新文件。
- 安装器会把启动器放到 Pi 所在的可执行目录；POSIX 若无写权限则使用 `${XDG_BIN_HOME:-$HOME/.local/bin}`，并提示将其加入 `PATH`。
- 这些辅助命令是可选工具，不会修改系统全局环境变量；换电脑安装或更新 Pi package 时会自动安装，若自动步骤被跳过再按上述方式补装。

## 生成内容

```text
<project-root>/
├── AGENTS.md
├── docs/
│   ├── clean-code.md
│   ├── current-state.md
│   ├── decisions.md
│   ├── session-log.md
│   └── pitfalls.md
└── .pi/
    ├── role-models.json
    └── pi-init-state.json
```

初始化提供两条路径：快速路径自动读取 `package.json`、锁文件和目录名，只需一次确认；高级路径可编辑项目名称、语言、项目定位、测试命令和角色模型，不再询问 Skill 名称或 slug。当前项目初始化完成后会自动 reload。另可通过 `/pi-init sync [目录]` 安全同步已有项目的托管模板区块。生成的 `AGENTS.md` 只保留项目定位、环境、命令和知识库等项目特有规则，并引用随 package 发布的 `pi-init-role-routing` Skill；通用任务执行流程、证据门控、工具调用、角色交接和真实验证规则统一由公共 Skill 维护。它仍要求按需读取随模板生成的 `docs/clean-code.md`，并记录当前 Pi 宿主系统、CPU 架构和平台命令约定；如果项目实际运行在 WSL、容器或远程主机，应重新执行检测。

默认模板面向 CGOSU 工作流，包含团队知识库和 Git 身份规则。其他团队使用前，请修改：

- `templates/AGENTS.md`
- `templates/en/AGENTS.md`

### 模板同步与历史保留

`/pi-init sync [目录]` 用于把已有项目升级到当前模板版本，不会重新初始化或覆盖项目配置。脚手架会在 `.pi/pi-init-state.json` 中记录模板 schema 版本和托管区块基线。

- `AGENTS.md` 仅同步带有 `pi-init` 标记的托管区块；其他项目规则保持不变。
- `docs/current-state.md`、`docs/decisions.md`、`docs/session-log.md` 和 `docs/pitfalls.md` 已存在时完整保留，只在缺失时创建。
- 老项目首次同步会迁移可精确识别的 Fast Path 区块；无法确认是否为模板内容时报告冲突，不静默覆盖。
- 同步会先执行内部 `dryRun` 预览，区分新增、更新、保留和冲突；冲突时不写入文件，成功后可重复执行且不会重复插入区块。

## 公共角色 Skill 与动态配置

### 公共 Skill 的职责

`skills/pi-init-role-routing/` 随 pi-init package 一起发布，是所有项目共用的职责路由来源：

- `SKILL.md` 维护任务执行流程、证据门控、工具调用、角色边界、交接、真实验证和 `task_workflow` 规则。
- `roles/*.md` 按需提供架构师、开发测试工程师、文档与收尾工程师的职责说明；不需要的角色不会额外加载。
- Skill 只描述职责和流程，不保存具体 provider、model 或 thinkingLevel，也不会自行切换模型；`switch_role` 和扩展运行时负责按项目配置应用模型。
- 它由 Pi 从已安装的 package 加载，不复制到 `~/.pi/agent/skills`；脚手架只生成对它的引用，不生成或覆盖 `.pi/skills/<slug>/SKILL.md`。

因此，公共 Skill 负责“谁在什么边界做什么”，项目 `.pi/role-models.json` 的 `roleModels` 负责保存显式角色模型映射。内置标准角色 `architect`、`developer-test`、`docs-commit` 无需映射即可使用；自定义角色仍需显式映射和对应职责说明。既有项目的旧项目级 Skill 不会自动删除，确认内容后可手动迁移或删除。

`roleModels` 中的每个显式映射值必须包含精确的 `provider`、`model` 和 `thinkingLevel`，并优先于会话默认。保存结构使用 `schemaVersion: 2`；`roleModels` 可省略或为空，例如：

```json
{
  "schemaVersion": 2,
  "roleModels": {
    "architect": { "provider": "provider", "model": "model", "thinkingLevel": "max" },
    "developer-test": { "provider": "provider", "model": "model", "thinkingLevel": "max" },
    "docs-commit": { "provider": "provider", "model": "model", "thinkingLevel": "medium" }
  }
}
```

配置文件缺失或没有任何显式角色映射（包括 `schemaVersion: 2` 缺少 `roleModels`/映射为空且没有兼容的旧版顶层映射）时，标准职责沿用当前 Pi 会话的模型和推理强度；角色切换只改变职责，不另选模型、不生成或持久化 fallback 映射。没有当前会话模型时会报错。损坏 JSON、未知 schema、`roleModels: null`/数组、无效映射字段、显式模型不可用或凭据缺失也会如实失败，不会静默回退。

添加新角色只需两步：

1. 在项目 `.pi/role-models.json` 的 `roleModels` 中加入合法的小写角色 ID及其模型映射；
2. 在公共 Skill package 的 `roles/<role-id>.md` 增加对应职责说明，并更新 package。

运行时不维护独立角色注册表；已配置的新角色可用于菜单和工作流任务，未配置的未知自定义角色不会 fallback 到其他模型。更新 package 后执行 `pi update --extensions`，再在当前会话执行 `/reload`；本地开发可重启 Pi 或重新加载本地扩展。

旧版配置中的顶层 `architect`、`developer-test` 和 `docs-commit` 字段仍会自动读取，但只有用户明确执行 `/pi-init save` 时才规范化写入 `schemaVersion: 2` 与 `roleModels`。旧项目已有的 `.pi/skills/<slug>/SKILL.md` 不会被脚手架自动删除；请人工确认内容后再删除。用户自定义的其他 Skill 同样不会被修改。

## 角色编排

公共 Skill 按交付物选择角色；pi-init 不再为内置标准职责预设固定 provider/model 或推理强度。未显式映射的标准职责沿用当前会话模型和推理强度，显式角色映射仍优先。项目可加入其他合法角色 ID：

- `auto`：自动切换。
- `confirm`：切换前询问。
- `manual`：手动模式。阻止自动换角；原生 `/model` 切换不会被扩展回滚。只有当前活动角色已有显式映射且项目受信任时，切换才更新该映射；标准职责使用会话默认模型时不会创建固定映射。无活动角色或项目不受信任时不写文件。
- `/pi-init role` 和 `switch_role` 只切换当前会话，不写项目配置。
- `/pi-init config [角色]` 与 `/pi-init config workflow` 只暂存当前会话变更；执行 `/pi-init save`（保存角色配置）后才写入 `.pi/role-models.json`。

自动模式在工作流非最终任务完成、重规划交接和证据请求/报告交接边界，且上下文使用率达到 50% 时判断是否压缩。顺序为保存结果与交接身份、等待 Agent settled、按需压缩、切换角色、派发下一任务；同角色任务也按阈值判断，普通角色切换本身不触发压缩。压缩绑定 operation ID、压缩时仍活动的源角色、session/branch 上下文代次及 workflow/coordination 身份；只有该次 `compact()` 的完成/失败回调能收敛，不使用无归属的 `session_compact` 事件冒认完成。压缩失败保留完成结果并暂停，下一任务尚未启动；工作流通过 `/pi-init workflow resume` 重试边界，已确认尚未派发的协作压缩失败由用户执行 `/pi-init coordination resume` 创建新交接并重试；未知派发结果仍需核对，不能用该命令重放。恢复时发现未收敛的工作流压缩也先暂停，旧回调不得续跑。最终任务、低于阈值、未知上下文以及 `confirm`、`manual` 模式不会因任务边界额外压缩。会话恢复时只按当前模型和推理强度匹配显式映射；没有唯一匹配时不猜测活动角色，仍按职责确认和恢复门处理。外部或非本次角色交接触发的 `session_compact` 会持久化“职责待恢复”标记；自动角色交接仅在绑定身份校验通过后由运行时记录 acknowledged，不要求重复切换。branch 实际变化时目标 branch 的旧 acknowledged 不再确认当前职责，必须重新确认；manual 模式无法从真实模型验证当前角色时，应由用户执行 `/pi-init role <role>`，不要循环调用 `switch_role`。恢复门解除前只允许查看工作流状态、读取文件或调用 `switch_role`，成功后才能编辑、写入、测试、执行 shell 或提交结果。new 或空会话不会额外上锁。

任务边界压缩达到 30 秒只触发一次长等待软提醒，不代表压缩失败：活动栏继续显示压缩进行中，并仅在有效真实开始时间可用时显示经过时长；提醒不会取消压缩、清除 in-flight/职责恢复门或自动重派发，真实失败仍由压缩错误回调表达。当前没有压缩耗时分布可据以评价 30 秒阈值是否最优，也不据此宣称性能改善。

### 读取与探索策略

普通任务由匹配角色连续调查、实现和验证，切角不重启任务，也不默认创建正式证据链。已确认事实、有效验证与进度按需复用；身份由运行时绑定实际派发回合，模型通常只提交业务结果。暂停恢复、兼容行为和授权边界见 [`docs/role-continuity.md`](docs/role-continuity.md)；详细职责规则仍由公共 `pi-init-role-routing` Skill 维护。

`architect` 只负责思考、分析、决策、规划和安排。其运行时仅允许 `switch_role` 与 `task_workflow(action="plan"/"replan"/"status"/"request-replan"/"request-child"/"review-child"/"request-evidence"/"review-evidence")`；后两项是纯协议规划/审阅动作，不授权读取仓库、运行取证或执行开发。`report-evidence`、`clarify`、`complete`、`block`、`resume`、`retry`、`cancel`，以及 `read`、搜索、shell、编辑、浏览器、脚本、协作和未知工具均由运行时 fail-closed 阻断。提示层只用于降低错误率，运行时守卫负责权限执行。

### 证据协作、开发契约与模型上下文

- `request-evidence` / `review-evidence` 由 architect 创建问题并明确接受、补查或阻塞；受派发的 `docs-commit` 用 `report-evidence` 回报事实、推断或未知、来源及版本、检查范围、测试位置和实际执行验证。取证报告不会自动变成已接受证据；docs 取证阶段不例行 commit。
- 正式协调动作通常由运行时绑定本轮派发身份，兼容显式 `coordinationHandoffId` 或完整 `coordinationIdentity`。未观察到真实派发消息的隐式提交不会套用当前状态；显式过期身份和冲突引用继续拒绝。
- 报告输入校验失败（来源版本/位置冲突、重复 acceptedEvidence、未解决缺口等）且尚未持久化时，可在同一有效 handoff 内用同一身份修正后重提，不新建 attempt、不自动重试、不重新取证；权限失败、身份过期、恢复失败、持久化结果未知或已提交成功的动作不属于可直接重提。单条 finding 内 `id`/`location`/`version` 完全一致的来源会去重保留首次顺序，同 `id` 不同版本或位置仍拒绝；`acceptedEvidence` 只合并完全一致的三元引用，不会自动接受任何未明确引用的结论。
- 普通计划不因 ready 旁账强制生成契约；主动携带 contract 或已绑定的正式/legacy 工作流仍校验有效证据、当前 revision、关键未决和副作用处置。不得删除契约降级或绕过正在进行/blocked 的显式取证。
- 协调状态复用 Pi 当前 session 的 append/branch 和既有 local task executor；协调记录本身不是 architect 执行任务，不新增第二个 executor，也不占用开发任务额度。
- 扩展通过公开 `context` 钩子为当前交接裁剪实际模型输入，保留原 session/branch 历史；Pi 管理的 system/tool state 不由扩展接管，不使用 `context_with_system`。边界可靠时保留当前角色工作窗口、真实工具调用与结果配对和新用户指令；交接、branch 或压缩映射不确定时保留完整输入并明确报告未裁剪。测试 harness 结果不代表已验证真实 Provider、Pi TUI/E2E、跨模型缓存或费用收益。

角色、模型和模式的关系：

```mermaid
flowchart LR
  TASK[当前任务] --> MODE[模式<br/>auto / confirm / manual]
  MODE -->|auto：自动决定| ROLE[角色<br/>架构师 / 开发测试 / 文档与收尾]
  MODE -->|confirm：先询问| CONFIRM[用户确认]
  CONFIRM --> ROLE
  MODE -->|manual：阻止自动换角| COMMAND["原生 /model"]
  COMMAND -->|已有映射且项目受信任| CONFIG[显式角色映射<br/>.pi/role-models.json]
  ROLE --> CONFIG
  CONFIG --> OVERRIDE[当前会话暂存覆盖]
  ROLE -->|标准职责无显式映射| SESSION_DEFAULT[当前 Pi 会话模型与推理]
  OVERRIDE --> MODEL[模型<br/>provider/model]
  OVERRIDE --> THINKING[推理强度<br/>off ... max]
  SESSION_DEFAULT --> MODEL
  SESSION_DEFAULT --> THINKING
  MODEL --> SESSION[当前会话]
  THINKING --> SESSION
```

用户只需记住一个入口：

```text
/pi-init
```

控制中心提供快速初始化、高级初始化、项目模板同步、角色与模型配置、独立的工作流策略配置、角色切换和模式切换；主状态摘要会显示当前工作流策略与执行进度。熟悉命令行时也可以直接使用：

```text
/fast <任务描述>
/pi-init init [目录]
/pi-init advanced [目录]
/pi-init sync [目录]
/pi-init role <role-id>
/pi-init config [role-id]
/pi-init config workflow
/pi-init save
/pi-init mode <auto|confirm|manual>
/pi-init workflow stop
/blackbox
/pi-init coordination resume
/pi-init coordination reopen <reportId> <原因>
```

`/fast <任务描述>` 是用户为本次任务显式选择 Fast Path，不设置持久开关、不修改项目配置或模型；Agent 忙碌、存在未结束工作流（running/paused/replanning）或有无法恢复的已保存工作流时仍会拒绝派发。它会跳过自动 Fast Path 的任务类型、规模和修改范围资格复核，直接按精简流程定向读取最少必要上下文、完成所需修改和风险匹配的最小验证；不会仅因自动资格不符而退回普通流程。安全、权限、需求/契约确认、职责边界、上下文恢复门、工作流保护和必要验证始终优先；任务独立要求架构规划或工作流时仍须遵循。

`/pi-init coordination resume` 只恢复已确认尚未派发的协作压缩失败；它不会解除证据审阅的 `block`。用户可用 `/pi-init coordination reopen <reportId> <原因>` 显式重开指定问题最新且明确阻塞的报告。重开保留原取证、来源版本和阻塞审阅记录，只创建新的 architect 复审轮次，不自动接受证据或派发开发；Agent 忙碌、项目不可信、状态恢复异常或存在未完成/结果未知的 handoff 时拒绝执行。

### 停止、保存待办与长任务预算

- `/pi-init workflow stop` 或明确的“停止工作”由运行时停止自动续跑，不靠切角或伪造 complete 退出任务。要求“写进 TODO 之后停止”或仅将当前任务进度输出到 TODO 时，系统从可信工作流派生轻量快照，追加到项目 `TODO.md`，保留已有内容；不要求模型填写交接表，不进入新的任务流，也不跟随 TODO 符号链接。讨论、否定、引用和完成后的条件指令不作为立即停止命令。
- 停止记录绑定当前 session/branch 的工作流，恢复会话时重新读取。活动执行被中断会保存为结果未知；停止不等于取消或副作用确认。明确“继续”或用户执行 resume/retry 只解除停止锁，仍须通过原有恢复/未知结果确认，模型不能用布尔参数代替用户授权。新只读问题可以回答，但不会顺带恢复旧任务；停止后的写入试探会结束当前回合。
- 同一真实身份下连续 3 个不同调用被同类业务/恢复门拒绝时，运行时停止当前重复回合及自动续跑；穿插普通读取不清空计数。它不限制合法交接次数，不自动重试或切角。
- auto 模式新增 SDK `turn_end` 的完整工具组预算检查，覆盖普通任务、单个长任务和同角色执行。只用当前窗口 usage，复用既有压缩操作/回调，不把累计账单 token 当窗口。manual/confirm、缺失 usage、恢复门、待派发消息、操作进行中和未知执行身份仍阻止自动压缩，并留下原因；失败或无收益反复尝试受冷却及新 usage 增长限制。
- 已验证的活动任务压缩后，只有相同 session/branch/角色/任务/attempt/handoff 且宿主已结束旧回合时，才通过现有唯一 dispatcher 续做一次；不创建新 attempt、不重派初始任务，也不把这次宿主中断计作模型未提交结果的纠偏。普通无工作流任务不额外启动模型回合；如果宿主结束了当前回合，界面提示用户明确继续未完成部分。取消、未知结果、失败或过期回调均不获得重放授权。
- `file_review(action="list")` 是全项目受支持代码文件的候选库存分页，不按 path 筛选；传入 path 时返回 `scope: "project"` 和 `ignoredPath`。path 用于 complete。Markdown 已被代码扩展名集合排除，不例行审阅文档结构。

### 控制中心与次级菜单

`/pi-init` 在 TUI 中打开控制中心，根菜单提升为“初始化”“变更”“同步”“工作流”四个分组；选择“初始化”或“变更”后再进入对应的次级菜单，同步和工作流入口直接执行对应操作。菜单使用尽可能宽的横向区域，选中项的说明会在列表下方独立显示并自动换行，避免窄终端截断。保存不再作为列表项出现，统一使用 `Ctrl+S`（Windows 终端若拦截该组合键，可用 `F2`）；带有次级菜单的入口需要逐级完成选择：

- “变更 · 工作流策略”只配置 `workflowMode`（`off`、`on` 或 `auto`）；工作流执行固定为当前主会话内的 local 顺序执行。命令行入口 `/pi-init config workflow` 也只打开策略菜单。
- 在任一次级菜单选择“返回”或按 `Esc`，都会返回上一级且取消本次尚未完成的配置选择；完成选择后，变更先暂存于当前会话。
- 在任一角色配置菜单中按 `Ctrl+S` 或 `F2`，会保存当前暂存的角色配置；保存完成或失败后仍停留在当前菜单，重复按键不会并发写入。
- `Ctrl+S` 和 `F2` 覆盖控制中心、角色与模型、模式、工作流策略、角色选择、模型搜索和推理强度等层级；初始化表单仍使用 `Enter` 确认、`Esc` 返回。
- 执行 `/pi-init save` 仍是非 TUI 和兼容场景的显式保存入口。

### 架构前置证据与职责边界

角色路由遵循公共 Skill 的单一层级：明确实现/测试直接交给 `developer-test`，明确文档、版本或 Git 收尾直接交给 `docs-commit`，不明确、含糊或跨职责的指令从 `architect` 开始。简单只读咨询可直接由适合的非 `architect` 角色完成；凡需要仓库、代码、测试、文档或外部事实取证，均由 `docs-commit` 完成并交接包含事实、来源、相关符号、调用/依赖、测试、工作区状态、风险和未确认项的结构化证据包。`architect` 只消费证据，负责思考、分析、决策、规划和安排，除 `switch_role` 与 `task_workflow` 的 `plan`/`replan`/`status` 外不调用工具、不连接 MCP；实现完成并验证后，只有产生文档、版本或 Git 收尾时才交给 `docs-commit`。

当公共 Skill 或扩展更新后，已安装的 package 和当前 Pi 进程不会自动获得新规则；请执行 `pi update --extensions`，然后 `/reload` 或重启 Pi。新守卫只在扩展重新加载后生效。当前仓库源码的修改不会自动覆盖已安装 Git package；本次退役未执行安装、`pi update --extensions`、reload、真实 Pi E2E、提交或推送。

任务工作流默认使用 `workflowMode: "auto"`。使用 `/pi-init config workflow` 在当前会话暂存 `off`、`on` 或 `auto`，执行 `/pi-init save` 后才写入项目配置；也可以直接编辑 `.pi/role-models.json` 的顶层 `workflowMode` 字段：`off` 不创建新规划，`on` 始终创建工作流，`auto` 对不超过 2 个任务的规划返回绕过提示、不持久化状态、不调度角色，并要求按各任务指定角色切换后直接顺序执行，架构角色不直接实现；超过 2 个任务才进入编排。所有 pi-init 工作流都在当前主会话内 local 顺序执行。缺省配置及旧 `workflowExecutor: "local"` 配置仍可用，但执行器不再作为菜单或 schema 选项；旧项目缺失 `workflowMode` 时，`workflowEnabled: true/false` 分别兼容为 `on/off`，两者同时存在时以 `workflowMode` 为准。

#### 已退役的旧 Runtime 数据

旧配置中的顶层 `runtime` 字段返回 `RUNTIME_CONFIG_RETIRED`，`workflowExecutor: "runtime"` 返回 `WORKFLOW_EXECUTOR_RETIRED`；请由用户检查并手动清理这些旧配置后再保存，不会自动忽略或改写。含 Runtime executor/authority 的历史 workflow session entry 会以 `WORKFLOW_STATE_RUNTIME_RETIRED` 在状态与动作入口报告恢复失败；pi-init 不会把它本地重放、自动迁移、改写或删除。请保留原始 entry，并由用户自行决定如何处理旧 session。当前未接入任何官方 Runtime 接口。

#### 工作流交接与恢复边界

工作流状态使用 Pi 扩展公开的 `appendEntry` 写入当前 session，并在 `session_start`/`session_tree` 从活动 branch 恢复。该能力持久化的是 pi-init 的工作流记录，不是 AgentHarness durable operation API；`appendEntry`/`sendMessage` 的公开契约不提供事务、fsync 或外部副作用 exactly-once 保证。工作流继续由 `task_workflow` 唯一负责计划、依赖、阻塞、验收和重规划，Pi turn 结束或消息已排队都不代表业务任务已完成。`architect` 不能作为执行任务角色，complete/block 只能由匹配的非 architect 执行角色调用；发现旧计划违反该约束时不会自动改写角色或派发，需先检查并显式取消该旧工作流，再另建计划。

创建工作流时会生成 `workflowId`、`planVersion`、当前 `sessionId` 与 `recoveryGeneration`；后续变更工具必须匹配当前基础身份。任务 `complete`/`block` 还须匹配当前 `taskId`、`attemptId` 和 `handoffId`，重规划还须匹配当前 `revisionId` 与 `handoffId`。这些身份由当前任务/重规划交接提供，缺失、旧 branch 或不匹配的身份会被拒绝，不从任务文本补齐。恢复时尚未派发的准备阶段可安全续接；已派发或已启动但无业务验收结果的任务会暂停为“结果未知”，不得自动重放。核对外部副作用后，用户可显式执行 `/pi-init workflow retry <taskId> --confirm-unknown-outcome` 创建新 attempt；这不是 exactly-once 或撤销既有副作用的保证。旧 local 状态可读取；缺少执行身份的 legacy `in_progress` 会暂停待核对，原 session entry 不原地改写，旧 Runtime 状态仍 fail-closed。

协调证据绑定会在工作流状态成功写入后统一同步；完成、阻塞、重试、提醒暂停和恢复产生的新执行代次，不再依赖各动作分别维护关联。派发或补充取证前也会补偿同 session、同 workflowId、同 planVersion 的已有落后绑定；不会创建缺失绑定、改绑其他计划或倒退未来代次。同步失败时保留已完成结果、暂停后续派发，存储恢复后重试关联，不重跑已完成任务。来源版本、证据就绪与任务契约检查仍然生效，真实不匹配仍会阻断。

工作流状态、单任务完成、工作流最终完成和普通执行计时分别由只读类型视图提供数据，并由纯文本与 TUI renderer 输出，不依据中文标题或已格式化文本推断类别。状态视图同时供状态文本、状态栏、进度面板及非暂停的 `task_workflow` 结果使用；进度面板的刷新与任务选择仍由运行层负责。完成报告保持中间任务精简、最终报告只展示明确的最终任务和整体耗时，验证只列明确失败项；计时缺失会显示不可用而非伪装成零。

TUI 所需的 `workflowPresentation` 只附加在当前工具结果 `details` 中，不写入 `WorkflowState` 或 session entry；缺少展示元数据的旧结果保留原始工具文本。模型侧既有内容仍由纯文本 formatter 提供。

状态阶段只来自共享状态视图中的当前工作流、活动任务与匹配 handoff；“执行中”要求 handoff 处于 executing，且任务启动、执行启动和 handoff 启动时间为同一有效值。当前任务位置按真实任务列表的一基索引展示，完成数仍独立显示为实际 `completed/total`；暂停、重规划、没有当前任务和终态不保留旧位置。

工作流查看默认突出活动阶段、完成进度和当前任务；嵌套工作流的进度面板与状态摘要以树状展示父目标、当前子目标、父层等待状态，以及已完成/取消的子目标；暂停时仍优先显示真实阻塞原因。工具结果中的任务/工作流完成摘要也默认精简；展开后保留任务身份、完整结果、验证、时间和子工作流历史。TUI 进度面板刷新时尽量保留仍存在的选中任务；切换到不同 workflow 时重置到新工作流的当前任务。模型可见的完整状态文本与身份不受 UI 摘要裁剪影响。

进度面板支持键盘分层浏览：↑↓ 选择任务，Enter 查看任务范围、验收、阻塞原因、结果和实际验证；Esc 从详情返回列表，在列表才关闭。按 `a` 打开与当前状态对应的继续/重试/取消操作，按 `d` 查看只读技术详情；长详情可用方向键或 PgUp/PgDn 滚动。刷新保留任务选择和详情滚动位置，切换工作流才重新定位当前任务；窄终端使用单列、固定底部提示。不可用操作显示原因，等待 AI 审阅不会提供跳过验收的入口。

取消当前层与取消全部分开显示，确认说明目标和影响范围，默认选择“返回，不执行”。结果未知的重试必须先核对副作用并显式授权新尝试；确认前后均校验工作流来源、会话与上下文，旧面板不能操作新状态。界面只复用既有业务命令，不直接写状态；取消不回滚副作用，也不保证停止已运行工具。

工作流动作失败时，工具仍向模型返回 `[PI-INIT_WORKFLOW_ERROR]` 下的结构化 JSON，`isError` 状态、身份守卫和失败行为保持不变；TUI 结果 renderer 对诊断先做窄化校验，再按类别、代码、原因、白名单身份差异及安全下一步分段显示。普通错误、损坏 JSON 和不符合字段要求的诊断以真实原文回退；未通过解析的输入不会被当作成功或无数据。此层只改变 TUI 展示，不替换模型诊断或触发自动重试。

### 取消、告警确认与历史恢复处置

- 新扁平工作流中，`/pi-init workflow cancel` 与工具同名动作取消当前共享队列；不会把目标归属分组当成独立执行器。对于旧 parentStack 状态，保留“取消当前层并返回旧父层处置”的兼容语义；`cancel-all` 取消整个旧父子流程。先持久化状态再撤销原身份续跑，写入失败不报告成功。取消只停止后续编排，不回滚副作用，也不保证已运行工具、进程或宿主压缩停止。
- `task_workflow` 工具收到 `AbortSignal` 只中止本次工具操作，不会取消或改写整个工作流，也不等同于上面的 `cancel` 命令。
- `/pi-init workflow acknowledge` 仅降低当前 session 中匹配告警的前台突出程度；详细状态、诊断、权限和恢复守卫保持不变。告警原因或 workflow/recovery/attempt 身份改变、切换 branch 或重新加载 session 后，未解决问题会重新突出；工作流进入 `completed`/`cancelled` 或不再有告警时清除对应标记。确认不是取消，也不会确认或隐藏独立的宿主压缩事实。
- `/pi-init workflow status` 会提供恢复分类和受限建议。仅对明确列为不可恢复且没有可读/待持久化工作流状态的历史记录，才可考虑 `/pi-init workflow discard-recovery <entryId> --confirm-unknown-outcome`。它要求项目受信任、Agent 空闲、指定当前 branch 中唯一且最新的原始工作流 entry ID，并先核对任务可能产生的外部副作用、显式确认未知结果。成功会在原记录之后追加版本化处置记录；原记录不删除或改写，也不生成成功/取消状态、不回滚副作用、不自动重跑任务。
- session 身份缺失或不匹配、可恢复状态、权限/存储失败以及未知错误都不能通过 `discard-recovery` 绕过；应按 `status` 给出的对应安全路径处理。隔离不是任务成功的证明。

### 活动工作流中的目标与队列

父子关系只表达目标归属与展示，不再用于新任务的运行时挂起/返回。所有新目标共用同一个 workflowId、任务列表和执行器；普通讨论、解释、纠正和“继续”文本不自动改变编排。修正或追加工作用 `request-replan`（或“重规划：…”、“追加任务：…”），明确新目标用 `request-goal`（或“新目标：…”、“插入目标：…”）。`request-child` 与旧“子流程：…”输入保留为插入目标的兼容别名，不创建新子流程。

新目标在当前任务完成或正式阻塞的安全边界规划。architect 用 `replan` 提交新增任务，并以 `retainTaskIds` 明确确认仍有效的全部原有 pending 任务；原目标、已完成成果和阻塞记录保持。新任务 ID 在整个队列与历史中唯一，归属 ID 由运行时生成；后续任务可用 `goalId` 引用已有归属，`parentGoalId` 指定已有父目标（默认当前任务所属目标或根目标）。归属自身不建立执行依赖，不要求额外 subworkflowContract；任务仍有目标、文件范围与验收条件，协调契约/证据守卫不放宽。

调度先检查 `dependsOn`，只在依赖完成的 pending 任务中比较 `priority`：默认 0、数值大者优先、同级保留原顺序。普通目标默认追加同级队尾；只有明确需要插队时才提高优先级。不会因为创建分组就自动加急，也不会强行中断正在运行的工具或写操作。

发现原任务不再有效时，可将插入请求转成 `request-replan`，保留新目标意图与既有成果，再修改当前队列；不需要先 retry 或取消工作流。阻塞态在没有活动交接时也可申请重规划，未知副作用仍不得自动重试；没有结构化澄清处置的未知结果若被新任务替换，须显式 confirmUnknownOutcome=true 并提供 reason 核对说明，处置写入 revision 审计。插入任务完成后只重新选择当前就绪项，不恢复旧栈位置；若原任务仍受阻或依赖未满足，队列继续暂停。

目标分组按实际任务验收与验证记录汇总，分组结束不代表根目标完成。撤销目标通过普通重规划移除其未完成任务并检查依赖；允许 `tasks=[]` 配合 `retainTaskIds` 只保留/撤销任务，替换记录保留在 revision 审计中，最终队列不能为空。新建 plan 或插入目标仍须至少一个任务。新扁平工作流的 `cancel` 取消整个当前队列，不把当前显示分组误当作独立执行器。

状态 schema 升至 v7，新增 `goals`、`goalId` 与 `priority`。v1–v6 历史仍可读取；旧父子运行栈、旧待规划嵌套请求、已完成成果、执行身份和未知副作用记录按兼容协议保留，不在加载时强制展开、重排或重放。`review-child` 和子流程契约只为旧记录收尾保留，新分组不需要一次额外的出栈审阅。旧 attempt/revision/session/branch 的结果仍不能推进新状态。

### 模型引用策略

模型安全来自角色和工作流配置中的明确引用，不维护 Provider 白名单（`1.1.0` 起移除 `providerPolicy`，旧配置中的该字段会被忽略）：

- 显式角色模型映射使用完整 `provider/model` 引用，并要求显式引用在注册表中存在；标准职责无显式映射时直接沿用当前会话模型。
- 原生 Agent 子代理由 Pi 宿主决定模型；pi-init 不注入、不校验、不拦截其 `model` 参数，模糊名称和跨 Provider 解析由宿主负责。
历史上的 OpenRouter 意外调用曾与 Agent 子代理的模糊模型解析有关；当前项目不再在原生 Agent 边界重复实现模型路由，需要控制该行为时应配置 Pi 宿主或显式使用完整模型引用。

原生 `/model` 切换由用户自主决定，扩展不回滚、不拦截。需要使用其他 Provider 时：

- `/pi-init config [角色]`：候选列表展示全部已注册模型（含刚登录的 Provider），随时暂存；在 TUI 配置菜单中按 `Ctrl+S`，或执行 `/pi-init save`，即可持久化。
- 直接编辑 `.pi/role-models.json` 的角色模型：保存即生效。
- 手动模式（`mode: "manual"`）：原生 `/model` 切换保留宿主行为；只有活动角色已有显式映射且项目受信任时才更新该映射。使用会话默认模型的标准职责不会因手动切换而生成固定映射。

注意取舍：完全限定的跨 Provider 引用（如 AI 主动写 `openrouter/...`）不会被拦截——如果你需要严格限制可用 Provider，应当自行在配置中只保留对应角色模型。

每个中间任务完成时只输出该任务的精简报告：任务、摘要、实现原因、耗时和验证。`implementationRationale` 必须由执行角色说明采用该实现的原因和关键取舍，不能重复摘要。验证结果只显示明确失败的验证项；成功项不显示，没有失败项时省略验证行，不再输出灰色 bullet 辅助项。完整 verification 仍保存在工作流状态中。

工作流暂停时，自动暂停通知和 `task_workflow block` 工具结果使用分区摘要，突出暂停状态、阻塞任务、真实原因及恢复建议；结果收起时不以成功标记呈现，展开后才显示完整任务和身份技术状态。通知与 TUI 由同一结构化暂停视图分别渲染，不从已格式化文案反推结构。结果未知时必须先核对外部副作用，再显式确认 retry；block 工具以结果展示为反馈，不另发重复 toast。显式 `task_workflow status`/TUI 查询与持久化状态仍保留完整任务、摘要和细节。

仅当最后一个任务完成、工作流进入 `completed` 时，才输出一次工作流完成报告：目标、进度、最终任务的摘要/实现原因/验证，以及整体开始/结束时间和总耗时；不会重新汇总前序任务。最终任务验证同样只显示明确失败的验证项。这样可以保留最终交付的完整上下文，同时避免任务报告和工作流报告重复。规划、架构审阅等待和任务之间的调度等待不计入整体执行耗时；不调用模型生成主观内容。报告中的开始/结束时间使用系统本地时区，格式为 `YYYY-MM-DD HH:mm:ss±HH:MM`。

未走 `task_workflow` 的普通外部执行仍会显示每轮独立的“普通执行时间报告”，字段包括来源、开始时间、结束时间和总耗时。另在 TUI 中，Pi 工作时显示原生 `Working`；空闲后在编辑器上方显示类似 `─ Worked for 1h 17m 49s ─` 的横向分隔线，其数值累计本次 session 的 Agent 实际工作时间，不包含闲置时间。session 恢复时优先从每轮完成后保存的独立累计快照恢复，并兼容只有普通执行记录的旧 session；活动工作流、扩展隐藏续跑和中断不会重复生成普通报告。

`/pi-init mode`、`/pi-init role`、`switch_role` 和 `/pi-init config` 的运行时变更只影响当前会话；TUI 配置菜单可按 `Ctrl+S` 保存暂存角色配置，非 TUI 或兼容场景仍使用 `/pi-init save`。Pi 原生 `/model` 和 `Shift+Tab` 仍可用于临时切换，角色自动切换以当前会话配置为准。

### 工作流运行时导出函数缺失

若遇到历史符号 `shouldOrchestrateWorkflow` 或当前工作流符号 `validateWorkflowExecutionRoles`、`workflowActionIdentity` 不是函数，不要直接断定是模块缓存、旧 package 或某种更新步骤导致。当前源码已将 `src/roles.js` 等实现迁为 `.ts`；静态 Jiti 调度测试和 Pi 1.1.0 隔离 RPC 冷启动均通过，但无法检查先前报错的长驻 Pi 进程，因此其根因仍未确认。新进程通过不代表旧进程已修复，`/reload` 也未被验证为根因修复。准确的现象、证据和未确认项见 [`docs/pitfalls.md`](docs/pitfalls.md)。

## 全局协作规则

如果所有项目都需要遵守同一套主机规则，可使用 Pi 全局上下文文件：

```text
~/.pi/agent/AGENTS.md
```

`settings.json` 主要用于配置，不适合承载自然语言协作规则。

## 检查与 TypeScript 源码

```bash
npm run typecheck
npm test
```

在 Pi 中使用 `/large` 手动重扫当前项目，并报告超过 500 个物理行的结构候选。扫描完整、状态可确认且存在当前内容版本未审候选时，命令仅在 Agent 空闲且没有未结束或恢复异常的工作流、职责恢复持久化失败时，通过 Pi 用户消息入口尝试启动一次命令专属结构审阅。请求已派发不代表模型已完成审阅或已登记结论；无候选（包括同版本已审）、扫描失败/不完整、状态无法确认、Agent 忙或工作流保护触发时，不启动、排队或抢占审阅。手动扫描可在职责恢复 pending 或 architect 角色下运行，但不会确认恢复状态或解除工具守卫。结构结论仅为 `keep`/`recommend-split` 建议，不自动修改或拆分文件。该命令与扩展内结构审阅共用扫描实现，不依赖 JavaScript/TypeScript 项目。`npm run typecheck` 运行 `tsc --noEmit` 检查 TypeScript 源码；`npm test` 运行 Node 测试。扫描在会话启动时建立当前 session/branch 的观察基线，并在文件工具结果与 Agent 回合边界补扫；支持 `.js`、`.mjs`、`.cjs`、`.ts`、`.mts`、`.cts`、`.tsx`、`.jsx`、Rust `.rs`、Go `.go`、Python `.py`/`.pyi` 和 PHP `.php`/`.phtml`。候选按项目、路径、内容指纹与策略版本跟踪并随当前 session branch 恢复；登记结论前须完整读取当前版本，扫描或持久化失败不会伪装成已审。测试价值审阅功能已退役；项目通用 Test Value Gate、增量补测原则与有价值的业务回归仍然保留。`npm run typecheck` 使用 `strict`、`NodeNext` 检查 `extensions/**/*.ts` 与 `src/**/*.ts`，`allowJs` 为 `false`。本轮文档收尾验证使用 Node v26.11.1；Pi peer/lockfile 版本为 1.1.0。Node `>=22.19.0` 的最低声明版本尚未单独实测。

`file_review` 仅承载大文件结构审阅。默认或显式 `reviewKind="structure"` 的结构审阅针对超过 500 个物理行的代码文件，结论为 `keep`/`recommend-split`；该阈值不是文件上限。旧的显式非结构 `reviewKind` 调用会明确失败，不会静默按结构审阅处理；不传 `reviewKind` 的既有结构调用继续有效。结构结论独立记录在 `pi-init-file-review`，必须完整读取当前内容版本并给出理由；内容变化会使旧结论失效。测试价值审阅入口、候选与状态维护已完整退役。

日常提示（系统提示 section、文件工具结果附加通知和 `agent_settled` 通知）只呈现当前 session/branch 观察基线之后实际观察到的结构候选变化，不代表精准的任务 Git diff 归属，也不重复提醒未变化的既有库存。`file_review(action="list", offset=...)` 与 `/large` 提供完整结构候选库存；增量基线、范围与通知水位只存在于当前 session/branch，恢复、切换 branch 或 reload 后重建，过期异步结果不会写入新上下文。候选通知按结构候选有效版本去重；未送达或受安全门阻断的通知不提前记为已消费。扫描或状态失败保持未确认，不推断未确认的删除或清空未知范围。项目通用 Test Value Gate 和增量补测原则不依赖此结构审阅工具，仍按项目规则执行。

项目通用 Test Value Gate 仅规定测试断言的价值取舍，不会自动发现测试文件、推断实现关联或维护审阅候选。测试选择与补测范围仍按项目规则，围绕实际行为变化、风险和有价值的业务回归确定。
