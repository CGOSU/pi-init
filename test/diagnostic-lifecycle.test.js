import "../scripts/test-bootstrap.js";
import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createDiagnosticWriter } from "../extensions/diagnostic-writer.ts";
import { createDiagnosticControls } from "../extensions/diagnostic-controls.ts";
import { createGlobalDiagnostics } from "../extensions/global-diagnostics.ts";
import { createHandoffDiagnostics } from "../extensions/handoff-diagnostics.ts";
import { createRuntimeDiagnostics } from "../extensions/runtime-diagnostics.ts";
import { createExtensionRuntimeState } from "../extensions/runtime-state.ts";
import { withTempDirectory } from "./support/temp-directory.js";
import { fastForwardTimeouts } from "./support/fast-forward-timeouts.js";
import { createExtensionHarness } from "./support/extension-harness.js";

function context(cwd) {
  const notices = [];
  return {
    cwd, hasUI: true, isProjectTrusted: () => true,
    sessionManager: { getSessionId: () => "fixture", getLeafId: () => "leaf" },
    ui: { notify: (...args) => notices.push(args), confirm: async () => true }, notices
  };
}
const writerOptions = { file: "logs/handoff.jsonl", maxBytes: 8192, maxPending: 128, warning: "recording stopped" };
const records = async file => (await fs.readFile(file, "utf8")).split("\n").filter(Boolean).map(JSON.parse);
const diskFull = () => Object.assign(new Error("private storage error"), { code: "ENOSPC" });

for (const file of ["logs/handoff.jsonl", "diagnostics/runtime.jsonl"]) {
  test(`${file}: explicit resume discards failed work and accepts only new events`, async () => withTempDirectory(async cwd => {
    const ctx = context(cwd), writer = createDiagnosticWriter({ ...writerOptions, file });
    await fs.writeFile(join(cwd, ".pi"), "blocked");
    for (let index = 0; index < 3; index++) writer.write(ctx, () => ({ index, failed: true }));
    await writer.flush();
    assert.equal(writer.failed, true);
    assert.equal(ctx.notices.length, 1);
    await fs.unlink(join(cwd, ".pi"));
    assert.equal((await writer.resume(ctx)).ok, true);
    assert.equal(writer.failed, false);
    assert.equal(await fs.readFile(join(cwd, ".pi", file), "utf8"), "");
    writer.write(ctx, dropped => ({ fresh: true, dropped })); await writer.flush();
    assert.deepEqual(await records(join(cwd, ".pi", file)), [{ fresh: true, dropped: 3 }]);
    await fs.mkdir(join(cwd, ".pi", file + ".1"));
    writer.write(ctx, () => ({ rejected: true })); await writer.flush();
    assert.equal(writer.failed, true);
    assert.equal(ctx.notices.length, 2, "one warning for each explicitly recovered recording period");
    assert.equal((await records(join(cwd, ".pi", file))).length, 1);
  }));
}

test("resume reports persistent storage errors without leaking them or replaying failed records", async () => withTempDirectory(async cwd => {
  const ctx = context(cwd);
  let blocked = true;
  const writer = createDiagnosticWriter({ ...writerOptions, io: { ...fs, open: (...args) => blocked ? Promise.reject(diskFull()) : fs.open(...args) } });
  writer.write(ctx, () => ({ failed: true })); await writer.flush();
  const failure = await writer.resume(ctx);
  assert.equal(failure.ok, false);
  assert.equal(failure.causeCode, "ENOSPC");
  assert.equal(JSON.stringify(failure).includes("private"), false);
  assert.equal(writer.failed, true);
  assert.equal(ctx.notices.length, 1);
  blocked = false;
  assert.equal((await writer.resume(ctx)).ok, true);
  writer.write(ctx, () => ({ fresh: true })); await writer.flush();
  assert.deepEqual(await records(join(cwd, ".pi", writerOptions.file)), [{ fresh: true }]);
}));

