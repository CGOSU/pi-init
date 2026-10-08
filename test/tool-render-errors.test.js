import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness } from "./helpers.js";

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

  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  const roleError = switchRole.renderResult(
    { content: [{ type: "text", text: "角色切换失败" }], details: {} },
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: true },
  ).render(80).join("\n");
  assert.match(roleError, /角色切换失败/);
});
