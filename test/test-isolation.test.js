import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

for (const mode of ["preload", "harness"]) test(`测试 ${mode} 隔离继承的 Agent 目录，退出只清理自己创建的目录`, async () => {
  const existing = await mkdtemp(join(tmpdir(), "pi-test-existing-agent-"));
  const sentinel = join(existing, "keep");
  await writeFile(sentinel, "user data");
  try {
    const bootstrap = new URL("../scripts/test-bootstrap.js", import.meta.url).href;
    const harness = new URL("./support/extension-harness.js", import.meta.url).href;
    const preload = mode === "preload" ? ["--import", bootstrap] : [];
    const result = await promisify(execFile)(process.execPath, [...preload, "--input-type=module", "-e", `
      ${mode === "harness" ? `import ${JSON.stringify(harness)};` : ""}
      import { getAgentDir } from '@earendil-works/pi-coding-agent';
      import { writeFileSync } from 'node:fs';
      const directory = getAgentDir(); writeFileSync(directory + '/test-marker', 'test');
      process.stdout.write(directory);
    `], { env: { ...process.env, PI_CODING_AGENT_DIR: existing } });
    assert.notEqual(result.stdout, existing);
    await assert.rejects(stat(result.stdout), { code: "ENOENT" });
    assert.equal(await readFile(sentinel, "utf8"), "user data");
  } finally { await rm(existing, { recursive: true, force: true }); }
});

test("测试入口排除辅助文件，支持过滤和定向文件并传播真实失败", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-test-selection-"));
  const launcher = fileURLToPath(new URL("../scripts/test.js", import.meta.url));
  const env = { ...process.env };
  // This subprocess is a new runner, not another file in this runner's protocol.
  delete env.NODE_TEST_CONTEXT;
  const run = args => promisify(execFile)(process.execPath, [launcher, ...args], { cwd: root, env });
  try {
    await mkdir(join(root, "test", "support"), { recursive: true });
    await mkdir(join(root, "test", "nested"));
    await writeFile(join(root, "package.json"), '{"type":"module"}');
    await writeFile(join(root, "test", "support", "helper.js"), 'throw new Error("helper must not execute independently");');
    await writeFile(join(root, "test", "selected.test.js"), 'import test from "node:test"; test("selected", () => {});');
    await writeFile(join(root, "test", "nested", "other.test.js"), 'import test from "node:test"; test("other", () => { throw new Error("expected-test-failure"); });');
    // Flags without a file still use the restricted default discovery.
    const filtered = await run(["--test-name-pattern", "^selected$"]);
    assert.match(filtered.stdout, /selected/);
    assert.doesNotMatch(filtered.stdout + filtered.stderr, /helper must not execute/);
    const targeted = await run(["test/selected.test.js"]);
    assert.match(targeted.stdout, /selected/);
    assert.doesNotMatch(targeted.stdout + targeted.stderr, /expected-test-failure/);
    // The default includes nested .test.js files and preserves Node's exit code.
    await assert.rejects(run([]), error => error.code === 1 && error.stdout.includes("expected-test-failure")
      && !error.stdout.includes("helper must not execute"));
    await assert.rejects(run(["--test-name-pattern"]), error => error.code === 1 && error.stderr.includes("缺少值"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
