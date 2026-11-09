import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { createExtensionHarness } from "./support/extension-harness.js";
import { withTempDirectory } from "./support/temp-directory.js";
import { MENU_BACK, showMenu } from "../extensions/ui.ts";

test("pending menu saves block duplicate submission and navigation until settlement", async () => {
  await withTempDirectory(async (directory) => {
    const savedPath = path.join(directory, "saved-selections.txt");
    const saving = Promise.withResolvers();
    const release = Promise.withResolvers();
    const saved = Promise.withResolvers();
    const harness = createExtensionHarness([], {
      mode: "tui",
      custom: async ({ component }) => {
        component.handleInput("\u0013");
        await saving.promise;
        component.handleInput("\u0013");
        component.handleInput("\u001b[B");
        component.handleInput("\n");
        component.handleInput("\u0003");
        release.resolve();
        await saved.promise;
        await setImmediate();
        component.handleInput("\u001b");
      },
    });
    const result = await showMenu(harness.context, "Save", [
      { value: "first", label: "First" },
      { value: "second", label: "Second" },
    ], {
      onSave: async (selection) => {
        saving.resolve();
        await release.promise;
        try {
          await appendFile(savedPath, `${selection}\n`);
        } finally {
          saved.resolve();
        }
      },
    });
    assert.equal(result, MENU_BACK);
    assert.equal(await readFile(savedPath, "utf8"), "first\n");
  });
});
