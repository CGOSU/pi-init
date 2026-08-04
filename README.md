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
pi -e ./extensions/init-project.ts
```

然后在 Pi 中执行 `/init-project`。命令会询问项目名称、语言、项目定位、测试命令和 Skill 名称，并在写入前确认。

也可以安装当前目录作为 Pi package：

```bash
pi install .
```

`init_project` 工具可由模型调用，`targetDir` 默认为当前工作目录；支持 `dryRun: true` 预览。

## 检查

```bash
npm test
```
