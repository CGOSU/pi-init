import assert from "node:assert/strict";
import test from "node:test";
import { createGmcClient, getGmcCommand, getPiCommand, getPiInvocation } from "../src/gmc-client.js";

const cwd = process.platform === "win32" ? "C:\\repo" : "/repo";
const candidate = process.platform === "win32" ? "C:\\work\\candidate" : "/work/candidate";
const configPath = process.platform === "win32" ? "C:\\temp\\gmc-empty.yaml" : "/tmp/gmc-empty.yaml";
const baseCommit = "0123456789abcdef0123456789abcdef01234567";

function worktree(name, worktreePath, branch = name) {
  return { name, path: worktreePath, branch, commit: baseCommit, status: "clean" };
}

test("gmc client 使用 JSON list 验证真实 worktree 路径和固定基线", async () => {
  const calls = [];
  const exec = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === "git") return { code: 0, stdout: `${baseCommit}\n`, stderr: "" };
    if (args[0] === "version") return { code: 0, stdout: "gmc version 0.10.1\n", stderr: "" };
    if (args[0] === "--output" && args.includes("hook")) return { code: 0, stdout: "[]", stderr: "" };
    if (args[0] === "--output" && args.includes("share")) return { code: 0, stdout: "[]", stderr: "" };
    if (args[0] === "wt" && args[1] === "add") return { code: 0, stdout: "created\n", stderr: "" };
    if (args[0] === "--output") return { code: 0, stdout: JSON.stringify([worktree("agent-a", candidate)]), stderr: "" };
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
  const client = createGmcClient({ exec });
  assert.equal(await client.checkVersion(cwd), "0.10.1");
  assert.equal(await client.resolveBase(cwd), baseCommit);
  const result = await client.add(cwd, { name: "agent-a", baseCommit });
  assert.deepEqual(result, worktree("agent-a", candidate));
  assert.deepEqual(calls.at(-1).args, ["--output", "json", "wt", "list"]);
  assert.equal(calls.at(-1).options.cwd, cwd);
});

test("gmc client 可绑定空配置并拒绝启用的共享资源或 hooks", async () => {
  const calls = [];
  const exec = async (_command, args) => {
    calls.push(args);
    if (args.includes("hook")) return { code: 0, stdout: "[{\"id\":\"install\",\"cmd\":\"npm install\",\"disabled\":false}]", stderr: "" };
    return { code: 0, stdout: "[]", stderr: "" };
  };
  const client = createGmcClient({ exec, configPath });
  await assert.rejects(() => client.add(cwd, { name: "agent-a", baseCommit }), /worktree hook/);
  assert.ok(calls[0].includes(configPath));
  assert.equal(calls.some((args) => args.includes("add")), false);
});

test("gmc client 不隐藏非零退出、坏 JSON 或基线漂移", async () => {
  const failing = createGmcClient({ exec: async () => ({ code: 1, stdout: "", stderr: "failed" }) });
  await assert.rejects(() => failing.list(cwd), /失败/);

  const malformed = createGmcClient({ exec: async () => ({ code: 0, stdout: "not-json", stderr: "" }) });
  await assert.rejects(() => malformed.list(cwd), /有效 JSON/);

  const drift = createGmcClient({ exec: async (_command, args) => {
    if (args[0] === "--output" && (args.includes("hook") || args.includes("share"))) return { code: 0, stdout: "[]", stderr: "" };
    if (args[0] === "wt" && args[1] === "add") return { code: 0, stdout: "created", stderr: "" };
    return { code: 0, stdout: JSON.stringify([worktree("agent-a", candidate, "agent-a")].map((item) => ({ ...item, commit: "fedcba987654321" }))), stderr: "" };
  } });
  await assert.rejects(() => drift.add(cwd, { name: "agent-a", baseCommit }), /基线不一致/);
});

test("gmc promote 使用独立集成 cwd，不自动删除或提交", async () => {
  const calls = [];
  const client = createGmcClient({ exec: async (command, args, options) => {
    calls.push({ command, args, options });
    return { code: 0, stdout: "promoted", stderr: "" };
  } });
  const result = await client.promote(cwd, candidate);
  assert.equal(result.stdout, "promoted");
  assert.deepEqual(calls[0].args, ["wt", "promote", candidate]);
  assert.equal(calls[0].options.cwd, cwd);
  await assert.rejects(() => client.promote(cwd, cwd), /不能等于/);
});

test("Pi 和 gmc Windows 使用可执行 shim，POSIX 使用裸命令", () => {
  assert.equal(getPiCommand("linux"), "pi");
  assert.deepEqual(getPiInvocation("win32", ""), { command: "cmd.exe", args: ["/d", "/s", "/c", "pi.cmd"] });
  assert.equal(getGmcCommand("win32"), "gmc.exe");
  assert.equal(getGmcCommand("linux"), "gmc");
});
