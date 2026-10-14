import type { ExtensionRuntimeState } from "./runtime-state.ts";

export function createCoordinationStatus(state: ExtensionRuntimeState) {
  function status() {
    const current = state.coordinationRuntimeState;
    if (state.coordinationRestoreError) return { error: { ...state.coordinationRestoreError } };
    if (!current) return undefined;
    return {
      coordinationId: current.coordination.coordinationId,
      coordinationVersion: current.coordination.version,
      sessionId: current.sessionId,
      recoveryGeneration: current.recoveryGeneration,
      workflowLink: current.coordination.workflowLink ? { ...current.coordination.workflowLink } : undefined,
      phase: current.coordination.phase,
      handoff: current.handoff ? {
        role: current.handoff.role,
        kind: current.handoff.kind,
        requestId: current.handoff.requestId,
        reportId: current.handoff.reportId,
        attemptId: current.handoff.attemptId,
        handoffId: current.handoff.handoffId,
        phase: current.handoff.phase,
        failure: current.handoff.failure,
      } : undefined,
      requests: current.coordination.requests.map((request) => ({
        requestId: request.requestId,
        questionId: request.questionId,
        question: request.question,
        round: request.round,
        status: request.status,
      })),
      reports: current.coordination.reports.map((report) => ({
        reportId: report.reportId,
        requestId: report.requestId,
        findingCount: report.findings.length,
        unresolved: report.unresolved,
      })),
      reviews: current.coordination.reviews.map((review) => ({
        reviewId: review.reviewId,
        reportId: review.reportId,
        decision: review.decision,
        gaps: review.gaps,
      })),
    };
  }

  function summary() {
    const value = status();
    if (!value) return "当前没有持久协作状态。";
    if ("error" in value && value.error) return `协作恢复失败（${value.error.code}）：${value.error.message}`;
    const workflowLink = value.workflowLink
      ? `${value.workflowLink.workflowId}/${value.workflowLink.planVersion}/${value.workflowLink.recoveryGeneration}`
      : "无";
    return `协作 ${value.coordinationId} · ${value.phase} · workflowLink ${workflowLink} · 请求 ${value.requests.map((request) => `${request.questionId}:${request.status}`).join("，") || "无"} · handoff ${value.handoff?.phase ?? "无"}`;
  }

  return { status, summary };
}
