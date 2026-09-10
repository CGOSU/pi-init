import { existsSync } from "node:fs";
import path from "node:path";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const COMMIT_PATTERN = /^[0-9a-f]{7,128}$/i;

function text(value, label, maxLength = 4096) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}不能为空`);
  const result = value.trim();
  if (result.length > maxLength) throw new Error(`${label}过长`);
  return result;
}

function commit(value, label = "commit") {
  const result = text(value, label, 128);
  if (!COMMIT_PATTERN.test(result)) throw new Error(`${label}必须是 commit 哈希`);
  return result.toLowerCase();
}

function absolutePath(value, label) {
  const result = text(value, label, 4096);
  if (!path.isAbsolute(result) && !path.win32.isAbsolute(result)) throw new Error(`${label}必须是绝对路径`);
  return path.normalize(result);
}

function samePath(left, right) {
  const normalize = (value) => {
    const result = path.normalize(value);
    return process.platform === "win32" ? result.toLowerCase() : result;
  };
  return normalize(left) === normalize(right);
}

function parseJson(stdout, label) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`${label}不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertCommandSuccess(result, command) {
  if (!result || result.code !== 0) {
    const details = [result?.stderr, result?.stdout].filter((item) => typeof item === "string" && item.trim()).join("\n");
    throw new Error(`${command}失败${details ? `：${details.trim()}` : ""}`);
  }
}

function normalizeWorktree(item, label) {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}格式无效`);
  const result = {
    name: text(item.name, `${label} name`, 256),
    path: absolutePath(item.path, `${label} path`),
    branch: text(item.branch, `${label} branch`, 256),
    commit: commit(item.commit, `${label} commit`),
  };
  if (typeof item.status !== "undefined") result.status = text(item.status, `${label} status`, 128);
  return result;
}

function normalizeList(stdout) {
  const value = parseJson(stdout, "gmc worktree 列表");
  if (!Array.isArray(value)) throw new Error("gmc worktree 列表必须是数组");
  return value.map((item, index) => normalizeWorktree(item, `gmc worktree[${index}]`));
}

function normalizePreparationList(stdout, label) {
  const value = parseJson(stdout, label);
  if (!Array.isArray(value)) throw new Error(`${label}必须是数组`);
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${label}[${index}]格式无效`);
    return item;
  });
}

function assertSafeName(value) {
  const name = text(value, "worktree name", 128);
  if (!NAME_PATTERN.test(name) || name.includes("..")) throw new Error("worktree name包含不安全字符");
  return name;
}

export function getPiInvocation(platform = process.platform, currentScript = platform === process.platform ? process.argv[1] : undefined) {
  if (platform === process.platform && currentScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript] };
  }
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", "pi.cmd"] };
  return { command: "pi", args: [] };
}

export function getPiCommand(platform = process.platform) {
  return getPiInvocation(platform).command;
}

export function getGmcCommand(platform = process.platform) {
  return platform === "win32" ? "gmc.exe" : "gmc";
}

