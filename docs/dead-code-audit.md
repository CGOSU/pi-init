# 未使用代码审计（2026-11-06）

审计基线：`97ddab6afc0a2a599d89a8df8f3650f1ea5e1dbf`。清理分支：`codex/remove-proven-unused-code`。删除前已记录下列证据，两批清理均已完成并通过各自验证，无需回滚；未推送、合并、安装或同步本机 Pi 副本。

## 取证范围与判定方法

- 扫描仓库跟踪的源码、脚本、测试、清单与文档；排除 `.git`、依赖安装目录和锁文件中的第三方实现。基线共有 268 个跟踪文件，其中 `src`、`extensions`、`scripts`、`test` 下有 227 个 TypeScript/JavaScript 文件。
- 使用 TypeScript AST 读取静态 `import`、`export ... from` 和字面量动态导入，建立文件依赖图；再核对字符串路径、脚本启动方式、动态资源和公开接口。没有静态引用只是候选，不直接作为删除结论。
- 产品入口包括 `package.json` 指定的 `extensions/index.ts`、`postinstall` 指定的 `scripts/install-launchers.js`，以及独立 CLI `scripts/pi-usage.js`、`scripts/check-line-count.js`、`scripts/diagnostics-report.js` 和 `scripts/handoff-report.js`。
- 测试入口包括所有 `test/**/*.test.js`、`npm test` 启动的 `scripts/test.js`，以及其通过 `--import` 加载的 `scripts/test-bootstrap.js`；测试辅助模块按真实导入追踪。
- 图中仅 `extensions/workflow-identity-report.ts` 同时不在上述产品和测试入口的可达集合。类型引用也视为使用。动态调用、外部 CLI、公开 facade、平台与恢复分支不能仅凭本机未执行删除。

下列命令固定使用删除前提交，清理完成后仍可复现搜索结果；报告中引用标识本身不作为程序使用。

## 第一批：删除已证明未使用的代码

### 1. 孤立的身份格式化文件

目标：`extensions/workflow-identity-report.ts` 全部 27 行，唯一导出 `formatWorkflowIdentityLines`。

```sh
git grep -n -E 'formatWorkflowIdentityLines|workflow-identity-report' 97ddab6 -- .
```

唯一结果（省略提交前缀）：

```text
extensions/workflow-identity-report.ts:8:export function formatWorkflowIdentityLines(workflowState: WorkflowState) {
```

- **入口可达性：不可达。** 没有任何导入、重导出、字符串调用或文件路径引用。Pi 清单只声明 `extensions/index.ts`，未声明此文件为入口；该文件只有导入和函数定义，没有需要保留的顶层副作用。
- **测试使用：无。** 全仓搜索仅命中定义，所有测试及辅助模块的依赖图均不能到达它。
- **动态与公开接口核对：** 未见文档或公共 facade 声明。现行身份输出通过 `workflow-status-renderer.ts` 的 `workflowIdentityLines` 提供，由状态 renderer 和 `workflow-status-tool-text.ts` 调用；它们是不同函数，继续保留。动态模块加载不指向此文件。

### 2–3. 用量模块遗留的两个私有常量

目标：`scripts/pi-usage/core.js:18` 的 `USAGE_SCHEMA_VERSION = 2` 与 `:20` 的 `APPENDER_BATCH_SIZE = 1024`，共 2 行。

```sh
git grep -n -E '\b(USAGE_SCHEMA_VERSION|APPENDER_BATCH_SIZE)\b' 97ddab6 -- .
```

完整结果（省略提交前缀，按文件排列）：

```text
scripts/pi-usage/core.js:18:const USAGE_SCHEMA_VERSION = 2;
scripts/pi-usage/core.js:20:const APPENDER_BATCH_SIZE = 1024;
scripts/pi-usage/database.js:5:export const USAGE_SCHEMA_VERSION = 4;
scripts/pi-usage/database.js:6:const APPENDER_BATCH_SIZE = 1024;
scripts/pi-usage/database.js:150:    { schema_version: USAGE_SCHEMA_VERSION },
scripts/pi-usage/database.js:195:      if ((index + 1) % APPENDER_BATCH_SIZE === 0) appender.flushSync();
scripts/pi-usage/refresh.js:1:export { USAGE_SCHEMA_VERSION } from "./database.js";
scripts/pi-usage/refresh.js:6:import { USAGE_SCHEMA_VERSION, clearDerivedData, insertActivityEvents, insertSpeedEvents, insertUsageEvents, markUsageChecked, readEventDates, readUsageSchemaVersion, readUsageState, withDatabase, withTransaction } from "./database.js";
scripts/pi-usage/refresh.js:324:  const schemaMigrated = schemaVersion !== USAGE_SCHEMA_VERSION;
scripts/pi-usage/refresh.js:380:      (schemaVersion !== USAGE_SCHEMA_VERSION || shouldRefreshUsage(state))
```

