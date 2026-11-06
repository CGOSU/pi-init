import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { advancedInit, quickInit } from "../extensions/scaffold-runtime.ts";
import { withTempDirectory } from "./support/temp-directory.js";

function scaffoldContext(directory) {
  return {
    cwd: directory,
    mode: "rpc",
    hasUI: false,
    ui: { notify() {} },
    async reload() {},
  };
}

async function withProject({ manifest, locks = [] }, run) {
  await withTempDirectory(async directory => {
    const packageText = manifest === undefined ? undefined : JSON.stringify(manifest);
    if (packageText !== undefined) await writeFile(path.join(directory, "package.json"), packageText);
    for (const lock of locks) await writeFile(path.join(directory, lock), "existing lockfile\n");
    await run(directory);
    if (packageText !== undefined) {
      assert.equal(await readFile(path.join(directory, "package.json"), "utf8"), packageText);
    }
    for (const lock of locks) {
      assert.equal(await readFile(path.join(directory, lock), "utf8"), "existing lockfile\n");
    }
  });
}

async function generatedTestCommand(directory) {
  const agents = await readFile(path.join(directory, "AGENTS.md"), "utf8");
  return agents.match(/^- 测试：`([^`]+)`/m)?.[1];
}

test("无包管理器约定时按已有脚本推断pnpm命令", async t => {
  for (const script of ["test", "check", "lint"]) {
    await t.test(script, async () => {
      await withProject({ manifest: { scripts: { [script]: "node verify.js" } } }, async directory => {
        await quickInit(".", scaffoldContext(directory));
        assert.equal(await generatedTestCommand(directory), `pnpm ${script}`);
      });
    });
  }
});

test("现有锁文件优先于pnpm兜底且不被迁移", async t => {
  for (const [lock, manager] of [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["bun.lock", "bun"],
    ["package-lock.json", "npm"],
    ["npm-shrinkwrap.json", "npm"],
  ]) {
    await t.test(lock, async () => {
      await withProject({ manifest: { scripts: { test: "node --test" } }, locks: [lock] }, async directory => {
        await quickInit(".", scaffoldContext(directory));
        assert.equal(await generatedTestCommand(directory), `${manager} test`);
      });
    });
  }
});

test("npm的check和lint脚本使用run子命令", async t => {
  for (const script of ["check", "lint"]) {
    await t.test(script, async () => {
      await withProject({ manifest: { scripts: { [script]: "node verify.js" } }, locks: ["package-lock.json"] }, async directory => {
        await quickInit(".", scaffoldContext(directory));
        assert.equal(await generatedTestCommand(directory), `npm run ${script}`);
      });
    });
  }
});

test("有效packageManager声明优先，空白声明回退锁文件", async t => {
  for (const [declaration, locks, manager] of [
    ["npm@10.0.0", ["pnpm-lock.yaml"], "npm"],
    ["yarn@1.0.0", ["package-lock.json"], "yarn"],
    ["", ["yarn.lock"], "yarn"],
    ["   ", ["package-lock.json"], "npm"],
  ]) {
    await t.test(JSON.stringify(declaration), async () => {
      await withProject({ manifest: { packageManager: declaration, scripts: { test: "node --test" } }, locks }, async directory => {
        await quickInit(".", scaffoldContext(directory));
        assert.equal(await generatedTestCommand(directory), `${manager} test`);
      });
    });
  }
});

test("无声明的多锁项目保留原有识别优先级", async () => {
  await withProject({ manifest: { scripts: { test: "node --test" } }, locks: ["package-lock.json", "yarn.lock", "pnpm-lock.yaml"] }, async directory => {
    await quickInit(".", scaffoldContext(directory));
    assert.equal(await generatedTestCommand(directory), "pnpm test");
  });
});

test("不存在test、check或lint脚本时不编造测试命令", async t => {
  for (const manifest of [undefined, {}, { scripts: { build: "node build.js" } }]) {
    await t.test(JSON.stringify(manifest) ?? "no package.json", async () => {
      await withProject({ manifest }, async directory => {
        await quickInit(".", scaffoldContext(directory));
        assert.equal(await generatedTestCommand(directory), "待项目维护者补充。");
      });
    });
  }
});

test("高级初始化保留用户明确填写的测试命令", async () => {
  await withProject({ manifest: { packageManager: "npm@10.0.0", scripts: { test: "node --test" } } }, async directory => {
    const ctx = scaffoldContext(directory);
    ctx.hasUI = true;
    ctx.ui.input = async title => title === "测试命令（可留空）" ? "pnpm run verify -- --focused" : "Example";
    ctx.ui.select = async (_title, items) => items[0];
    ctx.ui.confirm = async () => true;
    await advancedInit(".", ctx);
    assert.equal(await generatedTestCommand(directory), "pnpm run verify -- --focused");
  });
});
