import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import {
  createCoordinationState,
  hydrateCoordinationState,
  reportEvidence as recordEvidenceReport,
  requestEvidence as recordEvidenceRequest,
  reviewEvidence as recordEvidenceReview,
} from "../src/coordination.ts";
import type {
  CoordinationHandoff,
  CoordinationHandoffIdentity,
  CoordinationRole,
  CoordinationRuntimeState,
} from "../src/coordination-runtime-types.ts";
import type { EvidenceReportInput, EvidenceRequestInput, EvidenceReviewInput } from "../src/coordination-types.ts";
import type { WorkflowState } from "../src/workflow-types.ts";
import { textOf, type ExtensionRuntimeState } from "./runtime-state.ts";
import type { RoleRuntime } from "./role-runtime.ts";
import { compileCoordinationMessage } from "./coordination-messages.ts";
import { createCoordinationStatus } from "./coordination-status.ts";
import { createCoordinationHandoffValidator } from "./coordination-handoff-validation.ts";
import { checkCoordinationWorkflowReadiness } from "./coordination-readiness.ts";
import {
  COORDINATION_ENTRY_TYPE,
  COORDINATION_EVIDENCE_MESSAGE_TYPE,
  COORDINATION_REVIEW_MESSAGE_TYPE,
  COORDINATION_RUNTIME_VERSION,
  coordinationError,
  coordinationFailure as failure,
  coordinationHandoffIdentity as handoffIdentity,
  hydrateCoordinationRuntimeState,
  isRecord,
  nonEmptyText,
  requireCoordinationResult,
  sameCoordinationIdentity as sameIdentity,
} from "./coordination-runtime-protocol.ts";

export type CoordinationRuntimeDependencies = {
  pi: ExtensionAPI;
  roleRuntime: RoleRuntime;
  setInternalContinuationPending: (value: boolean) => void;
};

