# pi-init

`pi-init` 是 Pi 扩展：帮项目准备 AI Coding 协作说明，并提供角色切换、任务工作流和运行诊断命令。

## 能做什么

- 初始化项目的 `AGENTS.md`、`docs/` 项目记忆和 `.pi/role-models.json`，只创建缺失文件，已有文件原样保留。
- 使用随 package 发布的 `pi-init-role-routing` Skill 提供通用职责规则；支持按职责模型映射或固定模型 Auto 强度自适应。
- 在 Pi 中切换职责、配置自动换角方式，并查看或管理任务工作流。
- 提供 `/blackbox` 运行诊断、`/large` 大型代码文件结构审阅，以及独立的 `pi-usage` 用量统计命令。
- 支持[本地诊断采集](docs/diagnostics-collection.md)：将明确指定的 pi-init 日志与关联 session 汇成带来源的离线报告，用于比较版本和排查优化候选。

## 安装

```bash
pi install https://github.com/CGOSU/pi-init
```

安装后重启 Pi，在项目中运行 `/pi-init` 打开控制中心。Pi 1.5.0 及以上版本会在此扩展更新后的下次新启动时，显示 `CHANGELOG.md` 中比上次已见版本更新的条目；首次安装只记录版本，不显示历史更新。也可以直接在本仓库试用：

```bash
pi --no-extensions -e ./extensions/index.ts
```

## 初始化项目

在 Pi 中运行 `/pi-init`，按提示选择快速初始化或高级初始化。也可以直接使用命令：

```text
/pi-init init [目录]       快速初始化；省略目录时使用当前目录
/pi-init advanced [目录]  高级初始化
```

初始化只创建缺失的协作说明、项目记忆和角色模型配置，已有同名文件及符号链接原样保留。重新初始化不会更新已有文档的语言或项目信息，这些内容由维护者直接编辑；角色模型通过 `/pi-init config` 和 `/pi-init save` 修改。只有实际创建当前项目文件后才自动 reload，无变更不 reload。

默认中英文模板面向 CGOSU 项目，包含知识库、仓库 Git 身份及任务完成后默认中文提交的约定，push 仍需明确授权。其他团队使用前应调整这些项目约定。

JS/TS项目无既定工具链时默认使用pnpm。快速/高级初始化推断测试命令时，优先使用 `package.json` 的 `packageManager`，其次识别已有锁文件（包含npm的 `package-lock.json` 和 `npm-shrinkwrap.json`），没有这些标记才采用pnpm。只为实际存在的 `test`、`check` 或 `lint` 脚本生成命令，用户明确填写的命令优先；不安装工具或转换锁文件。

