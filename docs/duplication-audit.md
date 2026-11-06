# 等价重复实现审计（2026-11-06）

基线：`6303c3e`。工作分支：`codex/merge-equivalent-implementations`，从已完成死代码清理的提交建立；完成 **17 组等价实现合并**，分 **20 批验证**；代码与测试合计净减 **60 行**，文档新增另计。本轮不推送、不合并、不安装或同步本机 Pi 副本。

## 判定范围

- 检查 `src/`、`extensions/`、`scripts/` 与测试辅助，结合函数体、调用点及依赖关系寻找同名、不同名和轻微改写的重复实现。AST/文本相似只用于发现候选，是否合并取决于实际行为。
- 等价核对包含输入范围、类型转换、数组处理、缺失值、异常、返回值及副作用。只共享已经一致的部分；错误策略、保护边界、用户可见文案或调用顺序不同的实现保留。
- 原有公开导出名称和调用契约保持不变。源码公共纯函数位于 `src/`，不让底层依赖扩展运行时；独立安装的 `pi-usage` 只能依赖随安装器复制的支持模块，不能引用安装后不存在的仓库 `src/`。
- 每组实施前向用户说明保留版本及理由，每组修改后单独运行测试；相同测试的重复运行不累加为独立覆盖数。

## 合并组与保留版本

下表中的来源指基线实现；可用 `git show 6303c3e:<路径>` 复核删除前内容。调用方列出被替换的模块，既有业务调用保持原入口或改为导入唯一共享实现。

