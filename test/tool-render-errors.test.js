import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness } from "./helpers.js";
import { createWorkflowErrorView } from "../extensions/workflow-error-view.ts";
import { renderWorkflowOperationFailure } from "../extensions/workflow-result-renderer.ts";

test("工作流错误视图使用 Result 区分原文、损坏诊断、字段类型错误和缺失详情", () => {
  const ordinary = createWorkflowErrorView("  普通错误文本  ");
  assert.deepEqual(ordinary, { ok: true, value: { kind: "ordinary", text: "  普通错误文本  " } });

  const malformedText = " [PI-INIT_WORKFLOW_ERROR] {malformed ";
  const malformed = createWorkflowErrorView(malformedText);
  assert.equal(malformed.ok, false);
  if (malformed.ok) return;
  assert.equal(malformed.error.code, "WORKFLOW_ERROR_JSON_INVALID");
  assert.equal(malformed.error.rawText, malformedText);

  const markerFormat = createWorkflowErrorView("[PI-INIT_WORKFLOW_ERROR]{malformed");
  assert.equal(markerFormat.ok, false);
  if (markerFormat.ok) return;
  assert.equal(markerFormat.error.code, "WORKFLOW_ERROR_MARKER_FORMAT");

  const invalidDiagnosticText = `[PI-INIT_WORKFLOW_ERROR] ${JSON.stringify({ code: "WORKFLOW_ACTION_IDENTITY_STALE", message: 17, secret: "raw-only" })}`;
  const invalidDiagnostic = createWorkflowErrorView(invalidDiagnosticText);
  assert.equal(invalidDiagnostic.ok, false);
  if (invalidDiagnostic.ok) return;
  assert.equal(invalidDiagnostic.error.code, "WORKFLOW_ERROR_MESSAGE_TYPE");
  assert.equal(invalidDiagnostic.error.rawText, invalidDiagnosticText);

  const missing = createWorkflowErrorView(undefined);
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.equal(missing.error.code, "WORKFLOW_ERROR_CONTENT_MISSING");
  const nonText = createWorkflowErrorView({ secret: "must not stringify" });
  assert.equal(nonText.ok, false);
  if (nonText.ok) return;
  assert.equal(nonText.error.code, "WORKFLOW_ERROR_CONTENT_TYPE");
  assert.doesNotMatch(JSON.stringify(nonText), /must not stringify/);
  const harness = createExtensionHarness();
  const missingRendered = renderWorkflowOperationFailure(undefined, harness.context.ui.theme).render(120).join("\n");
  const nonTextRendered = renderWorkflowOperationFailure({ secret: "must not stringify" }, harness.context.ui.theme).render(120).join("\n");
  assert.match(missingRendered, /工作流操作失败/);
  assert.match(missingRendered, /没有提供错误详情/);
  assert.match(nonTextRendered, /错误详情必须是文本/);
});

test("结构化工作流错误视图只保留白名单身份差异和允许的标量值", () => {
  const result = createWorkflowErrorView(`[PI-INIT_WORKFLOW_ERROR] ${JSON.stringify({
    code: "WORKFLOW_ACTION_IDENTITY_STALE",
    message: "身份已变化",
    mismatchedFields: ["recoveryGeneration", "untrustedField"],
    expected: { recoveryGeneration: 8, untrustedField: "secret" },
    received: { recoveryGeneration: 7, untrustedField: "secret" },
    nextAction: "查询当前状态。",
    secret: "never copied into view",
  })}`);
  assert.equal(result.ok, true);
  if (!result.ok || result.value.kind !== "diagnostic") return;
  assert.deepEqual(result.value.identityDifferences, [{ field: "recoveryGeneration", expected: 8, received: 7 }]);
  assert.doesNotMatch(JSON.stringify(result.value), /untrustedField|secret/);
});

test("工具渲染器保留错误状态而不显示成功", () => {
  const harness = createExtensionHarness();
  const workflow = harness.tools.find((tool) => tool.name === "task_workflow");
  const workflowError = workflow.renderResult(
    { content: [{ type: "text", text: "身份校验失败" }], details: {} },
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: true },
  ).render(80).join("\n");
  assert.match(workflowError, /工作流操作失败/);
  assert.match(workflowError, /类别：操作未能完成/);
  assert.match(workflowError, /原因：身份校验失败/);

  const structuredError = workflow.renderResult(
    {
      content: [{
        type: "text",
        text: `[PI-INIT_WORKFLOW_ERROR] ${JSON.stringify({
          code: "WORKFLOW_ACTION_IDENTITY_STALE",
          message: "工作流基础身份已变化：recoveryGeneration",
          mismatchedFields: ["recoveryGeneration", "untrustedField"],
          expected: { recoveryGeneration: 8, untrustedField: "secret" },
          received: { recoveryGeneration: 7, untrustedField: "secret" },
          nextAction: "查询当前状态。\n若 handoff 已变化，不得用新身份提交旧结果。",
          untrustedField: "secret",
        })}`,
      }],
      details: {},
    },
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: true },
  ).render(80).join("\n");
  assert.match(structuredError, /类别：动作身份校验/);
  assert.match(structuredError, /代码：WORKFLOW_ACTION_IDENTITY_STALE/);
  assert.match(structuredError, /原因：工作流基础身份已变化：recoveryGeneration/);
  assert.match(structuredError, /recoveryGeneration：当前 8；提交 7/);
  assert.match(structuredError, /下一步：/);
  assert.match(structuredError, /不得用新身份提交旧结果/);
  assert.doesNotMatch(structuredError, /untrustedField|secret/);

  const malformedError = workflow.renderResult(
    { content: [{ type: "text", text: "[PI-INIT_WORKFLOW_ERROR] {malformed" }], details: {} },
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: true },
  ).render(80).join("\n");
  assert.match(malformedError, /原始诊断无法解析/);
  assert.match(malformedError, /malformed/);

  const successfulMarkerText = workflow.renderResult(
    { content: [{ type: "text", text: "[PI-INIT_WORKFLOW_ERROR] {malformed" }], details: {} },
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: false },
  ).render(80).join("\n");
  assert.match(successfulMarkerText, /PI-INIT_WORKFLOW_ERROR/);
  assert.doesNotMatch(successfulMarkerText, /工作流操作失败/);

  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  const roleError = switchRole.renderResult(
    { content: [{ type: "text", text: "角色切换失败" }], details: {} },
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: true },
  ).render(80).join("\n");
  assert.match(roleError, /角色切换失败/);
});
