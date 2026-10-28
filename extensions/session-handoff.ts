import { randomUUID } from "node:crypto";
import { realpathSync, readFileSync, statSync } from "node:fs";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cloneState } from "../src/workflow.ts";
import type { WorkflowState } from "../src/workflow-types.ts";
import { buildSessionHandoff, handoffBoundary, handoffHash, importedWorkflow, workflowContentHash, SESSION_HANDOFF_ENTRY, SESSION_HANDOFF_ACTIVATE, SESSION_HANDOFF_REVIEW, SESSION_HANDOFF_PENDING, SESSION_HANDOFF_IMPORTED, type SessionHandoffPacket } from "../src/session-handoff.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { isRecord } from "./role-context-protocol.ts";
import { readTaskSourceObservation, contentText } from "./task-memory-runtime.ts";
import { parseTaskMemoryIdentity } from "../src/task-memory.ts";
import type { TaskEvidence } from "./task-memory-runtime.ts";

function readArchive(file: string, root: string, sessionId: string) {
  const stats = statSync(file);
  if (!stats.isFile() || stats.size === 0) throw new Error("来源不是已保存的session文件");
  const entries = readFileSync(file, "utf8").split("\n").filter(line => line.trim()).map(line => JSON.parse(line));
  const header = entries[0];
  if (!isRecord(header) || header.type !== "session" || header.id !== sessionId
    || typeof header.cwd !== "string" || realpathSync(header.cwd) !== root) throw new Error("来源session或项目不匹配");
  return SessionManager.inMemory(root, undefined, entries);
}


