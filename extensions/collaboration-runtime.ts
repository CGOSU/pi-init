import * as fs from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveCollaborationDirs } from "./collaboration-paths.ts";
import {
  claimReservations,
  formatAgentDisplayName,
  getReservationConflicts,
  getReservationPatternConflicts,
  listActiveAgents,
  readAgentRegistration,
  registerSelf,
  resolveAgentName,
  releaseReservations,
  unregisterSelf,
  updateSelf,
} from "./collaboration-registry.ts";
import {
  processInbox,
  readMessageLog,
  readMessageLogTail,
  sendBroadcast,
  sendDirect,
} from "./collaboration-messages.ts";
import { formatSessionTail, readSessionTail } from "./collaboration-session-tail.ts";
import { listRuns } from "./collaboration-runs.ts";
import { abortAllSubagents, abortSubagent, formatCollaborationTimeout, startSubagentBatch } from "./collaboration-spawn.ts";
import { registerAgentMessageTool, type CollaborationToolApi, type CollaborationToolResult } from "./collaboration-tool.ts";
import { registerAgentsCommand } from "./collaboration-tool.ts";
import { registerSubagentTool, type SubagentToolApi } from "./collaboration-spawn-tool.ts";
import { openAgentsOverlay } from "./collaboration-overlay.ts";
import type {
  AgentProfile,
  AgentRegistration,
  CollaborationDirs,
  CollaborationState,
  ListedRun,
  SubagentTask,
} from "./collaboration-types.ts";

const STATUS_KEY = "pi-init-collab";
const MAX_MESSAGES = 50;

function currentSessionId(ctx: ExtensionContext): string {
  const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & { getSessionId?: () => string };
  return manager.getSessionId?.() || `pid-${process.pid}`;
}

function currentSessionFile(ctx: ExtensionContext): string | undefined {
  const manager = ctx.sessionManager as ExtensionContext["sessionManager"] & { getSessionFile?: () => string | undefined };
  return manager.getSessionFile?.() || undefined;
}

function runLabel(run: ListedRun): string {
  return `${run.recordId} (${formatAgentDisplayName(run.name)}, ${run.status})`;
}

function normalizeLimit(value: unknown, fallback = 20): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.min(MAX_MESSAGES, Math.floor(value))) : fallback;
}

function chooseName(dirs: CollaborationDirs, requested: string): string | undefined {
  const base = requested.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 64) || `agent-${process.pid}`;
  for (let index = 0; index < 50; index += 1) {
    const name = index === 0 ? base : `${base}${index + 1}`;
    if (!readAgentRegistration(dirs, name)) return name;
  }
  return undefined;
}

function runSelection(runs: ListedRun[], selector: string | undefined): ListedRun | undefined {
  if (!selector || selector === "latest") return runs[0];
  const matches = runs.filter((run) => run.recordId === selector || run.recordId.startsWith(selector)
    || run.name === selector || run.name.startsWith(selector) || run.sessionId?.startsWith(selector));
  return matches.length === 1 ? matches[0] : undefined;
}

function formatAgentList(agents: AgentRegistration[], selfName: string): string {
  if (agents.length === 0) return "当前没有其他活跃 Agent。";
  return agents.map((agent) => {
    const locks = agent.reservations?.length ? ` · reservation ${agent.reservations.length}` : "";
    return `- ${formatAgentDisplayName(agent.name)}${agent.name === selfName ? " (self)" : ""} · ${agent.role ?? "unknown"} · ${agent.cwd}${locks}`;
  }).join("\n");
}

function formatRuns(runs: ListedRun[]): string {
  if (runs.length === 0) return "当前没有子 Agent 运行记录。";
  return runs.map((run) => `- ${runLabel(run)} · ${run.taskPreview}${run.isStale ? " [stale]" : ""}${run.error ? ` · ${run.error}` : ""}`).join("\n");
}

export interface CollaborationRuntime {
  dirs: CollaborationDirs;
  state: CollaborationState;
  ensureRegistered(ctx: ExtensionContext): boolean;
  setProfileResolver(resolver: (role: string, ctx: ExtensionContext) => Promise<AgentProfile>): void;
  startWorkflowTask(ctx: ExtensionContext, args: { taskId: string; requestId: string; role: string; prompt: string; files?: string[]; acceptanceCriteria?: string[] }): Promise<{ batchRunId: string; recordId: string }>;
  stopWorkflowTask(taskId: string): boolean;
  executeMessage(params: Record<string, unknown>, ctx: ExtensionContext): CollaborationToolResult;
}

