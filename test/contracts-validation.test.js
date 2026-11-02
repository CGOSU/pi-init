import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { initProjectParameters, switchRoleParameters, taskWorkflowParameters } from "../extensions/contracts.ts";

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

test("host normalizes numeric strings and scalar arrays without mutating transcript arguments", () => {
  const args = { action: "complete", planVersion: "2", recoveryGeneration: "3", verification: "targeted checks passed" };
  const original = structuredClone(args);
  assert.deepEqual(validate(taskWorkflowParameters, args), {
    action: "complete", planVersion: 2, recoveryGeneration: 3, verification: ["targeted checks passed"],
  });
  assert.deepEqual(args, original);
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
