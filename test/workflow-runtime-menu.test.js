import assert from "node:assert/strict";
import test from "node:test";
import { createExtensionHarness } from "./helpers.js";

test("workflow configuration menu exposes runtime executor", async () => {
  const seen = [];
  const harness = createExtensionHarness([], {
    trusted: true,
    select: async (title, items) => {
      seen.push({ title, items });
      if (title === "工作流执行器") return "Runtime 执行器";
      return items[0];
    },
  });

  await harness.commands.get("pi-init").handler("config workflow", harness.context);

  const executorMenu = seen.find((item) => item.title === "工作流执行器");
  assert.ok(executorMenu);
  assert.ok(executorMenu.items.some((item) => item.includes("Runtime 执行器")));
});
