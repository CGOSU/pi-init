import { spawn as spawnProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { basename, join } from "node:path";

import { isPathAllowed, validateParallelTasks } from "./parallel.js";

export const DEFAULT_WORKER_TIMEOUT_MS = 15 * 60 * 1000;
export const WORKER_RETRY_LIMIT = 1;
const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;

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

function appendCaptured(chunks, value, state) {
  if (!value || state.bytes >= MAX_CAPTURED_OUTPUT_BYTES) return;
  const remaining = MAX_CAPTURED_OUTPUT_BYTES - state.bytes;
  const chunk = Buffer.from(value, "utf8").subarray(0, remaining).toString("utf8");
  chunks.push(chunk);
  state.bytes += Buffer.byteLength(chunk, "utf8");
}

function extractMessageText(message) {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function formatToolActivity(event) {
  if (event.type === "tool_execution_start") {
    const args = event.args && typeof event.args === "object" ? JSON.stringify(event.args) : "";
    const preview = args.length > 100 ? `${args.slice(0, 97)}...` : args;
    return preview ? `${event.toolName}: ${preview}` : String(event.toolName);
  }
  if (event.type === "tool_execution_update") {
    return `${event.toolName}: 执行中`;
  }
  if (event.type === "auto_retry_start") {
    return `Pi 自动重试模型请求（${event.attempt}/${event.maxAttempts}）`;
  }
  if (event.type === "compaction_start") {
    return "Pi 正在压缩上下文";
  }
  if (event.type === "message_update") {
    const delta = event.assistantMessageEvent?.delta;
    return typeof delta === "string" && delta.trim() ? `模型输出：${truncateText(delta.trim(), 120)}` : "模型处理中";
  }
  if (event.type === "message_end" && event.message?.role === "assistant") {
    const text = extractMessageText(event.message);
    return text ? `模型输出：${truncateText(text.split("\n")[0], 120)}` : "模型已返回";
  }
  return undefined;
}

function isTransientFailure(value) {
  return /(?:429|502|503|504|rate\s*limit|too\s*many\s*requests|timeout|timed\s*out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENETUNREACH|EAI_AGAIN|network|fetch failed|temporar(?:y|ily)|socket)/i.test(
    value,
  );
}

function createError(message, details = {}) {
  const error = new Error(message);
  Object.assign(error, details);
  return error;
}

function formatElapsed(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function snapshotTaskStates(states, now = Date.now()) {
  return states.map((state) => ({
    id: state.id,
    status: state.status,
    attempt: state.attempt,
    current: state.current,
    elapsedMs: state.startedAt ? now - state.startedAt : state.elapsedMs,
    lastActivityAt: state.lastActivityAt,
    ...(state.error ? { error: state.error } : {}),
  }));
}

function overallStatus(states) {
  if (states.some((state) => state.status === "running" || state.status === "starting" || state.status === "retrying" || state.status === "validating")) {
    return "running";
  }
  if (states.some((state) => state.status === "failed" || state.status === "cancelled")) return "failed";
  if (states.every((state) => state.status === "completed")) return "completed";
  return "starting";
}

function emitProgress(onUpdate, states, status = overallStatus(states), extra = {}) {
  if (!onUpdate) return;
  const tasks = snapshotTaskStates(states);
  const finished = tasks.filter((task) => ["completed", "failed", "cancelled"].includes(task.status)).length;
  const running = tasks.filter((task) => ["running", "starting", "retrying", "validating"].includes(task.status)).length;
  const active = tasks.find((task) => !["completed", "failed", "cancelled"].includes(task.status));
  const activeText = active ? ` · ${active.id}: ${active.current} (${formatElapsed(active.elapsedMs)})` : "";
  onUpdate({
    content: [{ type: "text", text: `并行开发：${finished}/${tasks.length} 完成 · ${running} 运行${activeText}` }],
    details: { status, tasks, ...extra },
  });
}

function parseJsonLines(buffer, onEvent) {
  let remaining = buffer;
  const lines = remaining.split("\n");
  remaining = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      onEvent(JSON.parse(line));
    } catch {
      // Pi JSON mode can emit a non-JSON diagnostic; keep it in captured stdout.
    }
  }
  return remaining;
}

function terminateProcess(child) {
  if (child.exitCode !== null) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // The process may have exited between the check and kill.
  }
}

