import "../scripts/test-bootstrap.js";
import assert from "node:assert/strict";
import test from "node:test";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { taskWorkflowParameters } from "../extensions/contracts.ts";
import { parseWorkflowVerification, restoreWorkflowVerification, formatWorkflowVerification, hasCurrentWorkflowVerification } from "../src/workflow-verification.ts";
import { createWorkflowState, startWorkflowTask, completeWorkflowTask, hydrateWorkflowState, requestWorkflowReplan } from "../src/workflow.ts";
import { createWorkflowTaskCompletionView, createWorkflowCompletionView } from "../extensions/workflow-completion-view.ts";
import { formatWorkflowTaskCompletionSummaryText, formatWorkflowCompletionSummaryText } from "../extensions/workflow-completion-renderer.ts";
import { workflowPresentationFromDetails } from "../extensions/workflow-presentation.ts";

function running() {
  return startWorkflowTask(createWorkflowState({ sessionId: "current-session", summary: "verification", tasks: [{ id: "check", task: "deliver", files: ["src/"], acceptanceCriteria: ["applicable checks"] }, { id: "next", task: "next delivery", files: ["src/"], acceptanceCriteria: ["next checks"] }] }, 10), "check", 20);
}
const record = (status, details = "real result") => ({ check: "targeted command", status, details });
const complete = (state, verification) => completeWorkflowTask(state, { taskId: "check", completionSummary: "delivered", implementationRationale: "confirmed acceptance", verification }, 30);

for (const [input, code] of [
  [undefined, "MISSING"], [null, "TYPE"], ["passed", "TYPE"], [[], "EMPTY"], [["passed"], "RECORD_TYPE"],
  [[null], "RECORD_TYPE"], [[{ check: "test", details: "done" }], "STATUS_MISSING"],
  [[record(1)], "STATUS_TYPE"], [[record("success")], "STATUS_INVALID"],
  [[{ ...record("passed"), check: " " }], "EMPTY"], [[{ ...record("passed"), details: false }], "TYPE"],
  [[{ check: "test", status: "passed" }], "MISSING"], [[{ ...record("passed"), sourceSessionId: "spoofed" }], "FIELD"],
]) test("new verification rejects " + code + " without mutating execution state: " + JSON.stringify(input), () => {
  const parsed = parseWorkflowVerification(input);
  assert.equal(parsed.ok, false); assert.equal(parsed.code, "WORKFLOW_VERIFICATION_" + code);
  const state = running(), before = structuredClone(state);
  assert.throws(() => complete(state, input), error => error.code === parsed.code);
  assert.deepEqual(state, before);
});

test("verification is normalized, persisted and deeply isolated from caller and revision snapshots", () => {
  const input = [{ check: "  command  ", status: "passed", details: "  no errors  " }];
  const state = complete(running(), input);
  input[0].details = "changed";
  assert.deepEqual(state.tasks[0].verification, [record("passed", "no errors")].map(item => ({ ...item, check: "command" })));
  const restored = hydrateWorkflowState(JSON.parse(JSON.stringify(state)));
  assert.equal(restored.ok, true); assert.deepEqual(restored.value.tasks[0].verification, state.tasks[0].verification);
  const next = requestWorkflowReplan(state, { revisionId: "review", direction: "review" }, 40);
  next.tasks[0].verification[0].details = "snapshot changed";
  assert.equal(state.tasks[0].verification[0].details, "no errors");
});

test("statuses alone determine failure, pending and success even when descriptions say the opposite", () => {
  const state = complete(running(), [record("passed", "expected failure error case"), record("failed", "no errors, 0 failures"), record("not-run", "manual system acceptance deferred")]);
  const view = createWorkflowTaskCompletionView(state.tasks[0]);
  assert.equal(view.task.verificationFailures.length, 1);
  assert.ok(view.task.verificationFailures[0].includes("no errors, 0 failures"));
  assert.equal(view.task.verificationPending.length, 1);
  assert.deepEqual(view.task.verificationUnclassified, []);
  assert.ok(formatWorkflowTaskCompletionSummaryText(view).includes("未执行"));
  assert.ok(formatWorkflowCompletionSummaryText(createWorkflowCompletionView(state, state.tasks[0])).includes("no errors, 0 failures"));
  assert.equal(state.tasks[0].status, "completed");
  assert.equal(state.tasks[0].outcomeUnknown, undefined);
});

test("explicitly deferred checks neither impose an all-pass completion gate nor mean an unknown side effect", () => {
  const state = complete(running(), [record("not-run", "explicitly deferred by confirmed acceptance")]);
  assert.equal(state.tasks[0].status, "completed");
  assert.equal(state.tasks[0].outcomeUnknown, undefined);
  assert.equal(hasCurrentWorkflowVerification(state.tasks[0].verification), false);
});

test("historical strings remain byte-for-byte unclassified facts and cannot become new completion evidence", () => {
  const original = ["  passed with no errors  ", "FAILED", "人工未执行", ""];
  const restored = restoreWorkflowVerification(original);
  assert.equal(restored.ok, true); assert.deepEqual(restored.value, original);
  const state = complete(running(), [record("passed")]);
  state.tasks[0].verification = original;
  const hydrated = hydrateWorkflowState(JSON.parse(JSON.stringify(state)));
  assert.equal(hydrated.ok, true); assert.deepEqual(hydrated.value.tasks[0].verification, original);
  const view = createWorkflowTaskCompletionView(hydrated.value.tasks[0]);
  assert.deepEqual(view.task.verificationFailures, []); assert.deepEqual(view.task.verificationPending, []);
  assert.equal(view.task.verificationUnclassified.length, 4);
  assert.ok(formatWorkflowTaskCompletionSummaryText(view).includes("未判定"));
  assert.equal(hasCurrentWorkflowVerification(original), false);
  assert.equal(parseWorkflowVerification(original).ok, false);
});

test("invalid stored statuses are rejected, not inferred or silently dropped", () => {
  const state = complete(running(), [record("passed")]);
  state.tasks[0].verification[0].status = "unknown";
  const restored = hydrateWorkflowState(state);
  assert.equal(restored.ok, false);
  assert.equal(restored.code, "WORKFLOW_VERIFICATION_STATUS_INVALID");
});

test("historical structured checks retain their source but are not current verified progress", () => {
  const historical = { ...record("passed"), sourceSessionId: "old-session" };
  assert.equal(restoreWorkflowVerification([historical]).ok, true);
  assert.equal(hasCurrentWorkflowVerification([historical]), false);
  assert.ok(formatWorkflowVerification(historical).includes("非当前验证"));
});

test("host rejects text verification and illegal or missing statuses rather than executing a legacy input", () => {
  for (const verification of [["passed"], "passed", [record("wrong")], [{ check: "x", details: "result" }], [{ ...record("passed"), sourceSessionId: "spoof" }]]) {
    assert.throws(() => validateToolArguments({ name: "task_workflow", parameters: taskWorkflowParameters }, { name: "task_workflow", arguments: { action: "complete", verification } }));
  }
});

test("malformed or old completion display metadata is rejected without treating omitted states as passed", () => {
  const view = createWorkflowTaskCompletionView(complete(running(), [record("passed")]).tasks[0]);
  const details = { workflowPresentation: { kind: "task-completion", view, continuation: "next-task" } };
  assert.equal(workflowPresentationFromDetails(details).ok, true);
  delete view.task.verificationPending;
  assert.equal(workflowPresentationFromDetails(details).ok, false);
  view.task.verificationPending = "passed";
  assert.equal(workflowPresentationFromDetails(details).ok, false);
});
