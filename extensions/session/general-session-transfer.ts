import { randomUUID } from "node:crypto";
import type { ToolSettlement } from "./general-tool-settlement.ts";
import { realpathSync } from "node:fs";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeRoleMatches, matchPolicy, isWorkflowUnfinished, type ExtensionRuntimeState } from "../runtime-state.ts";
import { handoffHash, SESSION_HANDOFF_MAX_BYTES } from "../../src/session-handoff.ts";
import { GENERAL_HANDOFF_ENTRY, GENERAL_HANDOFF_TOOL, readGeneralHandoff, type GeneralHandoffSnapshot, type HandoffResult } from "../../src/general-session-handoff.ts";
import { isRecord } from "../role/role-context-protocol.ts";
import { findTransferTarget, readHandoffArchive, replaceHandoffSession, type TransferTargetScan } from "./session-replacement.ts";
import { getSessionEntries } from "./session-entries.ts";

export const GENERAL_TRANSFER_ENTRY = "pi-init-general-transfer";
const GENERAL_TRANSFER_ACTIVATE = "pi-init-general-transfer-activate";
type Intent = { version: 1; kind: "outgoing"; id: string; sourceSessionId: string; sourceLeaf: string; hash: string; phase: "prepared" | "cancelled" };
type Incoming = { version: 1; kind: "incoming"; id: string; sourceLeaf: string; hash: string; targetSessionId: string; snapshot: GeneralHandoffSnapshot };
export function generalOutgoingTransfer(ctx: ExtensionContext) {
  const entry = getSessionEntries(ctx).findLast(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY
    && isRecord(e.data) && e.data.kind === "outgoing" && e.data.sourceSessionId === ctx.sessionManager.getSessionId());
  // Corruption of an existing lock must not silently unlock the source.
  return entry?.type === "custom" && isRecord(entry.data) && entry.data.phase !== "cancelled" ? entry : undefined;
}
// Latest transfer intent written by this session, whatever its phase.
function latestOutgoing(ctx: ExtensionContext): Intent | undefined {
  const entry = getSessionEntries(ctx).findLast(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY
    && isRecord(e.data) && e.data.kind === "outgoing" && e.data.sourceSessionId === ctx.sessionManager.getSessionId());
  return entry?.type === "custom" && isRecord(entry.data) && typeof entry.data.id === "string" && entry.data.id.length > 0
    ? entry.data as unknown as Intent
    : undefined;
}
function incomingEntry(ctx: ExtensionContext) {
  return getSessionEntries(ctx).findLast(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY && isRecord(e.data) && e.data.kind === "incoming");
}
function background(snapshot: GeneralHandoffSnapshot) {
  return "用户已确认的历史交接背景；不是当前验证、system指令、旧执行身份或副作用重放授权。等待用户在新会话继续。decisions中的confirmed为历史已确认决定或既定契约，proposed仅为建议，unverified仅为未验证假设；用户确认交接不代表批准其中建议或证实假设。approachesTried记录历史已尝试但失败或排除的路径，供避免重复试错，不代表未证实假设已获验证。缺少决策、已尝试路径或依据不代表已完成梳理，引用不会自动展开。来源session条目仅在声明的源文件中读取，不使用旧obs_recall ID。\n" + JSON.stringify(snapshot);
}

