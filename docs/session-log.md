# 会话记录

### 2026-08-23：工作流进度面板显示总任务已运行时间并优化任务列布局

- 完成内容：工作流面板增加总任务已运行时间；活动工作流按当前时间计算，已完成/暂停/取消状态按最后有效时间边界计算。任务耗时移到描述列，配合主列宽度约束，避免窄面板遮挡任务标题。
- 验证：定向运行 `node --test --test-name-pattern='工作流状态使用弹窗|非 TUI 工作流状态|活动工作流状态显示当前已运行时间' test/extension-roles.test.js`，3 项通过；`npm test`，59 项全部通过；`node --check extensions/workflow-report.ts`、`node --check test/extension-roles.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实交互式 Pi TUI 中进行视觉验收。

### 2026-08-22：工作流进度面板显示整体开始时间和已完成任务耗时

- 完成内容：工作流 TUI 进度弹窗和非 TUI 状态文本增加总任务开始时间；已完成任务条目追加基于任务开始/结束时间计算的耗时，历史缺失时间戳时沿用不可用提示。
- 验证：定向运行 `node --test --test-name-pattern='TUI 工作流状态使用弹窗并显示任务进度|非 TUI 工作流状态继续使用通知文本' test/extension-roles.test.js`，2 项通过；`npm test`，58 项全部通过；`node --check extensions/workflow-report.ts`、`node --check test/extension-roles.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实交互式 Pi TUI 中进行视觉验收。

### 2026-08-22：完成 pi-init 启动优化验证

- 完成内容：将控制中心和脚手架运行时改为扩展实例内 Promise 缓存的按需加载；工作流恢复改为使用 branch 的 `findLast`，避免复制和 reverse 整个 session branch；新增对应 dryRun 和最新状态回归测试。
- 基准方法：在 Windows 当前环境使用 fresh `pi.cmd` 进程，交替执行 12 组（共 24 个进程），命令分别为 `pi.cmd --no-session --no-extensions --no-skills --mode rpc` 与 `pi.cmd --no-session --no-extensions --no-skills -e ./extensions/index.ts --mode rpc`，每次输入 `{"id":"commands","type":"get_commands"}`，同时设置 `PI_TIMING=1`。
- 实际结果：无扩展 wall 中位数 808.2 ms，main TOTAL 中位数 58.5 ms，扩展首阶段（llama.cpp factory）9.0 ms；加载 pi-init wall 中位数 824.7 ms，main TOTAL 79.0 ms，`extensions/index.ts` module import 28.5 ms；wall 增量 16.5 ms。此前同机基线为 769.8/795.5 ms、增量 25.7 ms，本次增量改善约 9.2 ms，因此保留按需加载，未回退。
- 验证：`npm test`，58 项全部通过；`node --test test/extension-workflow.test.js`，6 项通过；`node scripts/check-line-count.js` 通过；`git diff --check` 通过，仅有 Windows 下 Git 的 LF/CRLF 转换提示。
- 遗留问题：尚未完成真实交互式 TUI 首屏、正常网络、离线和慢网络场景的分阶段基准；网络刷新仍由 Pi 核心管理。

### 2026-08-20：移除原生 Agent 模型守卫并保留 subtask

- 完成内容：删除 pi-init 对原生 `Agent`/`agent` tool_call 的模型注入、模糊名称回退和注册表校验；保留普通 Agent 的计时生命周期，以及 `workflowExecutor: "subtask"` 的派发、结果协议、状态持久化和旧 `subagents` 兼容。
- 完成内容：同步 README、中英文生成模板和项目记忆，明确原生 Agent 由 Pi 宿主选择模型，subtask 仍由 pi-init 管理。
- 验证：`node --test test/extension-roles.test.js test/extension-lifecycle.test.js` 14 项通过；`node scripts/check-line-count.js` 通过；`git diff --check` 通过（仅 Windows 换行转换警告）。
- 遗留问题：完整 `npm test` 和本次变更的提交/推送尚未执行。

### 2026-08-20：Agent 模糊模型名继承当前会话模型

- 完成内容：Agent 工具调用现在将未带 `/` 的非空模型名（如 `haiku`、`sonnet`）改为当前会话完整 `provider/model`，并发送提示；完整 `provider/model` 仍要求注册表精确匹配，不存在时阻止。
- 完成内容：更新 README、中英文生成模板和项目记忆，明确 Explore 等 Agent 预设的继承行为和跨 Provider 边界。
- 验证：`node --test test/extension-roles.test.js` 8 项通过；`npm test` 57 项全部通过；`node scripts/check-line-count.js` 通过；`git diff --check` 通过（仅 Windows 换行转换警告）。
- 遗留问题：尚未提交或推送本次模型继承变更。

### 2026-08-20：完成代码拆分、物理行数门禁和最终验证

- 完成内容：将 2389 行单体测试拆为职责测试文件和共享 harness；将 `src/workflow.js`、`extensions/index.ts` 与 `scripts/pi-usage.js` 拆为职责模块，同时保留三个公共 facade。pi-usage 安装器会携带 `scripts/pi-usage/` 支持文件，Windows/POSIX 启动行为保持不变。
- 完成内容：新增 `scripts/check-line-count.js` 和 `test/line-count.test.js`，递归检查指定 JavaScript/TypeScript 扩展名，排除 `.git`/`node_modules`，并由 `npm test` 在 Node 测试前执行 500 行门禁。测试覆盖 LF、CRLF、CR、无末尾换行，以及 500/501 行边界和 CLI 违规报告。
- 验证：`node scripts/check-line-count.js` 通过；`npm test` 57 项全部通过；`node --test test/line-count.test.js` 3 项全部通过；`node --check scripts/check-line-count.js && node --check test/line-count.test.js` 通过；`npm pack --dry-run` 通过；`git diff --check` 通过（仅 Windows 换行转换警告）。
- 遗留问题：真实 Pi 模型连续工作流、subtask fork 生命周期、reload 后人工恢复以及 Linux/macOS 本地验证仍未执行；未提交或推送。

### 2026-08-20：接入活动工作流方向变更和 revision 重规划

- 完成内容：普通 `interactive`/`rpc` 自然语言输入在活动工作流中记录 `revisionId` 和用户方向；当前任务完成或 subtask 结果回传后进入重规划边界，不启动旧计划的下一个任务。架构师通过 `task_workflow(action="replan")` 提交新计划后才恢复调度。
- 完成内容：补充 local、subtask、reload 以及 manual/confirm 角色边界测试；subtask fork 不由 pi-init 自动终止或重新派发，立即停止仍使用既有 cancel 流程。README、双语生成模板和项目决策/状态文档已同步。
- 验证：`npm test`，53 项全部通过；`node --check test/scaffold.test.js` 通过；`git diff --check` 通过（仅 Windows 换行转换警告）。
- 遗留问题：真实 Pi 模型连续工作流、subtask fork 生命周期和 reload 后人工恢复仍未端到端演练。

### 2026-08-19：`subagents` 执行器替换为 pi-subtask 对话 fork