- **入口可达性：文件可达，目标绑定无人读取。** `pi-usage` 会加载 `core.js`，但这两个模块私有的 `const` 只有声明，没有读取或导出。初始化值为数字字面量，没有副作用。
- **测试使用：无。** 没有测试直接或间接访问这两个私有绑定。`database.js` 的同名常量属于另一模块绑定，确有数据库写入和刷新调用，全部保留。
- **动态与公开接口核对：** 非导出绑定不能通过动态导入的命名空间取得；没有按名称解析或 `eval` 路径使用它们。不能将同名搜索结果误认为同一绑定，也不能连带删掉仍有效的数据库常量。

## 第二批：固定根节点上的不可达分支

审阅范围：基线 `extensions/workflow-status-renderer.ts:143–198`。删除其中私有 `WorkflowGoalTreeNode`、`workflowGoalTreeRoot` 及旧树遍历器中的不可能分支，保留 `formatWorkflowGoalTreeText` 导出、当前根节点输出和真实 `view.goals` 递归。

```sh
git grep -n -E '\b(WorkflowGoalTreeNode|workflowGoalTreeRoot|formatWorkflowGoalTreeText|formatWorkflowStatusPanelSummary)\b' 97ddab6 -- .
git show 97ddab6:extensions/workflow-status-renderer.ts | nl -ba | sed -n '143,217p'
```

搜索结果：`WorkflowGoalTreeNode` 仅用于本文件 `:143` 定义、`:152` 自引用、`:155` 返回类型和 `:165` 私有遍历器参数；`workflowGoalTreeRoot` 仅在 `:155` 定义、`:162` 调用。`formatWorkflowGoalTreeText` 在 `:160` 定义、`:217` 被同文件的 `formatWorkflowStatusPanelSummary` 调用，另在 `test/workflow-flat-queue.test.js:6,98` 导入并执行。后者在 `:209` 定义，并由 `test/workflow-status-view.test.js:7,98,143` 导入和调用。

- **不可达证明：** 唯一根构造器始终返回对象，固定 `current: true`、`activePath: true`、`children: []`，不设置 `parentTaskId`。唯一遍历调用为 `append(root, "", true, true)`，没有中间修改或对外泄漏。因此 `!root` 分支、非 current 状态/标记、非根连接符、父任务附加文本以及对子节点的递归均不能执行。数字、状态和标题等真实 view 内容仍保留。
- **入口可达性：** renderer 模块本身从产品入口可达，但这两个导出函数在仓库中的调用链仅由测试触发；不能把“模块可达”当作“每个导出在产品中被调用”。该事实不足以删除导出 API，因此只收缩已证明不可能的内部路径。
- **测试使用：** 两个现有测试文件真实调用公开函数；保留所有测试。`view.goals` 有独立的真实分组递归，与固定空 `children` 的旧树不同，继续保留。
- **动态与公开边界：** 不改变函数签名、导出或可能被仓外使用的行为。固定属性来自函数内创建的私有对象，而非可由用户输入或宿主回调改变的 feature flag。

## 保留的入口与动态边界

| 保留对象 | 证据与原因 |
| --- | --- |
| `src/workflow.ts`、`scripts/pi-usage.js` 的公共 facade | 2026-08-20 [设计决策](decisions.md)明确保留具名导出和 CLI 入口；无法仅凭仓内没有消费者排除外部调用。 |
| `scripts/install-launchers.ps1` | 未发现仓内调用，但它本身是可由用户直接执行的 Windows 安装入口；不能证明外部无人使用。 |
| `scripts/check-line-count.js` | 具有独立 CLI 入口，`test/line-count.test.js` 直接导入和执行；不因扩展不导入就删除。 |
| `scripts/test.js`、`scripts/test-bootstrap.js` | 前者由 npm 脚本启动，后者由 `--import` URL 加载；不属于产品图可达模块，但有真实测试入口。 |
| `templates/` 全部语言模板 | `src/scaffold.ts` 的 `TEMPLATE_ROOT`、`TEMPLATE_FILES` 和语言选择动态构造路径读取。 |
| `skills/pi-init-role-routing/` 及角色文档 | Pi 清单发布 Skill；`runtime-routing-context.ts` 读取 `SKILL.md` 并按角色字符串读取 `roles/<role>.md`。 |
| `scripts/pi-usage/` 支持模块与 `.cmd`/`.sh` 启动器 | 安装器遍历支持目录、复制文件并重写相对导入；平台分支选择启动器。它们不是孤立资源。 |
| DuckDB 动态加载 | `scripts/pi-usage/core.js` 的动态 `import(pathToFileURL(modulePath).href)` 来自对 `@duckdb/node-api` 的解析；不能按无静态导入删除依赖或加载逻辑。 |
| 测试中的动态加载 | 用量版本测试加载临时安装目录模块；运行时导出测试动态加载 SDK/jiti 模块。保留这些真实测试路径。 |

## 保留的符号与条件分支

