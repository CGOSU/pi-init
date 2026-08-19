# 开发踩坑记录

本文件记录容易复发且不直观的问题。一次性报错、普通开发流水和未经验证的猜测不写入此处。

## 记录格式

每条记录包含：

- 日期：发现或最后验证日期；
- 现象：可观察到的错误或异常行为；
- 根因：经过确认的直接原因；
- 修复：已验证有效的处理方法；
- 验证：复现、测试或检查命令及结果。

## 已知问题

### 2026-08-15：角色切换压缩与 Pi 自动压缩重复

- 日期：2026-08-15；
- 现象：角色切换后反复出现 `Compaction failed: Already compacted` 和“角色切换后的上下文压缩失败”警告。
- 根因：角色切换在上下文达到 50% 时登记待压缩；Pi 内置自动压缩可能在 `agent_settled` 前先完成，扩展随后再次调用 `ctx.compact()`，而 Pi 对以 `compaction` entry 结尾的 branch 返回 `Already compacted`。
- 修复：在 `agent_settled` 的待压缩处理前检查 branch 尾部；已是 `compaction` 时跳过第二次调用并直接续跑。该错误不是 provider、凭据或摘要请求失败。
- 验证：`node --test --test-name-pattern='角色切换遇到 Pi 已完成的自动压缩|角色切换压缩等待 agent 完全结束' test/scaffold.test.js` 和 `npm test` 均通过。

### 2026-08-15：Agent 模糊模型名可能跨 Provider 解析

- 日期：2026-08-15；
- 现象：部分子会话记录为 OpenRouter/Claude，即使主会话和角色配置默认使用 `openai-codex`。
- 根因：Agent 工具显式传入 `haiku`/`sonnet`，或 agent 类型携带默认模型时由子代理解析器进行模糊匹配/跨 Provider fallback；这不是主会话 Codex 失败后的自动 fallback。
- 修复：Agent spawn 前要求显式 `provider/model`，省略 model 时注入当前完整模型，模糊名称拒绝；曾以 fail-closed `providerPolicy` 白名单加固，2026-08-16 起白名单移除，仅保留精确引用纪律（见 `docs/decisions.md`）。
- 验证：`npm test` 覆盖 `haiku`/`sonnet` 拒绝、精确存在校验和省略注入。

### 2026-08-15：pi-usage 逐事件写入和全量 split 会放大冷导入成本

- 日期：2026-08-15；
- 现象：112 个 session、约 213 MB JSONL 的空数据库首次导入约 93.8 秒；独立文件读取、split 和 JSON 解析约 0.8 秒，导入时 Node RSS 约 377 MB。
- 根因：每个事件都 `await connection.run`，并且每个文件使用 `readFileSync(...).split(/\r?\n/)` 同时保留完整字符串和行数组；追加文件也会重复处理已提交内容。
- 修复：使用 DuckDB Appender 的 1024 行有界 flush 和每文件事务；改用流式字节解析，持久化 offset/行号/cwd/尾部校验，追加从 checkpoint 继续，回退时全量重建。
- 验证：优化后同一台机器实际 112 文件首次统计为 `filesRebuilt=112`、`bytesRead=215607665`，第二次为 `filesSkipped=112`、`filesChanged=0`、`durationDates=[]`；`npm test` 34 项全部通过。

### 2026-08-15：EOF 不完整 JSON 不能推进 session checkpoint

- 日期：2026-08-15；
- 现象：session 文件可能在最后一条 JSON 记录写完前被读取；若把文件大小直接记为已导入位置，后续补全记录会永久丢失或产生重复。
- 根因：JSONL 的最后一行没有换行时，字节流无法仅凭 EOF 判断它是完整记录还是仍在写入；checkpoint 若越过解析失败的尾部，下一次无法可靠恢复。
- 修复：只有 JSON.parse 成功的行或以换行结束的完整坏行推进 offset；未完成尾部保留 `has_incomplete_tail`，补写后从原 offset 和原行号继续，并用前缀尾部 SHA-256 校验检测回退。
- 验证：`node --test --test-name-pattern='流式 checkpoint'` 通过，覆盖不完整尾部、补全后单次导入、同尺寸改写和无变化跳过路径。

### 2026-08-19：subtask 执行器已派发任务不会在 reload 后自动重新派发

- 现象：reload 或 session replacement 后，工作流状态仍显示已委派给 fork 的非终态任务，但 pi-init 不会再次调用 `subtask` 工具派发它。
- 根因：自动重新派发会在共享工作区产生并发写入；fork 的存活状态由独立的 `gary149/pi-subtask` 扩展管理，主扩展无法安全猜测其结果是否已回传。
- 修复：持久化 delegation（requestId、类型、status）；`scheduleWorkflow` 只在 `workflowState.currentTaskId` 且存在 delegation 时尝试消费回传的 `subtask-result`，找不到匹配结果就保持等待，绝不自动重新派发。需要继续时由用户确认 fork 状态后 `/pi-init workflow retry <taskId>` 或 cancel 重新规划。
- 验证：`npm test` 覆盖派发、结果消费、取消和协议；真实 reload 后人工恢复尚未演练。

