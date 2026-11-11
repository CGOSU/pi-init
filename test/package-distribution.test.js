import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { withTempDirectory } from "./support/temp-directory.js";

function runCommand(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("插件安装包不携带测试，且保留运行所需文件", async () => {
  await withTempDirectory(async (directory) => {
    const result = spawnSync(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", directory],
      {
        cwd: new URL("../", import.meta.url),
        encoding: "utf8",
        shell: process.platform === "win32",
      },
    );
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);

    const [archive] = JSON.parse(result.stdout);
    const files = new Set(archive.files.map((file) => file.path));
    const testFiles = [...files].filter(
      (file) =>
        file.startsWith("test/") ||
        /^scripts\/test(?:-bootstrap)?\.js$/.test(file) ||
        file === "scripts/build-dist.sh",
    );
    assert.deepEqual(testFiles, []);
    for (const file of [
      "package.json",
      "extensions/index.ts",
      "src/scaffold.ts",
      "skills/pi-init-role-routing/SKILL.md",
      "templates/AGENTS.md",
      "scripts/install-launchers.js",
      "scripts/pi-usage.js",
      "scripts/pi-usage/core.js",
    ]) {
      assert.ok(files.has(file), `安装包缺少 ${file}`);
    }
  });
});

test("精简分发目录经 Git 克隆后不携带测试或开发依赖", async () => {
  await withTempDirectory(async (directory) => {
    const distribution = path.join(directory, "distribution");
    runCommand("bash", ["scripts/build-dist.sh", distribution], new URL("../", import.meta.url));

    runCommand("git", ["init", "-b", "dist"], distribution);
    runCommand("git", ["add", "--all"], distribution);
    runCommand("git", [
      "-c", "user.name=Distribution Test",
      "-c", "user.email=distribution@example.invalid",
      "commit", "-m", "distribution fixture",
    ], distribution);
    const clone = path.join(directory, "installed");
    runCommand("git", ["clone", "--branch", "dist", distribution, clone], directory);

    for (const file of ["test", "scripts/test.js", "scripts/test-bootstrap.js", "scripts/build-dist.sh"]) {
      assert.equal(existsSync(path.join(clone, file)), false, `不应分发 ${file}`);
    }
    const original = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    const installed = JSON.parse(readFileSync(path.join(clone, "package.json"), "utf8"));
    assert.equal(installed.devDependencies, undefined);
    for (const name of ["test", "typecheck", "pack:plugin", "build:dist"]) {
      assert.equal(installed.scripts[name], undefined);
    }
    assert.deepEqual(installed.dependencies, original.dependencies);
    assert.deepEqual(installed.peerDependencies, original.peerDependencies);
    assert.deepEqual(installed.pi, original.pi);
    assert.equal(installed.scripts.postinstall, original.scripts.postinstall);
    assert.ok(existsSync(path.join(clone, "extensions/index.ts")));
    assert.ok(existsSync(path.join(clone, "scripts/install-launchers.js")));
  });
});

test("构建拒绝覆盖非空目录", async () => {
  await withTempDirectory(async (directory) => {
    const output = path.join(directory, "existing");
    mkdirSync(output);
    const existing = path.join(output, "keep.txt");
    writeFileSync(existing, "preserve existing files");
    const result = spawnSync("bash", ["scripts/build-dist.sh", output], {
      cwd: new URL("../", import.meta.url),
      encoding: "utf8",
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(readFileSync(existing, "utf8"), "preserve existing files");
    assert.equal(existsSync(path.join(output, "package.json")), false);
  });
});