旧 `/pi-init sync` 命令及托管模板同步机制已移除。项目文档由维护者维护；公共 Skill 与角色规则随插件更新，通过 `/reload` 或重启生效，不会自动覆盖已有项目文档。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/pi-init` | 打开控制中心 |
| `/pi-init config [role-id\|workflow]` | 配置角色/模型，或配置工作流策略 |
| `/pi-init role <role-id>` | 切换到指定职责 |
| `/pi-init mode <auto\|confirm\|manual>` | 设置角色切换方式 |
| `/pi-init save` | 保存角色模型配置 |
| `/pi-init fresh` | 预览并确认交接后创建新会话；普通会话与工作流统一入口 |
| `/pi-init workflow status\|resume\|retry\|cancel\|fresh\|stop` | 查看或管理当前工作流；`workflow fresh` 保留为兼容入口 |
| `/pi-init diagnostics`、`/blackbox` | 打开运行诊断 |
| `/large [--scope 目录] [--exclude 目录] [--include-temporary]` | 按范围扫描大型代码文件并启动建议审阅 |

标准职责包括 `architect`（规划）、`developer-test`（实现与验证）和 `docs-commit`（文档与交付）；项目也可以配置自定义角色。角色切换方式为 `auto`（自动）、`confirm`（确认后切换）或 `manual`（手动切换）。内联模型选择和文本输入等待用户时，会向 Pi 声明 question 阻塞状态；支持 Program Status 的终端可以显示 Pi 正在等待用户。

模型策略与角色切换方式、任务编排的 `workflowMode` 相互独立。默认 `roles` 策略沿用原职责模型映射；在控制中心「角色与模型 → 模型策略」选择 `Auto` 后，指定一个固定模型及支持范围内的起始、最小和最大推理强度（最小 ≤ 起始 ≤ 最大）。下例中的 provider/model 是占位符，请从 Pi 已注册模型列表中选择。例如：

```json
{
  "schemaVersion": 2,
  "modelStrategy": "auto",
  "autoModel": {
    "provider": "<provider-id>",
    "model": "<model-id>",
    "initialThinkingLevel": "medium",
    "minThinkingLevel": "low",
    "maxThinkingLevel": "high"
  }
}
```

启用 `Auto` 时原 `roleModels` 映射保留但暂不使用；切回 `roles` 后恢复使用。菜单更改先暂存于当前会话，按 `Ctrl+S`/`F2` 或运行 `/pi-init save` 才写入项目配置。每次已确认职责后，模型可按任务复杂度与风险调用 `switch_role`，传入当前职责、`thinkingLevel` 和理由，为后续请求建议强度；这不换职责、不结束当前任务，也不额外调用分类模型。配置菜单依次标明起始强度、自动调整下限和上限。首次判断使用起始强度，同一任务内可按当前阶段复杂度与风险在允许范围内升降，无需声明新任务边界；工作流任务边界由运行时识别，普通会话仅在新的用户输入确实开始独立任务时设置 `taskBoundary: true`，不能把继续说明当作新任务。用户手动指定推理强度后自动调档暂停，可在模型策略菜单恢复 Auto。`confirm` 仍要求确认，`manual` 不自动应用模型或调档；模型能力、凭据或强度不匹配时明确失败，不回退到其他模型。Auto 只改变固定模型的选择与推理强度，不改变职责权限；代码格式化、测试验证、文档及提交仍由原职责流程共享，architect 也不会因此获得仓库读取或实现权限。

任务编排的 `workflowMode` 与角色切换方式独立：`off` 拒绝新计划，`on` 始终编排，`auto` 默认按数量跳过不超过两项的计划，不自动评估风险。需要持久检查点、恢复或职责调度时，architect 可在 `task_workflow(action="plan", orchestration="required", ...)` 中显式要求编排，包含一至两项的计划也会进入原工作流；`off` 仍拒绝。省略该参数保持原行为，跳过时没有活动工作流，不能用其checkpoint/complete/block。按真实交付物拆分，不为触发编排制造任务。

验证按当前任务验收和风险选择；“真实验证”表示实际执行适用检查，不默认要求每项任务都做真机、人工浏览器或全链路测试。代码完成与系统集成/发布验收分别说明，明确安排的后续人工验收保留待办；环境相关关键行为应在链路可运行时尽早验证，已有必需验收不能自行省略。具体触发条件与阻塞边界统一见公共[执行与验证规则](skills/pi-init-role-routing/SKILL.md#执行与验证)。

可选工具pi-graph、rg与context-mode的分工也由该公共Skill统一指导；按当前可用能力选择，不要求全部安装，不在初始化模板复制工具细则。

工作流中的任务文件清单默认用于定位，目标与公共契约不变时可自主补充必要的直接关联文件；明确的禁止、隔离及硬范围仍须遵守。长任务的阶段进展不等于完成，无进展暂停也不等于操作结果未知；具体边界见公共[工作流规则](skills/pi-init-role-routing/SKILL.md#单一扁平工作流)。

## 按范围审阅与状态查询

`/large --scope src --exclude src/generated` 只审阅指定目录；路径为项目相对目录前缀，可加引号，`--exclude` 可以重复，不支持 glob。默认排除项目顶层 `.tmp`、`.tmp-*` 临时目录，可用 `--include-temporary` 明确纳入；其他隐藏源码和普通 `tmp` 不因此排除。报告显示目录分布、排除项和当前范围。范围只在当前 session 生效，`/large` 无参数恢复默认，reload 或新 session 重置；Agent 忙碌时不更改范围。

`file_review(action="list")` 的分页正文直接包含路径、行数、fingerprint 和下一页 offset；清单、读取及结论登记遵循当前扫描范围。审阅只产生建议，同一交付物连续读取、分析和登记，不逐文件切换角色；真正需要确定新公共契约或跨模块设计时，再集中交接决策。

`task_workflow(action="status")` 默认返回当前进度、阻塞原因和下一步；需要完整计划、历史任务、身份与任务记忆时使用 `detail="full"`。`evidenceIds` 仍可定向读取真实来源，UI 展开详情保留完整视图。恢复提示直接给出待确认的任务角色；已有当前状态时执行该恢复动作，不重复查询。等待调度时同角色确认会结束当前回合，由现有调度器派发一次；普通同角色确认继续当前工作。无变化等待状态的重复查询仍会结束当前回合，查询本身不会确认恢复或重放任务。

checkpoint按需保存阶段进展，不是complete、block或交接的新增前置条件。缺少已知有效来源时，一次full status可从任务记忆正文取得`observations[].id`和`revision`；缺revision优先使用错误反馈已给出的值，版本陈旧则先核对已保存进展再决定提交。来源范围、失败观察及字段用法见公共[操作参考](skills/pi-init-role-routing/references/runtime-operations.md#检查点与历史来源)。

## 容量提醒与手动新会话

pi-init 直接使用宿主 `ctx.getContextUsage()` 的百分比，与状态栏同源；不再按消息字符数估算，也不额外添加输出或安全余量。低于 70% 时完全隐藏容量状态项（包括“容量”字样）；达到 70% 时显示百分比及“压力偏高”，超过 100% 时显示“超出窗口”，仍只提供软提醒。宿主用量不可用、窗口不匹配或虚拟模型下一物理路由未知时内部记为未知，状态栏不显示该项，不用字符数兜底。宿主指标也不代表请求一定超限，Pi 原生容量保护仍负责真实请求边界。

提醒不阻断请求或工作流、不主动压缩，也不额外请求模型摘要。同一 session/模型/窗口的容量提醒会去重；模型或窗口变化、压缩和新 session 后重新评估，启动、模型切换及压缩回调先清除观察结果；在下一次请求上下文事件或 Agent 收尾时重新读取宿主用量。

当同一 session 已报告过缓存使用，且单次缓存失配的估算额外成本严格超过 **$0.50** 时，Pi Init 会给出一次短交接建议；同一 session 最多提醒一次。提醒会显示本次额外成本及本 session 累计的缓存失配额外成本估算；状态栏显示已成功持久化的合格样本数和累计金额，例如：`Miss 2 次 ≈$1.85`，次数不是提醒次数。累计金额和样本数只包含单次估算严格超过 $0.50 且成功观测并持久化的样本；等于或低于门槛的样本不计入，重开 session 时从该 session 中保存的有效样本恢复。估算使用 Provider 用量和 Pi 的模型价格，不是账单金额。提醒不会自动准备快照、切换 session、暂停或停止任务；无可见 UI 时不发送也不累计。

普通会话无需先创建工作流：当前已确认的非 architect 执行角色可调用 `session_handoff` 准备短交接，显式填写目标、约束、完成项、待办、历史验证及其来源、未确认项和下一步；没有内容的数组也必须显式填写 `[]`。可选 `decisions` 用来保留影响下一步的跨角色关键结论及理由，并区分 `confirmed`（用户已确认/既定契约）、`proposed`（建议）和 `unverified`（未验证假设）；结论与关键理由、必要的否决方案及边界写入正文，详细论证可用来源引用追溯（引用不会自动展开）。没有决策可省略或传 `[]`，依据不明可省略、留空或标记待确认，不要求补造理由。准备时检查重要结论是否遗漏只是指导，不会因语义完整性阻止保存；旧快照仍兼容。你可以先对当前 AI 说“请用 `session_handoff` 准备短交接，记录目标、约束、已完成/待办、跨角色关键决策及理由、历史验证及来源、未确认项和下一步”，等工具结果返回后仍在当前来源会话直接运行 `/pi-init fresh`，查看预览并确认；不要先执行 `/new`。该工具只保存有界历史背景，不创建 session、不验证当前事实、不授予执行权限。准备后若出现新输入、其他工具活动或 branch 变化，快照即失效；应在当前执行结束、现场稳定时准备。交接包超过 32 KiB 会完整拒绝、不截断；这是存储上限，不是 token 预算。

`/pi-init fresh` 会展示交接预览并等待用户明确确认，确认前重新核对来源 session、branch 和快照。新会话只接收所选历史背景及来源，不继承全部对话、旧执行身份或自动续跑；用户需在目标会话自行决定下一步。若安全门拒绝，提示会显示原因码及处置方向；不要绕过停止/恢复保护或未知工具结果。已结束且配对完整的历史工具失败不会单独阻止普通交接。Pi SDK 在助手回复以 `error` 或 `aborted` 结束时不会调度该回复内的工具提案，因此这类提案不需要虚构 `toolResult`；若同一调用存在工具执行/结果证据，仍作为矛盾拒绝。`toolUse`、`length`、普通缺失配对、未确认操作及真实未完成的嵌套调用仍会拦截。Pi SDK 也可能仅因参数正文过长而省略嵌套回执内容并标记 `complete:false`；只有来源结构、子调用终态及省略阈值均验证后，普通交接才将其视为已收敛。工具收敛不代表失败操作成功或没有副作用；仍未确认的结果应写入交接的未确认项，且不要在目标重复执行。旧安装副本可能仍显示通用提示，需先更新并reload后才能看到新原因码。若迁移结果未知，来源保持冻结；先核对目标，不要从来源重复创建。已接收交接的目标session重复运行 `/pi-init fresh` 只会幂等核对已有背景并提示“本次未新建会话”；若要从该目标继续转出到下一个session，应先在目标运行 `session_handoff` 准备新的背景，再运行 `/pi-init fresh`。新准备过期或失败时会明确拒绝，不回退显示旧导入成功。

未结束的托管工作流也使用 `/pi-init fresh`；`/pi-init workflow fresh` 继续兼容。用户要求“准备交接”时，由当前执行角色按需保留进展，并如实暂停未完成的活动任务；保存 checkpoint 本身不会暂停任务。已暂停的任务不需为交接先 retry；reload 后若仅职责恢复待确认，应核对并确认原执行职责，保持业务暂停。具体步骤见公共[操作参考](skills/pi-init-role-routing/references/runtime-operations.md#检查点与历史来源)。

当前回合结束后，fresh 仍检查至少已有一个完成交付物、无活动任务、工具已结束且结果已知，以及停止/恢复/配置条件；拒绝时显示具体原因和处理方向。符合边界的 `task-blocked` 可保留原阻塞原因转移，目标不自动 retry 或派发；已经转移且内容未变化的阻塞目标再次 fresh 只核对已有交接。暂停或职责确认成功均不代表交接已经完成。

工作流交接超过 32 KiB 时，完整状态、约束、历史成果、检查点和验证来源保存在源 session 的快照中，目标使用含唯一快照标识、hash 和字节数的有界引用；导入时校验并恢复完整状态，旧内嵌包仍兼容。预览摘要不替代完整约束，源 session 必须保留；来源缺失、篡改或转移结果未知时保持冻结，不重复创建。普通 `session_handoff` 的 32 KiB 背景上限不变。70% 仍只是软提醒，不会因上下文占用或 cache miss 自动切换 session；手动交接也不保证 Provider cache hit 或费用下降。

托管工作流的请求上下文视图不改写原 session：仅在任务、branch 和工具组边界可核实时，保留用户约束、失败/恢复/未知结果、完整工具调用与结果配对及当前任务交接后的活动内容；无法安全确认时保留完整输入。普通会话不做语义历史裁剪。实现取舍和验证边界见[设计决策](docs/decisions.md)及[会话记录](docs/session-log.md)。

## 可选：用量统计

安装 package 后可运行 `pi-usage` 查看 Pi 用量；指定时间范围或导出 SVG：

```bash
pi-usage 7d
pi-usage 2026-08-01 2026-08-25 --output usage.svg
```

`pi-usage --update` 可立即更新统计数据。统计输出同时显示插件版本和来源 Git HEAD（例如 `v2.0.11 (git: a1b2c3d)`）；独立启动器记录安装时的来源 HEAD，非 Git 安装只显示版本号。CLI 与 SVG 报告会标明总费用是 Provider 上报、价目估算或混合来源；Provider 上报不等同于账单核对，明细成本及缓存失配额外成本仍按原有估算口径计算。详细诊断说明见[运行诊断文档](docs/runtime-diagnostics.md)。

## 开发与测试

开发期直接修改源码，默认不安装或同步本机 Pi package 副本。日常按改动选择测试文件，避免把普通任务收尾当作全量测试触发条件：

```sh
npm test -- test/runtime-diagnostics.test.js test/handoff-diagnostics.test.js
npm test -- --test-name-pattern='故障风暴' test/global-diagnostics.test.js
# 需要整体回归时运行；默认只发现 test/**/*.test.js
npm test
```

无文件参数时，包括仅提供名称过滤选项时，使用上述受限发现范围；`test/support` 中的普通辅助模块不会被当作独立测试入口。Node 负责文件匹配和执行，[项目最低版本 Node 22.19 已支持测试 glob 与 mock timers](https://nodejs.org/download/release/v22.19.0/docs/api/test.html)。启动器保留隔离预加载与真实退出码，不解析改动来猜测应该跳过哪些测试。

常用选项 `--test-name-pattern`、`--test-skip-pattern`、`--test-reporter`、`--test-reporter-destination`、`--test-concurrency`、`--test-timeout`、`--test-shard` 同时支持空格或 `=` 形式；其他带值选项使用 `--key=value`，由当前 Node 校验。未知裸选项会明确拒绝，`--` 后只接受文件选择。

新增/精简用例、复用已有结果及全量验证的条件统一遵循 [AGENTS 验证要求](AGENTS.md#验证要求)，不按用例年龄或长期通过自动删除回归。