- 完成内容：`workflowExecutor` 可选值改为 `subtask`（`gary149/pi-subtask` 对话 fork），旧值 `subagents` 自动映射兼容；删除 `@tintinweb/pi-subagents` 的 `pi.events` RPC 通道（spawn/stop/completed/failed）、request 序列与绑定清理、`WORKFLOW_SUBAGENT_TYPES`。
- 完成内容：模型驱动接入——主会话调用 `subtask` 工具派发（`pi-init-subtask-dispatch` custom 消息，`display:false`），fork 结果经 `subtask-result` custom 消息回传；`src/subtask.js` 提供 `pi-init/task-result@1` 严格解析（剥 markdown 围栏、complete 需非空验证、blocked 需原因）；`scheduleWorkflow` 改为派发/消费两分支，`details.task` 与派发提示词逐字相等才归属。
- 完成内容：删除 `.pi/agents/*.md` 代理脚手架（scaffold TEMPLATE_FILES 与 `templates/agents/`），fork 复用主会话角色与工具；派发前探测 `pi.getActiveTools()`，缺少 `subtask` 工具安全阻塞；取消/阻塞不再发送 stop RPC。
- 完成内容：同步中英文模板、README、决策/当前状态/陷阱/会话记录；版本号保持 `1.1.0`。
- 验证：`node --check extensions/index.ts`、`node --check src/subtask.js`、`node --check src/workflow.js`、`node --check src/roles.js`、`node --check src/scaffold.js`、`git diff --check` 通过；`npm test` 全部通过。
- 遗留问题：真实 pi-subtask 模型驱动连续任务、fork 生命周期和 reload 后人工恢复尚未演练；未提交或推送。

### 2026-08-18：将工作流进度查看改为 TUI 弹窗

- 完成内容：`/pi-init workflow status` 以及控制中心的“查看任务进度”在 TUI 中改为居中 overlay 弹窗，使用主题背景色、标题高亮和四边框明确区分弹窗，显示状态、进度、执行器、规划、暂停原因和可滚动任务列表；RPC 等非 TUI 模式继续使用原有通知文本。
- 完成内容：增加 TUI 弹窗和非 TUI 回退测试，覆盖 overlay 配置、四边框和任务状态展示。
- 验证：`npm test`，46 项全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实交互式 Pi TUI 中进行视觉验收。

### 2026-08-16：以精确模型引用替代 fail-closed Provider 白名单，升级版本

- 完成内容：确认历史“模型随意切换”根因为 Agent 子代理模糊模型名（`haiku`/`sonnet`）、agent 类型默认模型解析和宿主跨 Provider fallback，主会话无自动 fallback；据此移除 `providerPolicy` 整套机制。
- 完成内容：`src/roles.js` 删除 `resolveProviderPolicy`/`isProviderAllowed`/`isModelAllowed`/`assertProviderAllowed`/`assertModelAllowed`，`resolveRoleConfig` 不再输出 `providerPolicy`；扩展删除 `enforceProviderPolicy`/`restoreAllowedModel`/`configuredFallbackModel` 和 `model_select` 回滚、输入/provider 请求前守卫，manual 写回不再联动 allowlist。
- 完成内容：Agent spawn 保留精确引用纪律（省略注入完整 `provider/model`、模糊名称拒绝、注册表精确存在校验，全模式统一）；`/pi-init config` 候选列表展示全部已注册模型；修复 `model_select` 后状态栏不刷新——现在所有模式、所有路径（含 manual 写回被跳过的情况）统一刷新底部状态。
- 完成内容：同步中英文模板、README、决策/当前状态文档；版本从 `1.0.8` 升级到 `1.1.0`。
- 验证：`npm test`，44 项全部通过（覆盖无回滚、写回、spawn 纪律、全量候选和 roles 单元语义）；`git diff --check` 通过。
- 遗留问题：完全限定的跨 Provider 引用不再被拦截；未在真实 Pi TUI 中端到端演练。

### 2026-08-16：手动模式直连宿主并写回配置，升级版本

- 完成内容：澄清 README 中 fail-closed Provider 策略的歧义表述（配置修改途径分条列出，fallback 与临时解锁单独成段）。
- 完成内容：`mode: "manual"` 语义升级为直连宿主：`enforceProviderPolicy` 在 manual 下直接放行（覆盖 `session_start`、输入、provider 请求前守卫），Agent `tool_call` 门禁不再注入继承模型；`model_select` 在 manual 下改走 `writeBackManualModelSelection`，把活动角色的模型写回 `.pi/role-models.json` 并按需追加 Provider 允许列表，同值切换幂等跳过，无活动角色或非受信任项目仅提示。
- 完成内容：新增测试覆盖守卫旁路、写回（含允许列表扩展）、幂等、无活动角色提示和 Agent 门禁放行；同步中英文 `AGENTS.md`/`SKILL.md` 模板、README 模式说明和 Provider 锁定章节、根 `AGENTS.md`。
- 完成内容：版本从 `1.0.7` 升级到 `1.0.8`。
- 验证：`npm test`，44 项全部通过（含 2 项新增）；`git diff --check` 通过。
- 遗留问题：未在真实 Pi TUI 会话中端到端演练 manual 写回；`/pi-init config` 选择列表仍按允许列表过滤，manual 下暂不放开。

### 2026-08-15：报告时间改为系统本地时区

- 完成内容：报告时间从固定 UTC+8 改为使用运行 Pi 的系统本地时区，并显示数值时区偏移；持久化 Unix 时间戳保持不变。
- 验证：`npm test`，42 项全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。

### 2026-08-15：精简工作流报告并改用东八区时间

- 完成内容：精简任务和最终工作流报告，移除重复的文件列表、内部角色 ID、冻结时间和冗余分段，保留交付摘要、时间、耗时与验证信息。
- 完成内容：开始/结束时间改为 `YYYY-MM-DD HH:mm:ss+08:00`，持久化时间戳保持不变；普通执行时间报告同步使用该格式。
- 验证：`npm test`，42 项全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实长上下文模型会话中进行端到端演练。

### 2026-08-15：避免角色切换重复触发已完成的自动压缩

- 完成内容：定位 `Already compacted` 为 Pi 内置自动压缩与角色切换定制压缩在 `agent_settled` 边界重复执行；扩展现在检测 branch 尾部的 `compaction` entry 后直接续跑。
- 完成内容：增加角色切换回归测试，确认不会再次调用 `ctx.compact()` 或显示该警告。
- 验证：`npm test`，42 项全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：未在真实长上下文模型会话中进行端到端演练。

### 2026-08-15：增加项目级 Provider fail-closed 锁并升级版本

