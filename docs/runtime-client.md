# pi-init Runtime client

`extensions/runtime-client.ts` 是 pi-init 到 agent-runtime 的薄 transport client。它只负责 loopback JSONL 通信、请求重试和响应解码，不保存调度状态，不计算 next task，不持有 Worker/Agent 进程，也不读取模型凭据。

## 显式配置

```js
import { RuntimeClient } from "../extensions/runtime-client.ts";

const client = new RuntimeClient({
  endpoint: "127.0.0.1:7878",
  timeoutMs: 5000,
  retries: 2,
});
```

`endpoint` 必须显式提供，并且只能是数字 loopback 地址 `127.0.0.0/8` 或 `[::1]`；`localhost`、公网/局域网地址和端口 `0` 都拒绝。也可以使用 `loadRuntimeClientConfig()` 从显式的 `PI_INIT_RUNTIME_ENDPOINT` 环境变量读取，未设置时不会猜测 daemon 地址。

## wire 与重试

每个请求使用独立 LF-delimited JSON frame：

```json
{"version":1,"request_id":"...","command":{"command":"query_graph","payload":{"protocol_version":2,"graph_id":"graph-a","revision":null}}}
```

wire frame 上限为 128 KiB，request id 上限为 128 bytes。连接是单请求 bounded connection；断线或响应丢失只重试 transport error，并复用完全相同的 `request_id` 与 payload。Runtime server 的 replay cache 因而可以返回同一响应；结构化 Runtime error、协议版本不匹配、身份/权限错误和 `RecoveryUnknown` 不会被转成空状态，也不会盲目重试。

调用方可以为需要跨调用重放的操作提供稳定 request id：

```js
await client.acknowledgeEvents("graph-a", 12, { requestId: "ack-graph-a-12" });
```

不要用同一个 request id 发送不同 payload。Runtime 会拒绝冲突；client 不替换或吞掉该错误。

## API

- `queryGraph({ graphId, revision })`：读取 Runtime state；不生成 next task。
- `readEvents({ graphId, afterEventId, limit })`：读取事件；省略 cursor 时使用 Runtime session cursor。
- `acknowledgeEvents(graphId, eventId)`：显式确认已处理事件。应先完成本地处理，再调用 ack；失败时保留未确认事件。
- `cancelAttempt({ graphRevision, attemptId, leaseEpoch, reason })`：提交 Runtime cancel decision。
- `retryTask({ graphRevision, taskId, reason })`：请求 Runtime retry。
- `request(command, options)`：发送已构造的 Runtime command，返回 inner response payload，供新 command 逐步接入。

所有方法都返回 Runtime 的 typed response payload；`RuntimeClientError` 保留稳定 `code`、`requestId` 和 `retryable` 标志。客户端不解释 Agent 输出、Acceptance、Worker phase 或 recovery 证明。

## 当前边界

本 client 与已有 local/collaboration workflow 并行存在，默认不改变其 authority。Runtime backend 的 workflow graph 映射、事件驱动角色执行、cancel/retry UI 和 authority 冻结属于后续迁移任务；本阶段只提供可重连 transport 基础。
