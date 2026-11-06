import "../scripts/test-bootstrap.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureRuntimeIdentity, loadedRuntimeIdentity } from "../extensions/runtime-identity.ts";

test("运行身份保留加载快照，源码改变只影响新捕获，不包含路径或源码", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-identity-private-"));
  try {
    await mkdir(join(root, "extensions")); await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), '{"version":"2.0.11"}');
    await writeFile(join(root, "src", "private.ts"), "const privateCode = 1;");
    const before = captureRuntimeIdentity(root);
    const serialized = JSON.stringify(before);
    await writeFile(join(root, "src", "private.ts"), "const privateCode = 2;");
    const after = captureRuntimeIdentity(root);
    assert.equal(JSON.stringify(before), serialized);
    assert.notEqual(after.sourceFingerprint, before.sourceFingerprint);
    await writeFile(join(root, "src", "private.js"), "export const privateValue = 1;");
    const withJavaScript = captureRuntimeIdentity(root);
    await writeFile(join(root, "src", "private.js"), "export const privateValue = 2;");
    const changedJavaScript = captureRuntimeIdentity(root);
    assert.notEqual(changedJavaScript.sourceFingerprint, withJavaScript.sourceFingerprint);
    await mkdir(join(root, "skills"));
    await writeFile(join(root, "skills", "SKILL.md"), "A loaded role rule.");
    assert.notEqual(captureRuntimeIdentity(root).sourceFingerprint, changedJavaScript.sourceFingerprint);
    assert.equal(before.sourceCommit, undefined);
    assert.equal(before.extensionVersion, "2.0.11");
    assert.equal(before.pid, process.pid);
    assert.ok(Object.isFrozen(before));
    for (const secret of [root, "private.ts", "privateCode"]) assert.equal(serialized.includes(secret), false);
    assert.match(loadedRuntimeIdentity.sourceFingerprint, /^[a-f0-9]{64}$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("身份来源不可用、超预算或版本含动态文本时降级，不阻止扩展加载", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-identity-missing-"));
  try {
    const missing = captureRuntimeIdentity(root);
    assert.equal(missing.extensionVersion, "unknown");
    assert.equal(missing.sourceFingerprint, undefined);
    await mkdir(join(root, "extensions")); await mkdir(join(root, "src"));
    await writeFile(join(root, "package.json"), JSON.stringify({ version: "secret /Users/private" }));
    await writeFile(join(root, "src", "large.ts"), "x".repeat(4 * 1024 * 1024));
    const bounded = captureRuntimeIdentity(root);
    assert.equal(bounded.sourceFingerprint, undefined);
    assert.equal(bounded.extensionVersion, "unknown");
    assert.equal(JSON.stringify(bounded).includes("private"), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
