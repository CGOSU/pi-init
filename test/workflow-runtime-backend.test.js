import assert from "node:assert/strict";
import net from "node:net";
import test from "node:test";

import {
  createExtensionHarness,
  emitExtensionEvent,
  mkdir,
  path,
  withTempDirectory,
  writeFile,
} from "./helpers.js";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

async function writeRuntimeConfig(directory, endpoint, workflowMode = "auto") {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode,
    workflowExecutor: "runtime",
    runtime: {
      endpoint,
      agentBackend: "pi-rpc",
      permissionProfile: "safe-read-write",
      timeoutMs: 1000,
      retries: 1,
    },
    roleModels: {
      architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
      "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
    },
  }, null, 2)}\n`);
}

function ok(requestId, response, payload) {
  return `${JSON.stringify({
    version: 1,
    request_id: requestId,
    response: { status: "ok", payload: { response, payload } },
  })}\n`;
}

function errorResponse(requestId, code, message) {
  return `${JSON.stringify({
    version: 1,
    request_id: requestId,
    response: { status: "error", payload: { code, message } },
  })}\n`;
}

async function withRuntimeServer(handler, run) {
  const server = net.createServer((socket) => {
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const delimiter = buffer.indexOf("\n");
      if (delimiter < 0) return;
      const line = buffer.slice(0, delimiter).replace(/\r$/, "");
      buffer = buffer.slice(delimiter + 1);
      if (!line) return;
      const request = JSON.parse(line);
      Promise.resolve(handler(socket, request)).catch((error) => socket.destroy(error));
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  try {
    return await run(`127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function runtimePlan() {
  return {
    action: "plan",
    summary: "Runtime authority mapping",
    constraints: ["Runtime owns execution"],
    tasks: [
      {
        id: "prepare",
        role: "developer-test",
        task: "Prepare the workspace",
        files: ["src/prepare.js", "test/prepare.test.js"],
        acceptanceCriteria: ["the workspace is ready"],
      },
      {
        id: "verify",
        role: "developer-test",
        task: "Verify the workspace",
        files: ["src/verify.js"],
        acceptanceCriteria: ["verification passes"],
        dependsOn: ["prepare"],
      },
    ],
  };
}

function workflowEntry(branch) {
  return [...branch].reverse().find((entry) => entry.customType === "pi-init-workflow");
}

