import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyWorkflowRecoveryError,
  createWorkflowRecoveryDisposition,
  parseWorkflowRecoveryCommandInput,
  parseWorkflowRecoveryDisposition,
  workflowRecoveryDispositionMatches,
} from "../src/workflow-recovery-disposition.ts";
import { latestWorkflowRecoverySource, workflowRestoreErrorForSource } from "../extensions/workflow-recovery.ts";

test("恢复错误分类区分可隔离、可恢复、必须阻塞及未知错误", () => {
  const discardable = classifyWorkflowRecoveryError("WORKFLOW_STATE_INVALID");
  assert.equal(discardable.ok, true);
  assert.equal(discardable.value.kind, "discardable");
  assert.equal(discardable.value.requiresUnknownOutcomeConfirmation, true);

  const recoverable = classifyWorkflowRecoveryError("WORKFLOW_SESSION_MISMATCH");
  assert.equal(recoverable.ok, true);
  assert.equal(recoverable.value.kind, "recoverable");
  assert.equal(recoverable.value.action, "switch-session-or-plan");

  const storageFailure = classifyWorkflowRecoveryError("WORKFLOW_RECOVERY_PERSIST_FAILED");
  assert.equal(storageFailure.ok, true);
  assert.equal(storageFailure.value.kind, "blocked");
  assert.match(storageFailure.value.message, /存储/);

  const unknown = classifyWorkflowRecoveryError("WORKFLOW_FUTURE_ERROR");
  assert.equal(unknown.ok, true);
  assert.equal(unknown.value.kind, "blocked");
  assert.doesNotMatch(unknown.value.message, /discard-recovery/);

  assert.deepEqual(classifyWorkflowRecoveryError(undefined), {
    ok: false,
    error: { code: "WORKFLOW_RECOVERY_ERROR_CODE_TYPE", message: "恢复错误 code 必须是文本" },
  });
});

test("隔离命令参数解析结构化校验来源 ID 与未知结果确认", () => {
  assert.deepEqual(parseWorkflowRecoveryCommandInput("entry-a", true), {
    ok: true,
    value: { sourceEntryId: "entry-a", confirmedUnknownOutcome: true },
  });
  const missingId = parseWorkflowRecoveryCommandInput(undefined, true);
  assert.equal(missingId.ok, false);
  if (!missingId.ok) assert.equal(missingId.error.code, "WORKFLOW_RECOVERY_DISPOSITION_IDENTIFIER_TYPE");
  const missingConfirmation = parseWorkflowRecoveryCommandInput("entry-a", false);
  assert.equal(missingConfirmation.ok, false);
  if (!missingConfirmation.ok) {
    assert.equal(missingConfirmation.error.code, "WORKFLOW_RECOVERY_DISPOSITION_CONFIRMATION_REQUIRED");
    assert.equal(typeof missingConfirmation.error.message, "string");
  }
});

test("隔离记录解析要求可隔离错误、版本、来源身份及未知结果确认", () => {
  const input = {
    sessionId: "session-a",
    sourceEntryId: "entry-a",
    sourceErrorCode: "WORKFLOW_STATE_INVALID",
    confirmedUnknownOutcome: true,
  };
  const parsed = createWorkflowRecoveryDisposition(input);
  assert.deepEqual(parsed, {
    ok: true,
    value: {
      version: 1,
      action: "discard",
      sessionId: "session-a",
      sourceEntryId: "entry-a",
      sourceErrorCode: "WORKFLOW_STATE_INVALID",
      confirmedUnknownOutcome: true,
    },
  });

  const missingConfirmation = createWorkflowRecoveryDisposition({ ...input, confirmedUnknownOutcome: false });
  assert.equal(missingConfirmation.ok, false);
  if (!missingConfirmation.ok) {
    assert.equal(missingConfirmation.error.code, "WORKFLOW_RECOVERY_DISPOSITION_CONFIRMATION_REQUIRED");
    assert.equal(typeof missingConfirmation.error.message, "string");
  }
  assert.equal(createWorkflowRecoveryDisposition({ ...input, sourceErrorCode: "WORKFLOW_SESSION_MISMATCH" }).ok, false);
  assert.equal(parseWorkflowRecoveryDisposition({ ...parsed.value, version: 2 }).ok, false);
  assert.equal(parseWorkflowRecoveryDisposition({ ...parsed.value, sessionId: "  " }).ok, false);
});

test("恢复读取只接受当前 branch 中位于原记录之后的匹配处置", () => {
  const record = createWorkflowRecoveryDisposition({
    sessionId: "session-a",
    sourceEntryId: "entry-a",
    sourceErrorCode: "WORKFLOW_STATE_INVALID",
    confirmedUnknownOutcome: true,
  });
  assert.equal(record.ok, true);
  if (!record.ok) return;
  const source = { type: "custom", customType: "pi-init-workflow", id: "entry-a", data: null };
  const marker = { type: "custom", customType: "pi-init-workflow-recovery-disposition", data: record.value };
  const error = { code: "WORKFLOW_STATE_INVALID", message: "invalid state" };

  const sameBranch = [source, marker];
  const sameBranchSource = latestWorkflowRecoverySource(sameBranch);
  assert.equal(workflowRestoreErrorForSource(error, sameBranch, sameBranchSource, "session-a"), undefined);

  for (const branch of [
    [source],
    [source, { ...marker, data: { ...record.value, sessionId: "session-b" } }],
    [source, { ...marker, data: { ...record.value, sourceEntryId: "entry-b" } }],
    [marker, source],
    [source, marker, { type: "custom", customType: "pi-init-workflow", id: "entry-new", data: null }],
  ]) {
    const currentSource = latestWorkflowRecoverySource(branch);
    assert.equal(workflowRestoreErrorForSource(error, branch, currentSource, "session-a")?.code, error.code);
  }

  const missingIdBranch = [{ ...source, id: undefined }, marker];
  const missingIdSource = latestWorkflowRecoverySource(missingIdBranch);
  assert.equal(workflowRestoreErrorForSource(error, missingIdBranch, missingIdSource, "session-a")?.sourceEntryId, undefined);
});

test("隔离处置只匹配同 session、同 branch entry 与同恢复错误 code", () => {
  const record = createWorkflowRecoveryDisposition({
    sessionId: "session-a",
    sourceEntryId: "entry-a",
    sourceErrorCode: "WORKFLOW_HANDOFF_STATE_MISMATCH",
    confirmedUnknownOutcome: true,
  });
  assert.equal(record.ok, true);
  if (!record.ok) return;

  assert.deepEqual(workflowRecoveryDispositionMatches(record.value, {
    sessionId: "session-a",
    sourceEntryId: "entry-a",
    sourceErrorCode: "WORKFLOW_HANDOFF_STATE_MISMATCH",
  }), { ok: true, value: true });
  for (const expected of [
    { sessionId: "session-b", sourceEntryId: "entry-a", sourceErrorCode: "WORKFLOW_HANDOFF_STATE_MISMATCH" },
    { sessionId: "session-a", sourceEntryId: "entry-b", sourceErrorCode: "WORKFLOW_HANDOFF_STATE_MISMATCH" },
    { sessionId: "session-a", sourceEntryId: "entry-a", sourceErrorCode: "WORKFLOW_STATE_INVALID" },
  ]) {
    assert.deepEqual(workflowRecoveryDispositionMatches(record.value, expected), { ok: true, value: false });
  }
});
