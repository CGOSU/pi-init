import { textOf } from "../src/error-utils.ts";
import { randomUUID } from "node:crypto";
import type { ToolSettlement } from "./general-tool-settlement.ts";
import { registerGeneralSessionHandoff } from "./general-session-handoff.ts";
import { realpathSync } from "node:fs";
import { createGeneralSessionTransfer, generalOutgoingTransfer } from "./general-session-transfer.ts";
import { readHandoffArchive as readArchive, replaceHandoffSession } from "./session-replacement.ts";
import type { ExtensionAPI, ExtensionContext, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { cloneState } from "../src/workflow.ts";
import type { WorkflowState } from "../src/workflow-types.ts";
import { buildSessionHandoff, handoffBoundary, handoffHash, handoffEnvelope, resolveHandoffSnapshot, sessionHandoffSeed, importedWorkflow, workflowContentHash, SESSION_HANDOFF_ENTRY, SESSION_HANDOFF_ACTIVATE, SESSION_HANDOFF_REVIEW, SESSION_HANDOFF_PENDING, SESSION_HANDOFF_IMPORTED, type SessionHandoffPacket, type SessionHandoffSnapshot } from "../src/session-handoff.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { isRecord } from "./role-context-protocol.ts";
import { readTaskSourceObservation, contentText } from "./task-memory-runtime.ts";
import { parseTaskMemoryIdentity } from "../src/task-memory.ts";
import type { TaskEvidence } from "./task-memory-runtime.ts";
import { showCapacityHandoffHint } from "./role-context-capacity.ts";
import { getSessionEntries } from "./session-entries.ts";

type Outgoing = { version: 1; kind: "outgoing"; id: string; workflowId: string; sourceSessionId: string; phase: "prepared" | "cancelled"; contentHash: string; packetHash: string };
type Incoming = { version: 1; kind: "incoming"; id: string; workflowId: string; sourceSessionId: string; targetSessionId: string; sourceFile: string; projectRoot: string; contentHash: string; packetHash: string; packet: SessionHandoffPacket };
type HandoffReadiness = { ok: true } | { ok: false; code: string; message: string };
export function outgoingTransfer(ctx: ExtensionContext, workflow: WorkflowState | undefined) {
  const general = generalOutgoingTransfer(ctx);
  if (general) return general;
  if (!workflow) return undefined;
  const entry = getSessionEntries(ctx).findLast(entry => entry.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY
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
    || !("snapshot" in record.packet ? record.packet.version === 2 && isRecord(record.packet.snapshot)
      : isRecord(record.packet.workflow) && Array.isArray(record.packet.sources)) || !isRecord(record.packet.context)
    || handoffHash(record.packet) !== record.packetHash) return;
  return record;
}
function sourceManager(record: Incoming, ctx: ExtensionContext) {
  if (realpathSync(ctx.cwd) !== record.projectRoot) throw new Error("交接项目已变化");
  const archive = readArchive(record.sourceFile, record.projectRoot, record.sourceSessionId);
  if (!archive.ok) throw new Error(archive.code + ": " + archive.message);
  const manager = archive.value;
  if (manager.getSessionId() !== record.sourceSessionId || realpathSync(manager.getCwd()) !== record.projectRoot) throw new Error("来源session或项目不符");
  const packet = resolveHandoffSnapshot(record.packet, manager.getEntries());
  const intent = manager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === SESSION_HANDOFF_ENTRY
    && isRecord(entry.data) && entry.data.kind === "outgoing" && entry.data.workflowId === record.workflowId);
  if (intent?.type !== "custom" || !isRecord(intent.data) || intent.data.id !== record.id || intent.data.phase !== "prepared"
    || intent.data.contentHash !== record.contentHash || intent.data.packetHash !== record.packetHash
    || packet.workflow.sessionId !== record.sourceSessionId || packet.workflow.workflowId !== record.workflowId
    || workflowContentHash(packet.workflow) !== record.contentHash) throw new Error("来源队列尚未冻结或交接记录不匹配");
  return { manager, packet };
}
export function createSessionHandoff(pi: ExtensionAPI, state: ExtensionRuntimeState, deps: {
  persist: (next: WorkflowState, ctx: ExtensionContext) => void;
  restore: (ctx: ExtensionContext) => void;
  schedule: (ctx: ExtensionContext) => Promise<void>;
  toolsSettled: (ctx: ExtensionContext) => boolean;
  generalToolsSettled: (ctx: ExtensionContext, preparingId?: string) => ToolSettlement;
}) {
  const generalHandoff = registerGeneralSessionHandoff(pi, state, deps.generalToolsSettled);
  const generalTransfer = createGeneralSessionTransfer(pi, state, { read: generalHandoff.read, toolsSettled: deps.generalToolsSettled });
  let switching = false;
  let confirming = false;
  let activating = false;
  function checkReady(ctx: ExtensionContext): HandoffReadiness {
    const fail = (code: string, message: string): HandoffReadiness => ({ ok: false, code, message });
    if (!ctx.isProjectTrusted()) return fail("PROJECT_UNTRUSTED", "当前项目尚未受信任，不能交接。");
    if (!ctx.isIdle()) return fail("AGENT_BUSY", "当前执行尚未结束，请等待本轮结束后再交接。");
    if (ctx.hasPendingMessages()) return fail("MESSAGES_PENDING", "仍有排队消息，请先处理后再交接。");
    if (ctx.signal?.aborted) return fail("CONTEXT_ABORTED", "当前运行已中止，请先核对会话状态。");
    if (state.agentRunActive) return fail("AGENT_BUSY", "Agent仍在运行，请等待本轮结束后再交接。");
    if (state.roleCompactionInFlight || state.pendingRoleCompaction || state.activeRoleCompaction) return fail("COMPACTION_PENDING", "上下文压缩或职责切换尚未结束，请先等待结果。");
    if (state.userStopRequested) return fail("USER_STOPPED", "用户停止保护仍生效，请先核对停止原因；交接不能解除停止。");
    if (state.runtimeDisposed) return fail("CONTEXT_INACTIVE", "当前上下文已失效，请在有效会话中核对交接状态。");
    if (state.roleRecoveryPersistenceFailed) return fail("ROLE_RECOVERY_PERSIST_FAILED", "职责恢复记录保存失败，请先处理持久化错误；未确认前不能交接或继续执行。");
    if (state.roleRecoveryPending) return fail("ROLE_RECOVERY_PENDING", "职责恢复尚未确认；先用 switch_role 确认原执行职责，manual 模式无法验证时由用户执行 /pi-init role <职责>。确认后等待本轮结束，再执行 /pi-init fresh；原阻塞保持，不需要 retry/resume 或重跑业务。");
    if (state.workflowRestoreError) return fail(state.workflowRestoreError.code, "工作流恢复失败：" + state.workflowRestoreError.message + "；请按原恢复入口核对，不能通过交接绕过。");
    if (state.pendingWorkflowRecovery) return fail("WORKFLOW_RECOVERY_PENDING", "工作流恢复尚未持久化，请先核对恢复结果，不重试或重放业务。");
    if (state.workflowDispatchInFlight || state.internalContinuationPending) return fail("CONTINUATION_PENDING", "任务派发或内部续接尚未结束，请等待本轮结束后再交接。");
    if (Object.keys(state.sessionRoleConfigOverrides).length > 0) return fail("UNSAVED_CONFIG", "存在会话临时模型配置，请保存所需配置或撤销覆盖后再交接。");
    const current = state.workflowState;
    if (!current || current.sessionId !== ctx.sessionManager.getSessionId()) return fail("WORKFLOW_SESSION_MISMATCH", "工作流与当前会话不匹配，请先核对原工作流的恢复状态。");
    if (!handoffBoundary(current)) {
      if (current.pauseReason === SESSION_HANDOFF_PENDING) return fail("TRANSFER_PENDING", "来源已冻结，请先核对已有交接目标，不重复创建会话。");
      if (current.pendingRevision) return fail("REPLAN_PENDING", "工作流仍有待处理的重规划，请按原流程到达交付物边界后再交接。");
      if (current.tasks.some(task => task.outcomeUnknown)) return fail("OUTCOME_UNKNOWN", "任务结果未知，请先核对实际副作用并按原恢复入口处理；不能为交接清除未知状态或重放业务。");
      if (current.currentTaskId || current.tasks.some(task => task.status === "in_progress")) return fail("ACTIVE_TASK", "当前任务仍在执行；checkpoint 只保存进展，不会暂停任务。用户明确要求交接且工具已结束、结果已知时，由当前执行角色用 task_workflow(action=block) 如实暂停未完成任务；本轮结束后再执行 /pi-init fresh，不伪造 complete。");
      if (current.handoff || current.tasks.some(task => task.delegation && ["spawning", "running", "stop-requested"].includes(task.delegation.status))) return fail("HANDOFF_ACTIVE", "任务交接或委派仍在进行，请先等待执行结束并核对结果。");
      return fail("WORKFLOW_BOUNDARY_REQUIRED", "当前工作流尚未到达可交接边界；需已有完成交付物，且后续任务可派发或已在结果已知的 task-blocked 状态暂停。");
    }
    if (!deps.toolsSettled(ctx)) return fail("TOOLS_UNSETTLED", "仍有未结束的工具或无法确认的工具结果，请先核对结果；不要为交接重放工具。");
    return { ok: true };
  }
  const ready = (ctx: ExtensionContext) => checkReady(ctx).ok;
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
    // Capacity is advisory: never pause the queue or consult stale usage.
    // Only this existing safety gate may expose the manual workflow entry.
    if (ready(ctx) && ctx.sessionManager.getSessionFile?.()) showCapacityHandoffHint(ctx, state);
    return false;
  }
  async function activate(ctx: ExtensionContext, id: string, hash: string) {
    if (activating) return;
    const record = incomingTransfer(ctx);
    if (!record || record.id !== id || record.packetHash !== hash || !ctx.isProjectTrusted() || !ctx.isIdle() || ctx.hasPendingMessages()) return;
    activating = true;
    const generation = state.roleContextGeneration;
    try {
      const { packet } = sourceManager(record, ctx);
      if (!state.workflowState) {
        deps.restore(ctx);
        if (!state.workflowState && !state.workflowRestoreError && !state.pendingWorkflowRecovery) {
          const hasSeed = ctx.sessionManager.getBranch().some(entry => entry.type === "message" && entry.message.role === "user");
          if (!hasSeed) throw new Error("交接正文尚未完整保存，不能自动激活");
          deps.persist(importedWorkflow(packet, record.targetSessionId), ctx);
        }
      }
      const current = state.workflowState;
      if (!current || current.workflowId !== record.workflowId || current.sessionId !== record.targetSessionId
        || current.pauseReason !== SESSION_HANDOFF_IMPORTED) return;
      const expected = importedWorkflow(packet, record.targetSessionId);
      if (workflowContentHash(current) !== workflowContentHash(expected)) throw new Error("导入的任务或约束已变化，未自动激活");
      if (state.roleRecoveryPersistenceFailed || state.pendingWorkflowRecovery || state.workflowRestoreError || state.userStopRequested) throw new Error("恢复或停止守卫未解除");
      const next = cloneState(current);
      if (packet.workflow.pauseReason === "task-blocked") {
        next.status = "paused"; next.pauseReason = "task-blocked";
        next.taskPauseReason = packet.workflow.taskPauseReason;
        delete next.continuation;
      } else {
        next.status = "running"; delete next.pauseReason; delete next.taskPauseReason;
        next.continuation = { kind: "schedule", phase: "pending", reason: "resume" };
      }
      deps.persist(next, ctx);
      if (next.status === "running") await deps.schedule(ctx);
      if (state.runtimeDisposed || state.roleContextGeneration !== generation) return;
      ctx.ui.notify(next.pauseReason === "task-blocked"
        ? "已完整转移工作流；原阻塞任务和原因保留，未重试或派发。核对阻塞原因后使用 /pi-init workflow retry <taskId> 按原流程恢复。"
        : "已核对会话交接；任务派发仍遵循当前职责与恢复守卫，历史验证不是本session重跑。", "info");
    } catch (error) {
      if (state.runtimeDisposed || state.roleContextGeneration !== generation) return;
      const action = state.workflowState?.pauseReason === SESSION_HANDOFF_IMPORTED || !state.workflowState
        ? "修复原因后在此会话执行 /pi-init workflow fresh 重新核对，不重复新建"
        : "请查看当前工作流状态并按原恢复流程处理，不重复创建session";
      ctx.ui.notify("交接未确认，旧队列保持冻结；" + action + "：" + (textOf(error)), "warning");
    } finally { activating = false; }
  }
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "custom" || event.message.customType !== SESSION_HANDOFF_ACTIVATE || !isRecord(event.message.details)) return;
    const { id, hash } = event.message.details;
    if (typeof id === "string" && typeof hash === "string") await activate(ctx, id, hash);
  });
  async function fresh(ctx: ExtensionCommandContext) {
    const unfinished = state.workflowState && !["completed", "cancelled"].includes(state.workflowState.status);
    // A historical import does not own future ordinary handoffs after that workflow has ended.
    const workflowImport = !state.workflowState && getSessionEntries(ctx).some(e => e.type === "custom" && e.customType === SESSION_HANDOFF_ENTRY && isRecord(e.data) && e.data.kind === "incoming");
    if (generalTransfer.blocked(ctx) || (!unfinished && !workflowImport)) { await generalTransfer.fresh(ctx); return; }
    await workflowFresh(ctx);
  }
  async function workflowFresh(ctx: ExtensionCommandContext) {
    const incoming = incomingTransfer(ctx);
    if (incoming && (!state.workflowState || state.workflowState.pauseReason === SESSION_HANDOFF_IMPORTED)) { await activate(ctx, incoming.id, incoming.packetHash); return; }
    if (incoming && state.workflowState?.pauseReason === "task-blocked") {
      try {
        const { packet } = sourceManager(incoming, ctx);
        if (workflowContentHash(state.workflowState) === workflowContentHash(importedWorkflow(packet, incoming.targetSessionId))) {
          ctx.ui.notify("此阻塞工作流已转移，未重复创建session；核对原阻塞原因后执行 /pi-init workflow retry <taskId>。", "info");
          return;
        }
      } catch (error) { ctx.ui.notify("交接来源未确认，未重复创建session：" + String(error), "warning"); return; }
    }
    if (switching || confirming) { ctx.ui.notify("[TRANSFER_BUSY] 交接预览或会话切换正在进行，请等待结果。", "warning"); return; }
    const readiness = checkReady(ctx);
    if (!readiness.ok) { ctx.ui.notify(`[${readiness.code}] ${readiness.message}`, "warning"); return; }
    if (outgoingTransfer(ctx, state.workflowState)) { ctx.ui.notify("[TRANSFER_PENDING] 来源已冻结，请先核对已有交接目标，不重复创建会话。", "warning"); return; }
    if (typeof ctx.newSession !== "function") { ctx.ui.notify("[NEW_SESSION_UNAVAILABLE] 当前宿主未提供新建会话入口，未开始交接。", "warning"); return; }
    const current = state.workflowState!;
    const sourceFile = ctx.sessionManager.getSessionFile?.();
    if (!sourceFile) { ctx.ui.notify("当前session未持久化，不能安全交接。", "warning"); return; }
    let snapshot: SessionHandoffSnapshot;
    let packet: SessionHandoffPacket;
    let seed: string;
    try {
      const previous = incomingTransfer(ctx);
      snapshot = buildSessionHandoff(current, ctx.sessionManager.getBranch(), sourceFile, previous ? sourceManager(previous, ctx).packet : undefined);
      packet = handoffEnvelope(snapshot, randomUUID());
      seed = sessionHandoffSeed(packet, snapshot, sourceFile);
    } catch (error) { ctx.ui.notify(String(error), "warning"); return; }
    const projectRoot = realpathSync(ctx.cwd);
    const sourceLeaf = ctx.sessionManager.getLeafId();
    const sourceStateHash = handoffHash(current);
    const generation = state.roleContextGeneration;
    if (!ctx.hasUI) { ctx.ui.notify("需要交互式预览确认，未开始交接。", "warning"); return; }
    confirming = true;
    try {
      if (!await ctx.ui.confirm("预览工作流短上下文交接", JSON.stringify(packet))) return;
      const confirmedReadiness = checkReady(ctx);
      if (!confirmedReadiness.ok) { ctx.ui.notify(`[${confirmedReadiness.code}] ${confirmedReadiness.message} 确认期间状态已变化，未开始交接。`, "warning"); return; }
      if (state.roleContextGeneration !== generation || ctx.sessionManager.getLeafId() !== sourceLeaf
        || handoffHash(state.workflowState) !== sourceStateHash) { ctx.ui.notify("确认期间工作流或来源状态已变化，未开始交接。", "warning"); return; }
    } finally { confirming = false; }
    try {
      const archive = readArchive(sourceFile, projectRoot, current.sessionId);
      if (!archive.ok) throw new Error(archive.code + ": " + archive.message);
      const source = archive.value;
      const saved = source.getBranch().findLast(entry => entry.type === "custom" && entry.customType === "pi-init-workflow");
      if (source.getSessionId() !== current.sessionId || realpathSync(source.getCwd()) !== projectRoot
        || saved?.type !== "custom" || !isRecord(saved.data) || saved.data.workflowId !== current.workflowId
        || saved.data.recoveryGeneration !== current.recoveryGeneration
        || workflowContentHash(saved.data as unknown as WorkflowState) !== workflowContentHash(snapshot.workflow)) throw new Error("来源文件与当前项目/任务快照不一致");
    } catch (error) { ctx.ui.notify("未开始交接：" + String(error), "warning"); return; }
    const packetHash = handoffHash(packet);
    const intent: Outgoing = { version: 1, kind: "outgoing", id: randomUUID(), workflowId: current.workflowId,
      sourceSessionId: current.sessionId, phase: "prepared", contentHash: workflowContentHash(snapshot.workflow), packetHash };
    const frozen = cloneState(current);
    frozen.status = "paused"; frozen.pauseReason = SESSION_HANDOFF_PENDING;
    frozen.taskPauseReason = "跨session交接已准备；旧队列冻结，只读保留。交接ID：" + intent.id;
    try {
      if ("snapshot" in packet) pi.appendEntry(SESSION_HANDOFF_ENTRY, { version: 1, kind: "snapshot", id: packet.snapshot.id, packet: snapshot });
      pi.appendEntry(SESSION_HANDOFF_ENTRY, intent);
      deps.persist(frozen, ctx);
    }
    catch (error) { ctx.ui.notify("交接保存未确认，未创建新session；请检查来源记录：" + String(error), "error"); return; }
    switching = true;
    ctx.ui.notify("交接意图已保存，正在新建session；若结果不明，旧队列不会自动恢复或重复派发。", "info");
    try {
      await replaceHandoffSession(ctx, { sourceFile,
        setup: async manager => {
          if (realpathSync(manager.getCwd()) !== projectRoot) throw new Error("目标项目不匹配");
          const record: Incoming = { version: 1, kind: "incoming", id: intent.id, workflowId: intent.workflowId,
            sourceSessionId: intent.sourceSessionId, targetSessionId: manager.getSessionId(), sourceFile, projectRoot,
            contentHash: intent.contentHash, packetHash, packet };
          manager.appendCustomEntry(SESSION_HANDOFF_ENTRY, record);
          manager.appendMessage({ role: "user", content: seed, timestamp: Date.now() });
          manager.appendCustomEntry("pi-init-workflow", importedWorkflow(snapshot, record.targetSessionId));
        },
        activate: async freshContext => {
          await freshContext.sendMessage({ customType: SESSION_HANDOFF_ACTIVATE, content: "核对已确认的跨session交接", display: false, details: { id: intent.id, hash: packetHash } }, { triggerTurn: false });
        },
        // A confirmed cancellation before setup leaves the original context valid.
        cancel() {
          pi.appendEntry(SESSION_HANDOFF_ENTRY, { ...intent, phase: "cancelled" });
          const restored = cloneState(current);
          if (restored.pauseReason !== "task-blocked") {
            restored.status = "paused"; restored.pauseReason = SESSION_HANDOFF_REVIEW;
            restored.taskPauseReason = "新session创建已取消，可重试fresh或resume留在当前会话。";
          }
          deps.persist(restored, ctx);
          ctx.ui.notify(restored.taskPauseReason ?? "新session创建已取消；原任务阻塞和原因保留，可重试fresh。", "info");
        },
        uncertain() { console.warn("[pi-init] session交接结果未确认；旧队列保持冻结，请核对目标，不自动重试。"); },
      });
    } catch {
      // Replacement may already have happened: never touch captured pi/ctx or unfreeze the source.
      console.warn("[pi-init] session交接结果未确认；旧队列保持冻结，请检查当前session的交接记录，不自动重试。");
    } finally { switching = false; }
  }
  function readEvidence(ctx: ExtensionContext, id: string, dependencies: string[]): TaskEvidence | undefined {
    const record = incomingTransfer(ctx);
    if (!record || record.workflowId !== state.workflowState?.workflowId) return;
    try {
      const { packet } = sourceManager(record, ctx);
      const source = packet.sources.find(source => dependencies.includes(source.taskId) && source.evidenceIds.includes(id)
        && state.workflowState?.tasks.some(task => task.id === source.taskId && task.status === "completed"));
      if (!source?.sourceFile) return;
      const archive = readArchive(source.sourceFile, record.projectRoot, source.sourceSessionId);
      if (!archive.ok) return;
      const manager = archive.value;
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
  return { beforeDispatch, fresh, readEvidence, generalHandoff };
}
