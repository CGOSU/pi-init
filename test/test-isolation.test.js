import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

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