export function createGmcClient({
  exec,
  gmcCommand = getGmcCommand(),
  gitCommand = "git",
  configPath,
  expectedVersion = "0.10.1",
} = {}) {
  if (typeof exec !== "function") throw new Error("gmc client需要 exec 函数");
  const isolatedConfigPath = configPath === undefined ? undefined : absolutePath(configPath, "gmc config path");

  function gmcArgs(args) {
    return isolatedConfigPath ? ["--config", isolatedConfigPath, ...args] : args;
  }

  async function run(command, args, cwd, signal) {
    const workdir = absolutePath(cwd, "命令 cwd");
    const result = await exec(command, command === gmcCommand ? gmcArgs(args) : args, { cwd: workdir, signal });
    return result;
  }

  async function checkVersion(cwd, signal) {
    const result = await run(gmcCommand, ["version"], cwd, signal);
    assertCommandSuccess(result, "gmc version");
    const output = text(result.stdout, "gmc version输出", 4096);
    const match = output.match(/\bgmc version\s+v?(\d+\.\d+\.\d+)/i);
    if (!match) throw new Error("gmc version输出缺少可识别版本");
    if (expectedVersion && match[1] !== expectedVersion) {
      throw new Error(`gmc版本不受支持：期望 ${expectedVersion}，实际 ${match[1]}`);
    }
    return match[1];
  }

  async function assertNoPreparation(cwd, signal) {
    const hookResult = await run(gmcCommand, ["--output", "json", "wt", "hook", "list"], cwd, signal);
    assertCommandSuccess(hookResult, "gmc wt hook list");
    const hooks = normalizePreparationList(hookResult.stdout, "gmc hooks");
    if (hooks.some((hook) => hook.disabled !== true)) throw new Error("检测到启用的 gmc worktree hook，已拒绝自动执行");

    const shareResult = await run(gmcCommand, ["--output", "json", "wt", "share", "list"], cwd, signal);
    assertCommandSuccess(shareResult, "gmc wt share list");
    const shares = normalizePreparationList(shareResult.stdout, "gmc shares");
    if (shares.some((share) => share.disabled !== true)) throw new Error("检测到启用的 gmc shared resource，已拒绝自动共享");
  }

  async function list(cwd, signal) {
    const result = await run(gmcCommand, ["--output", "json", "wt", "list"], cwd, signal);
    assertCommandSuccess(result, "gmc wt list");
    return normalizeList(result.stdout);
  }

  async function resolveBase(cwd, ref = "HEAD", signal) {
    const reference = text(ref, "base ref", 256);
    if (reference.startsWith("-") || reference.includes("\0")) throw new Error("base ref包含不安全字符");
    const result = await run(gitCommand, ["rev-parse", "--verify", `${reference}^{commit}`], cwd, signal);
    assertCommandSuccess(result, "git rev-parse");
    return commit(result.stdout.split(/\r?\n/, 1)[0], "解析出的 base commit");
  }

  async function add(cwd, { name, baseCommit }, signal) {
    const worktreeName = assertSafeName(name);
    const fixedCommit = commit(baseCommit, "baseCommit");
    const parent = absolutePath(cwd, "parent cwd");
    await assertNoPreparation(parent, signal);
    const result = await run(gmcCommand, ["wt", "add", worktreeName, "-b", fixedCommit], parent, signal);
    assertCommandSuccess(result, `gmc wt add ${worktreeName}`);
    const worktrees = await list(parent, signal);
    const matches = worktrees.filter((item) => item.branch === worktreeName);
    if (matches.length !== 1) throw new Error(`gmc wt add后未找到唯一 worktree：${worktreeName}`);
    const worktree = matches[0];
    if (samePath(worktree.path, parent)) throw new Error("gmc 创建的 worktree 不能等于主工作区");
    if (worktree.commit !== fixedCommit) throw new Error(`gmc worktree基线不一致：期望 ${fixedCommit}，实际 ${worktree.commit}`);
    return worktree;
  }

  async function promote(integrationCwd, candidatePath, signal) {
    const parent = absolutePath(integrationCwd, "integration cwd");
    const candidate = absolutePath(candidatePath, "candidate path");
    if (samePath(parent, candidate)) throw new Error("candidate不能等于集成工作区");
    const result = await run(gmcCommand, ["wt", "promote", candidate], parent, signal);
    assertCommandSuccess(result, "gmc wt promote");
    return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }

  async function remove(cwd, name, signal) {
    const worktreeName = assertSafeName(name);
    const result = await run(gmcCommand, ["wt", "remove", worktreeName], cwd, signal);
    assertCommandSuccess(result, `gmc wt remove ${worktreeName}`);
    return result;
  }

  return {
    checkVersion,
    list,
    resolveBase,
    add,
    promote,
    remove,
  };
}
