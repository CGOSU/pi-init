import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Text } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parallelBatchParameters } from "./contracts.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import {
  attachParallelIntegrationWorktree,
  attachParallelWorkerWorktree,
  beginParallelIntegration,
  blockParallelBatchForRecovery,
  cancelParallelBatch,
  createParallelBatch,
  hydrateParallelBatch,
  parallelBatchProgress,
  recordParallelIntegrationResult,
  recordParallelWorkerFailure,
  recordParallelWorkerResult,
  retryParallelWorker,
  startParallelBatch,
  startParallelWorker,
} from "../src/parallel-batch.js";
import { createGmcClient, getGmcCommand } from "../src/gmc-client.js";
import { runParallelWorker, type ParallelWorkerSpec } from "./parallel-worker.ts";
import { textOf, type ExtensionRuntimeState, type ParallelBatchState, type WorkflowState } from "./runtime-state.ts";

const PARALLEL_ENTRY_TYPE = "pi-init-parallel-batch";
const ACTIVE_BATCH_STATUSES = new Set(["planned", "running", "awaiting-integration", "integrating"]);

type ParallelBatchDependencies = {
  roleRuntime: RoleRuntime;
  getWorkflowState: () => WorkflowState | undefined;
};

type ToolUpdate = (result: { content: Array<{ type: "text"; text: string }>; details?: unknown }) => void;

function stateText(state: ParallelBatchState) {
  const progress = parallelBatchProgress(state);
  const integration = state.integration ? ` · 集成 ${state.integration.path}` : "";
  const reason = state.status === "blocked" && state.blockReason ? ` · 原因 ${state.blockReason}` : "";
  return `批次 ${state.batchId} · ${state.status} · ${progress.completed}/${progress.total} 完成 · ${progress.running} 运行中${integration}${reason}`;
}

function resultText(state: ParallelBatchState | undefined) {
  return state ? stateText(state) : "当前没有并行批次。";
}

function isActive(state: ParallelBatchState | undefined) {
  return Boolean(state && ACTIVE_BATCH_STATUSES.has(state.status));
}

