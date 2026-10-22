import assert from "node:assert/strict";
import test from "node:test";
import { createTaskMemory, recordTaskObservations, checkpointTaskMemory, parseTaskMemory } from "../src/task-memory.ts";
const identity = { sessionId: "s", workflowId: "w", planVersion: 0, recoveryGeneration: 0, taskId: "t", attemptId: "a", handoffId: "h" };
function observation(id, outcome = "tool-ok") { return { id, messageEntryId: "message", toolCallId: id, toolName: "bash", inputHash: "input-" + id, outputHash: "output-" + id, outcome, summary: "Tests 91 passed", truncated: false }; }
test("memory records success and failure once, without mutating input or implying acceptance", () => {
  const empty = createTaskMemory(identity);
  const memory = recordTaskObservations(empty, [observation("ok"), observation("error", "tool-error")], "error");
  assert.equal(empty.observations.length, 0);
  assert.equal(memory.observations.length, 2);
  assert.equal(recordTaskObservations(memory, [observation("ok")], "error"), memory);
  assert.equal(memory.status, undefined);
  assert.deepEqual(parseTaskMemory(memory), memory);
});
test("checkpoint references must exist and pinned success survives bounded observation history", () => {
  let memory = recordTaskObservations(createTaskMemory(identity), [observation("verified")], "verified");
  const checkpoint = { step: "package", accomplished: [{ summary: "Historical verification", evidenceIds: ["verified"] }], remaining: ["generate patch"], blockers: [], nextStep: "generate patch" };
  memory = checkpointTaskMemory(memory, checkpoint);
  const revision = memory.revision;
  assert.equal(checkpointTaskMemory(memory, checkpoint), memory);
  for (let i = 0; i < 100; i++) memory = recordTaskObservations(memory, [observation("later-" + i)], "later-" + i);
  assert.ok(memory.observations.some(item => item.id === "verified"));
  assert.ok(memory.observations.length <= 48);
  assert.equal(memory.revision, revision);
  assert.throws(() => checkpointTaskMemory(memory, { ...checkpoint, accomplished: [{ summary: "fake", evidenceIds: ["missing"] }] }), error => error.code === "TASK_MEMORY_SOURCE_MISSING");
});
test("untrusted snapshots cannot smuggle arbitrary shapes or an unsupported schema", () => {
  assert.equal(parseTaskMemory({ ...createTaskMemory(identity), version: 2 }), undefined);
  assert.equal(parseTaskMemory({ ...createTaskMemory(identity), observations: [{ id: "fake" }] }), undefined);
  assert.equal(parseTaskMemory({ ...createTaskMemory(identity), identity: { ...identity, attemptId: "" } }), undefined);
});