| 验证批次（等价组） | 重复来源及调用方 | 保留实现与理由 | 状态 |
| --- | --- | --- | --- |
| 1 | `scripts/pi-usage/{database,query,report,bill,refresh}.js` 的五份 `numberValue` | 将相同的 `Number(value) || 0` 保留于 `scripts/pi-usage/numbers.js`；五个模块均改用它，保留原强制转换、零值及非有限数行为。共享文件属于安装器会复制的单层支持目录。 | 已合并 |
| 2 | `scripts/pi-usage/query.js`、`report.js` 的 `averageTps` | 保留原“缺 speed 或非正分母/分子返回 `null`，否则相除”的同一函数体，放在 `numbers.js`，两处导入。 | 已合并 |
| 3 | `scripts/pi-usage/report.js` 的 `formatDateMinute` 日期部分与 `core.js` 的 `localDateString` | 保留已存在的 `localDateString`；分钟格式化仍自行检查无效日期并保留小时、分钟输出，只委托完全相同的本地年月日拼接。 | 已合并 |
| 4 | 16 份严格对象判定：`src/{file-review,general-session-handoff,roles,scaffold,task-memory,workflow-handoff,workflow-hydration,workflow-recovery-disposition,workflow-replan}.ts`；`extensions/{cache-miss-reminder,edit-guard,role-context-protocol,scaffold-runtime,workflow-error-view,workflow-recovery,workflow-start-evidence}.ts` | 严格判定最初集中到 `value-guards.isRecord`，随后在批次 16 统一为 `src/record-guard.js` 的唯一实现；`value-guards.ts` 及原 `role-context-protocol.isRecord` 保留重导出，领域模块不相互依赖。 | 已合并 |
| 5 | `src/workflow-model.ts`、`extensions/workflow-presentation.ts`、`extensions/run-timing-view.ts` 的宽松对象判定 | `value-guards.isObject` 保留接受数组的原行为，独立于组 4 的严格判定。 | 已合并 |
| 6 | `extensions/cache-request-diagnostics.ts` 与 `handoff-tool-diagnostics.ts` 的对象读取 | `value-guards.recordOrEmpty` 保留合法对象本身；非法输入每次返回新的空对象，不能共享可变空对象实例。 | 已合并 |
| 7 | `src/roles.ts`、`src/workflow-model.ts` 的字符串成员判定 `isOneOf` | `value-guards.isStringMember` 保留先检查字符串、再执行 `some(candidate => candidate === value)` 的顺序；不混入接受数字的另一版本。 | 已合并 |
| 8 | `src/workflow-{model,hydration,replan}.ts` 的 `isUnknownArray` | `value-guards.isUnknownArray` 保留原 `Array.isArray` 行为及类型收窄。 | 已合并 |
| 9 | `src/roles.ts`、`extensions/workflow-error-view.ts` 的 `hasOwn`，以及 `src/workflow-{model,hydration,handoff}.ts`、`extensions/{role-runtime,edit-guard,workflow-recovery,workflow-recovery-actions}.ts` 的相同内联检查 | `value-guards.hasOwn` 保留 `Object.prototype.hasOwnProperty.call(value, key)`；不替换为会查原型链的 `in` 或会受对象方法覆盖影响的调用。 | 已合并 |
| 10 | `src/run-timing.ts:isValidTimestamp` 与 `src/session-work-time.ts:validTimestamp` | `value-guards.isFiniteNumber` 保留只接收有限 `number` 的规则；需要非负值的上层检查仍在原位置。 | 已合并 |
| 11 | `src/workflow-model.ts` 中 `normalizeRevisionId` 与 `normalizeIdentityToken` | 保留 `normalizeIdentityToken` 的 `requireText` 和 128 字符上限实现，`normalizeRevisionId` 薄委托；两个原有导出名和错误消息保持。 | 已合并 |
| 12 | `extensions/runtime-state.ts:textOf`、`src/file-review.ts:normalizeFileReviewError`，以及 `src/{file-review,roles,workflow-hydration}.ts`、`extensions/{large-command,ui,session-handoff,role-recovery}.ts` 的同式内联转换 | `src/error-utils.ts:textOf` 保留 `Error.message`／`String(error)` 分支；原导出通过重导出或委托保持兼容，不混入带默认消息或截断的实现。 | 已合并 |
| 13 | `src/task-memory.ts:taskMemoryError`、`extensions/workflow-tool-binding.ts:bindingError`、`extensions/workflow-recovery-actions.ts:throwActionError` | `error-utils.throwCodedError` 保留构造 `Error(message)`、附加 `code` 并立即抛出的行为；公开 `taskMemoryError` 保持原入口，不与返回错误对象的函数合并。 | 已合并 |
| 14 | `src/session-handoff.ts:handoffHash` 与 `src/file-review-journal.ts` 的完整 JSON SHA-256 | `src/json-hash.ts:jsonHash` 保留完整十六进制摘要及 JSON 序列化失败的传播；`handoffHash` 保留原导出入口，审阅日志直接使用共享函数。 | 已合并 |
| 15 | `extensions/session-handoff.ts:records`、`general-session-transfer.ts:entries`、`cache-miss-reminder.ts` 的会话条目读取 | `extensions/session-entries.ts:getSessionEntries` 原样保留 `getEntries?.() ?? getBranch()`，共三份实现、六个读取调用；使用类型导入，不增加 SDK 运行时依赖。 | 已合并 |
| 16（组 4 扩展） | `scripts/diagnostics/runtime-report.js:object`、`session-report.js:object` | 两个 JS 报告和 TS 调用方共用 `src/record-guard.js:isRecord`；`.d.ts` 仅提供类型声明，`value-guards.ts` 重导出，不保留第二份实现。采集器哈希纳入该文件，运行身份指纹扫描纳入 `.js`，既有测试验证实际 JS 内容变化会改变指纹。 | 已合并 |
| 17（组 16） | `test/architect-boundary.test.js:callToolCall` 与 `test/role-recovery.test.js` 的局部 `callTool` | 保留前者逐 handler 等待并返回最后阻塞的实现，放入 `test/support/extension-harness.js`；不替换为首次阻塞就返回的通用事件 helper。 | 已合并 |
| 18（组 17） | `test/workflow-{handoff,input-resume,nested-lifecycle,persistence,replan-directions,report,runtime-retirement,start-lifecycle,task-count}.test.js` 中相同的条目查询与三个 `latestWorkflow` helper | `test/support/workflow-fixtures.js:latestWorkflowEntry` 只共享相同查询；`latestWorkflow` 保留 `entry?.data`。直接读取或可选访问继续留在原调用点，避免改变缺失条目／缺失 `data` 的抛错行为。 | 已合并 |
| 19（组 4 补齐） | `extensions/{architect-boundary,cache-request-diagnostics,cache-status,diagnostic-controls,role-runtime,task-memory-runtime,workflow-recovery-actions}.ts` 与 `src/workflow-goals.ts` 的 11 处局部变量严格对象判定 | 同样委托 `isRecord`，保留前后的状态分支与错误；仅替换局部变量谓词，不改变重复属性读取次数或更宽松守卫。 | 已合并 |
| 20（组 1 补齐） | `scripts/pi-usage/core.js` 的 token 字段、cost 转换与 `database.js` 的 `appendBigInt` 转换 | 全部使用 `numbers.numberValue`，保留原 `Number(value) || 0` 以及调用点后续的 `BigInt` 等处理。 | 已合并 |

