import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CoordinationHandoff,
  CoordinationHandoffIdentity,
  CoordinationRole,
  CoordinationRuntimeState,
} from "../src/coordination-runtime-types.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import {
  COORDINATION_EVIDENCE_MESSAGE_TYPE,
  COORDINATION_REVIEW_MESSAGE_TYPE,
  coordinationError,
  coordinationHandoffIdentity,
  isRecord,
  nonEmptyText,
  sameCoordinationIdentity,
} from "./coordination-runtime-protocol.ts";

export function createCoordinationHandoffValidator(
  getState: () => CoordinationRuntimeState | undefined,
  roleRuntime: RoleRuntime,
) {
  function requireCurrentIdentity(
    input: unknown,
    ctx: ExtensionContext,
    expectedRole: CoordinationRole,
    expectedKind: CoordinationHandoff["kind"],
    expectedReportId?: string,
  ): CoordinationHandoffIdentity {
    const current = getState();
    if (!current) throw coordinationError("COORDINATION_STATE_MISSING", "当前没有可验证的持久协作状态");
    if (!isRecord(input)) throw coordinationError("COORDINATION_HANDOFF_IDENTITY_MISSING", "协作动作缺少 coordinationIdentity");
    const identity: CoordinationHandoffIdentity = {
      coordinationId: nonEmptyText(input.coordinationId, "coordinationId"),
      coordinationVersion: input.coordinationVersion as number,
      sessionId: nonEmptyText(input.sessionId, "sessionId"),
      recoveryGeneration: input.recoveryGeneration as number,
      requestId: nonEmptyText(input.requestId, "requestId"),
      role: input.role as CoordinationRole,
      kind: input.kind as CoordinationHandoff["kind"],
      attemptId: nonEmptyText(input.attemptId, "attemptId"),
      handoffId: nonEmptyText(input.handoffId, "handoffId"),
      ...(input.reportId === undefined ? {} : { reportId: nonEmptyText(input.reportId, "reportId") }),
    };
    if (!Number.isSafeInteger(identity.coordinationVersion) || identity.coordinationVersion < 1
      || !Number.isSafeInteger(identity.recoveryGeneration) || identity.recoveryGeneration < 0) {
      throw coordinationError("COORDINATION_HANDOFF_IDENTITY_INVALID", "协作 identity 版本或恢复代次格式无效");
    }
    let sessionId: unknown;
    try {
      sessionId = ctx.sessionManager.getSessionId();
    } catch (error) {
      throw coordinationError("COORDINATION_SESSION_ID_UNAVAILABLE", `无法读取当前 Pi sessionId：${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw coordinationError("COORDINATION_SESSION_ID_UNAVAILABLE", "无法读取当前 Pi sessionId");
    }
    if (identity.sessionId !== sessionId || current.sessionId !== sessionId) {
      throw coordinationError("COORDINATION_SESSION_MISMATCH", "协作动作来自过期或不同 Pi session");
    }
    if (identity.coordinationVersion !== current.coordination.version) {
      throw coordinationError("COORDINATION_VERSION_MISMATCH", "协作协议版本已变化");
    }
    const expected = coordinationHandoffIdentity(current);
    if (!expected || !sameCoordinationIdentity(identity, expected)) {
      throw coordinationError("COORDINATION_HANDOFF_IDENTITY_STALE", "协作 attempt/handoff 身份已变化；旧回调不能推进状态");
    }
    if (identity.role !== expectedRole || identity.kind !== expectedKind || identity.role !== expected.role) {
      throw coordinationError("COORDINATION_ACTION_ROLE_MISMATCH", `当前协作动作要求 ${expectedRole}/${expectedKind} 身份`);
    }
    if (expectedReportId !== undefined && identity.reportId !== expectedReportId) {
      throw coordinationError("COORDINATION_REPORT_ID_MISMATCH", "协作动作报告 ID 与当前 handoff 不一致");
    }
    const activeRole = roleRuntime.activeRoleFor(ctx)?.role;
    if (activeRole !== expectedRole) {
      throw coordinationError("COORDINATION_ACTION_ROLE_FORBIDDEN", `当前角色 ${activeRole ?? "（未知）"} 无权执行 ${expectedRole} 协作动作`);
    }
    if (!["queued", "executing"].includes(current.handoff?.phase ?? "")) {
      throw coordinationError("COORDINATION_HANDOFF_NOT_ACTIVE", `协作 handoff 当前不可提交结果（${current.handoff?.phase ?? "missing"}）`);
    }
    const customType = expectedKind === "evidence" ? COORDINATION_EVIDENCE_MESSAGE_TYPE : COORDINATION_REVIEW_MESSAGE_TYPE;
    const branch = ctx.sessionManager.getBranch();
    const messageExists = Array.isArray(branch) && branch.some((entry: unknown) => isRecord(entry)
      && entry.type === "custom_message"
      && entry.customType === customType
      && sameCoordinationIdentity(entry.details, expected));
    if (!messageExists) {
      throw coordinationError("COORDINATION_HANDOFF_BRANCH_MISMATCH", "当前 session branch 不包含匹配的协作 handoff 消息；拒绝旧分支回调");
    }
    return expected;
  }

  return { requireCurrentIdentity };
}
