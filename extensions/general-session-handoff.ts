import { realpathSync, statSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { activeRoleMatches, type ExtensionRuntimeState } from "./runtime-state.ts";
import { GENERAL_HANDOFF_ENTRY, GENERAL_HANDOFF_INVALIDATED, GENERAL_HANDOFF_TOOL, generalHandoffBranchHash, parseGeneralHandoff, readGeneralHandoff, type GeneralHandoffSnapshot, type HandoffResult } from "../src/general-session-handoff.ts";
import { SESSION_HANDOFF_MAX_BYTES } from "../src/session-handoff.ts";

const sourceSchema = Type.Object({ kind: Type.Union([Type.Literal("session-entry"), Type.Literal("file")]), location: Type.String(), description: Type.String() }, { additionalProperties: false });
const strings = Type.Array(Type.String());

/** Preparation only: no provider requests, workflow creation, migration or resumption. */
export function registerGeneralSessionHandoff(pi: ExtensionAPI, state: ExtensionRuntimeState) {
  const activeTools = new Set<string>();
  function invalidate(reason: string, ctx: ExtensionContext) {
    if (ctx.sessionManager.getBranch().some(e => e.type === "custom" && e.customType === GENERAL_HANDOFF_ENTRY)) {
      pi.appendEntry(GENERAL_HANDOFF_INVALIDATED, { reason });
    }
  }
  pi.on("tool_execution_start", (event, ctx) => {
    activeTools.add(event.toolCallId);
    if (event.toolName !== GENERAL_HANDOFF_TOOL) invalidate("tool-activity", ctx);
  });
  pi.on("tool_execution_end", event => { activeTools.delete(event.toolCallId); });
  pi.on("input", (_event, ctx) => { invalidate("new-input", ctx); });
  pi.on("session_tree", (_event, ctx) => { invalidate("branch-change", ctx); });
  pi.on("session_start", () => { activeTools.clear(); });

  function read(ctx: ExtensionContext): HandoffResult<GeneralHandoffSnapshot> {
    try {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile || !statSync(sessionFile).isFile()) return { ok: false, code: "PERSISTENCE", message: "当前session没有可读取的持久化文件" };
      return readGeneralHandoff(ctx.sessionManager.getBranch(), { sessionId: ctx.sessionManager.getSessionId(), projectRoot: realpathSync(ctx.cwd), sessionFile: realpathSync(sessionFile) });
    } catch {
      return { ok: false, code: "PERSISTENCE", message: "无法核对来源session文件或项目目录" };
    }
  }
  pi.registerTool({
    name: GENERAL_HANDOFF_TOOL,
    label: "准备短上下文交接",
    description: "仅为普通会话准备并持久化短交接背景，不创建会话或工作流、不解除暂停、不自动续跑。必须显式填写全部字段，无内容用空数组。验证与来源均为历史声明，不是本轮验证或执行授权。后续用户通过 /pi-init fresh 预览确认。保存后避免业务工具或新需求，否则需重新准备。",
    parameters: Type.Object({
      goal: Type.String(), constraints: strings, completed: strings, remaining: strings,
      verification: Type.Array(Type.Object({ summary: Type.String(), sources: Type.Array(sourceSchema) }, { additionalProperties: false })),
      unknowns: strings, nextStep: Type.String(), sources: Type.Array(sourceSchema),
    }, { additionalProperties: false }),
    async execute(toolCallId, input, signal, _update, ctx) {
      const result = (value: HandoffResult<GeneralHandoffSnapshot>) => ({
        content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value,
      });
      const fail = (code: string, message: string) => result({ ok: false, code, message });
      if (signal?.aborted || ctx.signal?.aborted || !ctx.isProjectTrusted() || state.runtimeDisposed || state.userStopRequested
        || state.roleRecoveryPending || state.roleRecoveryPersistenceFailed || state.workflowRestoreError || state.pendingWorkflowRecovery
        || state.roleCompactionInFlight || state.pendingRoleCompaction || state.activeRoleCompaction
        || state.workflowDispatchInFlight || state.internalContinuationPending) return fail("SAFETY_GATE", "停止、恢复、信任或运行状态尚不允许准备交接");
      if (!state.activeRole || state.activeRole.role === "architect" || !activeRoleMatches(state, ctx, pi.getThinkingLevel())) return fail("ROLE", "仅当前已确认且模型匹配的执行角色可准备交接");
      if (state.workflowState && !["completed", "cancelled"].includes(state.workflowState.status)) return fail("WORKFLOW_ACTIVE", "未结束工作流必须使用已有工作流交接路径");
      if ([...activeTools].some(id => id !== toolCallId)) return fail("TOOLS_ACTIVE", "仍有其他工具执行，不能保存现场快照");
      const parsed = parseGeneralHandoff(input);
      if (!parsed.ok) return result(parsed);
      try {
        const branch = ctx.sessionManager.getBranch();
        const leaf = ctx.sessionManager.getLeafId();
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!leaf || !sessionFile || !statSync(sessionFile).isFile()) return fail("PERSISTENCE", "来源session/branch必须已持久化");
        const snapshot: GeneralHandoffSnapshot = {
          version: 1, historical: true, context: parsed.value,
          source: { sessionId: ctx.sessionManager.getSessionId(), projectRoot: realpathSync(ctx.cwd), sessionFile: realpathSync(sessionFile), branchLeafId: leaf, branchHash: generalHandoffBranchHash(branch, toolCallId), toolCallId },
        };
        const sourceIds = [...snapshot.context.sources, ...snapshot.context.verification.flatMap(check => check.sources)];
        if (sourceIds.some(source => source.kind === "session-entry" && !branch.some(e => e.id === source.location))) return fail("SOURCE_IDENTITY", "来源条目不属于当前branch；请提供文件位置或有效条目ID");
        if (Buffer.byteLength(JSON.stringify(snapshot), "utf8") > SESSION_HANDOFF_MAX_BYTES) return fail("TOO_LARGE", "完整快照超过32 KiB，不截断或保存");
        pi.appendEntry(GENERAL_HANDOFF_ENTRY, snapshot);
        return result(read(ctx));
      } catch {
        return fail("PERSISTENCE", "保存或核对交接快照失败；不得据此创建目标会话");
      }
    },
  });
  return { read };
}
