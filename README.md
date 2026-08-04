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

项目级 Skill 保持精简，长期规则只在 `AGENTS.md` 中维护。

## 检查

```bash
npm test
```
