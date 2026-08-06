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
