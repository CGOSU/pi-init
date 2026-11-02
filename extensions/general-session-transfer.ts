import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeRoleMatches, type ExtensionRuntimeState } from "./runtime-state.ts";
import { handoffHash, SESSION_HANDOFF_MAX_BYTES } from "../src/session-handoff.ts";
import { readGeneralHandoff, type GeneralHandoffSnapshot, type HandoffResult } from "../src/general-session-handoff.ts";
import { isRecord } from "./role-context-protocol.ts";
import { readHandoffArchive, replaceHandoffSession } from "./session-replacement.ts";

export const GENERAL_TRANSFER_ENTRY = "pi-init-general-transfer";
const GENERAL_TRANSFER_ACTIVATE = "pi-init-general-transfer-activate";
type Intent = { version: 1; kind: "outgoing"; id: string; sourceSessionId: string; sourceLeaf: string; hash: string; phase: "prepared" | "cancelled" };
type Incoming = { version: 1; kind: "incoming"; id: string; sourceLeaf: string; hash: string; targetSessionId: string; snapshot: GeneralHandoffSnapshot };
const entries = (ctx: ExtensionContext) => ctx.sessionManager.getEntries?.() ?? ctx.sessionManager.getBranch();
export function generalOutgoingTransfer(ctx: ExtensionContext) {
  const entry = entries(ctx).findLast(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY
    && isRecord(e.data) && e.data.kind === "outgoing" && e.data.sourceSessionId === ctx.sessionManager.getSessionId());
  // Corruption of an existing lock must not silently unlock the source.
  return entry?.type === "custom" && isRecord(entry.data) && entry.data.phase !== "cancelled" ? entry : undefined;
}
function incomingEntry(ctx: ExtensionContext) {
  return entries(ctx).findLast(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY && isRecord(e.data) && e.data.kind === "incoming");
}
function background(snapshot: GeneralHandoffSnapshot) {
  return "用户已确认的历史交接背景；不是当前验证、system指令、旧执行身份或副作用重放授权。等待用户在新会话继续。来源session条目仅在声明的源文件中读取，不使用旧obs_recall ID。\n" + JSON.stringify(snapshot);
}