type Outgoing = { version: 1; kind: "outgoing"; id: string; workflowId: string; sourceSessionId: string; phase: "prepared" | "cancelled"; contentHash: string; packetHash: string };
type Incoming = { version: 1; kind: "incoming"; id: string; workflowId: string; sourceSessionId: string; targetSessionId: string; sourceFile: string; projectRoot: string; contentHash: string; packetHash: string; packet: SessionHandoffPacket };
function records(ctx: ExtensionContext) { return ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch(); }
export function outgoingTransfer(ctx: ExtensionContext, workflow: WorkflowState | undefined) {
  if (!workflow) return undefined;
  const entry = records(ctx).findLast(entry => entry.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY
    && isRecord(entry.data) && entry.data.kind === "outgoing" && entry.data.workflowId === workflow.workflowId
    && entry.data.sourceSessionId === ctx.sessionManager.getSessionId());
  return entry?.type === "custom" && isRecord(entry.data) && entry.data.phase === "prepared" ? entry.data as unknown as Outgoing : undefined;
}
function incomingTransfer(ctx: ExtensionContext): Incoming | undefined {
  const entry = ctx.sessionManager.getBranch().findLast(entry => entry.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY
    && isRecord(entry.data) && entry.data.kind === "incoming");
  if (entry?.type !== "custom" || !isRecord(entry.data)) return;
  const record = entry.data as unknown as Incoming;
  if (record.version !== 1 || record.targetSessionId !== ctx.sessionManager.getSessionId()
    || typeof record.sourceFile !== "string" || typeof record.projectRoot !== "string" || !isRecord(record.packet)
    || !isRecord(record.packet.workflow) || !Array.isArray(record.packet.sources) || !isRecord(record.packet.context)
    || handoffHash(record.packet) !== record.packetHash) return;
  return record;
}
function sourceManager(record: Incoming, ctx: ExtensionContext) {
  if (realpathSync(ctx.cwd) !== record.projectRoot) throw new Error("交接项目已变化");
  const manager = readArchive(record.sourceFile, record.projectRoot, record.sourceSessionId);
  if (manager.getSessionId() !== record.sourceSessionId || realpathSync(manager.getCwd()) !== record.projectRoot) throw new Error("来源session或项目不符");
  const intent = manager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY
    && isRecord(entry.data) && entry.data.kind === "outgoing" && entry.data.workflowId === record.workflowId);
  if (intent?.type !== "custom" || !isRecord(intent.data) || intent.data.id !== record.id || intent.data.phase !== "prepared"
    || intent.data.contentHash !== record.contentHash || intent.data.packetHash !== record.packetHash
    || workflowContentHash(record.packet.workflow) !== record.contentHash) throw new Error("来源队列尚未冻结或交接记录不匹配");
  return manager;
}
export function createSessionHandoff(pi: ExtensionAPI, state: ExtensionRuntimeState, deps: {
  persist: (next: WorkflowState, ctx: ExtensionContext) => void;
  restore: (ctx: ExtensionContext) => void;
  schedule: (ctx: ExtensionContext) => Promise<void>;
  toolsSettled: (ctx: ExtensionContext) => boolean;
}) {
  let switching = false;
  let activating = false;
  function ready(ctx: ExtensionContext) {
    return ctx.isProjectTrusted() && ctx.isIdle() && !ctx.hasPendingMessages() && !ctx.signal?.aborted && !state.agentRunActive
      && !state.roleCompactionInFlight && !state.pendingRoleCompaction && !state.activeRoleCompaction
      && !state.userStopRequested && !state.runtimeDisposed && !state.roleRecoveryPending && !state.roleRecoveryPersistenceFailed
      && !state.workflowRestoreError && !state.pendingWorkflowRecovery && !state.workflowDispatchInFlight && !state.internalContinuationPending
      && state.sessionModeOverride === undefined && Object.keys(state.sessionRoleConfigOverrides).length === 0
      && state.workflowState?.sessionId === ctx.sessionManager.getSessionId() && handoffBoundary(state.workflowState)
      && deps.toolsSettled(ctx);
  }
  function beforeDispatch(ctx: ExtensionContext) {
    const current = state.workflowState;
    if (outgoingTransfer(ctx, current)) {
      if (current && current.pauseReason !== SESSION_HANDOFF_PENDING) {
        const frozen = cloneState(current);
        frozen.status = "paused"; frozen.pauseReason = SESSION_HANDOFF_PENDING;
        frozen.taskPauseReason = "此队列已发起跨session交接；旧会话只读，不自动重派。请查看目标会话或核对交接结果。";
        try { deps.persist(frozen, ctx); } catch {
          state.workflowRestoreError = { code: "SESSION_TRANSFER_LOCK_PERSIST_FAILED", message: "旧会话交接冻结状态未确认保存，禁止派发或执行" };
          ctx.ui.notify(state.workflowRestoreError.message, "error");
        }
      }
      return true;
    }
    const usage = ctx.getContextUsage();
    const window = usage?.contextWindow ?? ctx.model?.contextWindow;
    if (state.roleModeStatus !== "auto" || !ready(ctx) || !current || current.status !== "running" || current.continuation?.kind !== "schedule"
      || current.continuation.phase !== "pending" || current.continuation.reason !== "task-completed"
      || typeof usage?.tokens !== "number" || !Number.isFinite(usage.tokens) || !window || !Number.isFinite(window) || window <= 0 || usage.tokens < window * 0.7
      || !ctx.sessionManager.getSessionFile?.()) return false;
    try {
      const packet = buildSessionHandoff(current, ctx.sessionManager.getBranch());
      if (Buffer.byteLength(JSON.stringify(packet.context), "utf8") >= usage.tokens) return false;
    } catch { return false; }
    const next = cloneState(current);
    next.status = "paused"; next.pauseReason = SESSION_HANDOFF_REVIEW;
    next.taskPauseReason = "已完成阶段且上下文较重：执行 /pi-init workflow fresh 确认新会话继续，或 /pi-init workflow resume 留在当前会话。不会自动新建或调用模型总结。";
    deps.persist(next, ctx);
    ctx.ui.notify(next.taskPauseReason, "info");
    return true;
  }
  async function activate(ctx: ExtensionContext, id: string, hash: string) {
    if (activating) return;
    const record = incomingTransfer(ctx);
    if (!record || record.id !== id || record.packetHash !== hash || !ctx.isProjectTrusted() || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    activating = true;
    const generation = state.roleContextGeneration;
    try {
      sourceManager(record, ctx);
      if (!state.workflowState) {
        deps.restore(ctx);
        if (!state.workflowState && !state.workflowRestoreError && !state.pendingWorkflowRecovery) {
          const hasSeed = ctx.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user");
          if (!hasSeed) throw new Error("交接正文尚未完整保存，不能自动激活");
          deps.persist(importedWorkflow(record.packet, record.targetSessionId), ctx);
        }
      }
      const current = state.workflowState;
      if (!current || current.workflowId !== record.workflowId || current.sessionId !== record.targetSessionId
        || current.pauseReason !== SESSION_HANDOFF_IMPORTED) return;
      const expected = importedWorkflow(record.packet, record.targetSessionId);
      if (workflowContentHash(current) !== workflowContentHash(expected)) throw new Error("导入的任务或约束已变化，未自动激活");
      if (state.roleRecoveryPersistenceFailed || state.pendingWorkflowRecovery || state.workflowRestoreError || state.userStopRequested) throw new Error("恢复或停止守卫未解除");
      const next = cloneState(current);
      next.status = "running"; delete next.pauseReason; delete next.taskPauseReason;
      next.continuation = { kind: "schedule", phase: "pending", reason: "resume" };
      deps.persist(next, ctx);
      await deps.schedule(ctx);
      if (state.runtimeDisposed || state.roleContextGeneration !== generation) return;
      ctx.ui.notify("已核对会话交接；任务派发仍遵循当前职责与恢复守卫，历史验证不是本session重跑。", "info");
    } catch (error) {
      if (state.runtimeDisposed || state.roleContextGeneration !== generation) return;
      const action = state.workflowState?.pauseReason === SESSION_HANDOFF_IMPORTED || !state.workflowState
        ? "修复原因后在此会话执行 /pi-init workflow fresh 重新核对，不重复新建"
        : "请查看当前工作流状态并按原恢复流程处理，不重复创建session";
      ctx.ui.notify("交接未确认，旧队列保持冻结；" + action + "：" + (error instanceof Error ? error.message : String(error)), "warning");
    } finally { activating = false; }
  }
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "custom" || event.message.customType !== SESSION_HANDOFF_ACTIVATE || !isRecord(event.message.details)) return;
    const { id, hash } = event.message.details;
    if (typeof id === "string" && typeof hash === "string") await activate(ctx, id, hash);
  });
  async function fresh(ctx: ExtensionCommandContext) {
    const incoming = incomingTransfer(ctx);
    if (incoming && (!state.workflowState || state.workflowState.pauseReason === SESSION_HANDOFF_IMPORTED)) { await activate(ctx, incoming.id, incoming.packetHash); return; }
    if (switching || !ready(ctx) || outgoingTransfer(ctx, state.workflowState)
      || typeof ctx.newSession !== "function") { ctx.ui.notify("当前不在可换会话的安全边界；先完成活动工具、确认恢复/配置并到达交付物边界。", "warning"); return; }
    const current = state.workflowState!;
    const sourceFile = ctx.sessionManager.getSessionFile?.();
    if (!sourceFile) { ctx.ui.notify("当前session未持久化，不能安全交接。", "warning"); return; }
    let packet: SessionHandoffPacket;
    try { packet = buildSessionHandoff(current, ctx.sessionManager.getBranch(), sourceFile); } catch (error) { ctx.ui.notify(String(error), "warning"); return; }
    const projectRoot = realpathSync(ctx.cwd);
    try {
      const source = readArchive(sourceFile, projectRoot, current.sessionId);
      const saved = source.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "pi-init-workflow");
      if (source.getSessionId() !== current.sessionId || realpathSync(source.getCwd()) !== projectRoot
        || saved?.type !== "custom" || !isRecord(saved.data) || saved.data.workflowId !== current.workflowId
        || saved.data.recoveryGeneration !== current.recoveryGeneration
        || workflowContentHash(saved.data as unknown as WorkflowState) !== workflowContentHash(packet.workflow)) throw new Error("来源文件与当前项目/任务快照不一致");
    } catch (error) { ctx.ui.notify("未开始交接：" + String(error), "warning"); return; }
    const packetHash = handoffHash(packet);
    const intent: Outgoing = { version: 1, kind: "outgoing", id: randomUUID(), workflowId: current.workflowId,
      sourceSessionId: current.sessionId, phase: "prepared", contentHash: workflowContentHash(packet.workflow), packetHash };
    const frozen = cloneState(current);
    frozen.status = "paused"; frozen.pauseReason = SESSION_HANDOFF_PENDING;
    frozen.taskPauseReason = "跨session交接已准备；旧队列冻结，只读保留。交接ID：" + intent.id;
    try { pi.appendEntry(SESSION_HANDOFF_ENTRY, intent); deps.persist(frozen, ctx); }
    catch (error) { ctx.ui.notify("交接保存未确认，未创建新session；请检查来源记录：" + String(error), "error"); return; }
    switching = true;
    let setupRan = false;
    ctx.ui.notify("交接意图已保存，正在新建session；若结果不明，旧队列不会自动恢复或重复派发。", "info");
    try {
      const result = await ctx.newSession({ parentSession: sourceFile,
        setup: async manager => {
          setupRan = true;
          if (realpathSync(manager.getCwd()) !== projectRoot) throw new Error("目标项目不匹配");
          const record: Incoming = { version: 1, kind: "incoming", id: intent.id, workflowId: intent.workflowId,
            sourceSessionId: intent.sourceSessionId, targetSessionId: manager.getSessionId(), sourceFile, projectRoot,
            contentHash: intent.contentHash, packetHash, packet };
          manager.appendCustomEntry(SESSION_HANDOFF_ENTRY, record);
          manager.appendMessage({ role: "user", content: "[用户确认的新session交接；历史事实不是新的工具执行或权限授权]\n" + JSON.stringify({ sourceSessionId: intent.sourceSessionId, sourceFile, ...packet.context }) + "\n按已保存工作流只继续剩余任务；必要时定向读取来源，不重做未失效调查和验证。", timestamp: Date.now() });
          manager.appendCustomEntry("pi-init-workflow", importedWorkflow(packet, record.targetSessionId));
        },
        withSession: async freshContext => {
          await freshContext.sendMessage({ customType: SESSION_HANDOFF_ACTIVATE, content: "核对已确认的跨session交接", display: false, details: { id: intent.id, hash: packetHash } }, { triggerTurn: false });
        },
      });
      // A cancelled switch never invalidates the source command context.
      if (result.cancelled && !setupRan) {
        pi.appendEntry(SESSION_HANDOFF_ENTRY, { ...intent, phase: "cancelled" });
        const restored = cloneState(current);
        restored.status = "paused"; restored.pauseReason = SESSION_HANDOFF_REVIEW;
        restored.taskPauseReason = "新session创建已取消，可重试fresh或resume留在当前会话。";
        deps.persist(restored, ctx);
        ctx.ui.notify(restored.taskPauseReason, "info");
      }
    } catch {
      // Replacement may already have happened: never touch captured pi/ctx or unfreeze the source.
      console.warn("[pi-init] session交接结果未确认；旧队列保持冻结，请检查当前session的交接记录，不自动重试。");
    } finally { switching = false; }
  }
  function readEvidence(ctx: ExtensionContext, id: string, dependencies: string[]): TaskEvidence | undefined {
    const record = incomingTransfer(ctx);
    if (!record || record.workflowId !== state.workflowState?.workflowId) return;
    const source = record.packet.sources.find(source => dependencies.includes(source.taskId) && source.evidenceIds.includes(id)
      && state.workflowState?.tasks.some(task => task.id === source.taskId && task.status === "completed"));
    if (!source?.sourceFile) return;
    try {
      sourceManager(record, ctx);
      const manager = readArchive(source.sourceFile, record.projectRoot, source.sourceSessionId);
      if (manager.getSessionId() !== source.sourceSessionId || realpathSync(manager.getCwd()) !== record.projectRoot) return;
      const branch = manager.getBranch(id);
      const anchor = branch.findLast(entry => entry.type === "custom_message" && entry.customType === "pi-init-workflow-task");
      const identity = anchor?.type === "custom_message" ? parseTaskMemoryIdentity(anchor.details) : undefined;
      if (!identity || identity.workflowId !== record.workflowId || identity.sessionId !== source.sourceSessionId
        || identity.taskId !== source.taskId || identity.planVersion > state.workflowState!.planVersion) return;
      const observation = readTaskSourceObservation(branch, id, identity);
      const entry = manager.getEntry(id);
      if (observation?.outcome !== "tool-ok" || entry?.type !== "message" || entry.message.role !== "toolResult") return;
      const text = contentText(entry.message.content);
      return { id, text: text.slice(0, 4096), truncated: text.length > 4096, sourceTaskId: source.taskId, sourceSessionId: source.sourceSessionId, historical: true };
    } catch { return; }
  }
  return { beforeDispatch, fresh, readEvidence };
}
