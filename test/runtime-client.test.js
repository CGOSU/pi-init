import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  MAX_JSON_FRAME_BYTES,
  RUNTIME_WIRE_VERSION,
  RuntimeWireError,
  decodeRuntimeResponse,
  encodeRequest,
  parseLoopbackEndpoint,
} from "../extensions/runtime-wire.ts";
import {
  RuntimeClient,
  RuntimeClientError,
} from "../extensions/runtime-client.ts";
import {
  RuntimeClientConfigError,
  createRuntimeClientConfig,
  loadRuntimeClientConfig,
} from "../extensions/runtime-client-config.ts";

const statePayload = {
  tasks: [{ task_id: "task-a", state: "pending" }],
  attempts: [],
  active_attempt_id: null,
};

function ok(requestId, response, payload) {
  return JSON.stringify({
    version: RUNTIME_WIRE_VERSION,
    request_id: requestId,
    response: { status: "ok", payload: { response, payload } },
  }) + "\n";
}

function errorResponse(requestId, code, message) {
  return JSON.stringify({
    version: RUNTIME_WIRE_VERSION,
    request_id: requestId,
    response: { status: "error", payload: { code, message } },
  }) + "\n";
}

async function withServer(handler, run) {
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let delimiter;
      while ((delimiter = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, delimiter).replace(/\r$/, "");
        buffer = buffer.slice(delimiter + 1);
        if (!line) continue;
        Promise.resolve(handler(socket, JSON.parse(line))).catch((error) => socket.destroy(error));
      }
    });
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const endpoint = `127.0.0.1:${address.port}`;
  try {
    return await run(endpoint);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("runtime wire accepts only explicit numeric loopback endpoints", () => {
  assert.deepEqual(parseLoopbackEndpoint("127.0.0.1:7878"), {
    host: "127.0.0.1",
    port: 7878,
    address: "127.0.0.1:7878",
  });
  assert.deepEqual(parseLoopbackEndpoint("[::1]:7878").host, "::1");
  for (const endpoint of ["localhost:7878", "0.0.0.0:7878", "192.168.1.1:1", "127.0.0.1:0", "127.0.0.1", "[::ffff:127.0.0.1]:1"]) {
    assert.throws(() => parseLoopbackEndpoint(endpoint), RuntimeWireError, endpoint);
  }
  assert.throws(() => createRuntimeClientConfig(), RuntimeClientConfigError);
  assert.throws(() => loadRuntimeClientConfig({}), (error) => error.code === "missing_endpoint");
  const config = loadRuntimeClientConfig({
    PI_INIT_RUNTIME_ENDPOINT: "127.0.0.1:7878",
    PI_INIT_RUNTIME_TIMEOUT_MS: "1200",
    PI_INIT_RUNTIME_RETRIES: "3",
  });
  assert.equal(config.timeoutMs, 1200);
  assert.equal(config.retries, 3);
});

test("runtime wire bounds frames and rejects malformed/version-mismatched responses", () => {
  const encoded = encodeRequest(
    { command: "query_graph", payload: { graph_id: "graph-a", revision: null } },
    "request-a",
  );
  assert.equal(encoded.endsWith("\n"), true);
  assert.equal(JSON.parse(encoded).request_id, "request-a");
  assert.throws(
    () => encodeRequest({ command: "query_graph", payload: { value: "x".repeat(MAX_JSON_FRAME_BYTES) } }, "large"),
    (error) => error.code === "request_frame_too_large",
  );
  assert.throws(() => decodeRuntimeResponse("not-json"), (error) => error.code === "invalid_response_json");
  assert.throws(
    () => decodeRuntimeResponse(JSON.stringify({ version: 99, request_id: "a", response: {} })),
    (error) => error.code === "unsupported_wire_version",
  );
  assert.throws(
    () => decodeRuntimeResponse(JSON.stringify({ version: 1, request_id: "a", response: { status: "error", payload: { code: "recovery_unknown", message: "still unknown" } } })),
    (error) => error.code === "recovery_unknown" && error.retryable === false,
  );
});

test("response loss retries the exact same request id and payload", async () => {
  const seen = [];
  let first = true;
  await withServer((socket, request) => {
    seen.push(request);
    if (first) {
      first = false;
      socket.destroy();
      return;
    }
    socket.end(ok(request.request_id, "events", { events: [] }));
  }, async (endpoint) => {
    const client = new RuntimeClient({ endpoint, timeoutMs: 1000, retries: 1 });
    assert.deepEqual(await client.readEvents("graph-a", { limit: 1 }), []);
  });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].request_id, seen[1].request_id);
  assert.deepEqual(seen[0].command, seen[1].command);
});

test("ack response loss retries the same id without replaying the side effect", async () => {
  const seen = [];
  let applied = 0;
  await withServer((socket, request) => {
    seen.push(request);
    if (applied === 0) {
      applied += 1;
      socket.destroy();
      return;
    }
    socket.end(ok(request.request_id, "events_acknowledged", {
      graph_id: "graph-a",
      event_id: 1,
    }));
  }, async (endpoint) => {
    const client = new RuntimeClient({ endpoint, timeoutMs: 1000, retries: 1 });
    assert.deepEqual(
      await client.acknowledgeEvents("graph-a", 1, { requestId: "ack-response-loss" }),
      { graph_id: "graph-a", event_id: 1 },
    );
  });
  assert.equal(applied, 1);
  assert.equal(seen.length, 2);
  assert.equal(seen[0].request_id, "ack-response-loss");
  assert.equal(seen[1].request_id, "ack-response-loss");
});