- 完成内容：新增默认只允许 `openai-codex` 的 `providerPolicy`；旧项目缺少策略字段时同样锁定。角色、模型选择/循环、会话恢复、工作流和 Agent 子代理共用策略，省略 Agent model 继承当前模型，`haiku`/`sonnet` 和 OpenRouter 参数在 spawn 前拒绝。
- 完成内容：针对当前 Pi 0.84 的通知型 `model_select` 增加 awaited 安全模型恢复，并在 `session_start`、输入、provider 请求前增加 fail-closed 守卫；同步中英文模板、README、决策、踩坑和当前状态文档。
- 完成内容：版本从 `1.0.6` 升级到 `1.0.7`，同步 `package-lock.json`。
- 验证：`npm test`，41 项全部通过。
- 验证：`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、`node --check src/roles.js`、package/package-lock 版本一致性检查和 `git diff --check` 通过；Git 仅提示 Windows 下的 LF/CRLF 转换警告。
- 验证：使用 `node --input-type=module` 实例化最小 ExtensionAPI harness，`init-project.ts` RPC 扩展加载成功。
- 遗留问题：Pi 核心尚未提供可取消的 `before_model_select`；当前实现依赖切换后立即回滚和请求前守卫，未来可接入核心事件进一步前移拦截。

### 2026-08-15：修复 npm lifecycle 中 pi-usage 安装目标错误并升级版本

- 完成内容：修复 `postinstall` 在 `pi update --extensions` 中误选当前包 `node_modules/.bin/pi.cmd` 的问题；安装器现在跳过该本地 shim，选择 PATH 中后续的实际 Pi CLI 目录。
- 完成内容：增加 npm lifecycle PATH 优先级回归测试，版本从 `1.0.5` 升级到 `1.0.6`，同步 `package-lock.json`。
- 验证：`node --test --test-name-pattern='本地 pi shim|自动刷新 pi-usage' test/scaffold.test.js`，2 项通过。
- 验证：`node --check scripts/install-launchers.js`、`node --check test/scaffold.test.js` 通过。
- 验证：手动执行安装器后，`%APPDATA%\\npm\\pi-usage.js` 的嵌入版本更新为 `1.0.6`，执行 `pi-usage 2026-08-15` 输出 `v1.0.6`。
- 验证：`npm test`，37 项全部通过。
- 验证：`node --check scripts/install-launchers.js`、`node --check test/scaffold.test.js`、`git diff --check` 通过，仅有 Git 的 LF/CRLF 环境警告。
- 遗留问题：无。

### 2026-08-15：角色配置改为会话暂存并升级版本

- 完成内容：运行时角色切换、角色模型配置和工作流配置改为当前会话草稿；`/pi-init config` 不再直接写 `.pi/role-models.json`，新增 `/pi-init save` 作为显式保存入口。
- 完成内容：更新控制中心、命令补全、中文/英文 README、AGENTS 和 Skill 模板；版本从 `1.0.4` 升级到 `1.0.5`，同步 `package-lock.json`。
- 完成内容：增加回归测试，验证配置保存前文件不变、显式保存后才更新。
- 验证：`npm test`，36 项全部通过；命令输出显示 `pi-init@1.0.5`。
- 验证：`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、`node --check scripts/pi-usage.js`、`node --check scripts/install-launchers.js` 通过。
- 验证：`git diff --check` 通过，仅有 Git 将 LF 转换为 CRLF 的环境警告。
- 遗留问题：无。

### 2026-08-15：同步 pi-init 与 pi-usage 版本并显示版本号

- 完成内容：`pi-usage` 以 `package.json` 的 `version` 作为仓库运行时版本来源，报告标题追加 `v<version>`；安装器复制脚本时将同一版本嵌入独立启动器，避免脱离 package 目录后版本丢失。
- 完成内容：增加版本一致性、报告输出和安装器嵌入版本的回归测试。
- 验证：`node --test --test-name-pattern='pi-init 与 pi-usage 共用版本|Pi package 更新时自动刷新' test/scaffold.test.js`，2 项通过。
- 验证：`node --check scripts/pi-usage.js`、`node --check scripts/install-launchers.js`、`node --check test/scaffold.test.js` 通过。
- 验证：`npm test`，35 项全部通过。
- 验证：`git diff --check` 通过。
- 遗留问题：无。

### 2026-08-15：完成 pi-usage JSONL 导入 I/O 优化

- 完成内容：将 usage/activity/speed 事件改为 DuckDB Appender 批量写入；每文件的删除、写入和 checkpoint 更新使用事务；speed schema 回填使用单个全量重建事务。
- 完成内容：将 JSONL 解析改为字节流读取，`session_files` 保存 offset、下一行号、cwd、尾部校验和 EOF 不完整状态；追加只处理新字节，截断、改写或校验失败全量回退；duration summary 只刷新受影响日期。
- 完成内容：增加可选刷新进度回调和 TTY 摘要；README 补充追加 checkpoint、回退和自动/手动刷新进度说明；增加不完整尾部、补全、同尺寸改写和无变化刷新测试。
- 验证：`npm test`，34 项全部通过。
- 验证：`node --test --test-name-pattern='流式 checkpoint'`，目标测试通过。
- 验证：本机 112 个 session 文件实际进度检查，首次 `filesRebuilt=112`、`bytesRead=215607665`，独立计时约 2.3 秒；第二次 `filesSkipped=112`、`filesChanged=0`、`durationDates=[]`，独立计时约 65 ms。
- 验证：`git diff --check` 通过，仅有 Git 将 LF 转换为 CRLF 的环境警告。
- 遗留问题：尚未在真实 TTY 终端观察进度文本，也未在 Linux/macOS 上执行；变更文件的全量回退仍需读取该文件全部内容，这是正确性优先的边界。

### 2026-08-14：将最终摘要改为整体工作总结与复盘

- 完成内容：最终报告保留冻结规划作为“工作流目标”，新增“整体工作总结”“工作复盘”“汇总验证”；总结和验证按任务顺序从持久化状态确定性汇总，复盘使用已有冻结时间、整体实际执行区间和总耗时，不增加模型调用。更新 local/subagents 共用报告的 TUI 样式和回归测试。
- 验证：`npm test`，33 项通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：真实模型连续多任务、subagents 生命周期和交互式 TUI 视觉验收仍未执行。

### 2026-08-14：增加冻结工作流整体完成报告

- 完成内容：持久化工作流级实际开始/完成时间；最终 `task_workflow` 报告使用冻结的 `state.plan.summary`，汇总全部任务和验证结果，并展示从首个任务实际开始到最后任务完成的整体耗时。中间任务仍使用任务级报告，local 与 `subagents` 完成路径统一格式和醒目 TUI 样式。
- 验证：`npm test`，33 项通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：真实模型连续多任务、subagents 生命周期和交互式 TUI 视觉验收仍未执行。

### 2026-08-14：修复 task_workflow 完成报告显示

- 完成内容：修复 `task_workflow complete` 的 `renderResult`，不再让工作流进度摘要覆盖完整任务完成报告；现在会显示任务摘要、开始时间、结束时间、总耗时和验证结果。
- 验证：`npm test`，33 项通过；`node --check extensions/init-project.ts`；`node --check test/scaffold.test.js`；`git diff --check` 均通过。
- 遗留问题：真实交互式 TUI 视觉验收仍未执行。

### 2026-08-14：增加非工作流 Agent 执行时间报告

- 完成内容：新增普通执行计时模型和扩展生命周期接入；`interactive`/`rpc` 输入从首次 `agent_start` 计时到最终 `agent_settled`，完成后写入 `pi-init-run-timing` custom entry，并在 TUI 展示来源、开始/结束时间、总耗时和不等同于任务完成的计时口径。活动工作流、扩展隐藏续跑、subagents 和中断路径不会重复或伪造普通报告。
- 完成内容：新增核心边界、扩展 harness、custom entry renderer 和工作流计时回归测试。
- 验证：`npm test`，32 项通过；`node --check test/scaffold.test.js`；`git diff --check` 均通过。
- 遗留问题：尚未在真实交互式 TUI 和真实模型连续工作流中进行端到端视觉/生命周期演练。

