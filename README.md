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

Skill 会在每个职责开始前调用 `switch_role`，由 Extension 读取 `.pi/role-models.json` 并自动执行 `pi.setModel()` 与 `pi.setThinkingLevel()`。可用 `/role architect`、`/role developer-test`、`/role docs-commit` 手动验证；需要其他模型时只修改该 JSON。

## 检查

```bash
npm test
```