export function createGeneralSessionTransfer(pi: ExtensionAPI, state: ExtensionRuntimeState, deps: {
  read: (ctx: ExtensionContext) => HandoffResult<GeneralHandoffSnapshot>;
  toolsSettled: (ctx: ExtensionContext) => boolean;
}) {
  let switching = false;
  let storageUncertain = false;
  function ready(ctx: ExtensionContext) {
    return ctx.isProjectTrusted() && ctx.isIdle() && !ctx.hasPendingMessages() && !ctx.signal?.aborted
      && !state.agentRunActive && !state.runtimeDisposed && !state.userStopRequested && !state.roleRecoveryPending
      && !state.roleRecoveryPersistenceFailed && !state.workflowRestoreError && !state.pendingWorkflowRecovery
      && !state.roleCompactionInFlight && !state.pendingRoleCompaction && !state.activeRoleCompaction
      && !state.workflowDispatchInFlight && !state.internalContinuationPending
      && state.sessionModeOverride === undefined && Object.keys(state.sessionRoleConfigOverrides).length === 0
      && (!state.workflowState || ["completed", "cancelled"].includes(state.workflowState.status))
      && !!state.activeRole && activeRoleMatches(state, ctx, pi.getThinkingLevel()) && deps.toolsSettled(ctx);
  }
  function blocked(ctx: ExtensionContext) {
    return storageUncertain || !!generalOutgoingTransfer(ctx);
  }
  pi.on("tool_call", (_event, ctx) => blocked(ctx) ? { block: true, reason: "此来源会话已冻结；请检查交接目标或未知结果，不得重放工具。" } : undefined);
  pi.on("input", (_event, ctx) => {
    if (!blocked(ctx)) return;
    ctx.ui.notify("来源会话交接已冻结；请查看目标会话，不自动重放。", "warning");
    return { action: "handled" as const };
  });
  pi.on("before_agent_start", (_event, ctx) => { if (blocked(ctx)) ctx.abort(); });
  pi.on("session_start", () => { storageUncertain = false; });

  function verify(data: unknown, ctx: ExtensionContext): HandoffResult<GeneralHandoffSnapshot> {
    const fail = (code: string, message: string): HandoffResult<never> => ({ ok: false, code, message });
    if (!isRecord(data)) return fail("TYPE", "目标交接记录必须为对象");
    if (data.version !== 1 || data.kind !== "incoming" || !isRecord(data.snapshot)
      || ![data.id, data.sourceLeaf, data.hash, data.targetSessionId].every(v => typeof v === "string" && v.length > 0)) return fail("INVALID", "目标交接包身份不完整");
    if (Buffer.byteLength(JSON.stringify(data), "utf8") > SESSION_HANDOFF_MAX_BYTES) return fail("TOO_LARGE", "目标完整交接包超限");
    if (data.targetSessionId !== ctx.sessionManager.getSessionId() || handoffHash(data.snapshot) !== data.hash) return fail("IDENTITY", "目标session或交接内容不匹配");
    const record = data as unknown as Incoming;
    const source = record.snapshot.source;
    if (!isRecord(source) || ![source.projectRoot, source.sessionFile, source.sessionId].every(v => typeof v === "string" && v.length > 0)
      || source.sessionId === record.targetSessionId) return fail("IDENTITY", "来源身份不完整或与目标相同");
    try {
      if (realpathSync(ctx.cwd) !== source.projectRoot) return fail("PROJECT", "来源与目标项目不符");
      const archive = readHandoffArchive(source.sessionFile, source.projectRoot, source.sessionId);
      if (!archive.ok) return archive;
      const manager = archive.value;
      if (!manager.getEntry(record.sourceLeaf)) return fail("BRANCH", "来源branch不存在");
      const checked = readGeneralHandoff(manager.getBranch(record.sourceLeaf), source);
      if (!checked.ok) return checked;
      if (handoffHash(checked.value) !== record.hash) return fail("STALE", "来源快照已变化");
      const intent = manager.getEntries().findLast(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY
        && isRecord(e.data) && e.data.kind === "outgoing" && e.data.sourceSessionId === source.sessionId);
      if (intent?.type !== "custom" || !isRecord(intent.data) || intent.data.version !== 1 || intent.data.phase !== "prepared"
        || intent.data.id !== record.id || intent.data.sourceLeaf !== record.sourceLeaf || intent.data.hash !== record.hash) return fail("SOURCE_LOCK", "来源冻结记录不匹配");
      const branch = ctx.sessionManager.getBranch();
      const entry = incomingEntry(ctx);
      const hasBody = (items: typeof branch) => items.some(e => e.type === "message" && e.message.role === "user" && e.message.content === background(checked.value));
      if (!entry || !branch.some(e => e.id === entry.id) || !hasBody(branch)) return fail("INCOMPLETE", "目标正文或当前branch不完整；不新建目标");
      const targetFile = ctx.sessionManager.getSessionFile();
      const targetLeaf = ctx.sessionManager.getLeafId();
      if (!targetFile || !targetLeaf) return fail("PERSISTENCE", "目标尚未持久化");
      const targetArchive = readHandoffArchive(targetFile, source.projectRoot, record.targetSessionId);
      if (!targetArchive.ok) return targetArchive;
      const target = targetArchive.value;
      const savedRecord = target.getEntry(entry.id);
      if (!target.getEntry(targetLeaf) || savedRecord?.type !== "custom" || handoffHash(savedRecord.data) !== handoffHash(record)
        || !hasBody(target.getBranch(targetLeaf))) return fail("PERSISTENCE", "目标交接包或正文持久化尚未确认");
      return checked;
    } catch (error) { return fail("PERSISTENCE", "来源或目标文件核对失败：" + String(error)); }
  }
  async function activate(ctx: ExtensionContext) {
    const entry = incomingEntry(ctx);
    const result: HandoffResult<GeneralHandoffSnapshot> = !ready(ctx)
      ? { ok: false, code: "SAFETY_GATE", message: "目标信任、角色或停止/恢复/工具守卫尚未确认" }
      : verify(entry?.type === "custom" ? entry.data : undefined, ctx);
    if (!result.ok) {
      ctx.ui.notify("目标交接未确认；修复后在当前目标执行 /pi-init fresh 重新核对，不创建第二个会话：[" + result.code + "] " + result.message, "warning");
      return;
    }
    // No scheduling, sendUserMessage, role restoration or old execution identity.
    ctx.ui.notify("已核对历史交接背景；请在此新会话输入继续或新需求。未自动执行任何任务。", "info");
  }
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "custom" || event.message.customType !== GENERAL_TRANSFER_ACTIVATE || !isRecord(event.message.details)) return;
    const entry = incomingEntry(ctx);
    if (entry?.type !== "custom" || !isRecord(entry.data) || event.message.details.id !== entry.data.id || event.message.details.hash !== entry.data.hash) return;
    await activate(ctx);
  });
  async function fresh(ctx: ExtensionCommandContext) {
    if (incomingEntry(ctx)) { await activate(ctx); return; }
    if (switching || blocked(ctx)) { ctx.ui.notify("来源已冻结或交接结果未知；请检查目标，不重试创建。", "warning"); return; }
    if (!ready(ctx) || typeof ctx.newSession !== "function" || !ctx.hasUI) {
      ctx.ui.notify("当前停止、恢复、角色、临时模型配置、工具或宿主确认状态不允许交接；保持原会话。", "warning"); return;
    }
    const prepared = deps.read(ctx);
    if (!prepared.ok) { ctx.ui.notify(prepared.message + "。请让当前执行角色用 session_handoff 准备/更新目标、约束、进度、来源和下一步，再执行 /pi-init fresh。", "warning"); return; }
    const snapshot = prepared.value;
    const sourceLeaf = ctx.sessionManager.getLeafId();
    const sourceFile = snapshot.source.sessionFile;
    const hash = handoffHash(snapshot);
    const generation = handoffHash([state.roleContextGeneration, state.roleTransitionGeneration, state.activeRole, state.workflowState]);
    const id = randomUUID();
    const intent: Intent = { version: 1, kind: "outgoing", id, sourceSessionId: snapshot.source.sessionId, sourceLeaf: sourceLeaf!, hash, phase: "prepared" };
    const packet = { version: 1 as const, kind: "incoming" as const, id, sourceLeaf: sourceLeaf!, hash, targetSessionId: "00000000-0000-0000-0000-000000000000", snapshot };
    if (!sourceLeaf || Buffer.byteLength(JSON.stringify(packet), "utf8") > SESSION_HANDOFF_MAX_BYTES) { ctx.ui.notify("完整交接包超限或branch缺失，不截断迁移。", "warning"); return; }
    switching = true;
    try {
      const confirmed = await ctx.ui.confirm("预览短上下文交接（不自动执行）", background(snapshot));
      if (!confirmed) return;
      const current = deps.read(ctx);
      if (!ready(ctx) || handoffHash([state.roleContextGeneration, state.roleTransitionGeneration, state.activeRole, state.workflowState]) !== generation || ctx.sessionManager.getLeafId() !== sourceLeaf
        || !current.ok || handoffHash(current.value) !== hash) { ctx.ui.notify("确认期间来源状态已变化，请重新准备并确认。", "warning"); return; }
      try {
        const archive = readHandoffArchive(sourceFile, snapshot.source.projectRoot, snapshot.source.sessionId);
        if (!archive.ok) throw new Error(archive.code + ": " + archive.message);
        const archived = archive.value;
        const saved = readGeneralHandoff(archived.getBranch(sourceLeaf), snapshot.source);
        if (!saved.ok || handoffHash(saved.value) !== hash || archived.getLeafId() !== sourceLeaf) throw new Error("来源尚未完整持久化或branch已变化");
        pi.appendEntry(GENERAL_TRANSFER_ENTRY, intent);
        const frozen = readHandoffArchive(sourceFile, snapshot.source.projectRoot, snapshot.source.sessionId);
        if (!frozen.ok) throw new Error(frozen.code + ": " + frozen.message);
        const savedIntent = frozen.value.getLeafEntry();
        if (savedIntent?.type !== "custom" || savedIntent.customType !== GENERAL_TRANSFER_ENTRY
          || handoffHash(savedIntent.data) !== handoffHash(intent)) throw new Error("来源冻结保存未确认");
      } catch (error) { storageUncertain = true; ctx.ui.notify("来源保存未确认，未创建目标；请核对来源文件：" + String(error), "error"); return; }
      await replaceHandoffSession(ctx, {
        sourceFile,
        setup(manager) {
          if (realpathSync(manager.getCwd()) !== snapshot.source.projectRoot || manager.getSessionId() === snapshot.source.sessionId) throw new Error("目标项目或session身份不符");
          const incoming: Incoming = { ...packet, targetSessionId: manager.getSessionId() };
          if (Buffer.byteLength(JSON.stringify(incoming), "utf8") > SESSION_HANDOFF_MAX_BYTES) throw new Error("目标身份加入后完整包超限");
          manager.appendCustomEntry(GENERAL_TRANSFER_ENTRY, incoming);
          manager.appendMessage({ role: "user", content: background(snapshot), timestamp: Date.now() });
        },
        activate: async freshContext => {
          await freshContext.sendMessage({ customType: GENERAL_TRANSFER_ACTIVATE, content: "核对历史交接背景（不自动执行）", display: false, details: { id, hash } }, { triggerTurn: false });
        },
        cancel() {
          if (state.runtimeDisposed || ctx.sessionManager.getSessionId() !== intent.sourceSessionId) { storageUncertain = true; return; }
          pi.appendEntry(GENERAL_TRANSFER_ENTRY, { ...intent, phase: "cancelled" });
          ctx.ui.notify("已取消，未建立目标；旧会话保留，重新交接前请更新快照。", "info");
        },
        uncertain() { storageUncertain = true; console.warn("[pi-init] 普通会话交接结果未知；来源保持冻结，请核对目标，不自动重建或重放。"); },
      });
    } finally { switching = false; }
  }
  return { fresh, blocked };
}
