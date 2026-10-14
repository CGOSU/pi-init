import type { CoordinationRuntimeState } from "../src/coordination-runtime-types.ts";
import type { EvidenceRequest } from "../src/coordination-types.ts";
import {
  coordinationError,
  coordinationHandoffIdentity,
  COORDINATION_EVIDENCE_MESSAGE_TYPE,
  COORDINATION_REVIEW_MESSAGE_TYPE,
} from "./coordination-runtime-protocol.ts";

function acceptedFindingSummaries(
  current: CoordinationRuntimeState,
  questionId: string,
  excludeRequestId?: string,
) {
  const reports = current.coordination.reports.filter((report) => report.requestId !== excludeRequestId
    && current.coordination.requests.some((request) => request.requestId === report.requestId && request.questionId === questionId));
  const summaries = new Map<string, string>();
  for (const report of reports) {
    const review = current.coordination.reviews.find((item) => item.reportId === report.reportId);
    if (review?.decision !== "accept") continue;
    for (const reference of review.acceptedEvidence) {
      const finding = report.findings.find((item) => item.findingId === reference.findingId
        && item.classification === "fact"
        && item.sources.some((source) => source.id === reference.sourceId && source.version === reference.sourceVersion));
      if (!finding) continue;
      summaries.set(JSON.stringify([reference.findingId, reference.sourceId, reference.sourceVersion]),
        `${finding.statement}（${reference.findingId} · ${reference.sourceId}@${reference.sourceVersion}）`);
    }
  }
  return [...summaries.values()];
}

function previousReviewGaps(current: CoordinationRuntimeState, request: EvidenceRequest) {
  if (!request.followUpOfRequestId) return [];
  const report = current.coordination.reports.find((item) => item.requestId === request.followUpOfRequestId);
  const review = report && current.coordination.reviews.find((item) => item.reportId === report.reportId);
  return review?.decision === "more" ? review.gaps : [];
}

export function compileCoordinationMessage(current: CoordinationRuntimeState) {
  const handoff = current.handoff;
  if (!handoff) throw coordinationError("COORDINATION_HANDOFF_MISSING", "协作状态缺少活动 handoff");
  const identity = coordinationHandoffIdentity(current);
  if (!identity) throw coordinationError("COORDINATION_HANDOFF_IDENTITY_MISSING", "协作状态缺少 handoff identity");
  const request = current.coordination.requests.find((item) => item.requestId === handoff.requestId);
  if (!request) throw coordinationError("COORDINATION_HANDOFF_REQUEST_MISMATCH", "协作 handoff 找不到对应请求");
  const report = handoff.reportId
    ? current.coordination.reports.find((item) => item.reportId === handoff.reportId)
    : undefined;
  const priorAcceptedFacts = acceptedFindingSummaries(current, request.questionId, request.requestId);
  const priorGaps = previousReviewGaps(current, request);
  if (handoff.kind === "evidence") {
    return {
      customType: COORDINATION_EVIDENCE_MESSAGE_TYPE,
      identity,
      content: [
        "[PI-INIT 证据取证交接]",
        `当前协作 handoff 短引用（report-evidence 时按原样传回 coordinationHandoffId）：${handoff.handoffId}`,
        `问题 ID：${request.questionId}`,
        `待回答问题：${request.question}`,
        `取证理由：${request.rationale}`,
        `限定范围：${request.scope.map((item) => `- ${item}`).join("\n")}`,
        request.exclusions.length ? `排除范围：${request.exclusions.map((item) => `- ${item}`).join("\n")}` : "",
        `完成条件：${request.completionCriteria.map((item) => `- ${item}`).join("\n")}`,
        request.addressesGaps.length ? `需回应的先前缺口：${request.addressesGaps.map((item) => `- ${item}`).join("\n")}` : "",
        priorGaps.length ? `上一轮 architect 指出的缺口：${priorGaps.map((item) => `- ${item}`).join("\n")}` : "",
        priorAcceptedFacts.length ? `本问题先前已接受事实（历史来源版本，须按本轮范围重新核实）：${priorAcceptedFacts.map((item) => `\n- ${item}`).join("")}` : "",
        "你是受派发的 docs-commit 取证角色。当前交接包只包含本问题和相关历史事实，不得推断完整协作账本。核对最新实现、直接调用方和相关测试；报告必须区分 fact/inference/unconfirmed/conflict，并给每条发现附来源 location 与当前版本。测试源码已定位与实际执行验证分开填写；没有运行的测试不得声称通过。不要代替 architect 接受证据、决定业务方案或派发开发。",
        `完成后调用 task_workflow(action=\"report-evidence\", coordinationHandoffId="${handoff.handoffId}", report={...})。一次报告后停止；若证据不完整，明确列出未确认项。若报告输入校验失败，可在同一有效 handoff 内修正后重提，不要新建 attempt、重复取证或复用已消费身份。`,
      ].filter(Boolean).join("\n\n"),
    };
  }
  if (!report) throw coordinationError("COORDINATION_REPORT_NOT_FOUND", "架构审阅 handoff 缺少报告");
  const review = current.coordination.reviews.find((item) => item.reportId === report.reportId);
  return {
    customType: COORDINATION_REVIEW_MESSAGE_TYPE,
    identity,
    content: [
      "[PI-INIT 证据审阅交接]",
      `当前审阅 handoff 短引用（review-evidence 与后续 request-evidence 使用时按原样传回 coordinationHandoffId）：${handoff.handoffId}`,
      `问题 ${request.questionId}：${request.question}`,
      `取证范围：${request.scope.join("；")}`,
      `报告 ${report.reportId}：\n${report.findings.map((finding) => `- [${finding.classification}] ${finding.statement}；来源：${finding.sources.map((source) => `${source.location} @ ${source.version}`).join("，") || "未提供"}`).join("\n")}`,
      report.findings.some((finding) => finding.sources.length > 0)
        ? `可核对引用（findingId · sourceId · sourceVersion）：\n${report.findings.flatMap((finding) => finding.sources.map((source) => `- ${finding.findingId} · ${source.id} · ${source.version}（${finding.classification}）`)).join("\n")}`
        : "",
      priorAcceptedFacts.length ? `本问题之前已接受的事实：${priorAcceptedFacts.map((item) => `\n- ${item}`).join("")}` : "",
      `已检查范围：${report.inspectedScope.join("；")}`,
      report.testsLocated.length ? `已定位测试：${report.testsLocated.join("；")}` : "未列出测试位置。",
      report.testsRun.length ? `实际运行：${report.testsRun.map((result) => `${result.command} → ${result.result}`).join("；")}` : "报告未声称执行测试。",
      report.unresolved.length ? `未确认项：${report.unresolved.join("；")}` : "报告未列出未确认项。",
      review ? `当前最新审阅 decision：${review.decision}` : "该报告尚未审阅。",
      `你是 architect，只做证据审阅和架构决策。调用 task_workflow(action="review-evidence", coordinationHandoffId="${handoff.handoffId}", review={reportId, decision: accept|more|block, acceptedEvidence, gaps, reason})；从上方可核对引用中显式选择要接受的 fact。accept 必须逐条引用来源版本匹配的 fact，more 必须给出具体 gaps。若 decision=more，随后用同一短引用调用 request-evidence，设置 followUpOfRequestId 并明确 addressesGaps。不得执行取证、调用代码工具或派发开发；关键证据未接受前不得 plan。`,
    ].join("\n\n"),
  };
}
