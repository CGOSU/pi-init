# 工具操作参考（按需读取）

只在对应工具使用、参数或恢复问题出现时参考；正常任务不例行加载。工具schema与运行时校验是实际契约，本文不授予执行权限。

## 原文读取与结构审阅

- file_review list是项目候选库存，path不筛选库存；read/complete才使用path。Markdown不在代码审阅范围。
- read从第1行开始，默认100行、最多200行，每页原文最多16 KiB UTF-8；只登记完整返回行，按nextOffset至eof。单行过长失败，不算部分覆盖。
- 覆盖绑定当前指纹；失败、取消、内容或session/branch变化不产生覆盖。可传fingerprint拒绝混合版本，complete须全文覆盖和有效理由。
- 缺原生read可用内置read；宿主schema仍只允许list/complete时先核实加载路径并reload新版本，不用脚本摘要或测试runtime伪造当前session覆盖。

## 检查点与历史来源

- checkpoint按需保存进展，不是complete、block或交接的新增前置条件；携带expectedMemoryRevision及step/accomplished/remaining/blockers/nextStep。有已知有效来源和当前revision时直接复用，缺少来源时按需一次`task_workflow(action="status", detail="full")`，从任务记忆正文JSON取`observations[].id`及`revision`（结构化路径为`details.taskMemory.memory`）。
- 来源ID是工具结果的session entry ID，不是toolCallId、messageEntryId或obs_recall ID；以真实返回值为准，不猜造。observations是有界视图，已有归档但仍能核验的本任务来源可复用；核对outcome如实记录失败观察，只有complete的evidenceIds要求成功来源。accomplished没有成果时可传[]，每项实际成果的evidenceIds须非空，不为凑来源执行额外工具。
- 缺revision时使用运行时错误已给出的当前值，不为补字段循环查status；revision陈旧时按需一次full status核对最新checkpoint/remaining/nextStep，合并有效进展后再决定提交，不只替换revision覆盖新进展。查询不解除身份、恢复或防轮询守卫。
- status(evidenceIds)可定向读取真实来源；memoryFiles最多16个项目相对文件，只记内容hash。历史引用、指纹和工具成功不代表当前验收通过。
- `/pi-init fresh` 是普通会话与托管工作流共用的用户命令，预览并确认后才进入安全换session流程；活动工作流仍走原有受保护交接路径。`/pi-init workflow fresh` 保留为兼容入口，`resume` 留在原会话。这些命令不是新的task_workflow工具动作。
- 用户明确要求准备工作流交接时，当前执行角色按需复用或保存进展，再对未完成的活动任务调用 `task_workflow(action="block", ...)`，reason说明用户要求暂停及未完成内容，outcomeUnknown按实际结果填写；只有真实完成并验证后才可complete。checkpoint只保存进展，不会暂停活动任务，也不证明可fresh；普通保存检查点不自动block。工具未结束或副作用未确认时保留真实未知状态，不为通过交接填写false。block若因待重规划进入replanning，应按真实返回状态处理，不宣称已到交接边界。
- 已处于 `task-blocked` 时不为交接先retry业务。若reload后只是职责恢复待确认，依据原未完成任务核对执行职责，通过 `switch_role` 确认；不因交接准备切到docs-commit。确认职责不解除业务暂停、不授权重放。结束当前回合后再由用户运行fresh，核验至少已有一个完成交付物、无活动任务、工具已结束、结果已知及其余停止/恢复/配置条件；block成功不是可交接证明。安全门拒绝时按具体原因处理，不用反复status、切角或retry探路。目标保留原阻塞原因，按原恢复动作继续。
- 大工作流使用源session的hash快照引用，保留源文件，预览摘要不替代完整状态。新会话仍遵守职责恢复与未知结果保护。
- 普通会话无需工作流：当前已确认的非architect执行角色在现场稳定、当前执行结束后调用 `session_handoff`，显式填写 `goal`、`constraints`、`completed`、`remaining`、`verification`、`unknowns`、`nextStep`、`sources`；无内容的数组使用 `[]`。可选 `decisions` 记录影响下一步的跨角色关键结论、关键理由、必要的否决方案与适用边界，并用 `confirmed`（用户已确认/既定契约）、`proposed`（建议）、`unverified`（未验证假设）区分效力。正文保留关键结论，详细论证可引用来源但不会自动展开。无决策可省略或传空数组；理由不明可省略、留空或写待确认，不补造。遗漏检查是准备指导而非保存门槛，旧快照仍兼容。用户可先说“请用 `session_handoff` 准备短交接，记录目标、约束、已完成/待办、跨角色关键决策及理由、历史验证及来源、未知项和下一步”，等待工具返回后直接执行 `/pi-init fresh`。验证项必须引用历史来源；来源只能是当前session条目ID或文件位置，不能使用旧 `obs_recall` ID。工具只持久化所选背景，不创建session或续跑。32 KiB 是完整存储上限，不是token数；超限拒绝，不截断。新输入、其他工具活动或branch变化会让快照失效，因此准备后不要插入其他输入或工具操作。
- 仅当影响后续执行时，复用已观察的工作目录、工具入口、依赖缓存及必要非敏感选项到constraints，在verification保留已验证完整命令、真实结果及来源，nextStep沿用这些条件。缺失条件写unknowns，不为交接扫描env/.env或重跑验证；凭据只记录变量名或安全获取方式，不复制值。不新增交接必填字段或自动采集流程。
- cache miss提示：同一session曾报告缓存使用后，单次估算的额外成本严格超过$0.50且有UI时提醒一次；累计金额只包含单次成本严格超过该门槛且成功持久化的样本，等于或低于门槛不统计。状态栏提醒次数仅记录成功发送的通知，重开同一session可恢复。估算基于Pi暴露的usage和模型价格，不是Provider账单或完整提示前缀比较；数据不完整、错误/中止或没有可确认价格时不猜、不提醒。此提示不自动准备快照、不换session、不暂停任务；无UI的运行不占提醒次数。
- `fresh` 会展示预览并等待用户确认，确认前重新核对session、branch和快照。目标只包含选定的历史背景，不继承完整历史/旧执行身份，也不自动继续任务。若交接结果未知，来源保持冻结；先检查是否已有目标，不要从来源再次创建。已有待核对包时，在目标运行 `/pi-init fresh` 只做核对，不创建第二个session。旧冻结工作流不能用普通会话路径绕过，也不能通过 `resume`/`retry`/`replan` 清除未知结果。