test("separate client instances do not collide in the broker replay cache", async () => {
  const seen = [];
  await withServer((socket, request) => {
    seen.push(request);
    socket.end(ok(request.request_id, "events", { events: [] }));
  }, async (endpoint) => {
    const first = new RuntimeClient({ endpoint, timeoutMs: 1000, retries: 0 });
    const second = new RuntimeClient({ endpoint, timeoutMs: 1000, retries: 0 });
    await first.readEvents("graph-a", { limit: 1 });
    await second.readEvents("graph-a", { limit: 1 });
  });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0].request_id, seen[1].request_id);
});

test("structured Runtime errors are returned truthfully without retry or empty-state fallback", async () => {
  const seen = [];
  await withServer((socket, request) => {
    seen.push(request);
    socket.end(errorResponse(request.request_id, "recovery_unknown", "execution evidence is unavailable"));
  }, async (endpoint) => {
    const client = new RuntimeClient({ endpoint, timeoutMs: 1000, retries: 3 });
    await assert.rejects(
      client.queryGraph("graph-a"),
      (error) => error instanceof RuntimeClientError
        && error.code === "recovery_unknown"
        && error.retryable === false,
    );
  });
  assert.equal(seen.length, 1);
});

test("read-before-ack and reconnecting command methods preserve typed payloads", async () => {
  const seen = [];
  await withServer((socket, request) => {
    seen.push(request);
    switch (request.command.command) {
      case "query_graph":
        socket.end(ok(request.request_id, "state", { state: statePayload }));
        break;
      case "read_events":
        socket.end(ok(request.request_id, "events", { events: [{ event_id: 1, kind: "attempt_started" }] }));
        break;
      case "acknowledge_events":
        socket.end(ok(request.request_id, "events_acknowledged", {
          graph_id: request.command.payload.graph_id,
          event_id: request.command.payload.event_id,
        }));
        break;
      case "cancel_attempt":
        socket.end(ok(request.request_id, "attempt_cancelled", { attempt: { attempt_id: "attempt-a" } }));
        break;
      case "retry_task":
        socket.end(ok(request.request_id, "task_retried", {
          graph_revision: request.command.payload.graph_revision,
          task_id: request.command.payload.task_id,
        }));
        break;
      default:
        socket.end(errorResponse(request.request_id, "invalid_command", "unexpected command"));
    }
  }, async (endpoint) => {
    const client = new RuntimeClient({ endpoint, timeoutMs: 1000, retries: 1 });
    assert.deepEqual(await client.queryGraph({ graphId: "graph-a", revision: 1 }), statePayload);
    const events = await client.readEvents({ graphId: "graph-a", afterEventId: 0, limit: 10 });
    assert.equal(events.length, 1);
    const acknowledged = await client.acknowledgeEvents("graph-a", 1, { requestId: "ack-once" });
    assert.deepEqual(acknowledged, { graph_id: "graph-a", event_id: 1 });
    assert.deepEqual(
      await client.cancelAttempt({
        graphRevision: { graphId: "graph-a", revision: 1 },
        attemptId: "attempt-a",
        leaseEpoch: 1,
        reason: "user requested cancellation",
      }),
      { attempt_id: "attempt-a" },
    );
    assert.deepEqual(
      await client.retryTask({
        graphRevision: { graphId: "graph-a", revision: 1 },
        taskId: "task-a",
        reason: "retry after inspection",
      }),
      { graph_revision: { graph_id: "graph-a", revision: 1 }, task_id: "task-a" },
    );
  });
  assert.deepEqual(seen.map((request) => request.command.command), [
    "query_graph",
    "read_events",
    "acknowledge_events",
    "cancel_attempt",
    "retry_task",
  ]);
  assert.deepEqual(seen[1].command.payload.after_event_id, 0);
  assert.equal(seen[2].request_id, "ack-once");
});

test("caller-controlled request ids let ack retries replay but reject payload conflicts", async () => {
  const seen = [];
  const fingerprints = new Map();
  await withServer((socket, request) => {
    seen.push(request);
    const fingerprint = JSON.stringify(request.command);
    const previous = fingerprints.get(request.request_id);
    if (previous && previous !== fingerprint) {
      socket.end(errorResponse(request.request_id, "request_id_conflict", "request id payload conflicts"));
      return;
    }
    fingerprints.set(request.request_id, fingerprint);
    socket.destroy();
  }, async (endpoint) => {
    const client = new RuntimeClient({ endpoint, timeoutMs: 1000, retries: 1 });
    await assert.rejects(
      client.acknowledgeEvents("graph-a", 1, { requestId: "ack-retry" }),
      (error) => error.code === "transport_closed",
    );
    await assert.rejects(
      client.request({ command: "acknowledge_events", payload: { graph_id: "graph-a", event_id: 2 } }, { requestId: "ack-retry" }),
      (error) => error.code === "request_id_conflict",
    );
  });
  assert.equal(seen.length, 3);
  assert.equal(seen[0].request_id, "ack-retry");
  assert.equal(seen[1].request_id, "ack-retry");
  assert.equal(seen[2].request_id, "ack-retry");
});
