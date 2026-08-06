# pi-init

Pi 扩展：为项目生成 AI Coding 协作上下文，并提供角色编排与并行开发子代理。

## 功能

- 生成项目级 `AGENTS.md`、记忆文档和 `.pi/skills/<slug>/SKILL.md`。
- 通过统一的 `/pi-init` 控制中心完成初始化、职责配置和模型切换。
- 根据任务在架构、开发测试、文档提交三类角色之间切换模型。
- 支持 `auto`、`confirm`、`manual` 三种角色切换模式。
- 通过隔离 Git worktree 并行运行开发测试子代理。
- 记录项目宿主环境、阶段耗时、token/cache/cost 和自动重试指标。

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

## 生成内容

```text
<project-root>/
├── AGENTS.md
├── docs/
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

初始化提供两条路径：快速路径自动读取 `package.json`、锁文件和目录名，只需一次确认；高级路径才会询问项目名称、语言、项目定位、测试命令和 Skill 名称。当前项目初始化完成后会自动 reload。生成的 `AGENTS.md` 会记录当前 Pi 宿主系统、CPU 架构和平台命令约定；如果项目实际运行在 WSL、容器或远程主机，应重新执行检测。

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

用户只需记住一个入口：

```text
/pi-init
```

控制中心提供快速初始化、高级初始化、职责与模型配置、职责切换和模式切换。熟悉命令行时也可以直接使用：

```text
/pi-init init [目录]
/pi-init advanced [目录]
/pi-init role <architect|developer-test|docs-commit>
/pi-init config [architect|developer-test|docs-commit]
/pi-init mode <auto|confirm|manual>
```

`/pi-init mode` 只临时覆盖当前会话；`/pi-init config` 持久修改项目配置。Pi 原生 `/model` 和 `Shift+Tab` 仍可用于临时切换，但角色自动切换以项目配置为准。

## 并行开发

仅当工作包真正独立、契约已冻结且足够大时才使用 `parallel_develop`。共享 DOM、API 或测试契约的任务，即使文件范围不重叠，也应交给单个子代理。

运行规则：

- 最多接受 4 个任务，默认同时运行 2 个，其余排队。
- 每个任务必须提供 `id`、`task` 和不重叠的 `files` 范围。
- 仅在受信任项目中运行，使用隔离 Git worktree。
- 高频模型进度按 250ms 节流；工具和阶段变化即时报告。
- `terminated` 等基础设施错误自动重试一次；代码或测试错误交由主开发测试工程师处理。
- 成功后才合并和清理；失败 worktree、prompt 及日志会保留。
- 主工作区必须干净，子代理不会提交或推送。

结果包含 worker 耗时、turn/token/cache/cost、自动重试次数，以及准备、worker、合并阶段耗时。

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
