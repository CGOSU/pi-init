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

## 容量提醒与手动新会话

pi-init 根据当前 context hook 可见消息的序列化字符数估算输入规模（字符数除以 4），并与当前可确认模型的上下文窗口比较。达到 70% 时只给出软提醒；估算包含 10% 输出与 5% 安全策略余量，但它们不是实际预留。没有可确认的窗口（包括下一物理路由未知的虚拟模型）时不显示百分比。该启发式不等于 tokenizer、Provider 实际输入或硬上限；Pi 原生容量保护仍负责真实请求边界。

提醒不阻断请求或工作流、不主动压缩，也不额外请求模型摘要。同一 session/模型/窗口的提醒会去重；模型或窗口变化、压缩和新 session 后重新评估，压缩或新 session 要等下一次可见投影才更新估算。普通会话没有可信的 pi-init 任务检查点：请先保存目标、约束、已完成和未完成事项，待当前执行结束后再由用户手动运行 `/new`；新会话不会自动继承任务进度或全部历史。

托管工作流只会在现有安全条件满足时显示 `/pi-init workflow fresh` 的手动入口。该命令仍须由用户发起并确认，沿用有限的工作流交接和源会话保护；容量提醒不暂停队列，也不授权恢复或重放。工具仍在执行、停止状态、结果未知或恢复边界未确认时，现有安全门继续生效。

托管工作流的请求上下文视图不改写原 session：仅在任务、branch 和工具组边界可核实时，保留用户约束、失败/恢复/未知结果、完整工具调用与结果配对及当前任务交接后的活动内容；无法安全确认时保留完整输入。普通会话不做语义历史裁剪。实现取舍和验证边界见[设计决策](docs/decisions.md)及[会话记录](docs/session-log.md)。

## 可选：用量统计

安装 package 后可运行 `pi-usage` 查看 Pi 用量；指定时间范围或导出 SVG：

```bash
pi-usage 7d
pi-usage 2026-08-01 2026-08-25 --output usage.svg
```

`pi-usage --update` 可立即更新统计数据。详细诊断说明见[运行诊断文档](docs/runtime-diagnostics.md)。