export async function spawnPiWorker(invocation, { cwd, signal, timeout, onEvent }) {
  if (signal?.aborted) {
    return { stdout: "", stderr: "", code: -1, killed: true, aborted: true, timedOut: false };
  }

  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let spawnError;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let summary = "";
    const stdoutChunks = [];
    const capturedStdout = { bytes: 0 };
    const capturedStderr = { bytes: 0 };
    let timeoutId;
    let forceKillId;
    let handleEvent = () => {};

    const finish = (code, killed = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      clearTimeout(forceKillId);
      signal?.removeEventListener("abort", abort);
      if (stdoutBuffer.trim()) {
        try {
          handleEvent(JSON.parse(stdoutBuffer));
        } catch {
          // Ignore an incomplete diagnostic line.
        }
      }
      resolve({
        stdout: stdoutChunks.join(""),
        stderr: stderrBuffer,
        summary,
        code: code ?? 0,
        killed,
        aborted,
        timedOut,
        spawnError,
      });
    };

    const abort = () => {
      aborted = true;
      terminateProcess(child);
      forceKillId = setTimeout(() => finish(-1, true), 2000);
    };

    try {
      child = spawnProcess(invocation.command, invocation.args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      spawnError = error;
      finish(1, false);
      return;
    }

    handleEvent = (event) => {
      if (event.type === "message_end" && event.message?.role === "assistant") {
        summary = extractMessageText(event.message) || summary;
      }
      onEvent?.(event);
    };
    child.stdout?.on("data", (data) => {
      const text = data.toString();
      appendCaptured(stdoutChunks, text, capturedStdout);
      stdoutBuffer += text;
      stdoutBuffer = parseJsonLines(stdoutBuffer, handleEvent);
    });
    child.stderr?.on("data", (data) => {
      const text = data.toString();
      const remaining = MAX_CAPTURED_OUTPUT_BYTES - capturedStderr.bytes;
      if (remaining > 0) {
        const chunk = Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
        stderrBuffer += chunk;
        capturedStderr.bytes += Buffer.byteLength(chunk, "utf8");
      }
    });
    child.on("error", (error) => {
      spawnError = error;
      finish(1, false);
    });
    child.on("close", (code, signalName) => finish(code, Boolean(signalName) || child.killed));

    if (timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        terminateProcess(child);
        forceKillId = setTimeout(() => finish(-1, true), 2000);
      }, timeout);
    }
    if (signal) {
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    }
  });
}

async function writeWorkerLogs(tempRoot, index, attempt, child) {
  await Promise.all([
    writeFile(join(tempRoot, `worker-${index + 1}-attempt-${attempt}.stdout.log`), child.stdout ?? "", "utf8"),
    writeFile(join(tempRoot, `worker-${index + 1}-attempt-${attempt}.stderr.log`), child.stderr ?? "", "utf8"),
  ]);
}

function guidanceFor(category) {
  if (category === "infrastructure") return "已自动重试一次；仍失败时由用户检查网络、凭据或模型服务。";
  if (category === "scope") return "由主开发测试工程师检查文件范围和子代理修改。";
  if (category === "merge") return "由架构师重新拆分冲突工作包，再重新执行。";
  if (category === "cancelled") return "用户已取消，现场保留，不自动重试。";
  return "由主开发测试工程师接管失败任务并检查测试输出。";
}

