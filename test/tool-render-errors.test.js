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
  assert.match(workflowError, /工作流操作失败：身份校验失败/);

  const switchRole = harness.tools.find((tool) => tool.name === "switch_role");
  const roleError = switchRole.renderResult(
    { content: [{ type: "text", text: "角色切换失败" }], details: {} },
    { expanded: false, isPartial: false },
    harness.context.ui.theme,
    { isError: true },
  ).render(80).join("\n");
  assert.match(roleError, /角色切换失败/);
});