### 2026-08-19：pi-subtask 是可选的外部扩展而不是 pi-init 依赖

- 现象：将 `workflowExecutor` 设为 `subtask`，但同一 Pi 环境没有启用 `gary149/pi-subtask` 时，`pi.getActiveTools()` 不含 `subtask` 工具，任务无法派发。
- 根因：pi-subtask 没有扩展 RPC 接口（不订阅 `pi.events`），pi-init 不能导入或复制其实现，只能依赖模型侧 `subtask` 工具存在。
- 修复：派发前用 `pi.getActiveTools()` 探测 `subtask` 工具，缺失时安全阻塞任务并提示安装启用扩展；默认保持 `workflowExecutor: "local"`；README 和生成规则要求单独安装 `pi install npm:pi-subtask`，主扩展对缺少工具和无效结果安全阻塞任务。

### 2026-08-15：npm lifecycle 的本地 Pi shim 会遮蔽实际 CLI

- 现象：执行 `pi update --extensions` 后，`pi-usage` 仍显示 `vunknown` 或保持旧版本，尽管 package 的 `postinstall` 已执行。
- 根因：Pi 更新 Git 包时在包目录执行 npm lifecycle，当前包的 `node_modules/.bin` 被放到 `PATH` 首位；安装器取到该目录中的本地 `pi` shim，并把启动器复制到会被依赖安装/清理影响的目录，而不是用户实际使用的 Pi CLI 目录。
- 修复：安装器按 PATH 扫描候选 Pi CLI，跳过当前包 `node_modules/.bin`，选择后续实际 CLI 目录；Windows/POSIX 均适用。
- 验证：回归测试覆盖本地 Windows `pi.cmd` shim 位于 PATH 首位的场景；目标目录获得嵌入版本号，npm shim 目录不产生启动器。

### 2026-08-14：Pi 更新不会自动刷新独立复制的启动器

- 现象：`pi update --extensions` 更新 package 后，PATH 中独立安装的 `pi-usage` 仍可能是旧版本。
- 根因：Pi package 资源目录与手动复制到 Pi 可执行目录的启动器是两套文件；后者不属于扩展资源，更新 package 不会自动同步。
- 修复：在 package `postinstall` 中执行跨平台启动器复制；找不到 `pi` 时安全跳过，避免影响 package 更新。
- 验证：回归测试覆盖 Windows 和 POSIX 启动器复制；`npm test` 26 项通过。

### 2026-08-14：整格柱状图会掩盖接近的 token 数差异

- 现象：`pi-usage` 中不同模型的 token 数不同，但柱状图长度看起来相同。
- 根因：固定宽度柱状图使用整格四舍五入，数值差异小于一个终端字符的显示分辨率时会落入同一格。
- 修复：使用 Unicode 八分之一分数块增加柱状图的离散显示分辨率，同时保留数值标签。
- 验证：`npm test` 25 项通过；回归测试覆盖 100 与 99 token 的不同柱形。

### 2026-08-14：Pi package 更新后扩展与相邻源码可能短暂混用

- 现象：创建 2 个任务的工作流时出现 `(0, _roles.shouldOrchestrateWorkflow) is not a function`。
- 根因：当前扩展已经调用新策略函数，但 Pi 运行时加载的 `src/roles.js` 仍是旧模块，常见于 Git package 更新后未 reload、旧扩展实例仍在内存中，或扩展与源码来自不同副本。
- 修复：升级 pi-init 到 `1.0.4`，在调用前检测函数是否存在；缺失时停止规划并提示 `pi update --extensions`、`/reload`，本地开发重启 Pi 且确保扩展与 `src/roles.js` 来自同一目录。
- 验证：本地 `node` 导入确认 `typeof shouldOrchestrateWorkflow === "function"`；RPC 扩展加载成功；`npm test` 24 项通过。

### 2026-08-14：自动任务必须以状态机和持久 entry 驱动

- 现象：仅在 Skill 中要求“架构师拆 task、开发后继续下一个 task”容易在模型换回合、压缩或 reload 后丢失当前任务，也无法区分用户需要审阅架构和默认自动推进。
- 根因：自然语言计划没有可验证的状态、依赖和完成协议；角色切换工具本身只切换模型，不负责任务生命周期。
- 修复：`task_workflow` 用显式状态机保存 plan、currentTaskId、task status 和真实 verification，并通过 `pi.appendEntry` 持久化；只有 `reviewRequired` 或真实 block 才暂停，完成后由 `agent_settled` 调度下一个任务。
- 验证：`node --test --test-concurrency=1` 34 项通过；真实模型连续任务演练仍待执行。
### 2026-08-13：DuckDB schema 升级不应重建历史事件