| 保留对象 | 搜索及使用证据 | 保留原因 |
| --- | --- | --- |
| `DEFAULT_ROLE_CONFIG` | `src/roles.ts:148` 导出；`test/extension-lifecycle.test.js:14`、`test/scaffold.test.js:32`、`test/role-recovery.test.js:44` 使用 | 有实际测试使用，导出也可能被仓外消费。 |
| `collectRoleModels` | `extensions/ui.ts` 导出；`test/extension-roles.test.js:83,88,90` 调用 | 仓内仅测试调用，不符合“无人使用”；外部调用未知。 |
| `formatWorkflowStatusPanelSummary` | 基线 `extensions/workflow-status-renderer.ts:209` 导出；`test/workflow-status-view.test.js:98,143` 调用 | 保留测试正在使用的导出接口；本轮只精简其内部确定不可达的树路径。 |
| `RoleContextView` 类型 | `extensions/role-context-view.ts:24` 导出；2026-10-19 [设计决策](decisions.md#2026-10-19按活动执行暂停恢复和共享协议拆分上下文视图)明确该入口兼容 | 兼容承诺有效，不能凭仓内未引用删除。 |
| 八个工作流类型别名 | `src/workflow-types.ts:163–179`：`WorkflowPlanInput`、`WorkflowStateInput`、`WorkflowTaskInput`、`WorkflowLegacyState`、`WorkflowRevisionRecord`、`WorkflowTaskRecord`、`WorkflowIdentityValues`、`WorkflowContinuationKind` | 没有仓内消费者，但为具名类型导出；外部深路径导入未知。它们均未通过 `src/workflow.ts` facade 重导出，保留理由不依赖 facade。 |
| 四个扩展类型别名 | `WorkflowActions`、`ControlCenter`、`RoleRecovery`、`FileReviewRuntime` 分别从同名职责模块导出 | 没有仓内消费者，但外部深路径类型导入未知。 |
| 工厂返回接口成员 | `lastContext`，以及 report 返回的 `formatWorkflowBlockNotice`、`formatWorkflowTimestamp`、`formatWorkflowDuration`、`formatRunTimingReport` | 工厂本身已有调用；部分成员未见仓内读取，但不能排除返回接口的外部使用，不借“属性未读取”扩大 API 清理。 |
| `setupRan`、`activated` 等异步状态 | `session-replacement.ts:33–42` 的 SDK `setup`/`withSession` 回调会写入；其他检查涉及 `await` 后 `currentSession` 和 Promise `settled` 状态 | 回调或异步边界可改变值，不是字面量恒定条件。 |
| 空 `thinkingLevel` 数组、宿主 `sections` 等输入边界 | 依赖运行配置或宿主传入数据 | 防御路径不能仅按当前环境或常见输入判为不可达。 |
| `PI_INIT_HANDOFF_LOG` | `test/runtime-diagnostics.test.js:114–122` 覆盖未设置、`"0"` 与 `"1"` | 真实环境开关，并非硬编码关闭的 feature flag。 |

除第二批外，未确认其他可删除的不可达分支或恒关闭开关。对 147 个源码、脚本与测试辅助文件的注释扫描产生 15 处代码形态候选，逐项检查均为说明性注释，没有确认整块注释掉的旧实现；不删除用于解释边界的文字。额外以 `allowUnreachableCode: false`、`allowUnusedLabels: false` 运行 TypeScript 检查通过，该检查只作为辅助证据，不能证明所有动态路径均已穷尽。

## 验证与回滚

仓库未配置 `build` 脚本。`tsconfig.json` 使用 `noEmit`；2026-10-08 [设计决策](decisions.md)明确源码由 ESM/Node/Pi 直接加载，不增加 `dist` 或编译层。因此不能声称“构建通过”；按现有交付方式分别执行全量测试、类型检查和打包清单检查。

| 阶段 | `npm test` | `npm run typecheck` | `npm pack --dry-run --ignore-scripts` | 回滚 |
| --- | --- | --- | --- | --- |
| 删除前基线 | 856/856 通过 | 退出 0 | 退出 0，154 个包条目 | 不适用 |
| 第一批删除后 | 856/856 通过 | 退出 0 | 退出 0，153 个包条目 | 无失败，无需回滚 |
| 第二批删除后 | 856/856 通过 | 退出 0 | 退出 0，153 个包条目 | 无失败，无需回滚 |

以上三次全量测试均无失败、跳过；不将重复运行相加为独立覆盖数。各阶段 `git diff --check` 也通过。第二批另比较删除前后 46 个输入场景（11 种 activity × 4 种 goals 布局，加无工作流与恢复错误），输出全部一致；没有新增或删除仓库测试。临时比对脚本不属于产品或长期测试资产。

`pack --dry-run` 只核对包清单，不运行安装脚本、发布、安装或同步。实际未运行构建，因为仓库没有构建命令。

## 删除数量

相对基线的代码差异如下，文档新增另计，不混入代码删除量：

| 文件 | 删除行 | 新增行 | 结果 |
| --- | ---: | ---: | --- |
| `extensions/workflow-identity-report.ts` | 27 | 0 | 删除整个文件 |
| `scripts/pi-usage/core.js` | 2 | 0 | 删除两个私有常量 |
| `extensions/workflow-status-renderer.ts` | 50 | 5 | 保留输出，替换不可达树结构 |
| 合计 | **79** | **5** | **净减 74 行** |

删除完整文件 **1 个**，另外修改代码文件 **2 个**，删除目录 **0 个**。审计证据集中维护在本文件；当前状态与会话记录仅链接这里。