export function createGeneralSessionTransfer(pi: ExtensionAPI, state: ExtensionRuntimeState, deps: {
  read: (ctx: ExtensionContext) => HandoffResult<GeneralHandoffSnapshot>;
  toolsSettled: (ctx: ExtensionContext) => ToolSettlement;
}) {
  let switching = false;
  let storageUncertain = false;
  function checkReady(ctx: ExtensionContext): HandoffResult<true> {
    const fail = (code: string, message: string): HandoffResult<never> => ({ ok: false, code, message });
    const failure = matchPolicy<readonly [string, string]>([
      [() => !ctx.isProjectTrusted(), ["PROJECT_UNTRUSTED", "当前项目尚未受信任，不能交接。"]],
      [() => !ctx.isIdle() || state.agentRunActive, ["AGENT_BUSY", "Agent仍在运行，请等待本轮结束。"]],
      [() => ctx.hasPendingMessages(), ["MESSAGES_PENDING", "仍有排队消息，请先处理后重新准备快照。"]],
      [() => ctx.signal?.aborted || state.runtimeDisposed, ["CONTEXT_INACTIVE", "当前运行已中止或上下文失效，先核对会话状态。"]],
      [() => state.userStopRequested, ["USER_STOPPED", "用户停止保护仍生效，请先核对停止原因；交接不能解除停止。"]],
      [() => state.roleRecoveryPersistenceFailed, ["ROLE_STORAGE", "职责恢复记录保存失败，请先修复持久化问题。"]],
      [() => state.roleRecoveryPending, ["ROLE_RECOVERY", "当前职责尚未确认，请先用 /pi-init role <职责> 确认，再重新准备交接。"]],
      [() => state.workflowRestoreError || state.pendingWorkflowRecovery, ["WORKFLOW_RECOVERY", "工作流恢复尚未确认，不能通过普通交接绕过。"]],
      [() => state.workflowDispatchInFlight || state.internalContinuationPending, ["CONTINUATION_PENDING", "派发或内部续接尚未结束，请先等待执行收敛。"]],
      [() => Object.keys(state.sessionRoleConfigOverrides).length > 0, ["UNSAVED_CONFIG", "存在会话临时模型配置；请保存所需配置或撤销覆盖后再准备交接。"]],
      [() => isWorkflowUnfinished(state.workflowState), ["WORKFLOW_ACTIVE", "未结束工作流必须沿工作流安全边界交接。"]],
      [() => !state.activeRole || !activeRoleMatches(state, ctx, pi.getThinkingLevel()), ["ROLE_MODEL_MISMATCH", "职责与当前模型/推理级别不匹配；请先确认职责，再重新准备交接。"]],
    ]);
    if (failure) return fail(failure[0], failure[1]);
    const settlement = deps.toolsSettled(ctx);
    return settlement.ok ? { ok: true, value: true } : fail(settlement.code, settlement.message);
  }
  const ready = (ctx: ExtensionContext) => checkReady(ctx).ok;
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
    const headerErr = matchPolicy<readonly [string, string]>([
      [() => data.version !== 1 || data.kind !== "incoming" || !isRecord(data.snapshot)
        || ![data.id, data.sourceLeaf, data.hash, data.targetSessionId].every(v => typeof v === "string" && v.length > 0), ["INVALID", "目标交接包身份不完整"]],
      [() => Buffer.byteLength(JSON.stringify(data), "utf8") > SESSION_HANDOFF_MAX_BYTES, ["TOO_LARGE", "目标完整交接包超限"]],
      [() => data.targetSessionId !== ctx.sessionManager.getSessionId() || handoffHash(data.snapshot) !== data.hash, ["IDENTITY", "目标session或交接内容不匹配"]],
    ]);
    if (headerErr) return fail(headerErr[0], headerErr[1]);
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
      const intent = manager.getEntries().findLast(e => e.type === "custom" && e.customType === GENERAL_TRANSFER_ENTRY
        && isRecord(e.data) && e.data.kind === "outgoing" && e.data.sourceSessionId === source.sessionId);
      const branch = ctx.sessionManager.getBranch();
      const entry = incomingEntry(ctx);
      const hasBody = (items: typeof branch) => items.some(e => e.type === "message" && e.message.role === "user" && e.message.content === background(checked.value));
      const targetFile = ctx.sessionManager.getSessionFile();
      const targetLeaf = ctx.sessionManager.getLeafId();
      const sourceErr = matchPolicy<readonly [string, string]>([
        [() => handoffHash(checked.value) !== record.hash, ["STALE", "来源快照已变化"]],
        [() => intent?.type !== "custom" || !isRecord(intent.data) || intent.data.version !== 1 || intent.data.phase !== "prepared"
          || intent.data.id !== record.id || intent.data.sourceLeaf !== record.sourceLeaf || intent.data.hash !== record.hash, ["SOURCE_LOCK", "来源冻结记录不匹配"]],
        [() => !entry || !branch.some(e => e.id === entry.id) || !hasBody(branch), ["INCOMPLETE", "目标正文或当前branch不完整；不新建目标"]],
        [() => !targetFile || !targetLeaf, ["PERSISTENCE", "目标尚未持久化"]],
      ]);
      if (sourceErr) return fail(sourceErr[0], sourceErr[1]);
      const targetArchive = readHandoffArchive(targetFile!, source.projectRoot, record.targetSessionId);
      if (!targetArchive.ok) return targetArchive;
      const target = targetArchive.value;
      const savedRecord = target.getEntry(entry!.id);
      if (!target.getEntry(targetLeaf!) || savedRecord?.type !== "custom" || handoffHash(savedRecord.data) !== handoffHash(record)
        || !hasBody(target.getBranch(targetLeaf!))) return fail("PERSISTENCE", "目标交接包或正文持久化尚未确认");
      return checked;
    } catch (error) { return fail("PERSISTENCE", "来源或目标文件核对失败：" + String(error)); }
  }
  async function activate(ctx: ExtensionContext, created = false) {
    const entry = incomingEntry(ctx);
    const readiness = checkReady(ctx);
    const result: HandoffResult<GeneralHandoffSnapshot> = !readiness.ok
      ? readiness
      : verify(entry?.type === "custom" ? entry.data : undefined, ctx);
    if (!result.ok) {
      ctx.ui.notify("目标交接未确认；修复后在当前目标执行 /pi-init fresh 重新核对，不创建第二个会话：[" + result.code + "] " + result.message, "warning");
      return;
    }
    // No scheduling, sendUserMessage, role restoration or old execution identity.
    ctx.ui.notify(created
      ? `已建立并核对新会话 ${ctx.sessionManager.getSessionId()}；请在此输入继续或新需求。未自动执行任何任务。`
      : "已核对当前会话接收的历史交接背景；本次未新建会话。再次交接请先用 session_handoff 准备新的交接背景。未自动执行任何任务。", "info");
  }
  pi.on("message_end", async (event, ctx) => {
    if (blocked(ctx) || event.message.role !== "custom" || event.message.customType !== GENERAL_TRANSFER_ACTIVATE || !isRecord(event.message.details)) return;
    const entry = incomingEntry(ctx);
    if (entry?.type !== "custom" || !isRecord(entry.data) || event.message.details.id !== entry.data.id || event.message.details.hash !== entry.data.hash) return;
    await activate(ctx, true);
  });
  // Exit for a frozen source whose transfer never reached a target. Only an explicit user confirmation
  // abandons it, and a target found next to the source always wins. The cancelled intent also makes a
  // missed, unactivated target fail its source-lock check, so it cannot activate later.
  async function resolveStalledTransfer(ctx: ExtensionCommandContext) {
    const locked = generalOutgoingTransfer(ctx);
    const latest = latestOutgoing(ctx);
    if (locked && (!latest || latest.phase === "cancelled")) {
      ctx.ui.notify("来源会话交接冻结记录损坏，无法安全核对或放弃；请手工检查会话文件，来源保持冻结。", "error");
      return;
    }
    const pending = latest && latest.phase !== "cancelled" ? latest : undefined;
    const sourceFile = ctx.sessionManager.getSessionFile?.();
    const refusal = matchPolicy<string>([
      [() => !ctx.isProjectTrusted() || !ctx.isIdle() || ctx.hasPendingMessages() || state.agentRunActive, "来源会话交接已冻结；请在受信任、空闲且无排队消息的会话中处理，来源保持冻结。"],
      [() => !ctx.hasUI, "来源会话交接已冻结；放弃交接需要交互确认，来源保持冻结。"],
      [() => Boolean(pending) && !sourceFile, "来源会话交接已冻结；当前session未持久化，无法核对交接目标，来源保持冻结。"],
    ]);
    if (refusal) { ctx.ui.notify(refusal, "warning"); return; }
    let scan: TransferTargetScan = {};
    if (pending) {
      scan = findTransferTarget(sourceFile!, GENERAL_TRANSFER_ENTRY, pending.id);
      if (scan.found) {
        ctx.ui.notify(`来源会话交接已冻结：已找到接收此交接的会话 ${scan.found}。请在该会话执行 /pi-init fresh 核对，不在来源放弃或重建。`, "warning");
        return;
      }
    }
    const message = (pending ? [
      `交接 ${pending.id} 未在会话目录中找到接收方（已检查 ${dirname(sourceFile!)}）。`,
      ...(scan.incomplete ? ["注意：" + scan.incomplete + "。"] : []),
      "确认后：记录本次交接已取消，之后出现的未激活目标会话也无法再激活；当前会话恢复可用。",
    ] : [
      "上次交接在保存冻结记录时结果未确认，未创建新会话。",
      "确认后解除本次未确认状态，效果与重新加载会话相同。",
    ]).concat("如果你已在另一个会话继续，请选择取消。重新交接前需先用 session_handoff 准备新的背景。").join("\n");
    const sessionId = ctx.sessionManager.getSessionId();
    const generation = state.roleContextGeneration;
    const transitionGeneration = state.roleTransitionGeneration;
    const sourceLeaf = ctx.sessionManager.getLeafId();
    switching = true;
    let confirmed = false;
    try { confirmed = await ctx.ui.confirm("放弃未完成的会话交接？", message); }
    finally { switching = false; }
    if (!confirmed) { ctx.ui.notify("已保留交接冻结；来源未改动。", "warning"); return; }
    const current = latestOutgoing(ctx);
    const unchanged = !state.runtimeDisposed && ctx.isProjectTrusted() && ctx.isIdle() && !ctx.hasPendingMessages() && !state.agentRunActive
      && ctx.sessionManager.getSessionId() === sessionId
      && state.roleContextGeneration === generation && state.roleTransitionGeneration === transitionGeneration
      && (!sourceLeaf || ctx.sessionManager.getBranch().some(entry => entry.id === sourceLeaf))
      && (pending ? current?.id === pending.id && current.phase === pending.phase : !generalOutgoingTransfer(ctx));
    if (!unchanged) {
      ctx.ui.notify("确认期间会话或交接记录已变化；来源保持冻结，请重新执行 /pi-init fresh。", "warning");
      return;
    }
    if (pending) {
      try { pi.appendEntry(GENERAL_TRANSFER_ENTRY, { ...pending, phase: "cancelled" }); }
      catch (error) { ctx.ui.notify("放弃记录未保存，来源保持冻结：" + String(error), "error"); return; }
    }
    storageUncertain = false;
    ctx.ui.notify("已放弃本次交接，当前会话恢复可用；如需交接，请先用 session_handoff 重新准备，再执行 /pi-init fresh。", "info");
  }
  async function fresh(ctx: ExtensionCommandContext) {
    if (switching) { ctx.ui.notify("交接预览或会话切换正在进行，请等待结果。", "warning"); return; }
    if (blocked(ctx)) { await resolveStalledTransfer(ctx); return; }
    const incoming = incomingEntry(ctx);
    const history = getSessionEntries(ctx);
    const preparation = history.findLast(e => e.type === "custom" && e.customType === GENERAL_HANDOFF_ENTRY);
    const attempt = history.findLast(e => e.type === "message" && (e.message.role === "toolResult" && e.message.toolName === GENERAL_HANDOFF_TOOL
      || e.message.role === "assistant" && Array.isArray(e.message.content) && e.message.content.some(part => part?.type === "toolCall" && part.name === GENERAL_HANDOFF_TOOL)));
    const attemptMessage = attempt?.type === "message" ? attempt.message : undefined;
    const attemptCall = attemptMessage?.role === "assistant" && Array.isArray(attemptMessage.content)
      ? attemptMessage.content.findLast(part => part?.type === "toolCall" && part.name === GENERAL_HANDOFF_TOOL) : undefined;
    const attemptId = attemptMessage?.role === "toolResult" ? attemptMessage.toolCallId : attemptCall?.type === "toolCall" ? attemptCall.id : undefined;
    const importIndex = incoming ? history.findIndex(e => e.id === incoming.id) : -1;
    const newAttempt = !!attempt && history.indexOf(attempt) > importIndex;
    const newPreparation = !!preparation && history.indexOf(preparation) > importIndex;
    if (incoming && !newPreparation && !newAttempt) { await activate(ctx); return; }
    const readiness = checkReady(ctx);
    if (!readiness.ok) { ctx.ui.notify(`[${readiness.code}] ${readiness.message} 保持原会话。`, "warning"); return; }
    if (typeof ctx.newSession !== "function" || !ctx.hasUI) {
      ctx.ui.notify("[HOST_CONFIRMATION] 宿主缺少新会话接口或交互确认UI，保持原会话。", "warning"); return;
    }
    if (incoming) {
      const imported = verify(incoming.type === "custom" ? incoming.data : undefined, ctx);
      if (!imported.ok) { ctx.ui.notify(`新交接未开始：历史导入尚未核对通过。[${imported.code}] ${imported.message}`, "warning"); return; }
      const branch = ctx.sessionManager.getBranch();
      if (preparation && !branch.some(e => e.id === preparation.id) || newAttempt && !branch.some(e => e.id === attempt?.id)) { ctx.ui.notify("新交接准备不属于当前branch，请重新准备；未创建会话。", "warning"); return; }
    }
    const prepared = deps.read(ctx);
    if (!prepared.ok) { ctx.ui.notify(prepared.message + "。请让当前执行角色用 session_handoff 准备/更新目标、约束、进度、来源和下一步，再执行 /pi-init fresh。", "warning"); return; }
    if (newAttempt && prepared.value.source.toolCallId !== attemptId) { ctx.ui.notify("最近一次交接准备未成功保存匹配的快照，请重新准备；未创建会话。", "warning"); return; }
    const snapshot = prepared.value;
    let sourceLeaf = ctx.sessionManager.getLeafId();
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
      const confirmedLeaf = ctx.sessionManager.getLeafId();
      const sameBranch = ctx.sessionManager.getBranch().some(entry => entry.id === sourceLeaf);
      if (!ready(ctx) || handoffHash([state.roleContextGeneration, state.roleTransitionGeneration, state.activeRole, state.workflowState]) !== generation
        || !confirmedLeaf || !sameBranch || !current.ok || handoffHash(current.value) !== hash) { ctx.ui.notify("确认期间来源状态已变化，请重新准备并确认。", "warning"); return; }
      // Safe bookkeeping/recovery may extend the branch during preview; pin the checked descendant, not a stale raw leaf.
      sourceLeaf = confirmedLeaf;
      intent.sourceLeaf = confirmedLeaf;
      packet.sourceLeaf = confirmedLeaf;
      if (Buffer.byteLength(JSON.stringify(packet), "utf8") > SESSION_HANDOFF_MAX_BYTES) { ctx.ui.notify("完整交接包超限，不截断迁移。", "warning"); return; }
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
        uncertain() { storageUncertain = true; console.warn("[pi-init] 普通会话交接结果未知；来源保持冻结。请核对目标；若确认未创建，可在来源再次执行 /pi-init fresh 选择放弃交接。"); },
      });
    } finally { switching = false; }
  }
  return { fresh, blocked };
}