批次与独立等价组分开计数：批次 1–15 对应组 1–15，批次 17、18 对应组 16、17；批次 16、19 是组 4 的延伸，批次 20 是组 1 的延伸。因此实际是 **17 组、20 次逐批验证**，不是 20 个独立组。

共享调用索引可在最终代码中直接核对：

```sh
rg -n 'from .*numbers|from .*value-guards|from .*record-guard|from .*error-utils|from .*json-hash|from .*session-entries' src extensions scripts
rg -n 'callToolCall|latestWorkflowEntry|latestWorkflow' test/support test/*.test.js
```

这些索引与上表共同覆盖本轮替换的实现及调用模块；公开旧名称通过重导出或薄委托继续指向同一实现。`record-guard.d.ts` 只有声明，不是第二套判定代码。`diagnostics-report.js` 的采集来源哈希及 `runtime-identity.ts` 的源码指纹已纳入新 JS 依赖，避免共享实现变化后仍错误复用旧来源身份。

## 有差异而保留的实现

| 候选 | 实际差异 | 处理 |
| --- | --- | --- |
| 测试中的 `emitExtensionEvent` 与手动 `tool_call` 遍历 | 前者遇到第一个阻塞立即返回；后者仍运行后续 handler 并返回最后一个阻塞。 | 不将两类语义混用；只合并同类手动遍历。 |
| 测试中的多种最新工作流查找 | 有的过滤 `entry.type === "custom"`，有的不检查；有的缺失时返回 `undefined`，有的直接读取 `.data` 并抛错。 | 只共享相同过滤及缺失处理的查找。 |
| 测试临时目录辅助 | 临时路径前缀、清理重试次数或等待策略不同，可能影响诊断和异步清理。 | 保留差异，未扩大为统一生命周期包装器。 |
| 中英文模板 | 模板结构近似，但最终语言和用户可见文本不同。 | 保留两种输出资源，不引入模板生成层。 |
| SDK 收据/回合辅助与常规事件 helper | SDK 调度、嵌套调用收据、事件配对和副作用观察各有不同契约。 | 保留各自边界，不以“都发送事件”替代等价证明。 |
| `numberValue` 与 `refresh.finiteNumber` | 前者强制转换后以假值回退为 `0`，保留 `Infinity`；后者拒绝非有限值并返回 `undefined`。 | 各自保留，不能用“统一数值校验”改变返回值。 |
| 字符串与字符串/数字成员检查 | `workflow-hydration` 的 `isOneOf` 允许数字，`roles` 与 `workflow-model` 的版本先要求字符串。 | 只合并后两者；数字兼容检查保留。 |
| `bill.js` 与 `report.js` 的金额、日期及汇总 | 账单输出 `US$`、两位小数和中文日期；报告金额使用 `$`、四位小数。账单汇总会处理 `row?.field` 并强转，报告的某些累加直接使用字段，空行与字符串输入不同。 | 保留格式和累加策略差异，只共享已证明相同的数值/日期子操作。 |
| CLI 诊断 `stats` 与扩展 `durationStats` | 输入过滤和空结果不同：CLI 过滤 `null`、空分位数为 `null`；扩展过滤非有限或负值，空结果省略分位数字段。 | 不合并统计与返回结构。 |
| 两套健康样本判断 | CLI 版本要求相关字段明确为零或 `false`；扩展版本对部分字段允许缺失。 | 保留各自的数据完整性含义。 |
| 普通会话与工作流的 `checkReady` | 错误码、检查顺序、角色/模型条件以及工作流状态要求不同。 | 保留两条恢复与交接验证路径，不以通用参数表重写。 |
| 身份比较辅助 | 有的遍历 expected，有的遍历 left/actual；对象和 `undefined` 守卫也不同。 | 不合并不同信任方向的比较。 |
| 完整 JSON 哈希、工具指纹与缓存 HMAC | 完整哈希保留 SHA-256 全长并传播异常；工具指纹截取 16 位且捕获失败；缓存诊断使用带预算的 HMAC。 | 组 14 只合并完整哈希，保留其余隐私、失败和长度语义。 |
| 普通嵌套工具收敛与工作流验证证据 | 普通交接允许已知失败和合法参数省略；工作流证据要求完整成功。 | 已有基础共享继续使用，剩余验收差异保持独立。 |
| 直接重复读取属性的对象判定 | `cache-request-diagnostics.ts` 对 `response.usage` 多次取值，潜在 getter 的调用次数与传入 helper 后只读取一次不同；另有守卫不完整或明确允许数组/函数。 | 保留这些边界，不把相似布尔式全部批量替换。 |
| 两种 `bounded` | `task-memory-runtime.ts` 超限时保留首尾并插入省略标记；`workflow-user-control.ts` 压缩换行、转义 `<` 并仅保留开头。 | 保留不同的证据展示和停止摘要规则。 |
| 两种 `shortDuration` | `activity-status.ts` 接收秒且不做范围校验；`workflow-status-renderer.ts` 接收毫秒，检查有限非负后向下取整为秒。 | 不改变单位、范围或取整语义。 |
| `durationText` 包装器 | `run-timing-renderer.ts` 与 `workflow-completion-renderer.ts` 的输入联合类型、不可用文案来源不同。 | 保留领域适配；底层 `formatWorkflowDuration` 已共享。 |
| `workflow-model.workflowError` 与组 13 的错误 helper | 前者返回附带 `code` 的 `Error` 对象；后者立即抛出。 | 不合并控制流不同的接口。 |

