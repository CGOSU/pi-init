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

test("identical observations do not evict distinct progress or claim semantic progress", () => {
  let memory = recordTaskObservations(createTaskMemory(identity), [observation("actual-work")], "actual-work");
  for (let i = 0; i < 40; i++) {
    const repeated = { ...observation("read-" + i), toolName: "read", inputHash: "same-path-and-range", outputHash: "same-content" };
    memory = recordTaskObservations(memory, [repeated], repeated.id);
  }
  assert.ok(memory.observations.some(item => item.id === "actual-work"));
  assert.equal(memory.observations.length, 2);
  assert.equal(memory.observations.at(-1).id, "read-39");
  assert.equal(memory.progressRevision, 0);
  memory = recordTaskObservations(memory, [{ ...observation("changed"), toolName: "read", inputHash: "same-path-and-range", outputHash: "changed-content" }], "changed");
  assert.equal(memory.observations.length, 3);
});

test("identical command receipts are not collapsed because side effects may repeat", () => {
  const first = { ...observation("command-1"), inputHash: "same-command", outputHash: "same-output" };
  const second = { ...first, id: "command-2", toolCallId: "command-2" };
  const memory = recordTaskObservations(createTaskMemory(identity), [first, second], second.id);
  assert.deepEqual(memory.observations.map(item => item.id), ["command-1", "command-2"]);
});

function checkpointFor(id, files) {
  return { step: "continue", accomplished: id ? [{ summary: "Observed progress", evidenceIds: [id] }] : [], remaining: ["finish"], blockers: [], nextStep: "finish", ...(files ? { files } : {}) };
}

test("checkpoint progress counts new successful sources once across the task history", () => {
  const first = observation("first");
  const second = observation("second");
  let memory = recordTaskObservations(createTaskMemory(identity), [first, second], second.id);
  const savedFirst = checkpointTaskMemory(memory, checkpointFor(first.id));
  const savedSecond = checkpointTaskMemory(savedFirst, checkpointFor(second.id), [savedFirst]);
  memory = checkpointTaskMemory(savedSecond, checkpointFor(first.id), [savedFirst, savedSecond]);
  assert.equal(memory.progressRevision, 2, "rotating old checkpoint sources must not renew progress");
  const repeated = { ...first, id: "repeated", toolCallId: "repeated", outputHash: "new-elapsed-time" };
  memory = recordTaskObservations(memory, [repeated], repeated.id);
  memory = checkpointTaskMemory(memory, checkpointFor(repeated.id), [savedFirst, savedSecond]);
  assert.equal(memory.progressRevision, 2, "a successful identical command is not new work because its timing changed");
  const failed = observation("failed", "tool-error");
  memory = recordTaskObservations(memory, [failed], failed.id);
  assert.equal(checkpointTaskMemory(memory, checkpointFor(failed.id), [savedFirst, savedSecond]).progressRevision, 2);
});

test("explicit new read findings count, while repeated content and old reads do not", () => {
  const first = { ...observation("read-first"), toolName: "read" };
  const repeated = { ...first, id: "read-repeat", toolCallId: "read-repeat" };
  const changed = { ...first, id: "read-changed", toolCallId: "read-changed", outputHash: "changed-content" };
  let memory = recordTaskObservations(createTaskMemory(identity), [first], first.id);
  const savedFirst = checkpointTaskMemory(memory, checkpointFor(first.id));
  memory = recordTaskObservations(savedFirst, [repeated, changed], changed.id);
  assert.equal(memory.progressRevision, 1, "ordinary observations alone are not progress");
  memory = checkpointTaskMemory(memory, checkpointFor(repeated.id), [savedFirst]);
  assert.equal(memory.progressRevision, 1);
  const savedChanged = checkpointTaskMemory(memory, checkpointFor(changed.id), [savedFirst]);
  assert.equal(savedChanged.progressRevision, 2);
  assert.equal(checkpointTaskMemory(savedChanged, checkpointFor(first.id), [savedFirst, savedChanged]).progressRevision, 2);
});

test("file progress requires a new hash for a previously recorded path, not a different file list", () => {
  const file = (path, hash) => ({ path, hash: hash.repeat(64) });
  const a = file("source.ts", "a"), b = file("source.ts", "b"), other = file("other.ts", "c");
  const savedA = checkpointTaskMemory(createTaskMemory(identity), checkpointFor(undefined, [a]));
  assert.equal(savedA.progressRevision, 0);
  const added = checkpointTaskMemory(savedA, checkpointFor(undefined, [other, a]), [savedA]);
  const removed = checkpointTaskMemory(added, checkpointFor(undefined, [other]), [savedA, added]);
  const reordered = checkpointTaskMemory(removed, checkpointFor(undefined, [a, other]), [savedA, added, removed]);
  assert.equal(reordered.progressRevision, 0);
  const savedB = checkpointTaskMemory(reordered, checkpointFor(undefined, [b]), [savedA, added, removed, reordered]);
  assert.equal(savedB.progressRevision, 1);
  assert.equal(checkpointTaskMemory(savedB, checkpointFor(undefined, [a]), [savedA, savedB]).progressRevision, 1);
  const otherTask = { ...savedB, identity: { ...identity, taskId: "different" } };
  assert.equal(checkpointTaskMemory(savedA, checkpointFor(undefined, [b]), [otherTask]).progressRevision, 1);
});