test("trust, session and branch changes during a probe never reactivate a failed recorder", async () => {
  for (const change of [ctx => { ctx.isProjectTrusted = () => false; }, ctx => { ctx.cwd += "-changed"; }, ctx => { ctx.sessionManager.getSessionId = () => "other"; }, ctx => { ctx.sessionManager.getLeafId = () => "other"; }]) {
    await withTempDirectory(async cwd => {
      const ctx = context(cwd);
      let blocked = true, probeStarted, release;
      const started = new Promise(resolve => { probeStarted = resolve; });
      const wait = new Promise(resolve => { release = resolve; });
      const writer = createDiagnosticWriter({
        ...writerOptions, io: {
          ...fs, open: async (...args) => {
            if (blocked) throw diskFull();
            probeStarted(); await wait;
            return fs.open(...args);
          }
        }
      });
      writer.write(ctx, () => ({ old: true })); await writer.flush(); blocked = false;
      const resumed = writer.resume(ctx);
      await started; change(ctx); release();
      assert.equal((await resumed).code, "DIAGNOSTIC_SCOPE_CHANGED");
      assert.equal(writer.failed, true);
      assert.equal(await fs.readFile(join(cwd, ".pi", writerOptions.file), "utf8"), "");
    });
  }
});

test("untrusted and concurrent resume requests do not bypass the recovery gate", async () => withTempDirectory(async cwd => {
  const ctx = context(cwd);
  const writer = createDiagnosticWriter(writerOptions);
  ctx.isProjectTrusted = () => false;
  assert.equal((await writer.resume(ctx)).code, "DIAGNOSTIC_UNTRUSTED_PROJECT");
  assert.deepEqual(await fs.readdir(cwd), []);
  ctx.isProjectTrusted = () => true;
  const first = writer.resume(ctx);
  assert.equal((await writer.resume(ctx)).code, "DIAGNOSTIC_RESUME_BUSY");
  assert.equal(writer.write(ctx, () => ({ duringRecovery: true })), false);
  assert.equal((await first).ok, true);
  assert.equal(await fs.readFile(join(cwd, ".pi", writerOptions.file), "utf8"), "");
}));

for (const file of ["logs/handoff.jsonl", "diagnostics/runtime.jsonl"]) {
  for (const linked of ["directory", "file", "backup"]) {
    test(`${file}: resume rejects ${linked} links without altering their targets`, async () => withTempDirectory(async root => {
      const cwd = join(root, "project"), outside = join(root, "outside");
      await fs.mkdir(cwd); await fs.mkdir(outside); await fs.writeFile(join(outside, "sentinel"), "keep");
      const directory = join(cwd, ".pi", file.split("/")[0]);
      await fs.mkdir(join(cwd, ".pi"));
      if (linked === "directory") await fs.symlink(outside, directory, "junction");
      else {
        await fs.mkdir(directory);
        await fs.symlink(join(outside, "sentinel"), join(cwd, ".pi", file + (linked === "backup" ? ".1" : "")));
      }
      const ctx = context(cwd), writer = createDiagnosticWriter({ ...writerOptions, file });
      writer.write(ctx, () => ({ blocked: true })); await writer.flush();
      const result = await writer.resume(ctx);
      assert.equal(result.ok, false);
      assert.equal(result.causeCode, "UNSAFE_DIAGNOSTIC_PATH");
      assert.equal(writer.failed, true);
      assert.equal(await fs.readFile(join(outside, "sentinel"), "utf8"), "keep");
      assert.deepEqual(await fs.readdir(outside), ["sentinel"]);
    }));
  }
}

test("busy and abandoned locks survive failed resume unchanged", async t => {
  await fastForwardTimeouts(t, () => withTempDirectory(async cwd => {
    const directory = join(cwd, ".pi", "logs"), lock = join(directory, "runtime.lock");
    await fs.mkdir(lock, { recursive: true }); await fs.writeFile(join(lock, "owner"), "do not steal");
    const writer = createDiagnosticWriter(writerOptions);
    const result = await writer.resume(context(cwd));
    assert.equal(result.ok, false); assert.equal(result.causeCode, "DIAGNOSTIC_LOCK_BUSY");
    assert.equal(await fs.readFile(join(lock, "owner"), "utf8"), "do not steal");
    await assert.rejects(fs.stat(join(directory, "handoff.jsonl")), { code: "ENOENT" });
  }));
});

for (const maxBytes of [8192, 16]) {
  test(`resume isolates an incomplete final JSON line without replay, budget ${maxBytes}`, async () => withTempDirectory(async cwd => {
    const file = join(cwd, ".pi", writerOptions.file);
    await fs.mkdir(join(cwd, ".pi", "logs"), { recursive: true });
    const damaged = '{"unfinished":"中文';
    await fs.writeFile(file, damaged);
    const writer = createDiagnosticWriter({ ...writerOptions, maxBytes });
    assert.equal((await writer.resume(context(cwd))).ok, true);
    writer.write(context(cwd), () => ({ fresh: true })); await writer.flush();
    const text = await fs.readFile(file, "utf8");
    assert.equal(JSON.parse(text.trim().split("\n").at(-1)).fresh, true);
    if (maxBytes === 8192) assert.equal(text, damaged + '\n{"fresh":true}\n');
    else assert.equal(await fs.readFile(file + ".1", "utf8"), damaged);
  }));
}

