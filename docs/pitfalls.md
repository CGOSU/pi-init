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

### 2026-08-06：职责切换压缩必须延迟到回合结束

- 现象：在 `switch_role` 工具执行期间直接调用 `ctx.compact()` 会中止当前 agent 操作，可能让角色切换结果无法自然续跑。
- 根因：Pi 的 `compact()` 会先 abort 当前 agent；工具仍处于当前回合时，压缩与 agent 生命周期存在竞争。
- 修复：只记录待压缩的角色边界，在 `turn_end` 事件中启动压缩；成功后发送隐藏自定义消息并触发一个新的 agent turn，失败不回滚模型切换。
- 验证：`npm test` 17 项通过；真实模型端到端续跑尚未演练。

### 2026-08-06：Windows `.cmd` 不能用 Node 的 shell-free spawn 直接启动

- 现象：Windows 下直接 `spawn("pi.cmd", args, { shell: false })` 报 `spawn EINVAL`。
- 根因：`.cmd` 是 shell 脚本而不是可执行 PE 文件；Node 的 shell-free spawn 不会像 shell 一样解释它。
- 修复：通过 `cmd.exe /d /s /c` 配合 `windowsVerbatimArguments` 和元字符转义启动；取消/超时使用平台对应的进程组/进程树终止策略。
- 验证：Windows `.cmd` 备用入口实际启动 Pi CLI；超时进程树测试通过，完整测试 21 项通过。

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

- 现象：直接运行 `pi -e ./extensions/init-project.ts` 报错，提示 `init_project` 与已安装的同名工具冲突。
- 根因：Pi 同时加载了用户级已安装包和命令行指定的本地扩展。
- 修复：开发验证时使用 `--no-extensions -e ./extensions/init-project.ts`，只加载当前文件。
- 验证：见 `docs/session-log.md` 中 2026-08-04 的 extension 加载检查。

### 2026-08-04：Skill 指令本身不会切换模型

- 现象：Skill 可以声明职责、模型和推理强度，但仅加载 Skill 不会自动调用 `pi.setModel()`。
- 根因：Pi Skill 是按需加载的工作流说明；运行时模型切换属于 Extension API。
- 修复：由 Skill 在职责边界调用 `switch_role`，Extension 从受信任项目的 `.pi/role-models.json` 读取映射并执行 `pi.setModel()` 与 `pi.setThinkingLevel()`。
- 验证：RPC 中依次执行 `/role architect`、`/role developer-test`、`/role docs-commit`，读取会话状态确认三个模型与推理强度均正确生效。

### 2026-08-06：Git 重命名检测会掩盖范围外删除

- 现象：使用 `git diff --name-only` 检查任务范围时，范围外文件重命名到范围内可能只返回目标路径。
- 根因：Git 默认启用重命名检测，源文件删除不会作为独立路径返回。
- 修复：并行 worker 使用 `git diff --no-renames --name-only`，分别检查源路径和目标路径。
- 验证：确定性并行开发测试覆盖范围外重命名，`npm test` 通过。

### 2026-08-06：子代理的 `--approve` 会隐式提升项目信任

- 现象：并行子代理启动参数中的 `--approve` 会主动接受项目级信任。
- 根因：Pi 的 `--approve` 会覆盖非交互模式默认的项目信任决策。
- 修复：父扩展要求当前项目已受信任，子代理改用 `--no-approve`。
- 验证：见 `docs/session-log.md` 中 2026-08-06 的实际验证记录。

### 2026-08-06：Windows 下 CLI 查找成功但直接启动仍可能失败

- 现象：`where.exe agent-browser` 能找到全局安装的 CLI，但依赖 Linux `which`、直接启动无扩展名 shim 或假设 POSIX 路径的工具仍提示未安装或无法执行。
- 根因：Windows npm 全局 CLI 同时可能存在 POSIX shell 脚本和 `.cmd` shim；Pi 扩展的 `pi.exec` 是直接启动进程，不会替工具经过 Bash 解析。
- 修复：生成的 `AGENTS.md` 和全局宿主规则要求先用 `where.exe`/`command -v` 复核，并提醒扩展按 Windows 入口启动；第三方工具本身仍需采用平台兼容的检测和执行逻辑。
- 验证：`where.exe agent-browser` 返回两个入口，`cmd.exe` 启动 `agent-browser --version` 成功；当前 browser 工具仍返回未安装，待其上游修复 Windows 检测/启动链。
