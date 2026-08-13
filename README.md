# pi-init

Pi 扩展：为项目生成 AI Coding 协作上下文，并提供角色编排。

## 功能

- 生成项目级 `AGENTS.md`、记忆文档和 `.pi/skills/<slug>/SKILL.md`。
- 通过统一的 `/pi-init` 控制中心完成初始化、角色配置和模型切换。
- 根据任务在架构、开发测试、文档提交三类角色之间切换模型。
- 支持 `auto`、`confirm`、`manual` 三种角色切换模式。
- 提供项目级任务工作流策略，默认 `workflowMode: "auto"`：`off` 拒绝新规划，`on` 始终编排，`auto` 对不超过 2 个任务的规划跳过编排并由当前架构角色直接顺序执行；可通过 `/pi-init config workflow` 选择。兼容旧配置中的 `workflowEnabled`，缺失 `workflowMode` 时 `true/false` 映射为 `on/off`。
- 自动模式在真实跨角色且上下文使用率达到 50% 时，于 agent 完全 settled 后压缩上下文并自动继续任务。
- 记录项目宿主环境和平台相关命令约定。

## 安装与启动

直接在本仓库启动扩展：

```bash
pi --no-extensions -e ./extensions/init-project.ts
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

仓库提供跨平台的 `pi-usage` 命令，用于查看 Pi 的模型用量：

Windows PowerShell：

```powershell
pwsh -File .\scripts\install-launchers.ps1
pi-usage
```

POSIX shell（Linux/macOS/WSL）：

```bash
sh ./scripts/install-launchers.sh
pi-usage
```

- `pi-usage` 默认查询 DuckDB；首次查询、距离上次检查超过 1 小时或跨自然日时，会自动扫描并增量导入 session JSONL；使用 `pi-usage --update` 可强制立即检查，之后可传入 `YYYY-MM-DD` 查询指定日期，也可用 `--db <路径>` 指定数据库。默认数据库为 `~/.pi/agent/pi-usage.duckdb`，未安装 DuckDB 时会自动安装到用户目录。
- `pi-usage` 还显示活跃时长、模型等待时长和 session 跨度；Models 表按模型显示 `Avg TPS`（`输出 token 总数 / 有效生成秒数`），采用加权吞吐量而不是简单平均；没有 `pi-token-speed` 采样的历史模型显示 `--`。Overview、Models 和 Time 使用带边框的对齐表格，并额外显示按模型总 token 缩放的柱状图及整体缓存占比（`(Cache R + Cache W) / Total`）。交互终端默认使用 ANSI 颜色，设置 `NO_COLOR=1` 可关闭。活跃时长只连接间隔不超过 5 分钟的事件，避免空闲时间被计入。
- `--update` 会强制扫描 session JSONL 并更新 DuckDB 派生表；自动检查只在上述缓存过期时执行，未过期的普通查询直接读取数据库。session 很多或首次自动安装 DuckDB 时会短暂等待，交互终端会显示手动更新进度提示。
- 更新结束后在当前 Pi 会话执行 `/reload`，或重启 Pi，使已加载扩展使用新文件。
- 安装器会把启动器放到 Pi 所在的可执行目录；POSIX 若无写权限则使用 `${XDG_BIN_HOME:-$HOME/.local/bin}`，并提示将其加入 `PATH`。
- 这些辅助命令是可选工具，不会修改系统全局环境变量；换电脑时从仓库重新执行安装器即可。

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
    └── skills/
        └── <project-slug>/
            └── SKILL.md
```

初始化提供两条路径：快速路径自动读取 `package.json`、锁文件和目录名，只需一次确认；高级路径才会询问项目名称、语言、项目定位、测试命令和 Skill 名称。当前项目初始化完成后会自动 reload。生成的 `AGENTS.md` 会要求先读取随模板生成的 `docs/clean-code.md`，并记录当前 Pi 宿主系统、CPU 架构和平台命令约定；如果项目实际运行在 WSL、容器或远程主机，应重新执行检测。

默认模板面向 CGOSU 工作流，包含团队知识库和 Git 身份规则。其他团队使用前，请修改：