### 2026-08-14：修正任务完成报告的开始时间

- 完成内容：不再在工作流预调度阶段写入任务开始时间；本地任务在 `agent_start` 生命周期记录实际模型执行开始时间，子代理任务在发起执行前记录开始时间，并用持久化标记避免提醒回合重复刷新。旧状态的过时时间会在首次实际派发时刷新。
- 验证：`npm test`，29 项通过；`node --check src/workflow.js`、`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 均通过。
- 遗留问题：真实模型连续任务仍未演练。

### 2026-08-14：修复工作流终态后的底部状态显示

- 完成内容：工作流完成或取消后，底部 `pi-init` 状态改为显示初始的策略、执行器和无活动工作流摘要；保留控制中心和状态命令中的终态数据。
- 验证：`npm test`，29 项通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、扩展 RPC 加载和命令发现、`git diff --check` 均通过。
- 遗留问题：尚未在真实交互式 TUI 中观察完成后状态栏的视觉效果。

### 2026-08-14：补充 read/edit 工具调用约束

- 完成内容：在项目及中英文生成模板的 `AGENTS.md` 中增加 `read`/`edit` 参数边界、编辑前重读、精确复制 `oldText` 和匹配失败后重新读取规则。
- 验证：检查相关文件 diff；未运行代码测试，因为本次仅修改协作规则文档。
- 遗留问题：无。

### 2026-08-14：增加任务完成时间和结构化完成报告

- 完成内容：工作流任务进入 `in_progress` 时记录开始时间，完成时记录结束时间；新增任务耗时计算，旧状态缺少开始时间时保持兼容并报告不可用。
- 完成内容：本地 `task_workflow complete` 和 subagents 完成事件统一输出任务完成报告，包含任务 ID、任务内容、角色、涉及文件、开始/结束时间、总耗时、完成摘要和验证结果；同步中英文生成模板及 README 说明。
- 验证：`node --test --test-concurrency=1 test/scaffold.test.js`，29 项通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、扩展 RPC 加载和命令发现、`git diff --check` 均通过。
- 遗留问题：真实 subagents 模型驱动完成报告端到端演练仍未执行；未提交或推送。

### 2026-08-14：完成 pi-subagents 工作流集成和受限脚手架

- 完成内容：新增默认 `local`、可选 `subagents` 的工作流执行器；通过 `pi.events` RPC 顺序委派并持久化 request/agent 绑定，严格验证 `pi-init/task-result@1`，对 RPC/扩展/结果错误安全阻塞，取消/阻塞发送 stop 请求，reload 不自动重生已绑定代理。
- 完成内容：脚手架生成 `.pi/agents/pi-init-developer-test.md` 与 `.pi/agents/pi-init-docs-commit.md`，仅开放 read/bash/edit/write，关闭 extensions、skills 和嵌套子代理；中英文 AGENTS/Skill 与 README 已记录安装前提、共享工作区、状态所有权、结果协议和孤儿代理边界。
- 验证：`npm test`，29 项通过；`node --check src/scaffold.js`、`node --check test/scaffold.test.js` 通过；`node --test --test-concurrency=1 test/scaffold.test.js`，29 项通过；扩展 RPC 加载和命令发现检查成功；`git diff --check` 通过，仅有预期的 CRLF 转换警告。
- 遗留问题：尚未使用真实 `@tintinweb/pi-subagents` 运行模型驱动的连续任务、生命周期事件和 reload 后人工恢复演练；未提交或推送。

### 2026-08-14：修复工作流运行时版本错误并外显工作流状态

- 完成内容：定位 `(0, _roles.shouldOrchestrateWorkflow) is not a function` 为 Pi package 更新/reload 后扩展与相邻 `src/roles.js` 版本不一致；增加运行时诊断、升级到 `1.0.4`，并在 README 记录 `pi update --extensions`、`/reload` 和本地重启步骤。
- 完成内容：将工作流策略配置移出“变更 · 角色与模型”子菜单，增加控制中心顶层入口；主 `pi-init` 状态项和控制中心摘要显示工作流策略及活动工作流进度。
- 验证：`npm test`，24 项通过；`node --check src/roles.js`、`node --check src/workflow.js`、`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、`git diff --check` 通过；RPC 扩展加载和命令发现成功。
- 遗留问题：尚未在真实交互式 TUI 中截图验收；当前项目配置 `.pi/role-models.json` 的 `workflowMode` 仍为用户手动改成的 `off`，未覆盖。

### 2026-08-12：移除 pi-fast 和 pi-update

- 完成内容：删除 `pi-fast`、`pi-update` 的 Windows/POSIX 脚本，移除安装器复制逻辑，并清理 README、当前状态和测试引用。
- 验证：`bash -n scripts/*.sh`、`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js`、`git diff --check` 通过；`npm test` 26/27 通过，现有 Windows Pi CLI 启动测试偶发失败。
- 遗留问题：无。

### 2026-08-14：提高 pi-usage 柱状图对接近数值的辨识度

- 完成内容：模型 token 柱状图从整格四舍五入改为支持 Unicode 八分之一分数块；接近但不同的 token 数会显示不同的柱长，保留数字标签和最大值满格行为。
- 完成内容：增加回归测试，覆盖 100 与 99 token 不再渲染为相同柱状图。
- 验证：`node --test --test-name-pattern='柱状图使用分数块' test/scaffold.test.js` 通过；`node --check scripts/pi-usage.js`、`git diff --check` 和 `npm test`（25 项通过）通过。
- 遗留问题：未提交或推送。

### 2026-08-14：pi-usage 随 Pi package 更新自动重装启动器

- 完成内容：新增跨平台 `scripts/install-launchers.js`，并配置 package `postinstall`；`pi update --extensions` 触发 npm 安装流程时，会根据当前平台重新复制 `pi-usage` 启动器和脚本。
- 完成内容：找不到 `pi` 或 npm 禁用 lifecycle scripts 时不阻断 package 更新；补充 README 和安装回归测试。
- 验证：`node --check scripts/install-launchers.js`、`node --check scripts/pi-usage.js`、`git diff --check` 和 `npm test`（26 项通过）通过。
- 遗留问题：尚未提交或推送。

本文件按时间追加每次工作的完成内容、实际验证和遗留问题，不记录敏感信息或未经验证的结果。

### 2026-08-14：增加 task_workflow 全局开关

- 完成内容：新增顶层 `workflowEnabled` 配置，默认关闭；`/pi-init config workflow` 可持久启用或关闭，`task_workflow(action=plan)` 关闭时拒绝，既有工作流收尾操作不受影响。
- 完成内容：同步中英文 `AGENTS.md`、Skill、README、当前项目配置和设计决策，明确启用前提及直接编辑 `.pi/role-models.json` 的路径。
- 验证：`npm test`，24 项测试全部通过；`node --check extensions/init-project.ts`、`git diff --check` 和 RPC 扩展命令发现检查通过。
- 遗留问题：尚未在真实交互式 TUI 中演练开关菜单；该设计随后由下方 off/on/auto 策略取代。

