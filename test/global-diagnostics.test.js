import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createGlobalDiagnostics } from "../extensions/global-diagnostics.ts";
import { createRuntimeDiagnostics } from "../extensions/runtime-diagnostics.ts";

async function fixture(fn) {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-global-diagnostic-"));
  const notices = [];
  const ctx = { cwd: join(root, "private-project"), isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "private-session" }, ui: { notify: (...args) => notices.push(args) } };
  const agentDir = () => join(root, "agent");
  const file = join(agentDir(), "diagnostics", "pi-init", "runtime.jsonl");
  const rows = async () => (await fs.readFile(file, "utf8")).trim().split("\n").map(JSON.parse);
  try { await fn({ root, ctx, notices, agentDir, file, rows }); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("全局白名单仅存自身故障元数据，跨项目隔离并与项目现场关联", async () => fixture(async ({ ctx, agentDir, rows }) => {
  const box = createRuntimeDiagnostics(() => ({}), { global: { agentDir } });
  const secret = "Bearer secret-token /Users/private/config prompt and tool-result";
  box.observe(ctx, "pi-init.command_failed", { message: secret, stack: secret, code: secret, input: secret, result: secret });
  await box.flush();
  const first = (await rows())[0];
  const local = await fs.readFile(join(ctx.cwd, ".pi", "diagnostics", "runtime.jsonl"), "utf8");
  assert.ok(local.includes(first.diagnosticEventId));
  assert.ok(local.includes(first.diagnosticProjectId));
  assert.ok(local.includes(first.diagnosticSessionId));
  const another = createGlobalDiagnostics({ agentDir });
  another.observe(ctx, "pi-init.role_failed");
  another.observe({ ...ctx, cwd: ctx.cwd + "-other" }, "pi-init.workflow_failed");
  another.observe(ctx, "tool.result", { message: secret });
  another.observe(ctx, "assistant.result", { message: secret });
  await another.flush();
  const all = await rows();
  assert.equal(all.length, 3);
  assert.equal(all[0].diagnosticProjectId, all[1].diagnosticProjectId);
  assert.equal(all[0].diagnosticSessionId, all[1].diagnosticSessionId);
  assert.notEqual(all[0].diagnosticProjectId, all[2].diagnosticProjectId);
  assert.notEqual(all[0].diagnosticSessionId, all[2].diagnosticSessionId);
  assert.equal(new Set(all.map(row => row.diagnosticEventId)).size, 3);
  for (const row of all) assert.deepEqual(Object.keys(row).sort(), ["version", "timestamp", "runtimeId", "diagnosticEventId", "diagnosticProjectId", "diagnosticSessionId", "event", "category"].sort());
  const raw = JSON.stringify(all);
  for (const forbidden of [secret, "secret-token", "private-project", "private-session", "input", "stack"]) assert.equal(raw.includes(forbidden), false);
}));

test("多进程共享全局目录的并发写入保持完整且不丢记录", async () => fixture(async ({ agentDir, rows }) => {
  const moduleUrl = new URL("../extensions/global-diagnostics.ts", import.meta.url).href;
  const source = `import {createGlobalDiagnostics} from ${JSON.stringify(moduleUrl)};
    const d=createGlobalDiagnostics(); const ctx={cwd:process.cwd(),isProjectTrusted:()=>true,sessionManager:{getSessionId:()=>"s"},ui:{notify:()=>{}}};
    for(let i=0;i<12;i++) d.observe(ctx,"pi-init.command_failed"); await d.flush(); if(d.status().dropped) process.exitCode=1;`;
  await Promise.all(Array.from({ length: 3 }, () => new Promise((res, rej) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source], { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir() }, stdio: ["ignore", "pipe", "pipe"] });
    let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
    child.on("error", rej); child.on("exit", code => code === 0 ? res() : rej(new Error(errors || "child failed: " + code)));
  })));
  const all = await rows();
  assert.equal(all.length, 36);
  assert.equal(new Set(all.map(row => row.diagnosticEventId)).size, 36);
}));

test("轮转容量和保留期限有界，只清理本层文件", async () => fixture(async ({ ctx, agentDir, file }) => {
  const d = createGlobalDiagnostics({ agentDir, maxBytes: 2048, retentionMs: 1000 });
  for (let i = 0; i < 25; i++) d.observe(ctx, "pi-init.command_failed");
  await d.flush();
  for (const path of [file, file + ".1"]) {
    assert.ok((await fs.stat(path)).size <= 2048);
    for (const line of (await fs.readFile(path, "utf8")).trim().split("\n")) JSON.parse(line);
    await fs.utimes(path, new Date(0), new Date(0));
  }
  await fs.writeFile(file + ".unrelated", "keep");
  d.observe(ctx, "pi-init.role_failed"); await d.flush();
  await assert.rejects(fs.stat(file + ".1"), { code: "ENOENT" });
  assert.equal((await fs.readFile(file, "utf8")).trim().split("\n").length, 1);
  assert.equal(await fs.readFile(file + ".unrelated", "utf8"), "keep");
  assert.equal(d.status().dropped, 0);
}));

