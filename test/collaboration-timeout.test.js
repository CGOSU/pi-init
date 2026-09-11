import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCollaborationDirs } from "../extensions/collaboration-paths.ts";
import {
  abortSubagent,
  DEFAULT_COLLABORATION_TIMEOUT_MS,
  formatCollaborationTimeout,
  resolveCollaborationTimeoutMs,
  startSubagentBatch,
} from "../extensions/collaboration-spawn.ts";
import { listRuns } from "../extensions/collaboration-runs.ts";

const profile = {
  role: "developer-test",
  provider: "provider-x",
  model: "model-x",
  thinkingLevel: "high",
  systemPrompt: "test",
  allowedTools: ["read"],
};

async function sleep(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-init-collaboration-timeout-"));
  const previous = process.env.COLLABORATING_AGENTS_DIR;
  process.env.COLLABORATING_AGENTS_DIR = path.join(directory, "collaboration");
  try {
    await run(directory, resolveCollaborationDirs());
  } finally {
    if (previous === undefined) delete process.env.COLLABORATING_AGENTS_DIR;
    else process.env.COLLABORATING_AGENTS_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function context(cwd) {
  return {
    cwd,
    model: { provider: profile.provider, id: profile.model },
    sessionManager: { getSessionId: () => "parent-session" },
  };
}

function finalOutput(text = "done") {
  return JSON.stringify({
    type: "message_end",
    message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text }] },
  });
}

test("collaboration timeout is configurable with a bounded default", () => {
  assert.equal(resolveCollaborationTimeoutMs(""), DEFAULT_COLLABORATION_TIMEOUT_MS);
  assert.equal(resolveCollaborationTimeoutMs("60000"), 60000);
  assert.equal(formatCollaborationTimeout(DEFAULT_COLLABORATION_TIMEOUT_MS), "30 分钟");
  assert.throws(() => resolveCollaborationTimeoutMs("not-a-number"), /正整数/);
  assert.throws(() => resolveCollaborationTimeoutMs("0"), /必须在/);
});

test("configured timeout is recorded and invalid configuration rejects launch", async () => {
  await withDirectory(async (directory, dirs) => {
    const previous = process.env.PI_COLLAB_TIMEOUT_MS;
    process.env.PI_COLLAB_TIMEOUT_MS = "60000";
    try {
      const batch = startSubagentBatch({ exec: async () => ({ code: 0, stdout: finalOutput("configured"), stderr: "" }) }, context(directory), [{ task: "configured" }], {}, { dirs, parentAgent: "owner", profile });
      assert.equal(batch.records[0].timeoutMs, 60000);
      await sleep(40);
      assert.equal(listRuns(dirs, { parentAgent: "owner" })[0].status, "completed");
    } finally {
      if (previous === undefined) delete process.env.PI_COLLAB_TIMEOUT_MS;
      else process.env.PI_COLLAB_TIMEOUT_MS = previous;
    }
  });
  await withDirectory(async (directory, dirs) => {
    const previous = process.env.PI_COLLAB_TIMEOUT_MS;
    process.env.PI_COLLAB_TIMEOUT_MS = "invalid";
    try {
      assert.throws(() => startSubagentBatch({ exec: async () => ({ code: 0, stdout: "", stderr: "" }) }, context(directory), [{ task: "reject" }], {}, { dirs, parentAgent: "owner", profile }), /正整数/);
      assert.equal(listRuns(dirs, { parentAgent: "owner" }).length, 0);
    } finally {
      if (previous === undefined) delete process.env.PI_COLLAB_TIMEOUT_MS;
      else process.env.PI_COLLAB_TIMEOUT_MS = previous;
    }
  });
});

test("timeout remains failed with code zero and preserves diagnostic output", async () => {
  await withDirectory(async (directory, dirs) => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const batch = startSubagentBatch({ exec: async () => pending }, context(directory), [{ task: "timeout" }], {}, {
      dirs,
      parentAgent: "owner",
      profile,
      timeoutMs: 20,
    });
    await sleep(35);
    const output = finalOutput(JSON.stringify({ protocol: "pi-init/task-result@1", outcome: "complete" }));
    finish({ code: 0, killed: true, stdout: output, stderr: "" });
    await sleep(40);
    const record = listRuns(dirs, { parentAgent: "owner" })[0];
    assert.equal(record.recordId, batch.records[0].recordId);
    assert.equal(record.status, "failed");
    assert.equal(record.terminationReason, "timeout");
    assert.equal(record.exitCode, 0);
    assert.match(record.error, /超过 20 毫秒 的总时限/);
    assert.match(record.outputPreview, /pi-init\/task-result@1/);
  });
});

test("explicit cancellation remains failed and preserves the late output for diagnosis", async () => {
  await withDirectory(async (directory, dirs) => {
    let finish;
    const pending = new Promise((resolve) => { finish = resolve; });
    const batch = startSubagentBatch({ exec: async () => pending }, context(directory), [{ task: "cancel" }], {}, {
      dirs,
      parentAgent: "owner",
      profile,
      timeoutMs: 30,
    });
    await sleep(5);
    assert.equal(abortSubagent(batch.records[0].recordId), true);
    await sleep(40);
    finish({ code: 0, killed: true, stdout: finalOutput("late"), stderr: "" });
    await sleep(40);
    const record = listRuns(dirs, { parentAgent: "owner" })[0];
    assert.equal(record.status, "failed");
    assert.equal(record.terminationReason, "cancelled");
    assert.match(record.error, /用户取消/);
    assert.match(record.outputPreview, /late/);
  });
});

test("externally killed code-zero process cannot report completion", async () => {
  await withDirectory(async (directory, dirs) => {
    let settled;
    const strictResult = JSON.stringify({
      protocol: "pi-init/task-result@1",
      outcome: "complete",
      completionSummary: "late",
      implementationRationale: "late",
      verification: ["late"],
    });
    startSubagentBatch({ exec: async () => ({ code: 0, killed: true, stdout: JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: strictResult }] }],
    }), stderr: "" }) }, context(directory), [{ task: "killed" }], {
      onBatchSettled: (_batch, results) => { settled = results[0]; },
    }, { dirs, parentAgent: "owner", profile, timeoutMs: 1000 });
    await sleep(40);
    const record = listRuns(dirs, { parentAgent: "owner" })[0];
    assert.equal(record.status, "failed");
    assert.equal(record.terminationReason, "killed");
    assert.equal(settled.resultText, undefined);
    assert.match(record.outputPreview, /pi-init\/task-result@1/);
  });
});

test("agent_end assistant message is accepted only after a clean process exit", async () => {
  await withDirectory(async (directory, dirs) => {
    let settled;
    startSubagentBatch({ exec: async () => ({ code: 0, killed: false, stdout: JSON.stringify({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "clean result" }] }],
    }), stderr: "" }) }, context(directory), [{ task: "agent end" }], {
      onBatchSettled: (_batch, results) => { settled = results[0]; },
    }, { dirs, parentAgent: "owner", profile, timeoutMs: 1000 });
    await sleep(40);
    const record = listRuns(dirs, { parentAgent: "owner" })[0];
    assert.equal(record.status, "completed");
    assert.equal(settled.resultText, "clean result");
  });
});