async function runDeveloperWorker(
  exec,
  spawnWorker,
  base,
  tempRoot,
  worktree,
  plan,
  task,
  target,
  index,
  total,
  progress,
  states,
  signal,
  workerTimeoutMs,
  onUpdate,
  onStarted,
) {
  const state = states[index];
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

  let output = "";
  let lastError;
  for (let attempt = 1; attempt <= WORKER_RETRY_LIMIT + 1; attempt += 1) {
    state.attempt = attempt;
    state.status = attempt === 1 ? "starting" : "retrying";
    state.current = attempt === 1 ? "启动子代理" : `基础设施错误，自动重试 ${attempt - 1}/${WORKER_RETRY_LIMIT}`;
    state.startedAt ??= Date.now();
    state.lastActivityAt = Date.now();
    emitProgress(onUpdate, states);
    if (attempt === 1) {
      const started = ++progress.started;
      onStarted?.({ started, total, id: task.id });
    }

    if (attempt > 1) {
      await runGit(exec, worktree, ["reset", "--hard", base], signal);
      await runGit(exec, worktree, ["clean", "-fd"], signal);
    }

    const invocation = getPiInvocation([
      "--mode",
      "json",
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
    const child = await spawnWorker(invocation, {
      cwd: worktree,
      signal,
      timeout: workerTimeoutMs,
      onEvent: (event) => {
        const activity = formatToolActivity(event);
        if (activity) {
          state.current = activity;
          state.lastActivityAt = Date.now();
          emitProgress(onUpdate, states);
        }
      },
    });
    output = child.summary || child.stdout || "";
    await writeWorkerLogs(tempRoot, index, attempt, child);

    if (child.aborted || signal?.aborted) {
      lastError = createError(`任务 ${task.id} 已取消`, { category: "cancelled", retryable: false });
    } else if (child.timedOut) {
      lastError = createError(`任务 ${task.id} 超时（${formatElapsed(workerTimeoutMs)}）`, {
        category: "infrastructure",
        retryable: true,
      });
    } else if (child.spawnError) {
      lastError = createError(`任务 ${task.id} 子代理启动失败：${textOf(child.spawnError)}`, {
        category: "infrastructure",
        retryable: true,
      });
    } else if (child.code !== 0 || child.killed) {
      const detail = child.stderr.trim() || output.trim() || "子代理未返回结果";
      lastError = createError(`任务 ${task.id} 失败：${truncateText(detail)}`, {
        category: isTransientFailure(detail) ? "infrastructure" : "code",
        retryable: isTransientFailure(detail),
      });
    } else {
      state.status = "validating";
      state.current = "校验修改范围";
      state.lastActivityAt = Date.now();
      emitProgress(onUpdate, states);
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
        lastError = createError(`任务 ${task.id} 修改了未声明范围：${unauthorized.join(", ")}`, {
          category: "scope",
          retryable: false,
        });
      } else {
        state.status = "completed";
        state.current = `完成，${changedFiles.length} 个文件`;
        state.elapsedMs = state.startedAt ? Date.now() - state.startedAt : 0;
        state.lastActivityAt = Date.now();
        emitProgress(onUpdate, states);
        return {
          id: task.id,
          output: truncateText(output || "子代理未提供文字摘要"),
          changedFiles,
          patch: await runGit(exec, worktree, ["diff", "--binary", "--full-index", "--no-ext-diff", base], signal),
          category: "completed",
        };
      }
    }

    state.error = textOf(lastError);
    state.lastActivityAt = Date.now();
    if (lastError.retryable && attempt <= WORKER_RETRY_LIMIT && !signal?.aborted) {
      state.status = "retrying";
      state.current = `基础设施错误，准备自动重试 ${attempt}/${WORKER_RETRY_LIMIT}`;
      emitProgress(onUpdate, states);
      continue;
    }

    state.status = lastError.category === "cancelled" ? "cancelled" : "failed";
    state.current = `${lastError.category === "infrastructure" ? "基础设施错误" : "任务失败"}：${truncateText(textOf(lastError), 160)}`;
    emitProgress(onUpdate, states);
    throw lastError;
  }

  throw lastError ?? createError(`任务 ${task.id} 失败`, { category: "code", retryable: false });
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
  spawnWorker = spawnPiWorker,
  heartbeatMs = 5000,
  workerTimeoutMs = DEFAULT_WORKER_TIMEOUT_MS,
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
  const states = tasks.map(({ id }) => ({
    id,
    status: "queued",
    attempt: 0,
    current: "排队中",
    startedAt: undefined,
    elapsedMs: 0,
    lastActivityAt: Date.now(),
    error: undefined,
  }));
  let preserveFailureArtifacts = false;
  let heartbeat;
  emitProgress(onUpdate, states, "starting", { total: tasks.length });

  try {
    for (let index = 0; index < tasks.length; index += 1) {
      const worktree = join(tempRoot, `worktree-${index + 1}`);
      await runGit(exec, repoRoot, ["worktree", "add", "--detach", worktree, base], signal);
      worktrees.push(worktree);
    }

    if (heartbeatMs > 0 && onUpdate) {
      heartbeat = setInterval(() => emitProgress(onUpdate, states), heartbeatMs);
      heartbeat.unref?.();
    }

    const settled = await Promise.allSettled(
      tasks.map((task, index) =>
        runDeveloperWorker(
          exec,
          spawnWorker,
          base,
          tempRoot,
          worktrees[index],
          plan,
          task,
          target,
          index,
          tasks.length,
          progress,
          states,
          signal,
          workerTimeoutMs,
          onUpdate,
          onStarted,
        ),
      ),
    );
    const results = settled.map((entry, index) =>
      entry.status === "fulfilled"
        ? { ...entry.value, ok: true }
        : {
            id: tasks[index].id,
            ok: false,
            error: textOf(entry.reason),
            category: entry.reason?.category ?? "code",
            changedFiles: [],
            output: "",
            patch: "",
          },
    );
    const failures = results.filter((result) => !result.ok);
    if (failures.length > 0) {
      preserveFailureArtifacts = true;
      emitProgress(onUpdate, states, "failed", { failures });
      throw createError(
        [
          `并行开发失败：${failures.length}/${results.length} 个任务失败`,
          ...failures.map((result) => `- ${result.id}：${result.error}\n  ${guidanceFor(result.category)}`),
          `失败现场和日志已保留：${tempRoot}`,
        ].join("\n"),
        { category: failures.some((result) => result.category === "scope") ? "scope" : "code", results, tempRoot },
      );
    }

    const currentStatus = await runGit(exec, repoRoot, ["status", "--porcelain", "--untracked-files=all"], signal);
    const currentBase = (await runGit(exec, repoRoot, ["rev-parse", "HEAD"], signal)).trim();
    if (currentStatus.trim() || currentBase !== base) {
      preserveFailureArtifacts = true;
      throw createError("主工作区在并行执行期间发生变化，已停止合并。处理者：架构师检查主工作区和任务边界。失败现场和日志已保留。", {
        category: "merge",
        tempRoot,
      });
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
        preserveFailureArtifacts = true;
        throw createError(`并行修改无法合并：${check.stderr.trim() || check.stdout.trim()}\n处理者：架构师重新拆分冲突工作包。失败现场和日志已保留：${tempRoot}`, {
          category: "merge",
          tempRoot,
        });
      }
      await runGit(exec, repoRoot, ["apply", "--binary", patchPath], signal);
    }

    emitProgress(onUpdate, states, "completed");
    return { results, tasks: snapshotTaskStates(states) };
  } catch (error) {
    if (tempRoot && !String(error?.message ?? error).includes(tempRoot) && !preserveFailureArtifacts) {
      preserveFailureArtifacts = true;
      error = createError(`${textOf(error)}\n失败现场和日志已保留：${tempRoot}`, {
        category: error?.category ?? "code",
        tempRoot,
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (!preserveFailureArtifacts) {
      for (const worktree of worktrees.reverse()) {
        try {
          await exec("git", ["worktree", "remove", "--force", worktree], {
            cwd: repoRoot,
            timeout: 10000,
          });
        } catch {
          // Cleanup must not mask a successful merge.
        }
      }
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}
