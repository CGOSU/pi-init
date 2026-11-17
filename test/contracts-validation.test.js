import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { initProjectParameters } from "../extensions/project-tool-parameters.ts";
import { switchRoleParameters } from "../extensions/role/role-tool-parameters.ts";
import { taskWorkflowParameters } from "../extensions/workflow/workflow-tool-parameters.ts";
import { parseTaskCheckpoint } from "../src/task-memory.ts";

function validate(parameters, args) {
  return validateToolArguments({ name: "contract", parameters }, { name: "contract", arguments: args });
}

test("host validation rejects missing required fields and incompatible argument types", () => {
  for (const [schema, args] of [
    [taskWorkflowParameters, {}],
    [taskWorkflowParameters, { action: {} }],
    [taskWorkflowParameters, { action: "complete", planVersion: "invalid" }],
    [taskWorkflowParameters, { action: "complete", recoveryGeneration: -1 }],
    [taskWorkflowParameters, { action: "complete", verification: {} }],
    [switchRoleParameters, {}],
    [switchRoleParameters, { role: {} }],
    [switchRoleParameters, { role: "INVALID ROLE" }],
  ]) {
    assert.throws(() => validate(schema, args));
  }
});

test("host normalizes numeric strings while preserving structured verification and transcript arguments", () => {
  const args = { action: "complete", planVersion: "2", recoveryGeneration: "3", verification: [{ check: "targeted checks", status: "passed", details: "passed" }] };
  const original = structuredClone(args);
  assert.deepEqual(validate(taskWorkflowParameters, args), {
    action: "complete", planVersion: 2, recoveryGeneration: 3, verification: [{ check: "targeted checks", status: "passed", details: "passed" }],
  });
  assert.deepEqual(args, original);
});

test("host and persisted checkpoint parsing enforce the same external input boundaries", () => {
  const checkpoint = {
    step: "s".repeat(200),
    accomplished: Array.from({ length: 16 }, () => ({
      summary: "s".repeat(512),
      evidenceIds: Array.from({ length: 8 }, (_, index) => String(index).repeat(256)),
    })),
    remaining: Array(32).fill("r".repeat(512)),
    blockers: Array(16).fill("b".repeat(512)),
    nextStep: "n".repeat(512),
  };
  const validated = validate(taskWorkflowParameters, { action: "checkpoint", checkpoint });
  assert.deepEqual(parseTaskCheckpoint(validated.checkpoint), { ok: true, value: checkpoint });

  const invalid = [
    { step: "s".repeat(201) },
    { accomplished: [...checkpoint.accomplished, checkpoint.accomplished[0]] },
    { accomplished: [{ summary: "s".repeat(513), evidenceIds: ["source"] }] },
    { accomplished: [{ summary: "result", evidenceIds: [] }] },
    { accomplished: [{ summary: "result", evidenceIds: Array(9).fill("source") }] },
    { accomplished: [{ summary: "result", evidenceIds: ["i".repeat(257)] }] },
    { remaining: Array(33).fill("pending") },
    { blockers: Array(17).fill("blocked") },
    { nextStep: "n".repeat(513) },
  ];
  for (const override of invalid) {
    const input = { ...checkpoint, ...override };
    assert.throws(() => validate(taskWorkflowParameters, { action: "checkpoint", checkpoint: input }));
    assert.equal(parseTaskCheckpoint(input).ok, false);
  }
});

test("host accepts TypeBox role-map constraints while rejecting invalid role configuration", () => {
  const config = { roleModels: { schemaVersion: 2, roleModels: {
    "developer-test": { provider: "test", model: "dev", thinkingLevel: "high" },
  } } };
  assert.deepEqual(validate(initProjectParameters, config), config);
  assert.throws(() => validate(initProjectParameters, {
    roleModels: { roleModels: { "developer-test": { provider: "test", thinkingLevel: "high" } } },
  }));
});