- `templates/AGENTS.md`
- `templates/en/AGENTS.md`

## 角色编排

项目级 Skill 按交付物选择角色：

| 角色 | 默认模型 | 推理强度 |
| --- | --- | --- |
| 架构师 | `openai-codex/gpt-5.6-sol` | `max` |
| 开发测试工程师 | `openai-codex/gpt-5.6-luna` | `max` |
| 文档与收尾工程师 | `openai-codex/gpt-5.6-luna` | `medium` |

角色配置保存在项目的 `.pi/role-models.json`：

- `auto`：自动切换。
- `confirm`：切换前询问。
- `manual`：只允许用户手动切换。

自动模式仅在实际跨角色且上下文使用率达到 50% 时额外触发一次压缩；压缩会保留目标、决策、进度、文件、验证结果和下一步，成功后自动继续当前任务。会话恢复时会根据当前模型和推理强度唯一匹配并恢复角色。`confirm`、`manual`、首次选角、同角色重复切换和未知上下文不会额外触发。

角色、模型和模式的关系：

```mermaid
flowchart LR
  TASK[当前任务] --> MODE[模式<br/>auto / confirm / manual]
  MODE -->|auto：自动决定| ROLE[角色<br/>架构师 / 开发测试 / 文档与收尾]
  MODE -->|confirm：先询问| CONFIRM[用户确认]
  CONFIRM --> ROLE
  MODE -->|manual：手动指定| COMMAND["/pi-init role"]
  COMMAND --> ROLE
  ROLE --> CONFIG[角色配置<br/>.pi/role-models.json]
  CONFIG --> MODEL[模型<br/>provider/model]
  CONFIG --> THINKING[推理强度<br/>off ... max]
  MODEL --> SESSION[当前会话]
  THINKING --> SESSION
```

用户只需记住一个入口：

```text
/pi-init
```

控制中心提供快速初始化、高级初始化、角色与模型配置、独立的工作流策略配置、角色切换和模式切换；主状态摘要会显示当前工作流策略与执行进度。熟悉命令行时也可以直接使用：

```text
/pi-init init [目录]
/pi-init advanced [目录]
/pi-init role <architect|developer-test|docs-commit>
/pi-init config [architect|developer-test|docs-commit]
/pi-init config workflow
/pi-init mode <auto|confirm|manual>
```

任务工作流默认使用 `workflowMode: "auto"`。使用 `/pi-init config workflow` 持久选择 `off`、`on` 或 `auto`，也可以直接编辑 `.pi/role-models.json` 的顶层 `workflowMode` 字段：`off` 不创建新规划，`on` 始终创建工作流，`auto` 对不超过 2 个任务的规划返回绕过提示、不持久化状态、不调度角色，超过 2 个任务才进入编排；已开始的工作流仍可查看和收尾。旧项目缺失 `workflowMode` 时，`workflowEnabled: true/false` 分别兼容为 `on/off`，两者同时存在时以 `workflowMode` 为准。

`/pi-init mode` 只临时覆盖当前会话；`/pi-init config` 持久修改项目配置。Pi 原生 `/model` 和 `Shift+Tab` 仍可用于临时切换，但角色自动切换以项目配置为准。

### 工作流运行时版本不一致

如果创建工作流时看到 `(0, _roles.shouldOrchestrateWorkflow) is not a function`，说明正在运行的扩展和 `src/roles.js` 不是同一版本，通常是 Pi 仍加载旧的 Git package 或 reload 前的模块缓存。执行：

```bash
pi update --extensions
```

然后在当前 Pi 会话执行 `/reload`；本地开发直接重启 Pi，并使用同一份 `extensions/init-project.ts` 与 `src/roles.js`。pi-init `1.0.4` 起会把该情况转换为可操作的错误提示，不会继续以不确定的策略创建工作流。

## 全局协作规则

如果所有项目都需要遵守同一套主机规则，可使用 Pi 全局上下文文件：

```text
~/.pi/agent/AGENTS.md
```

`settings.json` 主要用于配置，不适合承载自然语言协作规则。

## 检查

```bash
npm test
```