test("project and global recorders resume independently and do not restore old capture buffers", async () => withTempDirectory(async cwd => {
  const ctx = context(cwd), agent = join(cwd, "agent");
  const box = createRuntimeDiagnostics(() => ({}), { global: { agentDir: () => agent } });
  await fs.writeFile(join(cwd, ".pi"), "blocked");
  box.observe(ctx, "tool.result", { toolName: "read", toolCallId: "old", isError: true }); await box.flush();
  await fs.unlink(join(cwd, ".pi"));
  assert.equal((await box.resume(ctx, "project")).ok, true);
  box.observe(ctx, "tool.result", { toolName: "read", toolCallId: "fresh", isError: true }); await box.flush();
  const rows = await records(join(cwd, ".pi", "diagnostics", "runtime.jsonl"));
  assert.equal(rows.some(row => row.latestTrigger?.data?.toolCallId === "fresh"), true);
  assert.equal(JSON.stringify(rows).includes('"old"'), false);
  await fs.writeFile(agent, "blocked");
  const global = createGlobalDiagnostics({ agentDir: () => agent });
  global.observe(ctx, "pi-init.command_failed"); await global.flush();
  assert.equal(global.status().failure, "storage"); await fs.unlink(agent);
  assert.equal((await global.resume(ctx)).ok, true);
  global.observe(ctx, "pi-init.role_failed"); await global.flush();
  assert.deepEqual((await records(join(agent, "diagnostics", "pi-init", "runtime.jsonl"))).map(row => row.event), ["pi-init.role_failed"]);
  assert.equal(global.status().dropped, 1); assert.equal(global.status().written, 1); assert.equal(global.status().failure, undefined);
}));

test("global observation failures remain isolated, visible and recoverable without logging private errors", async () => withTempDirectory(async cwd => {
  const ctx = context(cwd), agent = join(cwd, "agent");
  const global = createGlobalDiagnostics({ agentDir: () => agent });
  ctx.sessionManager.getSessionId = () => { throw new Error("private session failure"); };
  assert.doesNotThrow(() => global.observe(ctx, "pi-init.command_failed"));
  assert.equal(global.status().failure, "storage");
  assert.equal(global.status().dropped, 1);
  assert.equal(ctx.notices.length, 1);
  assert.equal(JSON.stringify(ctx.notices).includes("private"), false);
  await assert.rejects(fs.stat(agent), { code: "ENOENT" });
  ctx.sessionManager.getSessionId = () => "restored";
  assert.equal((await global.resume(ctx)).ok, true);
  global.observe(ctx, "pi-init.role_failed"); await global.flush();
  assert.deepEqual((await records(join(agent, "diagnostics", "pi-init", "runtime.jsonl"))).map(row => row.event), ["pi-init.role_failed"]);
}));

test("explicit control recovers only the selected recorder without changing task or recovery guards", async () => withTempDirectory(async cwd => {
  const ctx = context(cwd), state = createExtensionRuntimeState();
  state.roleRecoveryPending = true;
  state.workflowRestoreError = { code: "FIXTURE_PAUSED", message: "retained" };
  const monitor = createHandoffDiagnostics({ on() { } }, state, { mode: "verbose" });
  const control = createDiagnosticControls({ ...monitor, agentDir: () => join(cwd, "agent") });
  await fs.writeFile(join(cwd, ".pi"), "blocked");
  monitor.trace(ctx, "old"); await monitor.flush(); await fs.unlink(join(cwd, ".pi"));
  await control.command("resume handoff", ctx);
  assert.equal(ctx.notices.at(-1)[1], "info");
  monitor.trace(ctx, "fresh"); await monitor.flush();
  assert.deepEqual((await records(join(cwd, ".pi", "logs", "handoff.jsonl"))).map(row => row.event), ["fresh"]);
  assert.equal(state.roleRecoveryPending, true); assert.equal(state.workflowRestoreError.code, "FIXTURE_PAUSED");
  await assert.rejects(fs.stat(join(cwd, ".pi", "diagnostics")), { code: "ENOENT" });
  for (const mode of ["off", "automatic"]) {
    const disabled = createHandoffDiagnostics({ on() { } }, createExtensionRuntimeState(), { mode });
    assert.equal((await disabled.resume(ctx, "handoff")).code, "DIAGNOSTIC_RECORDER_DISABLED");
    if (mode === "off") assert.equal((await disabled.resume(ctx, "project")).code, "DIAGNOSTIC_RECORDER_DISABLED");
  }
}));