## 暂停与未知结果恢复

- 任务的 `handoff-outcome-unknown` 是本次任务执行结果未确认，与跨session交接的源冻结/目标核对不同；不要引导fresh。先核对实际副作用，再由用户执行 `/pi-init workflow retry <taskId> --confirm-unknown-outcome` 或使用工作流面板的未知结果确认重试入口。该动作授权新attempt，不是证明旧执行成功；模型不得自动执行或用布尔值替代用户确认。
- 用户说“继续”可以清除自动停止，但不清除已持久化的业务暂停或未知结果。`switch_role` 确认/复用职责也不解除这些门；回执应说明仍待处理的原因及具体恢复入口，不能仅因职责匹配声称可继续任务。已有状态和下一步时直接沿用，不为解除暂停反复status或换角。
- 暂停期间读取来源时只使用守卫允许的查询工具；把read包在codemode中不等于原生read，顶层执行工具仍可能被拒绝。模型请求零token、overloaded或fetch failed不足以证明工具收敛、原文持久化及身份都满足安全快续接条件，不能据此删掉未知状态。

## 结果获取与退役数据

- No matching sections found只表示未检索返回，不证明命令无输出或成功。补取原结果，不重复执行已有副作用或重跑整批命令。
- session与SDK提供的Skill名称/路径是发现依据，不拼猜.pi/skills路径。项目外公共Skill只能通过宿主允许的读取渠道获取。
- sync命令、托管模板同步和基线更新已移除；初始化只补缺失，已有项目文件由维护者编辑。正式证据、结构澄清、嵌套执行和/fast已退役；相关旧工作流记录保留并走明确诊断，检查副作用后才可使用受保护discard-recovery隔离。
- 原session、ObservationPack档案或worktree可能仍是验证来源；没有明确所有权与存活引用检查，不自动删除或回收。
