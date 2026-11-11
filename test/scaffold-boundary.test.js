import assert from "node:assert/strict";
import test from "node:test";
import fsPromises, { lstat, mkdir, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { createScaffold } from "../src/scaffold.ts";
import { runScaffold } from "../extensions/scaffold-runtime.ts";
import { registerProjectTool } from "../extensions/project-tool.ts";
import { withTempDirectory } from "./support/temp-directory.js";

for (const name of ["docs", ".pi"]) {
  for (const destination of ["external", "internal", "missing"]) {
    for (const dryRun of [false, true]) {
      test(`initialization rejects ${name} directory links (${destination}, dryRun=${dryRun}) before any generation`, async () => {
        await withTempDirectory(async directory => {
          const project = path.join(directory, "project");
          const shared = destination === "internal" ? path.join(project, "shared") : path.join(directory, destination);
          await mkdir(project);
          await writeFile(path.join(project, "package.json"), '{"name":"preserved"}');
          if (destination !== "missing") {
            await mkdir(shared);
            await writeFile(path.join(shared, "marker"), "keep shared bytes");
          }
          await symlink(shared, path.join(project, name), "junction");
          const before = await readdir(project);
          const result = await createScaffold(project, { dryRun });
          assert.equal(result.ok, false);
          assert.equal(result.code, "SCAFFOLD_OUTPUT_DIRECTORY_LINK");
          assert.ok(result.message.includes(name));
          assert.deepEqual(await readdir(project), before);
          assert.equal(await readFile(path.join(project, "package.json"), "utf8"), '{"name":"preserved"}');
          assert.equal((await lstat(path.join(project, name))).isSymbolicLink(), true);
          if (destination === "missing") {
            await assert.rejects(lstat(shared), { code: "ENOENT" });
          } else {
            assert.deepEqual(await readdir(shared), ["marker"]);
            assert.equal(await readFile(path.join(shared, "marker"), "utf8"), "keep shared bytes");
          }
        });
      });
    }
  }
}

for (const name of ["docs", ".pi"]) {
  test(`a non-directory ${name} rejects initialization before generating AGENTS.md`, async () => {
    await withTempDirectory(async directory => {
      await writeFile(path.join(directory, name), "owned file");
      const result = await createScaffold(directory);
      assert.equal(result.ok, false);
      assert.equal(result.code, "SCAFFOLD_OUTPUT_NOT_DIRECTORY");
      assert.deepEqual(await readdir(directory), [name]);
      assert.equal(await readFile(path.join(directory, name), "utf8"), "owned file");
    });
  });
}

test("an explicitly selected linked project root remains supported", async () => {
  await withTempDirectory(async directory => {
    const target = path.join(directory, "real-project");
    const alias = path.join(directory, "selected-project");
    await mkdir(target);
    await symlink(target, alias, "junction");
    const preview = await createScaffold(alias, { dryRun: true });
    assert.equal(preview.ok, true);
    assert.equal(preview.value.targetDir, alias);
    assert.deepEqual(await readdir(target), []);
    const actual = await createScaffold(alias);
    assert.equal(actual.ok, true);
    assert.deepEqual(actual.value.files, preview.value.files);
    assert.equal((await lstat(alias)).isSymbolicLink(), true);
    assert.equal((await lstat(path.join(target, "AGENTS.md"))).isFile(), true);
  });
});

test("initialization rechecks directory boundaries after interactive confirmation", async () => {
  await withTempDirectory(async directory => {
    const project = path.join(directory, "project");
    const shared = path.join(directory, "shared");
    await mkdir(path.join(project, "docs"), { recursive: true });
    await mkdir(shared);
    const result = await runScaffold({
      cwd: project,
      hasUI: true,
      ui: {
        confirm: async () => {
          await rename(path.join(project, "docs"), path.join(project, "owned-docs"));
          await symlink(shared, path.join(project, "docs"), "junction");
          return true;
        }
      },
    }, ".", {}, "always");
    assert.equal(result.ok, false);
    assert.equal(result.code, "SCAFFOLD_OUTPUT_DIRECTORY_LINK");
    assert.deepEqual(await readdir(shared), []);
    await assert.rejects(lstat(path.join(project, "AGENTS.md")), { code: "ENOENT" });
  });
});

test("the initialization tool reports a rejected directory link as an error", async () => {
  await withTempDirectory(async directory => {
    const project = path.join(directory, "project");
    const shared = path.join(directory, "shared");
    await mkdir(project);
    await mkdir(shared);
    await symlink(shared, path.join(project, "docs"), "junction");
    let definition;
    registerProjectTool({ registerTool: tool => { definition = tool; } }, () => import("../extensions/scaffold-runtime.ts"));
    const result = await definition.execute("init-boundary", {}, undefined, undefined, { cwd: project, hasUI: false });
    assert.equal(result.isError, true);
    assert.equal(result.details.code, "SCAFFOLD_OUTPUT_DIRECTORY_LINK");
    assert.deepEqual(await readdir(shared), []);
    await assert.rejects(lstat(path.join(project, "AGENTS.md")), { code: "ENOENT" });
  });
});

const invalidOptions = [
  [{ projectName: null }, "SCAFFOLD_PROJECT_NAME_TYPE"],
  [{ projectName: "   " }, "SCAFFOLD_PROJECT_NAME_EMPTY"],
  [{ projectName: "a\nb" }, "SCAFFOLD_PROJECT_NAME_MULTILINE"],
  [{ language: "unsupported" }, "SCAFFOLD_LANGUAGE_INVALID"],
  [{ description: false }, "SCAFFOLD_DESCRIPTION_TYPE"],
  [{ testCommand: 42 }, "SCAFFOLD_TEST_COMMAND_TYPE"],
  [{ dryRun: "true" }, "SCAFFOLD_DRY_RUN_TYPE"],
  [null, "SCAFFOLD_OPTIONS_TYPE"],
];
for (const [options, code] of invalidOptions) {
  test(`invalid scaffold input returns ${code} without creating the target`, async () => {
    await withTempDirectory(async directory => {
      const target = path.join(directory, "missing");
      const result = await createScaffold(target, options);
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      await assert.rejects(lstat(target), { code: "ENOENT" });
    });
  });
}

test("explicit project paths preserve meaningful surrounding spaces", async () => {
  await withTempDirectory(async directory => {
    const target = path.join(directory, " spaced project ");
    const result = await createScaffold(target);
    assert.equal(result.ok, true);
    assert.equal(result.value.targetDir, target);
    assert.equal((await lstat(path.join(target, "AGENTS.md"))).isFile(), true);
    await assert.rejects(lstat(target.trim()), { code: "ENOENT" });
  });
});

test("directory inspection permission errors are not treated as missing directories", async () => {
  await withTempDirectory(async directory => {
    const original = fsPromises.lstat;
    try {
      fsPromises.lstat = async (file, ...args) => {
        if (file === path.join(directory, ".pi")) throw Object.assign(new Error("fixture permission denied"), { code: "EACCES" });
        return original(file, ...args);
      };
      syncBuiltinESMExports();
      const result = await createScaffold(directory);
      assert.equal(result.ok, false);
      assert.equal(result.code, "SCAFFOLD_OUTPUT_INSPECTION_FAILED");
      assert.equal(result.causeCode, "EACCES");
      assert.deepEqual(await readdir(directory), []);
    } finally {
      fsPromises.lstat = original;
      syncBuiltinESMExports();
    }
  });
});

test("a link introduced during directory creation is rejected before the first file write", async () => {
  await withTempDirectory(async directory => {
    const project = path.join(directory, "project");
    const shared = path.join(directory, "shared");
    await mkdir(shared);
    const original = fsPromises.mkdir;
    try {
      fsPromises.mkdir = async (file, ...args) => {
        const result = await original(file, ...args);
        if (file === project) await symlink(shared, path.join(project, "docs"), "junction");
        return result;
      };
      syncBuiltinESMExports();
      const result = await createScaffold(project);
      assert.equal(result.ok, false);
      assert.equal(result.code, "SCAFFOLD_OUTPUT_DIRECTORY_LINK");
      assert.deepEqual(await readdir(project), ["docs"]);
      assert.deepEqual(await readdir(shared), []);
      assert.equal((await lstat(path.join(project, "docs"))).isSymbolicLink(), true);
    } finally {
      fsPromises.mkdir = original;
      syncBuiltinESMExports();
    }
  });
});
