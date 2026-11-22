import assert from "node:assert/strict";
import test from "node:test";
import { createTaskMemory, parseTaskCheckpoint, parseTaskMemory, parseTaskMemoryIdentity } from "../src/task-memory.ts";

const identity = { sessionId: "s", workflowId: "w", planVersion: 0, recoveryGeneration: 0, taskId: "t", attemptId: "a", handoffId: "h" };
const checkpoint = { step: "verify", accomplished: [{ summary: "Observed result", evidenceIds: ["source"] }], remaining: [], blockers: [], nextStep: "finish" };
const observation = { id: "source", messageEntryId: "message", toolCallId: "call", toolName: "bash", inputHash: "input", outputHash: "output", outcome: "tool-ok", summary: "result", truncated: false };

function rejected(result, code, field) {
  assert.equal(result?.ok, false);
  assert.equal(result.code, code);
  assert.equal(result.field, field);
  assert.ok(result.message.includes(field));
}

test("task memory parsers distinguish missing, type, range, format, and unsupported version failures", () => {
  for (const [parser, input, code, field] of [
    [parseTaskMemory, undefined, "TASK_MEMORY_INPUT_MISSING", "memory"],
    [parseTaskMemory, [], "TASK_MEMORY_INPUT_TYPE", "memory"],
    [parseTaskMemory, { ...createTaskMemory(identity), version: "1" }, "TASK_MEMORY_INPUT_TYPE", "memory.version"],
    [parseTaskMemory, { ...createTaskMemory(identity), version: 2 }, "TASK_MEMORY_VERSION_UNSUPPORTED", "memory.version"],
    [parseTaskMemory, { ...createTaskMemory(identity), revision: -1 }, "TASK_MEMORY_INPUT_RANGE", "memory.revision"],
    [parseTaskMemory, { ...createTaskMemory(identity), progressRevision: 0.5 }, "TASK_MEMORY_INPUT_FORMAT", "memory.progressRevision"],
    [parseTaskMemory, { ...createTaskMemory(identity), omittedObservations: Number.MAX_SAFE_INTEGER + 1 }, "TASK_MEMORY_INPUT_RANGE", "memory.omittedObservations"],
    [parseTaskMemoryIdentity, { ...identity, attemptId: undefined }, "TASK_MEMORY_INPUT_MISSING", "identity.attemptId"],
    [parseTaskMemoryIdentity, { ...identity, handoffId: false }, "TASK_MEMORY_INPUT_TYPE", "identity.handoffId"],
    [parseTaskMemoryIdentity, { ...identity, attemptId: "" }, "TASK_MEMORY_INPUT_RANGE", "identity.attemptId"],
    [parseTaskMemoryIdentity, { ...identity, recoveryGeneration: -1 }, "TASK_MEMORY_INPUT_RANGE", "identity.recoveryGeneration"],
    [parseTaskCheckpoint, { ...checkpoint, blockers: undefined }, "TASK_MEMORY_INPUT_MISSING", "checkpoint.blockers"],
    [parseTaskCheckpoint, { ...checkpoint, remaining: "none" }, "TASK_MEMORY_INPUT_TYPE", "checkpoint.remaining"],
    [parseTaskCheckpoint, { ...checkpoint, accomplished: [{ summary: "result", evidenceIds: [] }] }, "TASK_MEMORY_INPUT_RANGE", "checkpoint.accomplished[0].evidenceIds"],
    [parseTaskCheckpoint, { ...checkpoint, files: [{ path: "source.ts", hash: "not-a-hash" }] }, "TASK_MEMORY_INPUT_FORMAT", "checkpoint.files[0].hash"],
    [parseTaskMemory, { ...createTaskMemory(identity), observations: [{ ...observation, outcome: ["tool-ok"] }] }, "TASK_MEMORY_INPUT_TYPE", "memory.observations[0].outcome"],
  ]) rejected(parser(input), code, field);
});