### 2026-08-14：任务工作流升级为 off/on/auto 策略

- 完成内容：将规范配置字段升级为默认 `workflowMode: "auto"`，配置中心支持 `off`、`on`、`auto`；`auto` 对不超过 2 个任务跳过工作流状态、调度和角色切换，`on` 保留完整编排，`off` 继续拒绝新规划。
- 完成内容：保留旧 `workflowEnabled` 的读取兼容，并同步当前项目配置、双语 AGENTS/Skill 模板、README、当前状态和设计决策。
- 验证：`npm test`，24 项测试全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js`、`git diff --check` 通过；RPC 扩展加载和命令发现成功。
- 遗留问题：真实模型连续多任务端到端演练和真实交互式 TUI 菜单演练仍未执行；未提交或推送。

### 2026-08-14：移除自研 parallel_develop

- 完成内容：删除 `parallel_develop` 运行时工具及 `src/parallel.js`、`src/parallel-runner.js`；清理 README、模板、项目 Skill、AGENTS.md 和测试中的自研并行开发说明、导入、fixture 与契约断言。保留 `task_workflow`、`switch_role`、角色模型配置和脚手架生成。
- 验证：`npm test`，24 项测试全部通过；`node --check test/scaffold.test.js` 通过；退休实现引用扫描无结果；`git diff --check` 通过，仅有预期的 CRLF 转换警告。
- 遗留问题：未配置第三方并行开发替代品；`task_workflow` 真实模型连续多任务端到端演练仍未执行；未提交或推送。

## 记录格式

每次记录应包含日期、完成内容、实际执行的验证及遗留问题。

## 会话

### 2026-08-14：增加架构拆分和自动连续任务工作流

- 完成内容：新增 `src/workflow.js` 状态机，支持架构计划、任务依赖、角色、文件范围、验收标准、完成、阻塞、审阅暂停、恢复、重试、取消和未完成提醒。
- 完成内容：扩展新增 `task_workflow` 工具、工作流状态栏、session custom entry 恢复、自动角色切换和隐藏续跑消息；架构审阅仅由初始 `reviewRequired` 明确触发，默认自动进入下一个任务。
- 完成内容：中英文 `AGENTS.md` 和项目 Skill 模板补充连续流水线、任务拆分、暂停条件和 `task_workflow` 使用规则。
- 验证：`node --check src/workflow.js`、`node --check extensions/init-project.ts`、`node --test --test-concurrency=1`，34 项通过；`git diff --check` 通过；RPC 扩展命令发现和加载检查成功。
- 遗留问题：真实模型驱动的连续多任务端到端演练尚未执行；尚未提交或推送。
### 2026-08-13：修复 pi-usage TPS schema 升级导致更新变慢

- 完成内容：schema 从旧版本升级时只扫描 session JSONL 中的 `pi-token-speed` 样本并回填 `speed_events`，不再强制删除和重导全部 `usage_events`、`activity_events`。
- 完成内容：增加回归测试，确认迁移会保留已有 usage 数据并恢复平均 TPS；修正当前状态、设计决策和踩坑记录。
- 验证：89 个 session、约 161 MB 数据的旧库迁移基准从约 60 秒降至约 2.2 秒；`npm test` 29 项通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js`、`git diff --check` 通过；实际 `node scripts/pi-usage.js --update` 成功。
- 遗留问题：未提交或推送。

### 2026-08-13：展示按模型统计的平均 token 速度

- 后续修正：发现 `done` assistant stream event 发生在扩展的 `message_end` 之前，而 Pi 会在 `message_end` 后才持久化最终消息；改为在 assistant `message_start` 开始计时、`message_end` 使用最终 provider usage 立即写样本，`agent_end` 仅作兼容兜底并防重复。
- 后续修正：为 TypeScript 扩展内部导入补充 `.ts` 扩展名和 `allowImportingTsExtensions`，确保 Pi 运行时与 `tsc` 的模块解析一致。

- 完成内容：`pi-token-speed` 在 assistant `message_end` 时写入不进入上下文的 `pi-token-speed` 自定义 session entry，保存 provider/model、provider 输出 token 和排除 prompt-processing tool 时间后的有效生成时长；避免 `message_update` 的 done/error 与 `agent_end` 重复记录。
- 完成内容：`pi-usage` 新增 `speed_events` DuckDB 表和 schema 版本迁移，按模型显示加权 `Avg TPS`，Total 行也显示整体加权速度；无历史采样的模型显示 `--`。
- 完成内容：补充 `pi-token-speed` 引擎测试和 `pi-usage` 集成测试，更新两个项目 README。
- 验证：`pi-token-speed` 执行 `npm test`，4 项通过；`npx tsc -p tsconfig.json --pretty false` 通过；RPC 扩展加载检查通过。
- 验证：`pi-init` 执行 `node --check scripts/pi-usage.js`、`node --test --test-concurrency=1`，28 项通过；并运行 `git diff --check`。
- 遗留问题：`pi-init` 默认并发 `npm test` 的 Windows CLI 启动测试仍有环境相关偶发失败；串行测试通过。未提交或推送。

### 2026-08-10：优化 pi-usage 模型用量展示

- 完成内容：移除 Git changes 的扫描、数据库汇总和报告展示；增加按模型总 token 缩放的 Unicode 柱状图。
- 完成内容：在 Overview 增加缓存占比结果，按 `(Cache R + Cache W) / Total` 计算并显示缓存 token、总 token和百分比；补充 pi-usage 回归断言。
- 验证：`node --test test/scaffold.test.js`，27 项测试全部通过；`node --check scripts/pi-usage.js` 和 `git diff --check` 通过。完整测试在 `npm test` 下偶发 Windows Pi CLI 启动测试失败（26/27），单独重跑该测试通过；`node --test --test-concurrency=1` 全部通过。
- 遗留问题：`npm test` 的 Windows Pi CLI 启动测试仍有环境相关偶发失败；尚未提交或推送。

### 2026-08-06：为生成的 Skill 增加精确字符串替换说明

- 完成内容：中英文 Skill 模板增加类似 Claude Code Edit 的精确 `oldText` → `newText` 替换规则，覆盖唯一匹配、最小上下文、多个非重叠替换和修改后 diff 检查。
- 完成内容：补充中英文脚手架生成测试。
- 验证：`npm test`，23 项测试全部通过；`git diff --check` 通过。
- 遗留问题：尚未提交或推送。

### 2026-08-06：增加跨平台离线启动和扩展更新脚本

- 完成内容：新增 Windows `.cmd`、POSIX `.sh` 启动器，以及 PowerShell/POSIX 安装器；启动和升级分别控制 `PI_OFFLINE`，脚本纳入发布包。
- 完成内容：Windows 安装器将脚本复制到 `pi.cmd` 所在的 npm 可执行目录，修复脚本只存在于未持久 PATH 的用户 bin 导致 PowerShell 无法识别的问题。
- 验证：`npm test`，23 项测试全部通过；`bash -n scripts/*.sh`、`node --check test/scaffold.test.js`、`git diff --check`、`npm pack --dry-run` 通过；PowerShell 下 `pi-fast.cmd --version` 实际返回 `0.84.1`。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-06：恢复会话角色状态以支持跨日压缩

