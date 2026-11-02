import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPackageGitHead } from "../scripts/pi-usage/version.js";
import { installLaunchers } from "../scripts/install-launchers.js";

const scripts = fileURLToPath(new URL("../scripts/", import.meta.url));

for (const gitCheckout of [true, false]) {
  test(`installed build identity preserves package provenance (${gitCheckout ? "Git" : "non-Git"})`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-usage-version-"));
    try {
      const root = path.join(directory, "package");
      const sourceDir = path.join(root, "scripts");
      const targetDir = path.join(directory, "bin");
      await mkdir(sourceDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });
      await writeFile(path.join(root, "package.json"), JSON.stringify({ type: "module", version: "test-version" }));
      for (const name of ["pi-usage", "pi-usage.js", "pi-usage.cmd", "pi-usage.sh"]) {
        await cp(path.join(scripts, name), path.join(sourceDir, name), { recursive: true });
      }
      const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      let expectedHead;
      if (gitCheckout) {
        git("init");
        git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "test");
        expectedHead = git("rev-parse", "--short=7", "HEAD");
        assert.deepEqual(readPackageGitHead(root), { ok: true, value: expectedHead });
        assert.equal(readPackageGitHead(sourceDir).code, "NOT_GIT"); // Do not inherit a parent repository's HEAD.
      } else {
        assert.equal(readPackageGitHead(root).code, "NOT_GIT");
      }
      assert.equal(installLaunchers({ sourceDir, targetDir, platform: process.platform }), true);
      // The installed launcher must not probe either its destination or a later checkout revision.
      await rm(path.join(root, ".git"), { recursive: true, force: true });
      const installed = await import(pathToFileURL(path.join(targetDir, "pi-usage-lib", "version.js")).href);
      assert.equal(installed.PI_USAGE_VERSION, "test-version");
      assert.equal(installed.PI_USAGE_GIT_HEAD, expectedHead ?? null);
      assert.equal(installed.PI_USAGE_BUILD, `test-version${expectedHead ? ` (git: ${expectedHead})` : ""}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("unreadable Git metadata does not invent a HEAD", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-usage-version-"));
  try {
    await writeFile(path.join(directory, ".git"), "invalid Git metadata");
    assert.equal(readPackageGitHead(directory).code, "GIT_UNAVAILABLE");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
