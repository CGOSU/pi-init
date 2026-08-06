import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";

import { isPathAllowed, validateParallelTasks } from "./parallel.js";

function textOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function getPiInvocation(args) {
  const currentScript = process.argv[1];
  const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
  if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(executable)) {
    return { command: process.execPath, args };
  }
  return { command: process.platform === "win32" ? "pi.cmd" : "pi", args };
}

async function runGit(exec, cwd, args, signal) {
  const result = await exec("git", args, { cwd, signal });
  if (result.code !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(`git ${args.join(" ")} 失败（退出码 ${result.code}）${output ? `：${output}` : ""}`);
  }
  return result.stdout;
}

function truncateText(value, maxBytes = 8000) {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  let result = value.slice(0, maxBytes);
  while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(0, -1);
  return `${result}\n\n[输出已截断]`;
}

async function runDeveloperWorker(
  exec,
  base,
  tempRoot,
  worktree,
  plan,
  task,
  target,
  index,
  total,
  progress,
  signal,
  onUpdate,
  onStarted,
) {
  const promptPath = join(tempRoot, `worker-${index + 1}.md`);
  await writeFile(
    promptPath,
    [
      "你是并行开发测试工程师。架构师已经完成规划；你只负责下面这个独立工作包。",
      "必须在当前独立 worktree 内实现代码并运行相关测试。不要调用其他代理，不要 git commit，不要 git push。",
      `只能修改以下文件或目录：${task.files.join(", ")}`,
      "如果测试或工具产生了声明范围外的文件，清理它们；不要修改范围外的源码。",
      "完成后用简短文字说明修改内容、测试命令和真实结果。",
      "",
      "## 架构规划",
      plan,
      "",
      `## 工作包 ${task.id}`,
      task.task,
    ].join("\n"),
    "utf8",
  );

  const started = ++progress.started;
  onStarted?.({ started, total, id: task.id });
  onUpdate?.({
    content: [{ type: "text", text: `已启动 ${started}/${total} 个子代理：${task.id}（${target.provider}/${target.model}:${target.thinkingLevel}）` }],
    details: { status: "running", id: task.id, started, total },
  });

  const invocation = getPiInvocation([
    "-p",
    "--no-approve",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--model",
    `${target.provider}/${target.model}`,
    "--thinking",
    target.thinkingLevel,
    "--append-system-prompt",
    promptPath,
    `Task: ${task.task}`,
  ]);
  const child = await exec(invocation.command, invocation.args, { cwd: worktree, signal });
  const output = child.stdout.trim();
  if (child.code !== 0 || child.killed) {
    const detail = child.stderr.trim() || output || "子代理未返回结果";
    throw new Error(`任务 ${task.id} 失败：${truncateText(detail)}`);
  }

  await runGit(exec, worktree, ["add", "--all"], signal);
  const changedFiles = (await runGit(
    exec,
    worktree,
    ["diff", "--no-renames", "--name-only", "-z", base],
    signal,
  ))
    .split("\0")
    .filter(Boolean);
  const unauthorized = changedFiles.filter((file) => !isPathAllowed(file, task.files));
  if (unauthorized.length > 0) {
    throw new Error(`任务 ${task.id} 修改了未声明范围：${unauthorized.join(", ")}`);
  }

  return {
    id: task.id,
    output: truncateText(output || "子代理未提供文字摘要"),
    changedFiles,
    patch: await runGit(exec, worktree, ["diff", "--binary", "--full-index", "--no-ext-diff", base], signal),
  };
}

export async function runParallelDevelop({
  exec,
  cwd,
  planInput,
  taskInput,
  target,
  signal,
  onUpdate,
  onStarted,
}) {
  const plan = planInput.trim();
  if (!plan) throw new Error("parallel_develop 缺少架构规划");
  const tasks = validateParallelTasks(taskInput);
  const repoRoot = (await runGit(exec, cwd, ["rev-parse", "--show-toplevel"], signal)).trim();
  const status = await runGit(exec, repoRoot, ["status", "--porcelain", "--untracked-files=all"], signal);
  if (status.trim()) {
    throw new Error("parallel_develop 要求主工作区干净；请先处理现有修改，再启动并行开发");
  }
  const base = (await runGit(exec, repoRoot, ["rev-parse", "HEAD"], signal)).trim();
  const tempRoot = await mkdtemp(join(os.tmpdir(), "pi-init-parallel-"));
  const worktrees = [];
  const progress = { started: 0 };
  onUpdate?.({
    content: [{ type: "text", text: `准备启动 ${tasks.length} 个并行子代理：${tasks.map(({ id }) => id).join(", ")}` }],
    details: { status: "starting", started: 0, total: tasks.length, tasks: tasks.map(({ id }) => id) },
  });

  try {
    for (let index = 0; index < tasks.length; index += 1) {
      const worktree = join(tempRoot, `worktree-${index + 1}`);
      await runGit(exec, repoRoot, ["worktree", "add", "--detach", worktree, base], signal);
      worktrees.push(worktree);
    }

    const settled = await Promise.allSettled(
      tasks.map((task, index) =>
        runDeveloperWorker(
          exec,
          base,
          tempRoot,
          worktrees[index],
          plan,
          task,
          target,
          index,
          tasks.length,
          progress,
          signal,
          onUpdate,
          onStarted,
        ),
      ),
    );
    const results = settled.map((entry, index) =>
      entry.status === "fulfilled"
        ? { ...entry.value, ok: true }
        : { id: tasks[index].id, ok: false, error: textOf(entry.reason), changedFiles: [], output: "", patch: "" },
    );
    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      throw new Error(
        [
          `并行开发失败：${failures.length}/${results.length} 个任务失败`,
          ...failures.map((result) => `- ${result.id}: ${result.error}`),
        ].join("\n"),
      );
    }

    const currentStatus = await runGit(exec, repoRoot, ["status", "--porcelain", "--untracked-files=all"], signal);
    const currentBase = (await runGit(exec, repoRoot, ["rev-parse", "HEAD"], signal)).trim();
    if (currentStatus.trim() || currentBase !== base) {
      throw new Error("主工作区在并行执行期间发生变化，已停止合并");
    }

    const patch = results.map((result) => result.patch).filter(Boolean).join("\n");
    if (patch) {
      const patchPath = join(tempRoot, "combined.patch");
      await writeFile(patchPath, patch, "utf8");
      const check = await exec("git", ["apply", "--check", "--binary", patchPath], {
        cwd: repoRoot,
        signal,
      });
      if (check.code !== 0) {
        throw new Error(`并行修改无法合并：${check.stderr.trim() || check.stdout.trim()}`);
      }
      await runGit(exec, repoRoot, ["apply", "--binary", patchPath], signal);
    }

    return { results };
  } finally {
    for (const worktree of worktrees.reverse()) {
      await exec("git", ["worktree", "remove", "--force", worktree], {
        cwd: repoRoot,
        timeout: 10000,
      });
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}
