# pi-init

`pi-init` 是 Pi 扩展：帮项目准备 AI Coding 协作说明，并提供角色切换、任务工作流和运行诊断命令。

## 能做什么

- 初始化项目的 `AGENTS.md`、`docs/` 项目记忆和 `.pi/role-models.json`。已有文件不会静默覆盖。
- 使用随 package 发布的 `pi-init-role-routing` Skill 提供通用职责规则；项目可配置角色及对应模型。
- 在 Pi 中切换职责、配置自动换角方式，并查看或管理任务工作流。
- 提供 `/blackbox` 运行诊断、`/large` 大型代码文件结构审阅，以及独立的 `pi-usage` 用量统计命令。

## 安装

```bash
pi install https://github.com/CGOSU/pi-init
```

安装后重启 Pi，在项目中运行 `/pi-init` 打开控制中心。也可以直接在本仓库试用：

```bash
pi --no-extensions -e ./extensions/index.ts
```

## 初始化项目

在 Pi 中运行 `/pi-init`，按提示选择快速初始化或高级初始化。也可以直接使用命令：

```text
/pi-init init [目录]       快速初始化；省略目录时使用当前目录
/pi-init advanced [目录]  高级初始化
```

初始化会生成协作说明、项目记忆和角色模型配置；遇到已有同名文件时会先请求确认。

## 常用命令

| 命令 | 用途 |
| --- | --- |
| `/pi-init` | 打开控制中心 |
| `/pi-init config [role-id\|workflow]` | 配置角色/模型，或配置工作流策略 |
| `/pi-init role <role-id>` | 切换到指定职责 |
| `/pi-init mode <auto\|confirm\|manual>` | 设置角色切换方式 |
| `/pi-init save` | 保存角色模型配置 |
| `/pi-init workflow status\|resume\|retry\|cancel\|fresh\|stop` | 查看或管理当前工作流 |
| `/pi-init diagnostics`、`/blackbox` | 打开运行诊断 |
| `/large` | 扫描大型代码文件的结构审阅候选 |

标准职责包括 `architect`（规划）、`developer-test`（实现与验证）和 `docs-commit`（文档与交付）；项目也可以配置自定义角色。角色切换方式为 `auto`（自动）、`confirm`（确认后切换）或 `manual`（手动切换）。

## 可选：用量统计

安装 package 后可运行 `pi-usage` 查看 Pi 用量；指定时间范围或导出 SVG：

```bash
pi-usage 7d
pi-usage 2026-08-01 2026-08-25 --output usage.svg
```

`pi-usage --update` 可立即更新统计数据。详细诊断说明见[运行诊断文档](docs/runtime-diagnostics.md)。