- 完成内容：`session_start`、resume 和 reload 时，根据当前 provider/model 与实际推理强度唯一匹配并恢复角色；重复配置或无法匹配时保持未知。
- 完成内容：补充角色恢复单元测试，避免会话重启后第一次真实跨角色被误判为首次选角。
- 验证：`npm test`，22 项测试全部通过；`node --check src/roles.js`、`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 通过。
- 遗留问题：尚未使用真实模型验证跨日 resume 后的自动压缩续跑。

### 2026-08-06：修复并行 worker 跨平台兼容性

- 完成内容：Windows Node/Bun 备用入口改为通过 `cmd.exe` 安全转义启动 `pi.cmd`；POSIX worker 使用独立进程组，Windows 使用 `taskkill /t /f`，取消和超时均终止整个进程树。
- 完成内容：文件范围校验读取 Git `core.ignorecase`，统一处理 Windows/macOS 默认大小写不敏感文件系统；新增 Ubuntu、macOS、Windows GitHub Actions 测试矩阵。
- 验证：`npm test`，21 项测试全部通过；`node --check src/parallel.js`、`node --check src/parallel-runner.js` 和 `git diff --check` 通过；Windows `.cmd` 备用入口实际启动 Pi CLI 成功。
- 遗留问题：Linux、macOS CI 尚未在本地执行，待 GitHub Actions 验证。

### 2026-08-06：自动角色切换增加上下文压缩

- 完成内容：自动模式下，真实跨角色且切换前上下文使用率达到 50% 时，在当前回合结束后触发一次定制压缩；摘要保留目标、决策、进度、文件、验证结果和下一步，成功后通过隐藏续跑消息自动继续任务。
- 完成内容：确认、手动、首次选角、同角色重复切换和未知上下文不触发额外压缩；压缩失败只提示，不回滚已切换角色。
- 验证：`npm test`，17 项测试全部通过；`node --check src/roles.js`、`node --check test/scaffold.test.js`、`node --check extensions/init-project.ts`、`git diff --check` 和 RPC 扩展命令发现检查通过。
- 遗留问题：尚未使用真实模型端到端验证压缩后的自动续跑流程。

### 2026-08-06：状态卡片增加文字内边距

- 完成内容：状态卡片每行文字左右增加 1 格内边距，避免背景色紧贴文字；保留控制中心整体 2 格 padding。
- 验证：`node --check extensions/init-project.ts`、`npm test`（16 项通过）和 `git diff --check` 通过。
- 遗留问题：尚未在真实交互式终端中进行截图验收。

### 2026-08-06：版本 1.0.3 发布并补充角色关系图

- 完成内容：版本从 `1.0.2` 更新为 `1.0.3`，在 README 增加角色、模型、模式关系 Mermaid 图，并同步使用角色相关用户文案。
- 验证：`npm test` 16 项通过，`git diff --check` 通过。
- 收尾：已提交并推送到 `origin/master`。

### 2026-08-06：控制中心留白和角色文案调整

- 完成内容：使用 Pi 原生 `Box` 和 `Spacer` 为控制中心内容增加标题间距及统一 2 格左右 padding；将用户界面的“职责”文案调整为“角色”，并将主菜单分组改为“变更 · 角色与模型 / 切换角色 / 切换模式”。
- 验证：`node --check extensions/init-project.ts`、`npm test`（16 项通过）、`git diff --check` 和 RPC 扩展加载检查均通过。
- 遗留问题：尚未在真实交互式终端中进行截图验收。

### 2026-08-06：版本 1.0.2 发布

- 完成内容：发布第二轮控制中心 UI 优化，版本从 `1.0.1` 更新为 `1.0.2`。
- 验证：`npm test` 16 项通过，RPC 检查和 `git diff --check` 通过。
- 收尾：已提交并推送到 `origin/master`。

### 2026-08-06：第二轮 TUI 展示优化

- 完成内容：增加控制中心状态卡片、初始化/职责分组标签、图标、首次使用引导、紧凑初始化通知和返回上一级行为；模型列表显示可用推理级别，状态摘要使用当前实际模型并兼容窄终端换行。
- 验证：`npm test`，16 项测试全部通过；`node --check extensions/init-project.ts` 和 `git diff --check` 通过；RPC 命令发现和 `/pi-init mode auto` 执行成功。
- 遗留问题：尚未在真实交互式终端中进行截图验收。

### 2026-08-06：版本 1.0.1 发布准备

- 完成内容：将 `package.json` 版本从 `1.0.0` 更新为 `1.0.1`，同步整理 README 的初始化流程说明。
- 遗留问题：提交已完成，推送待本次会话完成后执行。

### 2026-08-06：记录宿主系统和跨平台命令约定

- 完成内容：`init_project` 生成的中英文 `AGENTS.md` 增加初始化宿主系统、CPU 架构和平台命令约定；Windows 规则覆盖 `where.exe`、`.cmd` shim、`pi.exec` 直接启动进程及安装前复核 CLI。
- 完成内容：补充 README 使用建议，并在当前用户的 `~/.pi/agent/AGENTS.md` 写入 Windows 全局宿主环境规则。
- 验证：`npm test`，14 项测试全部通过；`node --check src/scaffold.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 验证：`printf '{"id":"commands","type":"get_commands"}\\n' | pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc`，扩展加载和命令发现成功。
- 验证：Windows 下 `where.exe agent-browser` 能找到 npm 全局 CLI 及 `.cmd` shim；`cmd.exe` 方式可执行 `agent-browser --version`。当前 `agent-browser` 工具仍提示未安装，说明其检测/执行链与当前 Windows CLI 环境不一致，未在本仓库伪造修复第三方工具。

### 2026-08-04

- 完成内容：修正中文模板中的知识库与 Git 身份表述；统一中英文策略；压缩项目级 Skill；补全本项目上下文；增强双语关键规则测试和工具调用指引。
- 验证：`npm test`，3 项测试全部通过。
- 验证：`pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc` 的命令发现检查通过。
- 验证：`npm pack --dry-run` 成功，发布包预览包含 16 个预期文件。
- 遗留问题：暂无。

### 2026-08-04：智能职责路由与全自动模型切换

- 完成内容：在中英文项目 Skill 中增加架构师、开发测试工程师、文档与提交工程师三类职责；新增 `.pi/role-models.json`、`switch_role` 工具和 `/role` 命令，在职责边界自动切换具体模型与 Pi 推理强度。
- 验证：`npm test`，4 项测试全部通过，覆盖中英文职责、默认映射、项目覆盖和无效配置。
- 验证：TypeScript 5.9.3 以 `strict`、`noEmit` 检查 extension 通过。
- 验证：RPC 依次切换 `architect`、`developer-test`、`docs-commit`，会话状态分别为 `gpt-5.6-sol/max`、`gpt-5.6-terra/high`、`gpt-5.6-luna/medium`。
- 验证：生成临时项目后通过 `pi --no-session --no-extensions --no-skills --skill <path> --mode rpc` 发现 `skill:role-demo`。
- 验证：`npm pack --dry-run` 成功，发布包预览包含 17 个预期文件。
- 遗留问题：暂无。

### 2026-08-06：调整开发测试模型