export function createCoordinationRuntime(
  state: ExtensionRuntimeState,
  deps: CoordinationRuntimeDependencies,
) {
  let localScheduleInFlight = false;
  const statusView = createCoordinationStatus(state);
  const { requireCurrentIdentity } = createCoordinationHandoffValidator(
    () => state.coordinationRuntimeState,
    deps.roleRuntime,
  );

  function persist(next: CoordinationRuntimeState, ctx: ExtensionContext) {
    deps.pi.appendEntry(COORDINATION_ENTRY_TYPE, next);
    state.coordinationRuntimeState = next;
    state.coordinationRestoreError = undefined;
    return next;
  }

  function getSessionId(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (typeof sessionId !== "string" || !sessionId.trim()) throw new Error("sessionId 为空");
      return sessionId;
    } catch (error) {
      throw coordinationError("COORDINATION_SESSION_ID_UNAVAILABLE", `无法读取当前 Pi sessionId：${textOf(error)}`);
    }
  }

  function createHandoff(
    role: CoordinationRole,
    kind: CoordinationHandoff["kind"],
    requestId: string,
    reportId?: string,
    now = Date.now(),
  ): CoordinationHandoff {
    return {
      role,
      kind,
      requestId,
      ...(reportId ? { reportId } : {}),
      attemptId: randomUUID(),
      handoffId: randomUUID(),
      phase: "prepared",
      createdAt: now,
    };
  }

  function pendingRoleCompaction() {
    return state.pendingRoleCompaction;
  }

  function activeWorkflowIsLinked(coordination: CoordinationRuntimeState, workflow: WorkflowState) {
    const link = coordination.coordination.workflowLink;
    return Boolean(link
      && link.workflowId === workflow.workflowId
      && link.planVersion === workflow.planVersion
      && link.recoveryGeneration === workflow.recoveryGeneration);
  }

  function assertNoUnrelatedWorkflow(coordination?: CoordinationRuntimeState) {
    const workflow = state.workflowState;
    if (!workflow || ["completed", "cancelled"].includes(workflow.status)) return;
    if (!coordination || !activeWorkflowIsLinked(coordination, workflow)) {
      throw coordinationError("COORDINATION_WORKFLOW_ACTIVE", "当前有未关联的活动工作流；取证协作不会抢占或覆盖它");
    }
  }

  function isRelevantForNewWorkflowPlan() {
    const current = state.coordinationRuntimeState;
    if (!current || state.coordinationRestoreError) return false;
    const link = current.coordination.workflowLink;
    if (!link) return true;
    const workflow = state.workflowState;
    return Boolean(workflow && !["completed", "cancelled"].includes(workflow.status)
      && activeWorkflowIsLinked(current, workflow));
  }

  function isLinkedToWorkflow(workflow: WorkflowState) {
    const current = state.coordinationRuntimeState;
    return Boolean(current && !state.coordinationRestoreError && activeWorkflowIsLinked(current, workflow));
  }

  function withPhase(current: CoordinationRuntimeState, phase: CoordinationHandoff["phase"], failureValue?: CoordinationHandoff["failure"]): CoordinationRuntimeState {
    if (!current.handoff) return current;
    return {
      ...current,
      handoff: {
        ...current.handoff,
        phase,
        ...(failureValue ? { failure: failureValue } : {}),
      },
    };
  }

  function coordinationMessageExists(ctx: ExtensionContext, current: CoordinationRuntimeState, identity: CoordinationHandoffIdentity) {
    const handoff = current.handoff;
    const customType = handoff?.kind === "review" ? COORDINATION_REVIEW_MESSAGE_TYPE : COORDINATION_EVIDENCE_MESSAGE_TYPE;
    const branch = ctx.sessionManager.getBranch();
    return Array.isArray(branch) && branch.some((entry: unknown) => isRecord(entry)
      && entry.type === "custom_message"
      && entry.customType === customType
      && sameIdentity(entry.details, identity));
  }

  function blockUnknownDispatch(ctx: ExtensionContext, current: CoordinationRuntimeState, reason: string) {
    const blocked = withPhase(current, "blocked", {
      code: "COORDINATION_DISPATCH_OUTCOME_UNKNOWN",
      message: reason,
    });
    try {
      persist(blocked, ctx);
    } catch (error) {
      ctx.ui.notify(`证据交接结果未知，且无法持久化 fail-closed 状态：${textOf(error)}；不会自动重放。`, "error");
    }
  }

  async function sendCoordinationMessage(ctx: ExtensionContext, expectedIdentity?: CoordinationHandoffIdentity) {
    const current = state.coordinationRuntimeState;
    const identity = current ? handoffIdentity(current) : undefined;
    if (!current || !identity || current.handoff?.phase !== "dispatching") return false;
    if (expectedIdentity && !sameIdentity(expectedIdentity, identity)) return false;
    if (deps.roleRuntime.activeRoleFor(ctx)?.role !== identity.role) return false;
    if (coordinationMessageExists(ctx, current, identity)) {
      blockUnknownDispatch(ctx, current, "活动 branch 已包含相同协作消息；拒绝重复派发");
      return false;
    }
    let attempted = false;
    try {
      deps.setInternalContinuationPending(true);
      attempted = true;
      const message = compileCoordinationMessage(current);
      await deps.pi.sendMessage({
        customType: message.customType,
        content: message.content,
        display: false,
        details: message.identity,
      }, { triggerTurn: true });
      const latest = state.coordinationRuntimeState;
      if (!latest || !sameIdentity(handoffIdentity(latest), identity) || latest.handoff?.phase !== "dispatching") return false;
      persist(withPhase(latest, "queued"), ctx);
      return true;
    } catch (error) {
      deps.setInternalContinuationPending(false);
      const latest = state.coordinationRuntimeState;
      if (attempted && latest && sameIdentity(handoffIdentity(latest), identity)) {
        blockUnknownDispatch(ctx, latest, `派发协作消息后无法确认交接状态：${textOf(error)}`);
      }
      ctx.ui.notify(`无法确认协作 handoff 派发结果；不会自动重放。${textOf(error)}`, "error");
      return false;
    } finally {
      state.workflowDispatchInFlight = false;
    }
  }

  async function schedule(ctx: ExtensionContext) {
    const current = state.coordinationRuntimeState;
    if (!current || state.coordinationRestoreError || current.handoff?.phase !== "prepared") return;
    if (state.runtimeDisposed || state.roleRecoveryPending || state.roleRecoveryPersistenceFailed
      || state.workflowDispatchInFlight || state.roleCompactionInFlight || state.pendingRoleCompaction
      || localScheduleInFlight) return;
    const workflow = state.workflowState;
    if (workflow && !["completed", "cancelled"].includes(workflow.status)) {
      if (!activeWorkflowIsLinked(current, workflow) || (workflow.status === "running" && workflow.currentTaskId)) return;
    }
    localScheduleInFlight = true;
    state.workflowDispatchInFlight = true;
    const identity = handoffIdentity(current);
    try {
      if (!identity) return;
      const dispatching = withPhase(current, "dispatching");
      persist(dispatching, ctx);
      const selection = await deps.roleRuntime.automaticRole(identity.role, ctx);
      const latest = state.coordinationRuntimeState;
      if (!latest || !sameIdentity(handoffIdentity(latest), identity) || latest.handoff?.phase !== "dispatching") return;
      if (selection.result.role !== identity.role) {
        blockUnknownDispatch(ctx, latest, `角色运行时返回 ${selection.result.role}，预期 ${identity.role}`);
        ctx.ui.notify(`协作已暂停：当前角色不匹配 ${identity.role}，未派发证据任务。`, "warning");
        return;
      }
      const pendingCompaction = pendingRoleCompaction();
      if (selection.transition && pendingCompaction) {
        pendingCompaction.continuation = { kind: "coordination-evidence", identity };
        deps.roleRuntime.startPendingRoleCompaction(ctx);
        return;
      }
      await sendCoordinationMessage(ctx, identity);
    } catch (error) {
      const latest = state.coordinationRuntimeState;
      if (identity && latest && sameIdentity(handoffIdentity(latest), identity)) {
        blockUnknownDispatch(ctx, latest, `协作角色切换或派发准备失败：${textOf(error)}`);
      }
      ctx.ui.notify(`协作派发失败并已 fail-closed：${textOf(error)}`, "error");
    } finally {
      localScheduleInFlight = false;
      if (!state.roleCompactionInFlight && !state.pendingRoleCompaction) state.workflowDispatchInFlight = false;
    }
  }

  function restore(ctx: ExtensionContext) {
    state.coordinationRuntimeState = undefined;
    state.coordinationRestoreError = undefined;
    let branch: unknown;
    let sessionId: string;
    try {
      branch = ctx.sessionManager.getBranch();
      sessionId = getSessionId(ctx);
    } catch (error) {
      state.coordinationRestoreError = { code: "COORDINATION_SESSION_ID_UNAVAILABLE", message: textOf(error) };
      return;
    }
    if (!Array.isArray(branch)) return;
    let source: Record<string, unknown> | undefined;
    for (let index = branch.length - 1; index >= 0; index -= 1) {
      const entry = branch[index];
      if (isRecord(entry) && entry.type === "custom" && entry.customType === COORDINATION_ENTRY_TYPE) {
        source = entry;
        break;
      }
    }
    if (!source) return;
    const hydrated = hydrateCoordinationRuntimeState(source.data, sessionId);
    if (!hydrated.ok) {
      state.coordinationRestoreError = {
        code: hydrated.code,
        message: hydrated.message,
        ...(typeof source.id === "string" ? { sourceEntryId: source.id } : {}),
      };
      ctx.ui.notify(`无法恢复协作状态（${hydrated.code}）：${hydrated.message}；不会派发或接受旧回调。`, "error");
      return;
    }
    let recovered = hydrated.value;
    const oldHandoff = recovered.handoff;
    if (oldHandoff) {
      const recoveryGeneration = recovered.recoveryGeneration + 1;
      if (oldHandoff.phase === "prepared" || oldHandoff.kind === "review") {
        recovered = {
          ...recovered,
          recoveryGeneration,
          handoff: {
            ...oldHandoff,
            attemptId: randomUUID(),
            handoffId: randomUUID(),
            phase: "prepared",
            createdAt: Date.now(),
            failure: undefined,
          },
        };
      } else {
        recovered = {
          ...recovered,
          recoveryGeneration,
          handoff: {
            ...oldHandoff,
            phase: "blocked",
            failure: {
              code: "COORDINATION_DISPATCH_OUTCOME_UNKNOWN",
              message: "旧 session/branch 中的 docs 取证 handoff 已进入派发或执行阶段；结果未知，不会自动重放",
            },
          },
        };
      }
      try {
        persist(recovered, ctx);
      } catch (error) {
        state.coordinationRuntimeState = undefined;
        state.coordinationRestoreError = { code: "COORDINATION_RECOVERY_PERSIST_FAILED", message: textOf(error) };
        ctx.ui.notify(`协作恢复代次无法持久化，禁止继续派发：${textOf(error)}`, "error");
        return;
      }
      if (recovered.handoff?.phase === "blocked" && recovered.handoff.kind === "evidence") {
        ctx.ui.notify(`证据取证结果未知（${recovered.handoff.failure?.code}）；不会自动重放。架构师可核对后用 request-evidence 对同一 requestId 和 refreshReason 显式创建新 attempt。`, "warning");
      }
      return;
    }
    state.coordinationRuntimeState = recovered;
  }

  function validateRequestIdentityIfNeeded(
    current: CoordinationRuntimeState,
    input: unknown,
    ctx: ExtensionContext,
  ) {
    const handoff = current.handoff;
    if (!handoff) {
      if (current.coordination.phase !== "ready" && current.coordination.phase !== "blocked") {
        throw coordinationError("COORDINATION_HANDOFF_MISSING", "当前协作阶段缺少 architect 的有效 handoff 身份");
      }
      return;
    }
    if (handoff.role === "architect" && handoff.kind === "review") {
      requireCurrentIdentity(input, ctx, "architect", "review", handoff.reportId);
      return;
    }
    if (handoff.phase === "blocked" && handoff.kind === "evidence" && handoff.role === "docs-commit") return;
    throw coordinationError("COORDINATION_REQUEST_IN_FLIGHT", "当前协作 handoff 尚未完成；不得创建并行取证请求");
  }

  function requestEvidence(input: unknown, identity: unknown, ctx: ExtensionContext) {
    if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") {
      throw coordinationError("COORDINATION_ACTION_ROLE_FORBIDDEN", "只有 architect 可以请求取证");
    }
    const sessionId = getSessionId(ctx);
    const requestInput = isRecord(input) ? input : undefined;
    if (!requestInput) throw coordinationError("COORDINATION_REQUEST_INVALID_TYPE", "request 必须是对象");
    let current = state.coordinationRuntimeState;
    if (state.coordinationRestoreError) throw coordinationError(state.coordinationRestoreError.code, state.coordinationRestoreError.message);
    assertNoUnrelatedWorkflow(current);

    if (current) {
      validateRequestIdentityIfNeeded(current, identity, ctx);
      const handoff = current.handoff;
      if (handoff?.phase === "blocked" && handoff.kind === "evidence") {
        const requestedId = nonEmptyText(requestInput.requestId, "request.requestId");
        const refreshReason = nonEmptyText(requestInput.refreshReason, "request.refreshReason");
        const pending = current.coordination.requests.find((item) => item.requestId === handoff.requestId && item.status === "pending");
        const textList = (value: unknown) => value === undefined
          ? []
          : Array.isArray(value) && value.every((item) => typeof item === "string")
            ? value.map((item) => item.trim())
            : undefined;
        const requestMatches = Boolean(pending
          && requestedId === pending.requestId
          && typeof requestInput.questionId === "string" && requestInput.questionId.trim() === pending.questionId
          && typeof requestInput.question === "string" && requestInput.question.trim() === pending.question
          && typeof requestInput.rationale === "string" && requestInput.rationale.trim() === pending.rationale
          && JSON.stringify(textList(requestInput.scope)) === JSON.stringify(pending.scope)
          && JSON.stringify(textList(requestInput.exclusions)) === JSON.stringify(pending.exclusions)
          && JSON.stringify(textList(requestInput.completionCriteria)) === JSON.stringify(pending.completionCriteria)
          && JSON.stringify(textList(requestInput.addressesGaps)) === JSON.stringify(pending.addressesGaps)
          && (requestInput.followUpOfRequestId ?? undefined) === pending.followUpOfRequestId);
        if (!pending || !requestMatches) {
          throw coordinationError("COORDINATION_RETRY_REQUEST_MISMATCH", "未知结果只能用原 requestId 和未改变的请求内容显式创建新 attempt");
        }
        const activeWorkflow = state.workflowState;
        const keepWorkflowLink = Boolean(activeWorkflow && !["completed", "cancelled"].includes(activeWorkflow.status)
          && activeWorkflowIsLinked(current, activeWorkflow));
        const retryCoordination = keepWorkflowLink
          ? current.coordination
          : requireCoordinationResult(hydrateCoordinationState({ ...current.coordination, workflowLink: undefined }));
        const retried: CoordinationRuntimeState = {
          ...current,
          coordination: retryCoordination,
          handoff: createHandoff("docs-commit", "evidence", pending.requestId),
        };
        persist(retried, ctx);
        return { state: retried, request: pending, retryReason: refreshReason };
      }
    } else {
      assertNoUnrelatedWorkflow(undefined);
      const created = requireCoordinationResult(createCoordinationState({ sessionId }));
      current = {
        runtimeVersion: COORDINATION_RUNTIME_VERSION,
        coordination: created,
        sessionId,
        recoveryGeneration: 0,
      };
    }

    const recordedCoordination = requireCoordinationResult(recordEvidenceRequest(
      current.coordination,
      requestInput as unknown as EvidenceRequestInput,
    ));
    const activeWorkflow = state.workflowState;
    const keepWorkflowLink = Boolean(activeWorkflow && !["completed", "cancelled"].includes(activeWorkflow.status)
      && activeWorkflowIsLinked(current, activeWorkflow));
    const nextCoordination = keepWorkflowLink
      ? recordedCoordination
      : requireCoordinationResult(hydrateCoordinationState({ ...recordedCoordination, workflowLink: undefined }));
    const request = nextCoordination.requests.at(-1);
    if (!request) throw coordinationError("COORDINATION_REQUEST_NOT_CREATED", "取证请求未能生成");
    const next: CoordinationRuntimeState = {
      ...current,
      coordination: nextCoordination,
      sessionId,
      handoff: createHandoff("docs-commit", "evidence", request.requestId),
    };
    persist(next, ctx);
    return { state: next, request };
  }

  function reportEvidence(input: unknown, identityInput: unknown, ctx: ExtensionContext) {
    if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "docs-commit") {
      throw coordinationError("COORDINATION_ACTION_ROLE_FORBIDDEN", "report-evidence 只能由受派发的 docs-commit 角色提交");
    }
    const current = state.coordinationRuntimeState;
    if (!current) throw coordinationError("COORDINATION_STATE_MISSING", "当前没有待报告的持久协作状态");
    if (!isRecord(input)) throw coordinationError("COORDINATION_REPORT_INVALID_TYPE", "report 必须是对象");
    const identity = requireCurrentIdentity(identityInput, ctx, "docs-commit", "evidence");
    if (input.requestId !== identity.requestId) throw coordinationError("COORDINATION_REQUEST_ID_MISMATCH", "报告 requestId 与当前派发身份不一致");
    const nextCoordination = requireCoordinationResult(recordEvidenceReport(current.coordination, input as unknown as EvidenceReportInput));
    const report = nextCoordination.reports.at(-1);
    if (!report || report.requestId !== identity.requestId) throw coordinationError("COORDINATION_REPORT_NOT_CREATED", "证据报告未能写入当前请求");
    const next: CoordinationRuntimeState = {
      ...current,
      coordination: nextCoordination,
      handoff: createHandoff("architect", "review", identity.requestId, report.reportId),
    };
    persist(next, ctx);
    return { state: next, report };
  }

  function reviewEvidence(input: unknown, identityInput: unknown, ctx: ExtensionContext) {
    if (deps.roleRuntime.activeRoleFor(ctx)?.role !== "architect") {
      throw coordinationError("COORDINATION_ACTION_ROLE_FORBIDDEN", "只有 architect 可以审阅证据");
    }
    const current = state.coordinationRuntimeState;
    if (!current) throw coordinationError("COORDINATION_STATE_MISSING", "当前没有可审阅的证据状态");
    if (!isRecord(input)) throw coordinationError("COORDINATION_REVIEW_INVALID_TYPE", "review 必须是对象");
    const identity = requireCurrentIdentity(identityInput, ctx, "architect", "review", input.reportId as string);
    if (identity.requestId !== current.handoff?.requestId) throw coordinationError("COORDINATION_REQUEST_ID_MISMATCH", "审阅请求 ID 与当前 handoff 不一致");
    const nextCoordination = requireCoordinationResult(recordEvidenceReview(current.coordination, input as unknown as EvidenceReviewInput));
    const accepted = input.decision === "more";
    const next: CoordinationRuntimeState = {
      ...current,
      coordination: nextCoordination,
      ...(accepted ? {} : { handoff: undefined }),
    };
    persist(next, ctx);
    return { state: next, review: nextCoordination.reviews.at(-1) };
  }

  function markCurrentHandoffStartedFromMessage(ctx: ExtensionContext, message: unknown) {
    const current = state.coordinationRuntimeState;
    const handoff = current?.handoff;
    const identity = current ? handoffIdentity(current) : undefined;
    if (!current || !handoff || handoff.phase !== "queued" || !identity || !isRecord(message)) return false;
    const expectedType = handoff.kind === "review" ? COORDINATION_REVIEW_MESSAGE_TYPE : COORDINATION_EVIDENCE_MESSAGE_TYPE;
    if (message.role !== "custom" || message.customType !== expectedType || !sameIdentity(message.details, identity)) return false;
    try {
      persist(withPhase(current, "executing"), ctx);
      return true;
    } catch (error) {
      ctx.ui.notify(`无法持久化协作实际启动身份：${textOf(error)}；不会接受或重放旧回调。`, "error");
      return false;
    }
  }

  function readinessForWorkflow() {
    if (state.coordinationRestoreError) {
      return failure(state.coordinationRestoreError.code, state.coordinationRestoreError.message);
    }
    const current = state.coordinationRuntimeState;
    if (!current) return { ok: true as const, value: { ready: true as const, acceptedEvidence: [] as const } };
    return checkCoordinationWorkflowReadiness(current.coordination);
  }

  function assertReadyForWorkflow() {
    const readiness = readinessForWorkflow();
    if (!readiness.ok) throw coordinationError(readiness.code, readiness.message);
    return [...readiness.value.acceptedEvidence];
  }

  function linkWorkflow(workflow: WorkflowState, ctx: ExtensionContext) {
    const current = state.coordinationRuntimeState;
    if (!current) return undefined;
    const ready = assertReadyForWorkflow();
    const coordination = hydrateCoordinationState({
      ...current.coordination,
      workflowLink: {
        workflowId: workflow.workflowId,
        planVersion: workflow.planVersion,
        recoveryGeneration: workflow.recoveryGeneration,
      },
      updatedAt: Math.max(Date.now(), current.coordination.updatedAt),
    });
    const next = { ...current, coordination: requireCoordinationResult(coordination) };
    persist(next, ctx);
    return { state: next, acceptedEvidence: ready };
  }

  return {
    restore,
    schedule,
    sendCoordinationMessage,
    markCurrentHandoffStartedFromMessage,
    requestEvidence,
    reportEvidence,
    reviewEvidence,
    status: statusView.status,
    summary: statusView.summary,
    readinessForWorkflow,
    assertReadyForWorkflow,
    isRelevantForNewWorkflowPlan,
    isLinkedToWorkflow,
    linkWorkflow,
  };
}

export type CoordinationRuntime = ReturnType<typeof createCoordinationRuntime>;