export function createCollaborationRuntime(pi: ExtensionAPI): CollaborationRuntime {
  const dirs = resolveCollaborationDirs();
  const state: CollaborationState = { registered: false, reservations: [], activeRuns: new Map(), workflowRuns: new Map(), disposed: false };
  let lastContext: ExtensionContext | undefined;
  let profileResolver: ((role: string, ctx: ExtensionContext) => Promise<AgentProfile>) | undefined;

  function registration(ctx: ExtensionContext, name = state.agentName): AgentRegistration | undefined {
    if (!name) return undefined;
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "unknown";
    return {
      name,
      pid: process.pid,
      sessionId: currentSessionId(ctx),
      sessionFile: currentSessionFile(ctx),
      cwd: ctx.cwd,
      model,
      startedAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      role: process.env.PI_AGENT_NAME ? "subagent" : "orchestrator",
      reservations: state.reservations.length > 0 ? [...state.reservations] : undefined,
    };
  }

  function ensureRegistered(ctx: ExtensionContext): boolean {
    if (state.registered && state.agentName) return true;
    const requested = process.env.PI_AGENT_NAME?.trim() || `orchestrator-${process.pid}`;
    const name = process.env.PI_AGENT_NAME?.trim() || chooseName(dirs, requested);
    if (!name) return false;
    if (process.env.PI_COLLAB_INITIAL_RESERVATIONS) {
      try {
        const initial = JSON.parse(process.env.PI_COLLAB_INITIAL_RESERVATIONS);
        if (!Array.isArray(initial) || !initial.every((path) => typeof path === "string" && path.trim())) return false;
        const conflicts = initial.flatMap((path) => getReservationPatternConflicts(dirs, name, path, ctx.cwd));
        if (conflicts.length > 0) return false;
        state.reservations = initial.map((pattern) => ({ pattern: pattern.trim(), since: new Date().toISOString() }));
      } catch {
        return false;
      }
    }
    const value = registration(ctx, name);
    if (!value) return false;
    if (!registerSelf(dirs, value)) return false;
    state.agentName = name;
    state.registered = true;
    return true;
  }

  function refresh(ctx: ExtensionContext): void {
    const value = registration(ctx);
    if (value) updateSelf(dirs, value);
  }

  function updateStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    const peers = listActiveAgents(dirs, state.agentName).length;
    const lock = state.reservations.length > 0 ? ` · 🔒${state.reservations.length}` : "";
    ctx.ui.setStatus(STATUS_KEY, `${state.agentName ?? "协作"} · ${peers} peers${lock}`);
  }

  function deliver(message: { from: string; text: string; urgent?: boolean; [key: string]: unknown }): void {
    const content = `${message.urgent ? "Urgent " : ""}message from ${formatAgentDisplayName(message.from)}:\n\n${message.text}`;
    pi.sendMessage({ customType: "pi-init-collab-message", content, display: true, details: message }, {
      triggerTurn: true,
      deliverAs: message.urgent ? "steer" : "followUp",
    });
  }

  function stopWatcher(): void {
    if (state.watcherTimer) clearTimeout(state.watcherTimer);
    state.watcherTimer = undefined;
    state.watcher?.close();
    state.watcher = undefined;
  }

  function drainInbox(): void {
    if (!state.agentName || state.disposed) return;
    processInbox(dirs, state.agentName, (message) => deliver(message));
  }

  function startWatcher(ctx: ExtensionContext): void {
    stopWatcher();
    if (!state.agentName) return;
    const directory = `${dirs.inbox}/${state.agentName}`;
    fs.mkdirSync(directory, { recursive: true });
    drainInbox();
    try {
      state.watcher = fs.watch(directory, () => {
        if (state.watcherTimer) clearTimeout(state.watcherTimer);
        state.watcherTimer = setTimeout(() => {
          state.watcherTimer = undefined;
          drainInbox();
          refresh(ctx);
        }, 40);
      });
      state.watcher.unref?.();
    } catch {
      ctx.ui.notify("无法启动协作 inbox watcher；将仅在 turn_end 检查消息。", "warning");
    }
  }

  function selectedRuns(ctx: ExtensionContext): ListedRun[] {
    return listRuns(dirs, { parentAgent: state.agentName, parentSessionId: currentSessionId(ctx) });
  }

  function executeMessage(params: Record<string, unknown>, ctx: ExtensionContext): CollaborationToolResult {
    if (!ensureRegistered(ctx)) return { text: "无法注册当前 Agent。", isError: true };
    refresh(ctx);
    const action = typeof params.action === "string" ? params.action : "";
    const agents = listActiveAgents(dirs);
    if (action === "status") {
      return { text: `当前 Agent：${state.agentName}\n${formatAgentList(agents, state.agentName!)}\n\n我的 reservation：${state.reservations.join(", ") || "无"}`, details: { action, self: state.agentName, agents, reservations: state.reservations } };
    }
    if (action === "list") return { text: formatAgentList(agents, state.agentName!), details: { action, agents } };
    if (action === "sessions") {
      const runs = selectedRuns(ctx).slice(0, normalizeLimit(params.limit));
      return { text: formatRuns(runs), details: { action, runs } };
    }
    if (action === "session" || action === "tail") {
      const runs = selectedRuns(ctx);
      const selector = typeof params.runId === "string" ? params.runId : typeof params.to === "string" ? params.to : undefined;
      const run = runSelection(runs, selector);
      if (!run) return { text: "找不到唯一的子 Agent 运行记录；请使用明确的 runId。", isError: true, details: { action, runs } };
      if (action === "session") return { text: JSON.stringify(run, null, 2), details: { action, run } };
      if (!run.sessionFile) return { text: `${runLabel(run)}\nsession 文件尚不可用；输出：${run.outputPreview ?? "无"}`, details: { action, run } };
      const tail = readSessionTail(run.sessionFile, normalizeLimit(params.limit));
      return { text: formatSessionTail(tail), details: { action, run, tail } };
    }
    if (action === "send") {
      const result = sendDirect(dirs, state.agentName!, String(params.to ?? ""), String(params.message ?? ""), { urgent: params.urgent === true, replyTo: typeof params.replyTo === "string" ? params.replyTo : undefined });
      return result.ok ? { text: `已发送消息 ${result.id}。`, details: { action, ...result } } : { text: result.error, isError: true, details: { action, ...result } };
    }
    if (action === "broadcast") {
      const result = sendBroadcast(dirs, state.agentName!, String(params.message ?? ""), params.urgent === true);
      return result.ok ? { text: `广播已发送：${result.delivered.join(", ") || "无"}。`, details: { action, ...result } } : { text: result.error, isError: true, details: { action, ...result } };
    }
    if (action === "feed") {
      const events = readMessageLogTail(dirs, normalizeLimit(params.limit));
      return { text: events.map((event) => `${event.timestamp} ${event.from} -> ${event.to}: ${event.text}`).join("\n") || "暂无消息。", details: { action, events } };
    }
    if (action === "thread") {
      const peer = String(params.to ?? "");
      const events = readMessageLog(dirs).filter((event) => event.kind === "direct" && ((event.from === state.agentName && event.to === peer) || (event.to === state.agentName && event.from === peer))).slice(-normalizeLimit(params.limit));
      return { text: events.map((event) => `${event.from}: ${event.text}`).join("\n") || "暂无直接消息。", details: { action, events } };
    }
    if (action === "reserve" || action === "release") return reservationAction(action, params, ctx);
    return { text: `未知协作 action：${action}`, isError: true };
  }

  function reservationAction(action: string, params: Record<string, unknown>, ctx: ExtensionContext): CollaborationToolResult {
    if (!state.agentName) return { text: "当前 Agent 未注册。", isError: true };
    const requested = Array.isArray(params.paths) ? params.paths.filter((path): path is string => typeof path === "string" && path.trim().length > 0).map((path) => path.trim()) : [];
    if (action === "reserve") {
      if (requested.length === 0) return { text: "reserve 需要非空 paths。", isError: true };
      const result = claimReservations(dirs, state.agentName, ctx.cwd, requested, typeof params.reason === "string" ? params.reason : undefined);
      if (!result.ok) return { text: result.error, isError: true, details: { action, ...result } };
      state.reservations = result.reservations;
      updateStatus(ctx);
      return { text: `已预留：${requested.join(", ")}`, details: { action, reservations: result.reservations } };
    }
    if (action !== "release") return { text: `未知 reservation action：${action}`, isError: true };
    const result = releaseReservations(dirs, state.agentName, requested.length > 0 ? requested : undefined);
    if (!result.ok) return { text: result.error, isError: true, details: { action, ...result } };
    state.reservations = result.reservations;
    updateStatus(ctx);
    return { text: requested.length === 0 ? "已释放全部 reservation。" : `已释放：${requested.join(", ")}`, details: { action, reservations: result.reservations } };
  }

  function setProfileResolver(resolver: (role: string, ctx: ExtensionContext) => Promise<AgentProfile>): void {
    profileResolver = resolver;
  }

  async function startWorkflowTask(ctx: ExtensionContext, args: { taskId: string; requestId: string; role: string; prompt: string; files?: string[]; acceptanceCriteria?: string[] }) {
    if (!ensureRegistered(ctx)) throw new Error("无法注册当前 Agent");
    if (!profileResolver) throw new Error("pi-init role 适配器尚未初始化");
    const profile = await profileResolver(args.role, ctx);
    const batch = startSubagentBatch(pi, ctx, [{ task: args.prompt, files: args.files, acceptanceCriteria: args.acceptanceCriteria }], {
      onBatchSettled: (_batch, results) => {
        const result = results[0];
        if (!result || state.disposed) return;
        if (ctx.hasUI) {
          const returned = result.record.status === "completed";
          ctx.ui.notify(
            returned
              ? `协作任务 ${args.taskId} 已返回，主会话正在校验结果。`
              : `协作任务 ${args.taskId} 未成功返回：${result.record.error ?? "未知错误"}`,
            returned ? "info" : "warning",
          );
        }
        pi.sendMessage({
          customType: "pi-init-collaboration-result",
          content: `共享协作任务 ${args.taskId} 的 Agent 已${result.record.status === "completed" ? "完成" : "失败"}。`,
          display: false,
          details: { taskId: args.taskId, requestId: args.requestId, recordId: result.record.recordId, batchRunId: result.record.batchRunId, status: result.record.status, resultText: result.resultText, error: result.record.error, run: result.record },
        }, { deliverAs: "followUp", triggerTurn: true });
      },
    }, { dirs, parentAgent: state.agentName, profile });
    const recordId = batch.records[0]!.recordId;
    state.workflowRuns.set(args.taskId, recordId);
    if (ctx.hasUI) {
      ctx.ui.notify(
        `已启动后台协作 Agent 执行任务 ${args.taskId}（单次最长 ${formatCollaborationTimeout(batch.records[0]?.timeoutMs)}）；可用 /pi-init workflow status 或 /agents 查看进度。`,
        "info",
      );
    }
    return { batchRunId: batch.batchRunId, recordId };
  }

  function stopWorkflowTask(taskId: string): boolean {
    const recordId = state.workflowRuns.get(taskId);
    if (!recordId) return false;
    state.workflowRuns.delete(taskId);
    return abortSubagent(recordId);
  }

  const toolApi: CollaborationToolApi = { executeMessage, openOverlay: async (ctx) => { if (ensureRegistered(ctx)) await openAgentsOverlay(ctx, dirs, state.agentName!); } };
  const subagentApi: SubagentToolApi = {
    dirs,
    ensureRegistered,
    start: async (piApi, ctx, tasks, role) => {
      if (!role) throw new Error("共享子 Agent 必须指定 pi-init role；不会使用 fork 默认 type/model");
      if (!profileResolver) throw new Error("pi-init role 适配器尚未初始化");
      const profile = await profileResolver(role, ctx);
      return startSubagentBatch(piApi, ctx, tasks, {
        onBatchSettled: (batch) => {
          if (state.disposed) return;
          pi.sendMessage({ customType: "pi-init-collab-subagent-result", content: `协作子 Agent batch ${batch.batchRunId} 已结束；请使用 agent_message action=sessions 查看结果。`, display: false, details: batch }, { deliverAs: "followUp", triggerTurn: true });
        },
      }, { dirs, parentAgent: state.agentName, profile });
    },
  };

  registerAgentMessageTool(pi, toolApi);
  registerAgentsCommand(pi, toolApi);
  registerSubagentTool(pi, subagentApi);

  pi.on("tool_call", (event, ctx) => {
    if (!state.registered || (event.toolName !== "edit" && event.toolName !== "write")) return undefined;
    const input = event.input as Record<string, unknown>;
    if (typeof input?.path !== "string") return undefined;
    const conflicts = getReservationConflicts(dirs, state.agentName!, input.path, ctx.cwd);
    if (conflicts.length === 0) return undefined;
    const first = conflicts[0]!;
    return { block: true, reason: `${input.path}\nReserved by: ${first.agent}\nReservation pattern: ${first.pattern}${first.reason ? `\nReason: ${first.reason}` : ""}\nUse agent_message to coordinate.` };
  });

  pi.on("session_start", async (_event, ctx) => {
    state.disposed = false;
    lastContext = ctx;
    if (ensureRegistered(ctx)) {
      startWatcher(ctx);
      refresh(ctx);
      updateStatus(ctx);
    }
  });
  pi.on("turn_end", async (_event, ctx) => {
    lastContext = ctx;
    if (state.registered) {
      drainInbox();
      refresh(ctx);
      updateStatus(ctx);
    }
  });
  pi.on("session_shutdown", async () => {
    state.disposed = true;
    stopWatcher();
    state.workflowRuns.clear();
    abortAllSubagents();
    if (state.agentName) unregisterSelf(dirs, state.agentName, { pid: process.pid, sessionId: lastContext ? currentSessionId(lastContext) : undefined });
    if (lastContext?.hasUI) lastContext.ui.setStatus(STATUS_KEY, undefined);
    state.registered = false;
  });

  return { dirs, state, ensureRegistered, setProfileResolver, startWorkflowTask, stopWorkflowTask, executeMessage };
}

export default function collaborationExtension(pi: ExtensionAPI): void {
  createCollaborationRuntime(pi);
}