- 完成内容：将开发测试工程师的默认模型改为 `openai-codex/gpt-5.6-luna`，Pi 推理强度改为 `max`，并同步中英文模板、README、默认配置与测试。
- 验证：`npm test`，4 项测试全部通过。
- 验证：独立检查 `src/roles.js` 与 `.pi/role-models.json`，开发测试映射均为 `openai-codex/gpt-5.6-luna/max`。
- 遗留问题：暂无。

### 2026-08-06：增加并行开发测试编排

- 完成内容：新增 `parallel_develop` 工具；架构规划后可为 2 至 4 个文件范围不重叠的任务创建隔离 Git worktree，使用 `developer-test` 的 Luna/max 模型并发执行，并自动合并补丁。
- 完成内容：同步中英文项目 Skill、README、项目状态与设计决策；新增任务范围校验和测试。
- 验证：`npm test`，5 项测试全部通过。
- 验证：TypeScript 5.9.3 以 `strict`、`noEmit` 检查 extension 通过。
- 验证：`pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc` 的命令发现检查通过。
- 遗留问题：尚未进行真实 LLM 子代理端到端演练；当前已覆盖任务校验、扩展加载和编译检查。

### 2026-08-06：增加职责切换模式

- 完成内容：增加项目级 `mode` 配置和 `/role-mode` 会话命令，支持 `auto`、`confirm`、`manual`；确认模式默认接受自动建议，手动模式要求先执行 `/role`。
- 完成内容：`switch_role` 与 `parallel_develop` 遵守当前模式，避免手动模式下静默覆盖用户选择。
- 验证：`npm test`，5 项测试全部通过。
- 验证：TypeScript 5.9.3 以 `strict`、`noEmit` 检查 extension 通过。
- 验证：RPC 命令发现包含 `role-mode`，手动模式下执行 `/role architect` 后模型为 `gpt-5.6-sol/max`。
- 遗留问题：暂无。

### 2026-08-06：加固并行开发执行链路

- 完成内容：将并行 worktree、子代理执行和补丁合并移至 `src/parallel-runner.js`；改用 Pi 文本输出模式，移除 JSON 事件解析；传递已生效的开发测试模型；未受信任项目拒绝并行执行，子代理使用 `--no-approve`。
- 完成内容：关闭 Git 重命名检测以阻止文件范围绕过；手动职责模式现在会核对当前 provider、model 和 thinking level；删除无用职责模式 Schema。
- 完成内容：并行执行通过状态栏和工具进度显示已启动子代理数量（`x/y`），最终结果也显示总数。
- 验证：`npm test`，7 项测试全部通过，包含两个确定性 worktree/补丁合并测试和重命名范围测试。
- 验证：TypeScript 5.9.3 以 `strict`、`noEmit` 检查 extension 和 runner 通过。
- 验证：`pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc` 的命令发现检查通过。
- 遗留问题：尚未执行真实 LLM 子代理端到端演练。

### 2026-08-06：配置职责模型、初始化选择和运行时持久修改

- 完成内容：初始化和 `init_project` 支持按职责配置 provider、model、thinkingLevel；生成的中英文 Skill 表格与实际 `.pi/role-models.json` 同步。
- 完成内容：新增 `/role-config [role]`，从当前可用模型及其支持的推理强度中选择，写回项目配置并立即应用；Pi 原生 `/model` 与 `Shift+Tab` 保持会话级临时切换。
- 完成内容：并行编排器未返回结果；已检查两个隔离 worktree 的补丁、手动合并并清理 worktree。
- 验证：`npm test`，10 项测试全部通过。
- 验证：`printf '{"id":"commands","type":"get_commands"}\n' | pi --no-session --no-extensions -e ./extensions/init-project.ts --mode rpc`，命令发现包含 `role-config`。
- 验证：尝试执行 TypeScript 检查失败，环境未安装 TypeScript 编译器；未将其记录为通过。
- 遗留问题：真实交互式初始化和 `/role-config` 选择流程尚未端到端演练。

### 2026-08-06：职责模型选择增加搜索过滤

- 完成内容：初始化和 `/role-config` 的职责模型选择增加搜索输入，支持按 provider、model ID 或模型名称过滤后再选择；无匹配时给出提示，不写入配置。
- 完成内容：新增模型过滤单元测试，覆盖大小写、provider、名称、空搜索和无匹配。
- 验证：`npm test`，13 项测试全部通过。
- 验证：`git diff --check` 和 `node --check src/roles.js` 通过。
- 遗留问题：暂无。

### 2026-08-06：统一控制中心和紧凑 TUI

- 完成内容：将用户命令统一为 `/pi-init`，提供控制中心、快速/高级初始化、职责与模型配置、职责切换和会话模式切换；删除四个旧的独立命令注册。
- 完成内容：快速初始化从 `package.json`、锁文件和目录名推断项目元数据；当前项目生成成功后自动调用 `ctx.reload()`；状态栏改为模式、职责、模型和推理强度的紧凑摘要。
- 完成内容：TUI 菜单使用 Pi 原生边框、选择列表和主题；模型配置增加即时搜索列表；初始化、职责切换和并行开发工具增加紧凑的自定义结果渲染；将 `@earendil-works/pi-tui` 声明为运行时 peer dependency。
- 验证：`npm test`，16 项测试全部通过；`node --check extensions/init-project.ts`、`node --check src/roles.js`、`git diff --check` 和 `npm pack --dry-run` 通过。
- 验证：RPC 扩展加载和命令发现成功，仅发现 `pi-init`（另有环境中的 `llama` 扩展）；`/pi-init mode auto` 执行成功。
- 验证：Windows 临时项目 RPC 流程执行 `/pi-init init .`，自动确认后生成 `AGENTS.md`，项目元数据和测试命令推断成功；Pi 子进程在自动 reload 后正常退出，验证脚本删除临时工作目录时遇到 Windows `EBUSY` 文件锁。
- 遗留问题：尚未在真实交互式终端中进行视觉截图验收；当前环境未安装 `tsc`，未执行独立 TypeScript 类型检查。

### 2026-08-06：并行子代理性能和传输错误处理优化

- 完成内容：默认并发从任务数上限调整为 2，超过并发数的任务排队；高频模型进度更新按 250ms 节流。
- 完成内容：修正终态 worker 耗时统计，增加每个 worker 及准备、worker、合并阶段的耗时、turn/token/cache/cost/自动重试指标。
- 完成内容：识别子代理 JSON 中 `stopReason: error`，将 `terminated` 等传输错误交给已有基础设施重试链路，避免退出码为 0 时误判为成功。
- 验证：`npm test`，15 项测试全部通过。
- 验证：`node --check src/parallel-runner.js`、`node --check src/parallel.js` 和 `git diff --check` 通过。
- 验证：RPC 命令发现成功，`parallel_develop` 扩展加载正常。
- 遗留问题：尚未进行真实 LLM 子代理端到端 A/B 性能测试；传输协议仍由 Pi 全局设置控制。

### 2026-08-06：并行子代理实时可观察性和故障接管