- 现象：增加 `pi-token-speed` 后，`pi-usage --update` 明显变慢。
- 根因：schema 版本变化把所有历史 session 当作已修改文件，删除并逐条重导既有 `usage_events`、`activity_events`，放大了 DuckDB 写入成本。
- 修复：迁移时只扫描 JSONL 并回填新增的 `speed_events`；正常变更文件仍按文件大小和修改时间执行完整增量重导。
- 验证：89 个 session、约 161 MB 数据的迁移基准从约 60 秒降至约 2.2 秒；`npm test` 29 项通过。

### 2026-08-09：职责切换压缩必须等待 agent 完全 settled

- 现象：角色切换后触发压缩时，会额外写入 `This operation was aborted` 的 assistant 错误，随后压缩可能仍继续完成。
- 根因：Pi 的 `ctx.compact()` 内部会先 abort 当前 agent；`turn_end` 发生时 agent run 仍处于活动状态，压缩会与当前回合及其后续重试/续跑竞争。
- 修复：只记录待压缩的角色边界，在 `agent_settled` 事件中启动压缩；该事件表示 agent run、自动重试、自动压缩和队列续跑均已结束。成功后发送隐藏自定义消息并触发新的 agent turn，失败不回滚模型切换。
- 验证：`npm test` 25 项通过；`node --check extensions/init-project.ts` 和 `git diff --check` 通过；真实模型端到端续跑尚未演练。

### 2026-08-06：Windows `.cmd` 不能用 Node 的 shell-free spawn 直接启动

- 现象：Windows 下直接 `spawn("pi.cmd", args, { shell: false })` 报 `spawn EINVAL`。
- 根因：`.cmd` 是 shell 脚本而不是可执行 PE 文件；Node 的 shell-free spawn 不会像 shell 一样解释它。
- 修复：直接启动 Windows npm CLI 时使用对应的 `.cmd` 入口或 `cmd.exe` 参数转义；不要把 POSIX shell 脚本当作可执行文件。
- 验证：Windows `.cmd` CLI 启动检查通过；当前项目不再内置并行 worker 进程树管理。

### 2026-08-06：reload 会丢失扩展内存中的角色状态

- 现象：大上下文会话 reload 或次日 resume 后，第一次真实跨角色没有触发自动压缩。
- 根因：扩展实例重建后 `activeRole` 为空，首次角色选择被安全地视为首次选角。
- 修复：在 `session_start` 根据当前 provider/model 和推理强度唯一匹配角色；重复配置或无法匹配时保持未知。
- 验证：角色恢复单元测试通过，完整测试 22 项通过。

### 2026-08-04：中英文模板策略容易漂移

- 现象：中文 `AGENTS.md` 包含团队知识库和 Git 身份规则，英文模板缺失相同规则。
- 根因：两个语言模板独立维护，测试只检查了英文标题和测试命令。
- 修复：同步两种语言的协作策略，并在生成测试中检查关键规则。
- 验证：见 `docs/session-log.md` 中 2026-08-04 的实际验证记录。

### 2026-08-04：已安装扩展与 `-e` 本地扩展会重复注册工具

- 现象：直接运行 `pi -e ./extensions/index.ts` 报错，提示 `init_project` 与已安装的同名工具冲突。
- 根因：Pi 同时加载了用户级已安装包和命令行指定的本地扩展。
- 修复：开发验证时使用 `--no-extensions -e ./extensions/index.ts`，只加载当前文件。
- 验证：见 `docs/session-log.md` 中 2026-08-04 的 extension 加载检查。

### 2026-08-04：Skill 指令本身不会切换模型

- 现象：Skill 可以声明职责、模型和推理强度，但仅加载 Skill 不会自动调用 `pi.setModel()`。
- 根因：Pi Skill 是按需加载的工作流说明；运行时模型切换属于 Extension API。
- 修复：由 Skill 在职责边界调用 `switch_role`，Extension 从受信任项目的 `.pi/role-models.json` 读取映射并执行 `pi.setModel()` 与 `pi.setThinkingLevel()`。
- 验证：RPC 中依次执行 `/role architect`、`/role developer-test`、`/role docs-commit`，读取会话状态确认三个模型与推理强度均正确生效。

### 2026-08-06：Windows 下 CLI 查找成功但直接启动仍可能失败

- 现象：`where.exe agent-browser` 能找到全局安装的 CLI，但依赖 Linux `which`、直接启动无扩展名 shim 或假设 POSIX 路径的工具仍提示未安装或无法执行。
- 根因：Windows npm 全局 CLI 同时可能存在 POSIX shell 脚本和 `.cmd` shim；Pi 扩展的 `pi.exec` 是直接启动进程，不会替工具经过 Bash 解析。
- 修复：生成的 `AGENTS.md` 和全局宿主规则要求先用 `where.exe`/`command -v` 复核，并提醒扩展按 Windows 入口启动；第三方工具本身仍需采用平台兼容的检测和执行逻辑。
- 验证：`where.exe agent-browser` 返回两个入口，`cmd.exe` 启动 `agent-browser --version` 成功；当前 browser 工具仍返回未安装，待其上游修复 Windows 检测/启动链。