test("不可写目录、磁盘耗尽和通知失败均隔离，失败状态可见且不递归", async () => fixture(async ({ ctx, agentDir, notices, root }) => {
  const blocker = join(root, "not-directory"); await fs.writeFile(blocker, "x");
  const a = createGlobalDiagnostics({ agentDir: () => blocker });
  a.observe(ctx, "pi-init.command_failed"); await a.flush();
  assert.equal(a.status().failure, "storage");
  const denied = createGlobalDiagnostics({ agentDir, io: { ...fs, mkdir: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } } });
  denied.observe(ctx, "pi-init.workflow_failed"); await denied.flush();
  assert.equal(denied.status().failure, "storage");
  let writes = 0;
  const b = createGlobalDiagnostics({ agentDir, io: { ...fs, open: async () => {
    writes++; throw Object.assign(new Error("secret disk path"), { code: "ENOSPC" });
  } } });
  b.observe({ ...ctx, ui: { notify: () => { throw new Error("UI failed"); } } }, "pi-init.role_failed");
  b.observe(ctx, "pi-init.role_failed"); await b.flush();
  assert.equal(writes, 1);
  assert.equal(b.status().dropped, 2);
  assert.equal(b.status().written, 0);
  assert.equal(notices.length, 2);
  assert.equal(b.report().includes("secret"), false);
  assert.equal((await fs.readdir(join(agentDir(), "diagnostics", "pi-init"))).includes("runtime.lock"), false);
}));

test("故障风暴有界，存活或遗留锁不被抢占且不反复等待", async () => fixture(async ({ ctx, agentDir, file }) => {
  await fs.mkdir(join(agentDir(), "diagnostics", "pi-init", "runtime.lock"), { recursive: true });
  const d = createGlobalDiagnostics({ agentDir });
  for (let i = 0; i < 140; i++) d.observe(ctx, "pi-init.command_failed");
  assert.equal(d.status().pending, 128);
  assert.equal(d.status().dropped, 12);
  await d.flush();
  assert.equal(d.status().pending, 0);
  assert.equal(d.status().dropped, 140);
  assert.equal(d.status().failure, "lock-busy");
  assert.ok((await fs.stat(join(agentDir(), "diagnostics", "pi-init", "runtime.lock"))).isDirectory());
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
}));

test("项目写入失败不阻止全局诊断，未信任项目不写入", async () => fixture(async ({ ctx, agentDir, rows }) => {
  await fs.mkdir(ctx.cwd, { recursive: true }); await fs.writeFile(join(ctx.cwd, ".pi"), "blocked");
  const box = createRuntimeDiagnostics(() => ({}), { global: { agentDir } });
  box.observe(ctx, "pi-init.initialization_failed"); await box.flush();
  assert.equal((await rows()).length, 1);
  box.observe({ ...ctx, isProjectTrusted: () => false }, "pi-init.initialization_failed"); await box.flush();
  assert.equal((await rows()).length, 1);
}));

test("真实命令故障保持原失败提示，自动和详细模式都接入全局层", async () => fixture(async ({ root }) => {
  // Separate processes keep SDK environment and diagnostic modes out of other tests.
  const helper = new URL("./helpers.js", import.meta.url).href;
  for (const mode of ["", "1", "blocked"]) {
    const agent = join(root, "agent-" + mode);
    const source = `import {createExtensionHarness,emitExtensionEvent} from ${JSON.stringify(helper)};
      import {readFile,writeFile} from 'node:fs/promises';
      ${mode === "blocked" ? `await writeFile(${JSON.stringify(agent)}, 'blocked');` : ""}
      const h=createExtensionHarness([], {trusted:true}); h.context.cwd=${JSON.stringify(join(root, "project"))};
      h.context.ui.confirm=h.context.ui.select=h.context.ui.custom=async()=>{throw new Error('original-command-failure')};
      await h.commands.get('pi-init').handler('',h.context);
      if(!h.notifications.some(n=>JSON.stringify(n).includes('original-command-failure'))) throw new Error('failure changed: '+JSON.stringify(h.notifications));
      await emitExtensionEvent(h,'session_shutdown');
      ${mode === "blocked" ? `if(!h.notifications.some(n=>JSON.stringify(n).includes('全局本地诊断写入失败'))) throw new Error('missing diagnostic failure');` : `const rows=(await readFile(${JSON.stringify(join(agent, "diagnostics", "pi-init", "runtime.jsonl"))},'utf8')).trim().split('\\n').map(JSON.parse);
      if(!rows.some(r=>r.event==='pi-init.command_failed')) throw new Error('missing command failure');`}
      await h.commands.get('pi-init').handler('mode auto',h.context);
      if(h.notifications.at(-1)?.level!=='info') throw new Error('successful command changed');`;
    await new Promise((res, rej) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source], { cwd: resolve("."), env: { ...process.env, PI_CODING_AGENT_DIR: agent, PI_INIT_HANDOFF_LOG: mode }, stdio: ["ignore", "pipe", "pipe"] });
      let errors = ""; child.stderr.on("data", chunk => { errors += chunk; });
      child.on("error", rej); child.on("exit", code => code === 0 ? res() : rej(new Error(errors || "child failed: " + code)));
    });
  }
}));
