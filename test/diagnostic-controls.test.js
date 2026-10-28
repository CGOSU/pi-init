import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { createDiagnosticControls } from "../extensions/diagnostic-controls.ts";
import { createDiagnosticWriter } from "../extensions/runtime-diagnostics.ts";
import { createGlobalDiagnostics } from "../extensions/global-diagnostics.ts";
import { withDiagnosticLock } from "../extensions/diagnostic-storage.ts";
import { createExtensionHarness } from "./helpers.js";

async function fixture(run) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-controls-"));
  const project = join(root, "project"), agent = join(root, "agent");
  const directories = { project: join(project, ".pi", "diagnostics"), global: join(agent, "diagnostics", "pi-init") };
  for (const path of Object.values(directories)) await fs.mkdir(path, { recursive: true });
  const notices = [];
  const ctx = { cwd: project, hasUI: true, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "session" }, ui: { notify: (...args) => notices.push(args), confirm: async () => true } };
  let flushed = 0;
  const controls = createDiagnosticControls({ agentDir: () => agent, report: async () => "报告", flush: async () => { flushed++; } });
  try { await run({ root, project, agent, directories, ctx, controls, notices, flushed: () => flushed }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}
const file = directory => join(directory, "runtime.jsonl");
const exists = path => fs.access(path).then(() => true, () => false);

test("导出显式范围、256条上限、严格白名单与跨层关联，不覆盖目标", () => fixture(async ({ root, directories, ctx, controls }) => {
  const secret = "private-token-prompt-path";
  const records = Array.from({ length: 300 }, (_, count) => ({ count, kind: "issue", category: "runtime-failure", snapshot: secret, message: secret, code: secret, diagnosticEventId: "id", environment: secret, events: [{ data: secret }] }));
  await fs.writeFile(file(directories.project), records.map(JSON.stringify).join("\n") + "\n");
  await fs.writeFile(file(directories.global), JSON.stringify({ event: "runtime.failure", diagnosticEventId: "id", message: secret }) + "\n");
  const target = join(root, "project-export.json");
  const result = await controls.exportFile(ctx, "project", target);
  assert.equal(result.ok, true); assert.equal(result.value.count, 256);
  const text = await fs.readFile(target, "utf8"), parsed = JSON.parse(text);
  assert.equal(text.includes(secret), false); assert.equal(parsed.records[0].count, 44);
  assert.equal((await controls.exportFile(ctx, "project", target)).code, "EEXIST");
  assert.equal(await fs.readFile(target, "utf8"), text);
  const other = join(root, "global-export.json");
  assert.equal((await controls.exportFile(ctx, "global", other)).value.count, 1);
  const global = JSON.parse(await fs.readFile(other, "utf8"));
  assert.equal(global.records[0].diagnosticEventId, parsed.records[0].diagnosticEventId);
  assert.equal((await controls.exportFile(ctx, "all", join(root, "invalid"))).code, "INVALID_SCOPE");
  assert.equal(await exists(join(root, "invalid")), false);
}));

test("清理取消和无交互/未信任不产生写入或删除；清理仅限选定范围的两个日志", () => fixture(async ({ project, directories, ctx, controls, flushed }) => {
  for (const directory of Object.values(directories)) {
    await fs.writeFile(file(directory), "{}\n"); await fs.writeFile(file(directory) + ".1", "{}\n");
    await fs.writeFile(join(directory, "unrelated"), "keep");
  }
  const state = join(project, ".pi", "workflow.json"); await fs.writeFile(state, "keep");
  ctx.ui.confirm = async () => false;
  assert.equal(await controls.clear(ctx, "project"), undefined); assert.equal(flushed(), 0);
  assert.equal(await exists(file(directories.project)), true);
  ctx.hasUI = false;
  assert.equal((await controls.clear(ctx, "project")).code, "CONFIRMATION_REQUIRED");
  ctx.hasUI = true; ctx.ui.confirm = async () => true;
  ctx.isProjectTrusted = () => false;
  assert.equal((await controls.clear(ctx, "global")).ok, false);
  ctx.isProjectTrusted = () => true;
  assert.deepEqual(await controls.clear(ctx, "project"), { ok: true, value: { count: 2 } });
  assert.equal(await exists(file(directories.global)), true);
  assert.equal(await fs.readFile(state, "utf8"), "keep");
  assert.equal(await exists(join(directories.project, "unrelated")), true);
}));

test("拒绝目录/文件链接、损坏数据、超限文件，失败不生成成功导出", () => fixture(async ({ root, directories, ctx, controls }) => {
  const external = join(root, "external"); await fs.mkdir(external); await fs.writeFile(file(external), "keep");
  await fs.rm(directories.project, { recursive: true }); await fs.symlink(external, directories.project, "dir");
  assert.equal((await controls.clear(ctx, "project")).code, "UNSAFE_DIAGNOSTIC_PATH");
  await fs.unlink(directories.project); await fs.mkdir(directories.project);
  await fs.symlink(file(external), file(directories.project));
  assert.equal((await controls.clear(ctx, "project")).code, "UNSAFE_DIAGNOSTIC_PATH");
  assert.equal(await fs.readFile(file(external), "utf8"), "keep");
  await fs.unlink(file(directories.project));
  const target = join(root, "export");
  await fs.writeFile(file(directories.project), "invalid json\n");
  assert.equal((await controls.exportFile(ctx, "project", target)).ok, false);
  assert.equal(await exists(target), false);
  await fs.writeFile(file(directories.project), "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal((await controls.exportFile(ctx, "project", target)).code, "DIAGNOSTIC_TOO_LARGE");
  await fs.writeFile(file(directories.project), "{}\n");
  assert.equal((await controls.exportFile(ctx, "project", join(root, "missing", "export"))).code, "ENOENT");
}));

test("活动锁阻止清理，取消不等待锁；释放后项目与全局writer继续有效记录", () => fixture(async ({ directories, agent, ctx, controls }) => {
  for (const scope of ["project", "global"]) {
    const directory = directories[scope]; await fs.writeFile(file(directory), "{}\n");
    let release, ready;
    const acquired = new Promise(resolve => { ready = resolve; });
    const lock = withDiagnosticLock(directory, async () => { ready(); await new Promise(resolve => { release = resolve; }); });
    await acquired;
    ctx.ui.confirm = async () => false;
    assert.equal(await controls.clear(ctx, scope), undefined);
    ctx.ui.confirm = async () => true;
    assert.equal((await controls.clear(ctx, scope)).code, "DIAGNOSTIC_LOCK_BUSY");
    assert.equal(await exists(file(directory)), true);
    release(); await lock;
    assert.equal((await controls.clear(ctx, scope)).ok, true);
  }
  const writer = createDiagnosticWriter({ file: "diagnostics/runtime.jsonl", maxBytes: 4096, maxPending: 5, warning: "failure" });
  writer.write(ctx, () => ({ count: 1 })); await writer.flush();
  const global = createGlobalDiagnostics({ agentDir: () => agent }); global.observe(ctx, "runtime.failure"); await global.flush();
  assert.equal(JSON.parse(await fs.readFile(file(directories.project), "utf8")).count, 1);
  assert.equal(JSON.parse(await fs.readFile(file(directories.global), "utf8")).event, "runtime.failure");
}));

test("独立进程写入与清理共用锁，不破坏新日志", () => fixture(async ({ directories, ctx, controls }) => {
  const directory = directories.project;
  await fs.writeFile(file(directory), "{}\n");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {withDiagnosticLock} from ${JSON.stringify(new URL("../extensions/diagnostic-storage.ts", import.meta.url).href)};
    import {writeFile} from 'node:fs/promises';
    await withDiagnosticLock(${JSON.stringify(directory)}, async () => {
      process.stdout.write('locked\\n');
      await new Promise(r => setTimeout(r, 300));
      await writeFile(${JSON.stringify(file(directory))}, '{"count":1}\\n');
    });
  `], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error("child exit " + code))); });
  await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
  assert.equal((await controls.clear(ctx, "project")).ok, true);
  await exit;
  assert.equal(await exists(file(directory)), false);
  assert.equal(await exists(join(directory, "runtime.lock")), false);
}));

test("真实控制中心导航到同一诊断入口，按选择范围导出且不调用模型", () => fixture(async ({ root, project, directories }) => {
  await fs.writeFile(file(directories.project), '{"kind":"summary","count":7}\n');
  const destination = join(root, "selected.json");
  let step = 0;
  const harness = createExtensionHarness([], { cwd: project, trusted: true, mode: "tui",
    custom: async ({ component }) => {
      step++;
      if (step > 3) { component.handleInput("\u001b"); return; }
      const moves = step === 1 ? 3 : step === 2 ? 1 : 0;
      for (let i = 0; i < moves; i++) component.handleInput("\u001b[B");
      component.handleInput("\r");
    }, input: () => destination,
  });
  await harness.commands.get("pi-init").handler("", harness.context);
  const exported = JSON.parse(await fs.readFile(destination, "utf8"));
  assert.equal(exported.scope, "project"); assert.equal(exported.records[0].count, 7);
  assert.equal(harness.sentMessages.length, 0);
  assert.equal(harness.sentUserMessages.length, 0);
}));

test("命令必须选择范围，错误和取消不伪装成功，状态不读取未信任项目", () => fixture(async ({ ctx, controls, notices, flushed }) => {
  await controls.command("export", ctx);
  await controls.command("clear global extra", ctx);
  assert.equal(flushed(), 0);
  ctx.ui.confirm = async () => false;
  await controls.command("clear project", ctx);
  assert.equal(flushed(), 0);
  await controls.command("export project", ctx);
  assert.equal(notices.at(-1)[1], "error");
  ctx.isProjectTrusted = () => false;
  await controls.status(ctx); assert.equal(flushed(), 0);
}));
