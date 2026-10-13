# 角色交接诊断日志

日志仅用于观察角色反复交接及压缩等待，不增加交接次数限制，不修改压缩策略，不自动重试或暂停任务。

## 开启与查看

默认关闭。在启动 Pi 前设置环境变量，且项目必须已被用户信任。

Windows cmd：

```text
set PI_INIT_HANDOFF_LOG=1
pi --no-extensions -e ./extensions/index.ts
```

PowerShell：

```powershell
$env:PI_INIT_HANDOFF_LOG = "1"
pi --no-extensions -e ./extensions/index.ts
```

已安装为 Pi package 时，设置变量后使用原有 Pi 启动命令即可。扩展加载时读取开关；关闭时取消变量或设为 0，再重新加载扩展。

日志写入当前项目的 .pi/logs/handoff.jsonl，每行一个 JSON。约 2 MiB 轮转，保留一个 handoff.jsonl.1 备份。正在发生的问题可用 PowerShell 实时查看：

```powershell
Get-Content .pi/logs/handoff.jsonl -Tail 30 -Wait
```

## 排查顺序

1. 按 sessionId、runtimeId 和 sequence 还原顺序，run 表示本次扩展实例中的 Agent 回合编号。
2. 从 routing.model_proposed 查看模型提出的交接（包括随后可能被守卫拒绝的调用）；从 routing.tool_call 查看进入执行入口的 action、目标角色和身份，对照相同 toolCallId 的 routing.tool_result。
3. 对照 workflow.persisted、coordination.persisted，检查 revision、取证 round、任务状态和 handoff 是否持续变化。
4. workflow.schedule、coordination.schedule 记录调度入口及锁状态；workflow.nudge_requested 表示因未提交完成/阻塞结果而请求续跑。
5. agent.continuation 区分内部续跑与非内部回合；handoff.message_consumed 仅代表消息被观察到，实际启动状态以持久状态记录为准。
6. compaction.started、compaction.long_wait、compaction.settled 关联 operationId。只有 started 而无 settled 表示本次压缩尚未观察到收敛；通用 compaction.event 不等价于确认该操作成功。

问题、范围、缺口、方向、澄清和错误正文只保存指纹，便于识别重复内容，不保存用户提示、模型回复、工具命令或结果正文。标识符和模型名称仍会记录；分享日志前请检查敏感信息。跨重启的指纹可比较，但重启会创建新 runtimeId。

日志异步写入，不触发模型回合，也不进入会话上下文。待写记录最多 128 条，超过时丢弃，后续记录的 dropped 字段报告丢弃数。写入失败只提醒一次并停止后续收集，不阻止任务执行。正常 shutdown 等待已排队日志写入；进程强制退出可能丢失末尾记录。