test("maintenance rechecks scope after confirmation and after draining in-flight writes", async () => withTempDirectory(async cwd => {
  const ctx = context(cwd), file = join(cwd, ".pi", "logs", "handoff.jsonl");
  await fs.mkdir(join(cwd, ".pi", "logs"), { recursive: true }); await fs.writeFile(file, '{"run":1}\n');
  const monitor = createHandoffDiagnostics({ on() { } }, createExtensionRuntimeState(), { mode: "verbose" });
  const control = createDiagnosticControls(monitor);
  ctx.ui.confirm = async () => { ctx.sessionManager.getLeafId = () => "changed"; return true; };
  assert.equal((await control.clear(ctx, "handoff")).code, "DIAGNOSTIC_SCOPE_CHANGED");
  assert.deepEqual(await records(file), [{ run: 1 }]);
  const draining = createDiagnosticControls({ ...monitor, flush: async () => { ctx.isProjectTrusted = () => false; } });
  assert.equal((await draining.exportFile(ctx, "handoff", "export.json")).code, "DIAGNOSTIC_SCOPE_CHANGED");
  await assert.rejects(fs.stat(join(cwd, "export.json")), { code: "ENOENT" });
}));

test("the registered blackbox command exposes guarded explicit project resume", async () => withTempDirectory(async cwd => {
  const harness = createExtensionHarness([], { cwd, trusted: true });
  await harness.commands.get("blackbox").handler("resume project", harness.context);
  assert.equal(harness.notifications.at(-1).level, "info");
  assert.equal(await fs.readFile(join(cwd, ".pi", "diagnostics", "runtime.jsonl"), "utf8"), "");
}));

function childProcess(source, cwd) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", source], {
    cwd, env: { ...process.env, PI_CODING_AGENT_DIR: join(cwd, "agent") }, stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "", errors = "";
  child.stdout.on("data", chunk => { output += chunk; }); child.stderr.on("data", chunk => { errors += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve(output) : reject(new Error(errors || "child exit: " + code)));
  });
  done.catch(() => { });
  return { child, done };
}