test("snapshot parsing reports duplicate and missing source references instead of accepting unusable progress", () => {
  const memory = { ...createTaskMemory(identity), observations: [observation], checkpoint };
  rejected(parseTaskMemory({ ...memory, observations: [observation, { ...observation }] }), "TASK_MEMORY_SOURCE_DUPLICATE", "memory.observations[1].id");
  rejected(parseTaskMemory({ ...memory, checkpoint: { ...checkpoint, accomplished: [{ summary: "unverified", evidenceIds: ["missing"] }] } }), "TASK_MEMORY_SOURCE_MISSING", "memory.checkpoint.accomplished[0].evidenceIds");
  rejected(parseTaskMemory({ ...memory, checkpoint: { ...checkpoint, nextStep: 1 } }), "TASK_MEMORY_INPUT_TYPE", "memory.checkpoint.nextStep");
});

test("snapshot parsing enforces the pinned source limit even when every referenced observation exists", () => {
  const observations = Array.from({ length: 33 }, (_, index) => ({ ...observation, id: "source-" + index }));
  const accomplished = Array.from({ length: 5 }, (_, group) => ({
    summary: "Observed group", evidenceIds: observations.slice(group * 8, group * 8 + 8).map(item => item.id),
  }));
  const memory = { ...createTaskMemory(identity), observations, checkpoint: { ...checkpoint, accomplished } };
  rejected(parseTaskMemory(memory), "TASK_MEMORY_INPUT_RANGE", "memory.checkpoint.accomplished");
  memory.checkpoint.accomplished.at(-1).evidenceIds = ["source-0"];
  assert.equal(parseTaskMemory(memory).ok, true, "repeated references do not consume additional pinned source slots");
});

test("successful parsing projects known fields and detaches nested values without altering serialized data", () => {
  const files = [{ path: "source.ts", hash: "a".repeat(64) }];
  const memory = { ...createTaskMemory(identity), observations: [observation], checkpoint: { ...checkpoint, files } };
  const external = structuredClone(memory);
  external.extra = "ignored";
  external.identity.extra = "ignored";
  external.observations[0].extra = "ignored";
  external.checkpoint.accomplished[0].extra = "ignored";
  external.checkpoint.files[0].extra = "ignored";
  const parsed = parseTaskMemory(external);
  assert.equal(parsed?.ok, true);
  assert.deepEqual(parsed.value, memory);
  parsed.value.identity.attemptId = "another-attempt";
  parsed.value.observations[0].summary = "changed";
  parsed.value.checkpoint.accomplished[0].evidenceIds.push("another-source");
  parsed.value.checkpoint.files[0].path = "different.ts";
  assert.equal(external.identity.attemptId, identity.attemptId);
  assert.equal(external.observations[0].summary, observation.summary);
  assert.deepEqual(external.checkpoint.accomplished[0].evidenceIds, ["source"]);
  assert.equal(external.checkpoint.files[0].path, "source.ts");
  assert.deepEqual(parseTaskCheckpoint(checkpoint), { ok: true, value: checkpoint });
  assert.deepEqual(parseTaskMemoryIdentity(identity), { ok: true, value: identity });
});

test("observation derivation is optional and must be a positive integer when present", () => {
  const memory = createTaskMemory(identity);
  assert.equal(parseTaskMemory(memory).value.derivation, undefined);
  assert.equal(parseTaskMemory({ ...memory, derivation: 2 }).value.derivation, 2);
  rejected(parseTaskMemory({ ...memory, derivation: "2" }), "TASK_MEMORY_INPUT_TYPE", "memory.derivation");
  rejected(parseTaskMemory({ ...memory, derivation: 1.5 }), "TASK_MEMORY_INPUT_FORMAT", "memory.derivation");
  rejected(parseTaskMemory({ ...memory, derivation: 0 }), "TASK_MEMORY_INPUT_RANGE", "memory.derivation");
});