function changedFilesFromOutput(stdout: string) {
  return stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

export function createParallelBatchRuntime(
  pi: ExtensionAPI,
  state: ExtensionRuntimeState,
  deps: ParallelBatchDependencies,
) {
  let activeController: AbortController | undefined;

  function updateStatus(ctx: ExtensionContext) {
    ctx.ui.setStatus("pi-init-parallel", state.parallelBatchState ? stateText(state.parallelBatchState) : undefined);
  }

  function persist(next: ParallelBatchState, ctx: ExtensionContext, showStatus = true) {
    state.parallelBatchState = next;
    pi.appendEntry(PARALLEL_ENTRY_TYPE, next);
    if (showStatus && !state.runtimeDisposed) updateStatus(ctx);
    return next;
  }

  function assertTrusted(ctx: ExtensionContext) {
    if (!ctx.isProjectTrusted()) throw new Error("parallel_batch 仅允许在受信任项目中运行；请先信任当前项目");
  }

  function assertCurrentRole(ctx: ExtensionContext, batch?: ParallelBatchState) {
    const activeRole = deps.roleRuntime.activeRoleFor(ctx);
    if (!activeRole) throw new Error("parallel_batch 需要先通过 switch_role 确认当前角色");
    const workflow = deps.getWorkflowState();
    if (batch?.workflowTaskId) {
      if (!workflow || workflow.executor !== "local" || workflow.status !== "running" || workflow.currentTaskId !== batch.workflowTaskId) {
        throw new Error(`parallel_batch 关联的 local 任务不可用：${batch.workflowTaskId}`);
      }
      const workflowTask = workflow.tasks.find((task) => task.id === batch.workflowTaskId);
      if (!workflowTask || workflowTask.role !== activeRole.role) {
        throw new Error(`parallel_batch 当前角色 ${activeRole.role} 与关联任务角色不匹配`);
      }
      return activeRole;
    }
    if (workflow && workflow.status === "running" && workflow.executor !== "local") {
      throw new Error("parallel_batch 不能在 subtask 工作流中创建独立批次");
    }
    if (activeRole.role !== "developer-test") {
      throw new Error(`parallel_batch 独立批次需要 developer-test 角色，当前为 ${activeRole.role}`);
    }
    return activeRole;
  }

  function linkedWorkflowTask(ctx: ExtensionContext, requested: unknown) {
    const workflow = deps.getWorkflowState();
    const id = typeof requested === "string" && requested.trim()
      ? requested.trim().toLowerCase()
      : workflow?.status === "running" && workflow.executor === "local" ? workflow.currentTaskId : undefined;
    if (!id) return undefined;
    if (!workflow || workflow.executor !== "local" || workflow.status !== "running" || workflow.currentTaskId !== id) {
      throw new Error(`只能关联当前运行中的 local task_workflow 任务：${id}`);
    }
    assertCurrentRole(ctx);
    return id;
  }

  async function withGmc<T>(ctx: ExtensionContext, signal: AbortSignal | undefined, run: (client: ReturnType<typeof createGmcClient>) => Promise<T>) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-init-gmc-"));
    const configPath = path.join(directory, "config.yaml");
    await writeFile(configPath, "{}\n", { encoding: "utf8", mode: 0o600 });
    try {
      const client = createGmcClient({
        exec: (command, args, options) => pi.exec(command, args, options),
        gmcCommand: getGmcCommand(),
        configPath,
        expectedVersion: "0.10.1",
      });
      await client.checkVersion(ctx.cwd, signal);
      return await run(client);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  function worktreeName(batchId: string, taskId: string) {
    const raw = `pi-init-${batchId}-${taskId}`;
    if (raw.length <= 120) return raw;
    let hash = 0;
    for (const character of raw) hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
    return `pi-init-${batchId.slice(0, 48)}-${taskId.slice(0, 48)}-${hash.toString(36)}`.slice(0, 127);
  }

  function newAttemptId() {
    return `attempt-${randomUUID()}`;
  }

  function workerSpecs(batch: ParallelBatchState, role: { provider: string; model: string; thinkingLevel: string }) {
    return batch.tasks.filter((task) => task.status === "running").map((task) => ({
      batchId: batch.batchId,
      taskId: task.id,
      attemptId: task.attemptId!,
      baseCommit: batch.baseCommit,
      cwd: task.worktree!.path,
      task: task.task,
      files: task.files,
      acceptanceCriteria: task.acceptanceCriteria,
      model: `${role.provider}/${role.model}`,
      thinkingLevel: role.thinkingLevel,
    } satisfies ParallelWorkerSpec));
  }

  async function runWorkers(batch: ParallelBatchState, role: { provider: string; model: string; thinkingLevel: string }, signal: AbortSignal | undefined, onUpdate?: ToolUpdate) {
    let next = batch;
    const pending = next.tasks.filter((task) => task.status === "pending");
    if (pending.length === 0) return next;
    for (const task of pending) {
      next = startParallelWorker(next, { taskId: task.id, attemptId: newAttemptId() });
      persist(next, state.currentContext!, true);
    }
    const specs = workerSpecs(next, role);
    onUpdate?.({ content: [{ type: "text", text: `已启动 ${specs.length} 个隔离 Pi worker。` }], details: next });

    const controller = new AbortController();
    activeController = controller;
    const relayAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", relayAbort, { once: true });
    }
    const workerPromises = specs.map((spec) => runParallelWorker(
      (command, args, options) => pi.exec(command, args, options),
      spec,
      controller.signal,
    ));
    try {
      const settled = await Promise.allSettled(workerPromises);
      if (state.runtimeDisposed) return next;
      if (signal?.aborted) {
        next = cancelParallelBatch(next, "当前 Pi 回合被取消");
        persist(next, state.currentContext!, true);
        return next;
      }
      const ordered = settled
        .map((item, index) => ({ item, index }))
        .sort((left, right) => {
          const priority = (entry: typeof left) => entry.item.status === "rejected"
            ? 2
            : entry.item.value?.outcome === "complete" ? 0 : 1;
          return priority(left) - priority(right);
        });
      for (const { item, index } of ordered) {
        const taskId = specs[index].taskId;
        if (item.status === "fulfilled") {
          if (next.status !== "running") continue;
          try {
            next = recordParallelWorkerResult(next, item.value);
            persist(next, state.currentContext!, true);
          } catch (error) {
            if (next.status === "running") {
              next = recordParallelWorkerFailure(next, {
                taskId,
                attemptId: specs[index].attemptId,
                reason: `worker 结果无效：${textOf(error)}`,
              });
              persist(next, state.currentContext!, true);
            }
          }
        } else if (next.status === "running") {
          const task = next.tasks.find((candidate) => candidate.id === taskId);
          if (task?.status === "running") {
            next = recordParallelWorkerFailure(next, {
              taskId,
              attemptId: specs[index].attemptId,
              reason: textOf(item.reason),
            });
            persist(next, state.currentContext!, true);
          }
        }
      }
      if (["running", "blocked"].includes(next.status) && next.tasks.some((task) => ["running", "cancel-requested"].includes(task.status))) {
        next = blockParallelBatchForRecovery(next, "并行 worker 结果未完整到达，已停止自动续跑");
        persist(next, state.currentContext!, true);
      }
      onUpdate?.({ content: [{ type: "text", text: resultText(next) }], details: next });
      return next;
    } finally {
      if (signal) signal.removeEventListener("abort", relayAbort);
      if (activeController === controller) activeController = undefined;
    }
  }

  async function startBatch(params: any, signal: AbortSignal | undefined, ctx: ExtensionContext, onUpdate?: ToolUpdate) {
    assertTrusted(ctx);
    if (isActive(state.parallelBatchState)) throw new Error("当前已有活动 parallel_batch；请先 status、cancel 或 complete");
    const role = assertCurrentRole(ctx);
    const workflowTaskId = linkedWorkflowTask(ctx, params.workflowTaskId);
    const batchId = params.batchId ?? `batch-${Date.now().toString(36)}`;
    const baseRef = params.baseRef ?? "HEAD";
    return withGmc(ctx, signal, async (client) => {
      const baseCommit = await client.resolveBase(ctx.cwd, baseRef, signal);
      let batch = createParallelBatch({
        batchId,
        parentPath: ctx.cwd,
        baseCommit,
        baseBranch: baseRef,
        ...(workflowTaskId ? { workflowTaskId } : {}),
        tasks: params.tasks,
      });
      persist(batch, ctx);
      try {
        for (const task of batch.tasks) {
          const worktree = await client.add(ctx.cwd, {
            name: worktreeName(batch.batchId, task.id),
            baseCommit: batch.baseCommit,
          }, signal);
          batch = attachParallelWorkerWorktree(batch, { taskId: task.id, worktree });
          persist(batch, ctx);
        }
        const integration = await client.add(ctx.cwd, {
          name: worktreeName(batch.batchId, "integration"),
          baseCommit: batch.baseCommit,
        }, signal);
        batch = attachParallelIntegrationWorktree(batch, { worktree: integration });
        batch = startParallelBatch(batch);
        persist(batch, ctx);
      } catch (error) {
        batch = cancelParallelBatch(batch, `gmc worktree 初始化失败：${textOf(error)}`);
        persist(batch, ctx);
        throw error;
      }
      return runWorkers(batch, role, signal, onUpdate);
    });
  }

  async function integrateBatch(batch: ParallelBatchState, signal: AbortSignal | undefined, ctx: ExtensionContext) {
    assertTrusted(ctx);
    assertCurrentRole(ctx, batch);
    let next = beginParallelIntegration(batch);
    persist(next, ctx);
    try {
      await withGmc(ctx, signal, async (client) => {
        for (const task of next.tasks) {
          await client.promote(next.integration!.path, task.worktree!.path, signal);
        }
      });
    } catch (error) {
      next = recordParallelIntegrationResult(next, {
        outcome: "blocked",
        verification: ["gmc wt promote：失败"],
        changedFiles: [],
        reason: `候选改动集成失败：${textOf(error)}`,
      });
      persist(next, ctx);
      throw error;
    }
    return next;
  }

  async function actualChangedFiles(batch: ParallelBatchState, signal: AbortSignal | undefined) {
    const result = await pi.exec("git", ["diff", "--name-only"], { cwd: batch.integration!.path, signal });
    if (result.code !== 0) throw new Error("无法读取集成工作区的 git diff");
    return changedFilesFromOutput(result.stdout ?? "");
  }

  async function completeIntegration(params: any, batch: ParallelBatchState, signal: AbortSignal | undefined, ctx: ExtensionContext) {
    assertTrusted(ctx);
    assertCurrentRole(ctx, batch);
    const actual = await actualChangedFiles(batch, signal);
    const changedFiles = params.changedFiles ?? actual;
    if (params.changedFiles && [...params.changedFiles].sort().join("\n") !== [...actual].sort().join("\n")) {
      throw new Error("提交的 changedFiles 与集成工作区实际 git diff 不一致");
    }
    const next = recordParallelIntegrationResult(batch, {
      outcome: "complete",
      verification: params.verification,
      changedFiles,
    });
    persist(next, ctx);
    return next;
  }

  async function execute(params: any, signal: AbortSignal | undefined, onUpdate: ToolUpdate | undefined, ctx: ExtensionContext) {
    state.currentContext = ctx;
    if (params.action === "status") {
      updateStatus(ctx);
      return {
        content: [{ type: "text", text: resultText(state.parallelBatchState) }],
        details: state.parallelBatchState,
      };
    }
    if (params.action === "start") {
      const run = startBatch(params, signal, ctx, onUpdate);
      const next = await run;
      return { content: [{ type: "text", text: `${resultText(next)}\n请在 worker 全部完成后调用 parallel_batch(action="integrate")。` }], details: next };
    }
    const batch = state.parallelBatchState;
    if (!batch) throw new Error("当前没有并行批次；请先调用 parallel_batch(action=\"start\")");
    if (params.batchId && params.batchId !== batch.batchId) throw new Error("batchId与当前会话批次不一致");
    if (params.action === "cancel") {
      assertTrusted(ctx);
      if (activeController) activeController.abort();
      const next = cancelParallelBatch(batch, params.reason ?? "用户取消");
      persist(next, ctx);
      return { content: [{ type: "text", text: resultText(next) }], details: next };
    }
    if (params.action === "retry") {
      assertTrusted(ctx);
      const role = assertCurrentRole(ctx, batch);
      const retried = retryParallelWorker(batch, params.taskId);
      persist(retried, ctx);
      const next = await runWorkers(retried, role, signal, onUpdate);
      return { content: [{ type: "text", text: resultText(next) }], details: next };
    }
    if (params.action === "integrate") {
      const next = await integrateBatch(batch, signal, ctx);
      return { content: [{ type: "text", text: `${resultText(next)}\n请在集成工作区运行验证，然后调用 parallel_batch(action="complete")。` }], details: next };
    }
    if (params.action === "complete") {
      const next = await completeIntegration(params, batch, signal, ctx);
      return { content: [{ type: "text", text: `${resultText(next)}\n关联的 task_workflow 任务仍需单独调用 complete。` }], details: next };
    }
    throw new Error(`未知 parallel_batch action：${params.action}`);
  }

  function restore(ctx: ExtensionContext) {
    const entry = ctx.sessionManager.getBranch().findLast(
      (item) => item.type === "custom" && item.customType === PARALLEL_ENTRY_TYPE,
    );
    const data = entry && "data" in entry ? entry.data : undefined;
    try {
      state.parallelBatchState = data && typeof data === "object" ? hydrateParallelBatch(data) : undefined;
    } catch (error) {
      state.parallelBatchState = undefined;
      ctx.ui.notify(`无法恢复 parallel_batch 状态：${textOf(error)}`, "error");
    }
    updateStatus(ctx);
    if (isActive(state.parallelBatchState)) {
      ctx.ui.notify("检测到未终态 parallel_batch；本次恢复不会自动重新派发 worker，请显式 retry 或 cancel。", "warning");
    }
  }

  function shutdown(ctx: ExtensionContext) {
    state.runtimeDisposed = true;
    activeController?.abort();
    if (isActive(state.parallelBatchState)) {
      const next = blockParallelBatchForRecovery(state.parallelBatchState, "Pi 会话关闭，worker 状态未知；未自动重派");
      persist(next, ctx, false);
    }
    ctx.ui.setStatus("pi-init-parallel", undefined);
    activeController = undefined;
  }

  pi.registerEntryRenderer(PARALLEL_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data && typeof entry.data === "object" ? entry.data as ParallelBatchState : undefined;
    if (!data) return new Text(theme.fg("error", "并行批次状态无效"), 0, 0);
    const progress = parallelBatchProgress(data);
    const lines = [theme.fg("accent", `并行批次 ${data.batchId}`), theme.fg("muted", `${data.status} · ${progress.completed}/${progress.total}`)];
    if (expanded) lines.push(...data.tasks.map((task) => theme.fg("dim", `  [${task.status}] ${task.id} · ${task.worktree?.path ?? "未绑定 worktree"}`)));
    return new Text(lines.join("\n"), 0, 0);
  });

  pi.registerTool({
    name: "parallel_batch",
    label: "Parallel Batch",
    description: "Create and coordinate up to two independent Pi workers in gmc-isolated worktrees, then integrate serially in a separate worktree. Worker success never completes task_workflow automatically.",
    promptSnippet: "Run a bounded parallel batch in gmc worktrees and integrate it safely",
    promptGuidelines: [
      "Use parallel_batch only for two genuinely independent tasks with non-overlapping file scopes; it uses gmc v0.10.1 and never commits or pushes.",
      "parallel_batch start creates worker and integration worktrees from a fixed commit; workers return strict results and do not modify the main worktree or task_workflow state.",
      "After worker completion, call parallel_batch integrate, run verification in the reported integration worktree, then call parallel_batch complete with actual verification; linked task_workflow must be completed separately.",
      "parallel_batch status is read-only; reload/session shutdown never automatically re-dispatches an unfinished worker.",
    ],
    parameters: parallelBatchParameters,
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "...";
      return new Text(theme.fg("toolTitle", theme.bold("并行批次 ")) + theme.fg("muted", action), 0, 0);
    },
    renderResult(result, _options, theme) {
      if (result.isError) return new Text(theme.fg("error", "并行批次操作失败"), 0, 0);
      const data = result.details as ParallelBatchState | undefined;
      const summary = data && typeof data === "object" && typeof data.batchId === "string" && typeof data.status === "string"
        ? stateText(data)
        : "当前没有并行批次。";
      return new Text(theme.fg("success", "✓ ") + theme.fg("accent", summary), 0, 0);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      return execute(params, signal, onUpdate, ctx);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state.runtimeDisposed = false;
    restore(ctx);
  });
  pi.on("session_tree", async (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", async (_event, ctx) => shutdown(ctx));

  return { restore, shutdown, statusText: () => resultText(state.parallelBatchState) };
}