for (const scope of ["project", "handoff", "global"]) {
  for (const rotate of [false, true]) {
    test(`independent processes append ${scope} JSON atomically${rotate ? " with bounded rotation" : " without loss"}`, { timeout: 15000 }, async () => withTempDirectory(async cwd => {
      const count = rotate ? 45 : 12, maxBytes = rotate ? scope === "project" ? 2048 : 8192 : 1024 * 1024;
      const sources = {
        project: `import {createDiagnosticWriter} from ${JSON.stringify(new URL("../extensions/runtime-diagnostics.ts", import.meta.url).href)};
          const d=createDiagnosticWriter({file:'diagnostics/runtime.jsonl',maxBytes:${maxBytes},maxPending:128,warning:'stopped'});
          for(let i=0;i<${count};i++) d.write(ctx,()=>({producer:process.pid,index:i,text:'中文✓é'})); await d.flush(); if(d.failed) throw Error('writer stopped');`,
        handoff: `import {createHandoffDiagnostics} from ${JSON.stringify(new URL("../extensions/handoff-diagnostics.ts", import.meta.url).href)};
          import {createExtensionRuntimeState} from ${JSON.stringify(new URL("../extensions/runtime-state.ts", import.meta.url).href)};
          const d=createHandoffDiagnostics({on(){}},createExtensionRuntimeState(),{mode:'verbose',maxBytes:${maxBytes}});
          for(let i=0;i<${count};i++) d.trace(ctx,'fixture',{producer:process.pid,index:i,text:'中文✓é'}); await d.flush();`,
        global: `import {createGlobalDiagnostics} from ${JSON.stringify(new URL("../extensions/global-diagnostics.ts", import.meta.url).href)};
          const d=createGlobalDiagnostics({maxBytes:${maxBytes}});
          for(let i=0;i<${count};i++) d.observe(ctx,'pi-init.command_failed'); await d.flush(); if(d.status().written!==${count}||d.status().dropped) throw Error('writer lost records');`,
      };
      const prelude = `let notices=0; const ctx={cwd:process.cwd(),isProjectTrusted:()=>true,sessionManager:{getSessionId:()=>String(process.pid)},ui:{notify:()=>{notices++}}};`;
      await Promise.all(Array.from({ length: 3 }, () => childProcess(prelude + sources[scope] + "if(notices)throw Error('unexpected warning');", cwd).done));
      const file = scope === "global" ? join(cwd, "agent", "diagnostics", "pi-init", "runtime.jsonl") : join(cwd, ".pi", scope === "handoff" ? "logs/handoff.jsonl" : "diagnostics/runtime.jsonl");
      const rows = [];
      for (const suffix of [".1", ""]) {
        try { rows.push(...await records(file + suffix)); assert.ok((await fs.stat(file + suffix)).size <= maxBytes); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      assert.ok(rows.length > 0);
      if (!rotate) assert.equal(rows.length, count * 3);
      else { assert.ok(rows.length < count * 3); await fs.stat(file + ".1"); }
      const identities = rows.map(row => scope === "global" ? row.diagnosticEventId : JSON.stringify([scope === "handoff" ? row.data.producer : row.producer, scope === "handoff" ? row.data.index : row.index]));
      assert.equal(new Set(identities).size, rows.length);
      if (scope !== "global") {
        const producers = new Map();
        for (const row of rows) {
          const value = scope === "handoff" ? row.data : row;
          assert.equal(value.text, "中文✓é");
          const indices = producers.get(value.producer) ?? [];
          indices.push(value.index); producers.set(value.producer, indices);
        }
        for (const indices of producers.values()) {
          assert.equal(indices.at(-1), count - 1);
          assert.ok(indices.every((index, offset) => index === indices[0] + offset), "rotation discards a prefix, never fragments retained producer records");
        }
      }
      assert.equal((await fs.readdir(join(file, ".."))).includes("runtime.lock"), false);
    }));
  }
}

for (const operation of ["clear", "export", "resume"]) {
  test(`handoff ${operation} waits for another process holding the write/rotation lock`, { timeout: 15000 }, async () => withTempDirectory(async cwd => {
    const ctx = context(cwd), directory = join(cwd, ".pi", "logs"), file = join(directory, "handoff.jsonl");
    const monitor = createHandoffDiagnostics({ on() { } }, createExtensionRuntimeState(), { mode: "verbose" });
    monitor.trace(ctx, "before"); await monitor.flush();
    const control = createDiagnosticControls({ ...monitor, agentDir: () => join(cwd, "agent") });
    const source = `import * as fs from 'node:fs/promises'; import {withDiagnosticLock} from ${JSON.stringify(new URL("../extensions/diagnostic-storage.ts", import.meta.url).href)};
      const release=new Promise(resolve=>process.stdin.once('data',resolve));
      await withDiagnosticLock(${JSON.stringify(directory)},async()=>{
        const handle=await fs.open(${JSON.stringify(file)},'a');
        try{await handle.write('{"run":');console.log('locked');await release;await handle.write('77}\\n');}finally{await handle.close();}
      });`;
    const process = childProcess(source, cwd);
    const ready = new Promise((resolve, reject) => {
      let received = "";
      process.child.stdout.on("data", chunk => { received += chunk; if (received.includes("locked")) resolve(); });
      process.done.then(() => reject(new Error("process exited before handshake")), reject);
    });
    try {
      await ready;
      let settled = false;
      const work = operation === "clear" ? control.clear(ctx, "handoff") : operation === "export" ? control.exportFile(ctx, "handoff", "export.json") : control.resume(ctx, "handoff");
      work.then(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 50)); assert.equal(settled, false);
      process.child.stdin.end("release\n"); await process.done;
      const result = await work; assert.equal(result.ok, true);
      if (operation === "clear") await assert.rejects(fs.stat(file), { code: "ENOENT" });
      if (operation === "export") assert.deepEqual(JSON.parse(await fs.readFile(join(cwd, "export.json"), "utf8")).records.at(-1), { run: 77 });
      monitor.trace(ctx, "after"); await monitor.flush();
      assert.equal((await records(file)).at(-1).event, "after");
    } finally {
      if (!process.child.stdin.writableEnded) process.child.stdin.end("release\n");
      await process.done;
      await monitor.flush();
    }
  }));
}
