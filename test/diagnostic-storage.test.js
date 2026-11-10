import "../scripts/test-bootstrap.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiagnosticWriter, createRuntimeDiagnostics } from "../extensions/runtime-diagnostics.ts";
import { createGlobalDiagnostics } from "../extensions/global-diagnostics.ts";
import { readDiagnosticText } from "../extensions/diagnostic-storage.ts";

async function fixture(fn) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-diagnostic-storage-"));
  const outside = join(root, "outside");
  await fs.mkdir(outside);
  const notices = [];
  const ctx = {
    cwd: root,
    isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "test-session" },
    ui: { notify: (...args) => notices.push(args) },
  };
  try { await fn({ root, outside, ctx, notices }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

for (const file of ["diagnostics/runtime.jsonl", "logs/handoff.jsonl"]) {
  for (const linked of [".pi", ".pi/" + file.split("/")[0], ".pi/" + file, ".pi/" + file + ".1"]) {
    test(`project diagnostics refuse symlinked storage: ${linked}`, async () => fixture(async ({ root, outside, ctx, notices }) => {
      const target = join(root, linked);
      await fs.mkdir(join(target, ".."), { recursive: true });
      const directory = !linked.includes(".jsonl");
      const destination = directory ? outside : join(outside, "private.jsonl");
      if (!directory) await fs.writeFile(destination, "private-content\n");
      await fs.symlink(destination, target, directory ? "junction" : "file");
      const writer = createDiagnosticWriter({ file, maxBytes: 4096, maxPending: 4, warning: "storage rejected" });
      writer.write(ctx, () => ({ kind: "summary" }));
      await writer.flush();
      assert.equal(writer.failed, true);
      assert.equal(notices.length, 1);
      assert.deepEqual(await fs.readdir(outside), directory ? [] : ["private.jsonl"]);
      if (!directory) assert.equal(await fs.readFile(destination, "utf8"), "private-content\n");
      assert.equal((await fs.lstat(target)).isSymbolicLink(), true);
    }));
  }
}

for (const linked of ["diagnostics", "diagnostics/pi-init"]) {
  test(`global diagnostics refuse symlinked storage: ${linked}`, async () => fixture(async ({ root, outside, ctx }) => {
    const agent = join(root, "agent");
    const target = join(agent, linked);
    await fs.mkdir(join(target, ".."), { recursive: true });
    await fs.symlink(outside, target, "junction");
    const diagnostics = createGlobalDiagnostics({ agentDir: () => agent });
    diagnostics.observe(ctx, "pi-init.command_failed");
    await diagnostics.flush();
    assert.equal(diagnostics.status().written, 0);
    assert.equal(diagnostics.status().failure, "storage");
    assert.deepEqual(await fs.readdir(outside), []);
  }));
}

test("bounded diagnostic reads accept the exact limit and reject larger files", async () => fixture(async ({ root }) => {
  const file = join(root, "bounded.jsonl");
  await fs.writeFile(file, "éé");
  assert.equal(await readDiagnosticText(file, 4), "éé");
  await assert.rejects(readDiagnosticText(file, 3), { code: "DIAGNOSTIC_TOO_LARGE" });
  await assert.rejects(readDiagnosticText(root, 4), { code: "UNSAFE_DIAGNOSTIC_PATH" });
}));

test("runtime reports refuse symlinked files without reading external data", async () => fixture(async ({ root, outside, ctx }) => {
  const directory = join(root, ".pi", "diagnostics");
  await fs.mkdir(directory, { recursive: true });
  const external = join(outside, "runtime.jsonl");
  await fs.writeFile(external, JSON.stringify({ version: 1, kind: "issue", runtimeId: "external", id: "external", category: "PRIVATE_CATEGORY", code: "PRIVATE_CODE", count: 1 }) + "\n");
  await fs.symlink(external, join(directory, "runtime.jsonl"), "file");
  const diagnostics = createRuntimeDiagnostics(() => ({}));
  const report = await diagnostics.report(ctx);
  assert.equal(report.includes("PRIVATE_CATEGORY"), false);
  assert.equal(report.includes("PRIVATE_CODE"), false);
  assert.match(report, /记录不完整/);
}));