test("runtime executor without explicit endpoint/profile fails closed before state creation", async () => {
  await withTempDirectory(async (directory) => {
    await mkdir(path.join(directory, ".pi"), { recursive: true });
    await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
      schemaVersion: 2,
      mode: "auto",
      workflowMode: "on",
      workflowExecutor: "runtime",
      roleModels: {
        architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
        "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
      },
    })}\n`);
    const harness = createExtensionHarness([], {
      cwd: directory,
      trusted: true,
      model: architect,
      availableModels: [architect, developer],
    });
    await emitExtensionEvent(harness, "session_start");
    const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
    await assert.rejects(
      workflow.execute("runtime-no-config", runtimePlan(), undefined, undefined, harness.context),
      (error) => error.code === "missing_endpoint",
    );
    assert.equal(harness.branch.length, 0);
  });
});

test("runtime workflow submits one frozen graph with exact task/profile mapping", async () => {
  const submitted = [];
  await withTempDirectory(async (directory) => {
    await withRuntimeServer((socket, request) => {
      const command = request.command.command;
      if (command === "submit_graph") {
        submitted.push(request.command.payload.graph);
        socket.end(ok(request.request_id, "graph_submitted", {
          graph_revision: request.command.payload.graph.graph_revision,
        }));
      } else if (command === "read_events") {
        socket.end(ok(request.request_id, "events", { events: [] }));
      } else if (command === "query_graph") {
        const graph = submitted[0];
        socket.end(ok(request.request_id, "state", { state: {
          graph_revision: graph.graph_revision,
          tasks: graph.tasks.map((task, index) => ({
            task_id: task.task_id,
            state: index === 0 ? "ready" : "pending",
          })),
          attempts: [],
          active_attempt_id: null,
        } }));
      } else {
        socket.end(errorResponse(request.request_id, "invalid_command", `unexpected ${command}`));
      }
    }, async (endpoint) => {
      await writeRuntimeConfig(directory, endpoint, "auto");
      const branch = [];
      const harness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: architect,
        availableModels: [architect, developer],
      });
      await emitExtensionEvent(harness, "session_start");
      const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
      const result = await workflow.execute("runtime-plan", runtimePlan(), undefined, undefined, harness.context);
      assert.equal(result.details.executor, "runtime");
      assert.equal(result.details.authority, "runtime");
      assert.equal(result.details.runtimeAuthority.status, "running", JSON.stringify(result.details));
      assert.equal(submitted.length, 1);
      const graph = submitted[0];
      assert.equal(graph.graph_revision.revision, 1);
      assert.deepEqual(graph.tasks.map((task) => task.task_id), ["prepare", "verify"]);
      assert.deepEqual(graph.tasks[1].dependencies, ["prepare"]);
      assert.deepEqual(graph.tasks[0].acceptance_criteria, ["the workspace is ready"]);
      assert.match(graph.tasks[0].input, /src\/prepare\.js/);
      assert.equal(graph.tasks[0].profile_snapshot.agent_backend, "pi-rpc");
      assert.equal(graph.tasks[0].profile_snapshot.model_provider, developer.provider);
      assert.equal(graph.tasks[0].profile_snapshot.model, developer.id);
      assert.equal(graph.tasks[0].profile_snapshot.permission_profile, "safe-read-write");
      assert.equal(workflowEntry(branch).data.authority, "runtime");
      await emitExtensionEvent(harness, "session_shutdown");
    });
  });
});

test("Runtime ResultAccepted events complete the projection and are acknowledged after processing", async () => {
  const submitted = [];
  let reads = 0;
  await withTempDirectory(async (directory) => {
    await withRuntimeServer((socket, request) => {
      const command = request.command.command;
      if (command === "submit_graph") {
        submitted.push(request.command.payload.graph);
        socket.end(ok(request.request_id, "graph_submitted", {
          graph_revision: request.command.payload.graph.graph_revision,
        }));
      } else if (command === "read_events") {
        reads += 1;
        const graph = submitted[0];
        const events = reads === 1 ? graph.tasks.map((task, index) => ({
          event: "result_accepted",
          payload: {
            header: { event_id: index + 1, graph_revision: graph.graph_revision },
            result: { task_id: task.task_id, output: `${task.task_id} accepted` },
          },
        })) : [];
        socket.end(ok(request.request_id, "events", { events }));
      } else if (command === "query_graph") {
        const graph = submitted[0];
        socket.end(ok(request.request_id, "state", { state: {
          graph_revision: graph.graph_revision,
          tasks: graph.tasks.map((task) => ({ task_id: task.task_id, state: "succeeded" })),
          attempts: [],
          active_attempt_id: null,
        } }));
      } else if (command === "acknowledge_events") {
        socket.end(ok(request.request_id, "events_acknowledged", {
          graph_id: request.command.payload.graph_id,
          event_id: request.command.payload.event_id,
        }));
      } else {
        socket.end(errorResponse(request.request_id, "invalid_command", `unexpected ${command}`));
      }
    }, async (endpoint) => {
      await writeRuntimeConfig(directory, endpoint, "on");
      const branch = [];
      const harness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: architect,
        availableModels: [architect, developer],
      });
      await emitExtensionEvent(harness, "session_start");
      const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
      const result = await workflow.execute("runtime-complete", runtimePlan(), undefined, undefined, harness.context);
      assert.equal(result.details.status, "completed");
      assert.equal(result.details.runtimeAuthority.eventCursor, 2);
      assert.equal(result.details.tasks.every((task) => task.status === "completed"), true);
      assert.equal(result.details.tasks[0].completionSummary, "prepare accepted");
      await emitExtensionEvent(harness, "session_shutdown");
    });
  });
});

test("runtime cancel and retry use Runtime commands rather than local state transitions", async () => {
  const submitted = [];
  let phase = "running";
  let reads = 0;
  const commands = [];
  await withTempDirectory(async (directory) => {
    await withRuntimeServer((socket, request) => {
      const command = request.command.command;
      commands.push(command);
      if (command === "submit_graph") {
        submitted.push(request.command.payload.graph);
        socket.end(ok(request.request_id, "graph_submitted", {
          graph_revision: request.command.payload.graph.graph_revision,
        }));
      } else if (command === "read_events") {
        reads += 1;
        const graph = submitted[0];
        const events = reads === 1 ? [] : [{
          event: phase === "cancelled" ? "attempt_cancelled" : "task_retried",
          payload: { header: { event_id: reads - 1, graph_revision: graph.graph_revision } },
        }];
        socket.end(ok(request.request_id, "events", { events }));
      } else if (command === "query_graph") {
        const graph = submitted[0];
        const firstState = phase === "failed" ? "failed" : phase === "cancelled" ? "cancelled" : phase === "running" ? "running" : "ready";
        socket.end(ok(request.request_id, "state", { state: {
          graph_revision: graph.graph_revision,
          tasks: graph.tasks.map((task, index) => ({
            task_id: task.task_id,
            state: index === 0 ? firstState : "pending",
          })),
          attempts: phase === "cancelled" ? [] : [{
            attempt_id: "runtime-attempt",
            graph_revision: graph.graph_revision,
            task_id: graph.tasks[0].task_id,
            lease_epoch: 1,
            worker_id: "runtime-worker",
            protocol_version: 2,
            profile_snapshot: graph.tasks[0].profile_snapshot,
            state: "running",
          }],
          active_attempt_id: phase === "cancelled" ? null : "runtime-attempt",
        } }));
      } else if (command === "retry_task") {
        phase = "ready";
        socket.end(ok(request.request_id, "task_retried", {
          graph_revision: request.command.payload.graph_revision,
          task_id: request.command.payload.task_id,
        }));
      } else if (command === "cancel_attempt") {
        phase = "cancelled";
        socket.end(ok(request.request_id, "attempt_cancelled", { attempt: {
          attempt_id: request.command.payload.attempt_id,
        } }));
      } else if (command === "acknowledge_events") {
        socket.end(ok(request.request_id, "events_acknowledged", {
          graph_id: request.command.payload.graph_id,
          event_id: request.command.payload.event_id,
        }));
      } else {
        socket.end(errorResponse(request.request_id, "invalid_command", `unexpected ${command}`));
      }
    }, async (endpoint) => {
      await writeRuntimeConfig(directory, endpoint, "on");
      const branch = [];
      const harness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: architect,
        availableModels: [architect, developer],
      });
      await emitExtensionEvent(harness, "session_start");
      const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
      const planned = await workflow.execute("runtime-running", runtimePlan(), undefined, undefined, harness.context);
      assert.equal(planned.details.status, "running");
      await emitExtensionEvent(harness, "agent_start");
      await emitExtensionEvent(harness, "input", { source: "user", text: "follow-up must not mutate Runtime authority" });
      assert.equal(workflowEntry(branch).data.tasks[0].executionStartedAt, undefined);
      assert.equal(workflowEntry(branch).data.pendingRevision, undefined);
      const cancelled = await workflow.execute("runtime-cancel", { action: "cancel" }, undefined, undefined, harness.context);
      assert.equal(cancelled.details.status, "cancelled");
      const retried = await workflow.execute("runtime-retry", { action: "retry", taskId: "prepare" }, undefined, undefined, harness.context);
      assert.equal(retried.details.status, "running");
      assert.equal(retried.details.tasks[0].status, "pending");
      assert.ok(commands.includes("cancel_attempt"));
      assert.ok(commands.includes("retry_task"));
      await emitExtensionEvent(harness, "session_shutdown");
    });
  });
});

test("runtime RecoveryUnknown remains a truthful blocked projection and never falls back locally", async () => {
  const submitted = [];
  await withTempDirectory(async (directory) => {
    await withRuntimeServer((socket, request) => {
      if (request.command.command === "submit_graph") {
        submitted.push(request.command.payload.graph);
        socket.end(ok(request.request_id, "graph_submitted", {
          graph_revision: request.command.payload.graph.graph_revision,
        }));
        return;
      }
      if (request.command.command === "read_events") {
        socket.end(ok(request.request_id, "events", { events: [] }));
        return;
      }
      socket.end(errorResponse(request.request_id, "recovery_unknown", "Runtime execution evidence is unavailable"));
    }, async (endpoint) => {
      await writeRuntimeConfig(directory, endpoint, "on");
      const branch = [];
      const harness = createExtensionHarness(branch, {
        cwd: directory,
        trusted: true,
        model: architect,
        availableModels: [architect, developer],
      });
      await emitExtensionEvent(harness, "session_start");
      const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
      const result = await workflow.execute("runtime-unknown", runtimePlan(), undefined, undefined, harness.context);
      assert.equal(submitted.length, 1);
      assert.equal(result.details.runtimeAuthority.status, "unknown");
      assert.equal(result.details.status, "running");
      assert.equal(result.details.tasks.every((task) => task.status === "pending"), true);
      assert.equal(harness.sentMessages.some(({ message }) => message?.customType === "pi-init-workflow-task"), false);
      assert.equal(harness.notifications.length > 0, true);
      await emitExtensionEvent(harness, "session_shutdown");
    });
  });
});
