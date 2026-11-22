import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { symlink } from "node:fs/promises";
import path from "node:path";
import { withTempDirectory } from "./support/temp-directory.js";

for (const name of ["pi-usage", "install-launchers", "diagnostics-report", "handoff-report", "test"]) {
  test(`${name} executes and reports errors when invoked through a symlink`, async (t) => {
    await withTempDirectory(async (directory) => {
      const link = path.join(directory, name + ".js");
      try { await symlink(path.resolve("scripts", name + ".js"), link, "file"); }
      catch (error) {
        if (process.platform === "win32" && error.code === "EPERM") { t.skip("File symlinks require Windows developer mode or elevated permissions."); return; }
        throw error;
      }
      const result = spawnSync(process.execPath, [link, "--unknown"], {
        cwd: directory, encoding: "utf8", env: { ...process.env, PATH: directory },
      });
      assert.ifError(result.error);
      assert.equal(result.status, 1);
    });
  });
}
