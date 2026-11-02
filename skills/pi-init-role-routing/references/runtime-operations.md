# 工具操作参考（按需读取）

只在对应工具使用、参数或恢复问题出现时参考；正常任务不例行加载。工具schema与运行时校验是实际契约，本文不授予执行权限。

## 原文读取与结构审阅

- file_review list是项目候选库存，path不筛选库存；read/complete才使用path。Markdown不在代码审阅范围。
- read从第1行开始，默认100行、最多200行，每页原文最多16 KiB UTF-8；只登记完整返回行，按nextOffset至eof。单行过长失败，不算部分覆盖。
- 覆盖绑定当前指纹；失败、取消、内容或session/branch变化不产生覆盖。可传fingerprint拒绝混合版本，complete须全文覆盖和有效理由。
- 缺原生read可用内置read；宿主schema仍只允许list/complete时先核实加载路径并reload新版本，不用脚本摘要或测试runtime伪造当前session覆盖。

## 检查点与历史来源

- checkpoint携带expectedMemoryRevision及step/accomplished/remaining/blockers/nextStep；accomplished引用真实evidenceIds。缺revision时使用运行时给出的值，不为补字段循环查status。
- status(evidenceIds)可定向读取真实来源；memoryFiles最多16个项目相对文件，只记内容hash。历史引用、指纹和工具成功不代表当前验收通过。
- `/pi-init fresh` 是普通会话与托管工作流共用的用户命令，预览并确认后才进入安全换session流程；活动工作流仍走原有受保护交接路径。`/pi-init workflow fresh` 保留为兼容入口，`resume` 留在原会话。这些命令不是新的task_workflow工具动作。
- 普通会话无需工作流：当前已确认的非architect执行角色在现场稳定、当前执行结束后调用 `session_handoff`，显式填写 `goal`、`constraints`、`completed`、`remaining`、`verification`、`unknowns`、`nextStep`、`sources`；无内容的数组使用 `[]`。用户可先说“请用 `session_handoff` 准备短交接，记录目标、约束、已完成/待办、历史验证及来源、未知项和下一步”，等待工具返回后直接执行 `/pi-init fresh`。验证项必须引用历史来源；来源只能是当前session条目ID或文件位置，不能使用旧 `obs_recall` ID。工具只持久化所选背景，不创建session或续跑。32 KiB 是完整存储上限，不是token数；超限拒绝，不截断。新输入、其他工具活动或branch变化会让快照失效，因此准备后不要插入其他输入或工具操作。
- `fresh` 会展示预览并等待用户确认，确认前重新核对session、branch和快照。目标只包含选定的历史背景，不继承完整历史/旧执行身份，也不自动继续任务。若交接结果未知，来源保持冻结；先检查是否已有目标，不要从来源再次创建。已有待核对包时，在目标运行 `/pi-init fresh` 只做核对，不创建第二个session。旧冻结工作流不能用普通会话路径绕过，也不能通过 `resume`/`retry`/`replan` 清除未知结果。

## 结果获取与退役数据

- No matching sections found只表示未检索返回，不证明命令无输出或成功。补取原结果，不重复执行已有副作用或重跑整批命令。
- session与SDK提供的Skill名称/路径是发现依据，不拼猜.pi/skills路径。项目外公共Skill只能通过宿主允许的读取渠道获取。
- 旧sync不覆盖项目规则；正式证据、结构澄清、嵌套执行和/fast已退役。旧记录保留并走明确诊断，检查副作用后才可使用受保护discard-recovery隔离。
- 原session、ObservationPack档案或worktree可能仍是验证来源；没有明确所有权与存活引用检查，不自动删除或回收。
