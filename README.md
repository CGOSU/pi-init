# pi-init

Pi extension for initializing a project's AI Coding collaboration context.

生成：

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

## 使用

```bash
pi --no-extensions -e ./extensions/init-project.ts
```

然后在 Pi 中执行 `/init-project`。命令会询问项目名称、语言、项目定位、测试命令和 Skill 名称，并在写入前确认。

生成的 `AGENTS.md` 会记录初始化时检测到的宿主系统、CPU 架构和对应的命令约定；如果实际执行转移到 WSL、容器或远程主机，应以当前环境重新检测为准。

希望所有项目都遵守同一套主机规则时，使用 Pi 的全局上下文文件 `~/.pi/agent/AGENTS.md`；`settings.json` 主要用于配置，不适合承载这类自然语言指令。

也可以安装当前目录作为 Pi package：

```bash
pi install .
```

`init_project` 工具可由模型调用，`targetDir` 默认为当前工作目录；支持 `dryRun: true` 预览。

默认模板面向 CGOSU 工作流，包含团队知识库和仓库 Git 身份规则。其他团队使用时应先修改 `templates/AGENTS.md` 和 `templates/en/AGENTS.md`。

项目级 Skill 以 `AGENTS.md` 为唯一规则入口，并按交付物智能分配三类职责：

| 职责 | 技术水平 | 模型类型 | 默认模型 | Pi 推理强度 |
| --- | --- | --- | --- | --- |
| 架构师 | Staff / Principal | 旗舰长上下文通用推理模型 | `openai-codex/gpt-5.6-sol` | `max` |
| 开发测试工程师 | Senior / SDET | 代码专用或强工具调用模型 | `openai-codex/gpt-5.6-luna` | `max` |
| 文档与提交工程师 | Technical Writer / Release Engineer | 快速、强指令遵循的通用模型 | `openai-codex/gpt-5.6-luna` | `medium` |

Skill 会在每个职责开始前调用 `switch_role`，由 Extension 读取 `.pi/role-models.json` 并自动执行 `pi.setModel()` 与 `pi.setThinkingLevel()`。初始化 `/init-project` 时可选择默认职责配置或逐个选择当前可用模型和兼容的推理强度；项目运行中可用 `/role-config [architect|developer-test|docs-commit]` 持久修改某个职责并立即应用。

可用 `/role architect`、`/role developer-test`、`/role docs-commit` 手动验证。Pi 原生 `/model`、`Shift+Tab` 仍可用于当前会话的临时切换；职责自动切换仍以 `.pi/role-models.json` 为准。

职责切换模式配置在 `.pi/role-models.json` 顶层：`auto` 自动切换，`confirm` 切换前询问（默认接受建议），`manual` 只允许用户通过 `/role` 切换。`/role-mode <mode>` 仅临时覆盖当前会话。

架构师完成规划后，如果存在至少两个文件范围不重叠的工作包，Skill 会在允许自动切换时调用 `parallel_develop`。该工具仅在受信任项目中运行，为多个 `developer-test` 子代理创建隔离 Git worktree，并发执行当前已生效的开发测试模型；子代理使用 Pi JSON 事件流，状态栏和工具进度实时显示每个任务的运行状态、当前工具、耗时和最后活动。基础设施错误自动重试一次，代码/测试错误交由主开发测试工程师接管；失败现场和日志保留，成功后才合并并清理。主工作区必须干净，子代理不会提交或推送，且不会自动提升项目受信任级别。

## 检查

```bash
npm test
```
