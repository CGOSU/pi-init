import { checkCoordinationReadiness } from "../src/coordination.ts";
import type { CoordinationState } from "../src/coordination-types.ts";
import type { CoordinationReadiness } from "../src/coordination-types.ts";

export function checkCoordinationWorkflowReadiness(coordination: CoordinationState): CoordinationReadiness {
  const readiness = checkCoordinationReadiness(coordination);
  if (!readiness.ok) return readiness;
  const acceptedKeys = new Set(readiness.value.acceptedEvidence.map((item) =>
    `${item.findingId}\0${item.sourceId}\0${item.sourceVersion}`));
  const latestByQuestion = new Map<string, CoordinationState["requests"][number]>();
  for (const request of coordination.requests) latestByQuestion.set(request.questionId, request);
  for (const request of latestByQuestion.values()) {
    if (request.status !== "accepted") continue;
    const report = coordination.reports.find((item) => item.requestId === request.requestId);
    const review = report && coordination.reviews.find((item) => item.reportId === report.reportId);
    const staleEvidence = review?.acceptedEvidence.filter((item) =>
      !acceptedKeys.has(`${item.findingId}\0${item.sourceId}\0${item.sourceVersion}`)) ?? [];
    if (staleEvidence.length > 0) {
      return {
        ok: false,
        code: "COORDINATION_EVIDENCE_VERSION_STALE",
        message: `问题 ${request.questionId} 的来源版本已变化，必须重新核实后才能派发开发`,
      };
    }
  }
  return readiness;
}