- 完成内容：worker 改用 Pi JSON 事件流，实时上报模型输出、工具调用、任务状态、耗时和心跳；主界面状态栏显示完成/运行/失败任务及当前活动。
- 完成内容：基础设施错误自动重试一次；代码或测试错误不盲目重试，失败时提示主开发测试工程师接管；失败 worktree、prompt 和 stdout/stderr 日志保留。
- 验证：`node --check src/parallel-runner.js` 通过。
- 验证：`npm test`，12 项测试全部通过，包含 JSON 事件解析、实时事件、心跳、自动重试和失败现场保留测试。
- 验证：RPC 命令发现仍包含 `role-config`，扩展加载成功。
- 遗留问题：尚未进行真实 LLM 子代理端到端演练。

### 2026-08-09：增加 pi-usage 日用量统计命令

- 完成内容：新增跨平台 `pi-usage` 启动器和 Node.js 汇总脚本，支持默认当天或指定 `YYYY-MM-DD`，按模型统计调用次数、input/output/cache token、总 token 和费用；摘要调用单列为 `Tools/summaries`。
- 完成内容：更新 Windows/POSIX 安装器、README 和相关测试。
- 验证：`npm test`，24 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js`、`bash -n scripts/*.sh`、`git diff --check` 和 `npm pack --dry-run` 通过；脚本实际读取当前 session JSONL 并输出汇总。
- 遗留问题：尚未提交或推送。

### 2026-08-09：将 pi-usage 改为 DuckDB 统计并加入 Git 变化

- 完成内容：引入 `@duckdb/node-api`，将 JSONL usage 导入 `~/.pi/agent/pi-usage.duckdb`；缺少依赖时自动安装用户目录运行时。
- 完成内容：按 session `cwd` 关联 Git 仓库，增加当天 commit 变化和当前已跟踪未提交变化统计；README、安装说明和测试同步更新。
- 验证：`npm test`，24 项测试全部通过；`node --check scripts/pi-usage.js`、`bash -n scripts/*.sh`、`git diff --check` 通过；实际运行 DuckDB 汇总、临时目录自动安装 DuckDB fallback 均通过。
- 遗留问题：尚未提交或推送。

### 2026-08-09：优化 pi-usage 终端输出

- 完成内容：重排标题、模型统计和 Git 变化分区，改为左对齐名称、右对齐数值，缩短表头和仓库路径，去除重复列和行尾空格。
- 验证：`npm test`，24 项测试全部通过；`node --check scripts/pi-usage.js`、`git diff --check` 通过。
- 遗留问题：尚未提交或推送。

### 2026-08-09：增加颜色和使用时长统计

- 完成内容：交互终端增加 ANSI 标题/分区颜色，支持 `NO_COLOR=1`；新增活跃时长、模型等待时长和 session 跨度，并写入 DuckDB 的 `duration_summaries`。
- 完成内容：命令执行期间在交互终端显示扫描、DuckDB 和 Git 统计进度；补充等待原因说明和颜色/时长测试。
- 验证：`npm test`，24 项测试全部通过；`node --check scripts/pi-usage.js`、ANSI 输出检查和 `git diff --check` 通过。
- 遗留问题：尚未提交或推送。

### 2026-08-09：改为数据库查询并支持 session 增量更新

- 完成内容：默认 `pi-usage` 只查询 DuckDB，新增 `--update` 扫描 JSONL；通过 `session_files` 的大小和修改时间跳过未变化文件，变化或删除的 session 会同步更新/清理 usage 和 activity 数据。
- 完成内容：新增 `activity_events` 持久化，为增量更新后的时长计算提供完整事件来源；无数据时提示执行 `pi-usage --update`。
- 验证：`npm test`，24 项测试全部通过；覆盖数据库缓存查询、颜色、时长、增量导入、`node --check scripts/pi-usage.js` 和 `git diff --check`。
- 遗留问题：尚未提交或推送。

### 2026-08-09：修复角色切换与上下文压缩的生命周期竞争

- 完成内容：定位 `turn_end` 中调用 `ctx.compact()` 会 abort 仍处于活动状态的 agent run，导致会话先记录 `This operation was aborted`；将待处理角色压缩改为在 `agent_settled` 事件启动。
- 完成内容：补充回归测试，确保角色切换压缩监听 `agent_settled` 而不是 `turn_end`；同步更新踩坑、当前状态和设计决策文档。
- 验证：`npm test`，25 项测试全部通过；`node --check extensions/init-project.ts`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：真实模型端到端角色切换压缩续跑尚未演练；本次改动尚未提交或推送。

### 2026-08-09：统一 pi-usage 表格和颜色输出

- 完成内容：将 Overview、Models、Time 和 Git changes 的数据统一为对齐表格；交互终端为表头、分隔线和 Total 行增加 ANSI 颜色，非 TTY 与 `NO_COLOR=1` 保持纯文本。
- 完成内容：补充表格布局和颜色回归断言，并修正 README 中角色压缩触发时机的过期描述。
- 验证：`npm test`，25 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-09：初始化模板内置 Clean Code 规则

- 完成内容：新增 `templates/docs/clean-code.md` 和英文模板副本，生成项目时输出 `docs/clean-code.md`；中英文 `AGENTS.md` 均要求任务开始时优先读取该规则文件。
- 完成内容：保留来源 URL、版权和 MIT 许可说明，并补充初始化产物、测试和设计决策文档。
- 验证：`npm test`，25 项测试全部通过；`node --check src/scaffold.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-09：补充 pi-usage 表格边框

- 完成内容：为 Overview、Models、Time 和 Git changes 四个数据表增加完整的 Unicode 外框、列分隔线和表头/表尾分隔线，颜色继续只在 TTY 中启用。
- 验证：`npm test`，25 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-09：同步当前项目配置到新版 pi-init 模板

- 完成内容：根据当前 `.pi/role-models.json` 重新生成项目级 `AGENTS.md` 和 `.pi/skills/pi-init/SKILL.md`，补入宿主环境、Clean Code 入口、精确替换规则，并同步架构师 `medium` 推理强度。
- 完成内容：补入当前项目缺失的 `docs/clean-code.md`；同步模板 Skill 中的 `agent_settled` 压缩生命周期描述。
- 验证：`npm test`，25 项测试全部通过；配置解析、`node --check src/scaffold.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。

### 2026-08-09：按 Clean Code 规则清理 pi-usage

- 完成内容：修复默认日期范围从当前时刻开始的问题，改为本地当天 `00:00`；删除数据库增量导入后已无调用方的旧 JSONL 扫描函数。
- 完成内容：为默认日期边界补充回归测试，避免 Git 当日统计漏掉午夜至当前时刻之间的提交。
- 验证：`npm test`，26 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送；大型模块拆分暂不执行，待有明确边界或维护痛点时再处理。

### 2026-08-09：为 pi-usage 增加一小时自动检查

- 完成内容：普通查询首次、距上次检查超过一小时或跨自然日时自动执行增量检查；未过期时直接读取 DuckDB，`--update` 仍然强制检查。
- 完成内容：新增 `usage_state` 检查状态，并让文件变化影响的历史日期一并刷新派生汇总。
- 验证：`npm test`，27 项测试全部通过；`node --check scripts/pi-usage.js`、`node --check test/scaffold.test.js` 和 `git diff --check` 通过。
- 遗留问题：本次改动尚未提交或推送。