## 逐组验证

| 验证批次 | `npm test` | 类型与差异检查 |
| --- | --- | --- |
| 1 | 856/856 通过 | 仅 JS 变化，未单独运行类型检查 |
| 2 | 856/856 通过 | 仅 JS 变化，未单独运行类型检查 |
| 3 | 856/856 通过 | 仅 JS 变化，未单独运行类型检查 |
| 4 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 5 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 6 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 7 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 8 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 9 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 10 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 11 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 12 | 856/856 通过（首次失败见下文） | `npm run typecheck`、`git diff --check` 通过 |
| 13 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 14 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 15 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 16 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 17 | 856/856 通过 | 仅 JS 变化，未重复运行类型检查 |
| 18 | 856/856 通过 | 仅 JS 变化，未重复运行类型检查 |
| 19 | 856/856 通过 | `npm run typecheck`、`git diff --check` 通过 |
| 20 | 856/856 通过 | 仅 JS 变化，复用批次 19 的类型检查结果 |

批次 12 的首次全量测试为 855/856：`control-center-menu.test.js` 在确认思考级别为 `max` 后读取到 `off`。未修改测试或产品代码来隐藏失败；隔离前一批源码与当前源码后，该用例各重复 8 次通过，隔离版本及当前版本的全量重跑均 856/856。根因未复现，不能声称该失败已修复。首次失败、隔离及重跑结果保留于本次验证记录，最终通过不抹去首次失败。

所有 20 批最终全量测试均为 856/856，无失败或跳过；不将重复执行累加为更多独立测试。类型检查实际在批次 4–16、19 执行并通过；批次 17、18、20 只改 JavaScript，最终复用批次 19 的 TS 检查结果，不将未执行的检查写成通过。最终 `git diff --check` 通过。

发布文件核对执行 `npm pack --dry-run --ignore-scripts --json --cache /tmp/pi-init-duplicate-npm-cache`，退出 0，包清单为 160 条目，7 个新增共享文件全部包含。没有运行安装脚本，也没有安装、同步或发布。本仓库采用源码直接加载，未新增构建层。

既有 `runtime-identity` 测试补充 JS 实现内容变化必须改变来源指纹的断言，测试总数仍为 856；未删除有效回归。批次 1–19 的独立代码复核通过；批次 20 在实施前确认等价，实施后全量回归通过。

## 数量与行数

以基线 `6303c3e` 到本轮最终代码差异统计，包含新共享文件和必要接线，不只计算删除旧函数的行数。审计与项目记录新增另计，不能将下表称为整仓净减。

| 范围 | 变更文件 | 增加行 | 删除行 | 净减少行 |
| --- | ---: | ---: | ---: | ---: |
| 生产源码与脚本 | 56 | 169 | 223 | 54 |
| 测试与辅助 | 14 | 67 | 73 | 6 |
| 代码与测试合计 | **70** | **236** | **296** | **60** |

新增共享文件共 7 个：`extensions/session-entries.ts`、`scripts/pi-usage/numbers.js`、`src/error-utils.ts`、`src/json-hash.ts`、`src/record-guard.js`、`src/record-guard.d.ts`、`src/value-guards.ts`。归并量为 **17 个独立等价组**；对同一组分批补齐消费者不重复计数。
