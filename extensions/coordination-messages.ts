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
    const review = current.coordination.reviews.findLast((item) => item.reportId === report.reportId);
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
  const review = report && current.coordination.reviews.findLast((item) => item.reportId === report.reportId);
  return review?.decision === "more" ? review.gaps : [];
}

export function compileCoordinationMessage(current: CoordinationRuntimeState) {
  const handoff = current.handoff;
  if (!handoff) throw coordinationError("COORDINATION_HANDOFF_MISSING", "协作状态缺少活动 handoff");
  const identity = coordinationHandoffIdentity(current);
  if (!identity) throw coordinationError("COORDINATION_HANDOFF_IDENTITY_MISSING", "协作状态缺少 handoff identity");
  const request = current.coordination.requests.find((item) => item.requestId === handoff.requestId);
  if (!request) throw coordinationError("COORDINATION_HANDOFF_REQUEST_MISMATCH", "协作 handoff 找不到对应请求");
  const batchRequests = (handoff.requestIds && handoff.requestIds.length > 1
    ? handoff.requestIds
    : [request.requestId])
    .map((id) => current.coordination.requests.find((item) => item.requestId === id))
    .filter((item): item is EvidenceRequest => item !== undefined);
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
        "本消息由运行时派发给 docs-commit；本轮职责与身份由运行时确认和绑定。恢复门已解除且消息仍有效时，直接处理下列问题，不为确认重复 switch_role 或查询 status；若恢复或身份报错，按真实错误处理，不套用新身份。",
        `兼容短引用（本轮身份自动绑定，可省略）：coordinationHandoffId="${handoff.handoffId}"`,
        batchRequests.length > 1
          ? `本次为批量取证，共 ${batchRequests.length} 个问题；请在同一回合集中处理，可合并共享来源的重复核查，但必须分别按各请求的问题、范围和完成条件回答并报告：\n${batchRequests.map((item, index) => `${index + 1}. requestId ${item.requestId} / questionId ${item.questionId}\n   问题：${item.question}\n   理由：${item.rationale}\n   范围：${item.scope.join("；")}${item.exclusions.length ? `\n   排除：${item.exclusions.join("；")}` : ""}\n   完成条件：${item.completionCriteria.join("；")}${item.addressesGaps.length ? `\n   需回应的缺口：${item.addressesGaps.join("；")}` : ""}`).join("\n")}`
          : `问题 ID：${request.questionId}`,
        batchRequests.length > 1 ? "" : `待回答问题：${request.question}`,
        batchRequests.length > 1 ? "" : `取证理由：${request.rationale}`,
        batchRequests.length > 1 ? "" : `限定范围：${request.scope.map((item) => `- ${item}`).join("\n")}`,
        batchRequests.length > 1 ? "" : (request.exclusions.length ? `排除范围：${request.exclusions.map((item) => `- ${item}`).join("\n")}` : ""),
        batchRequests.length > 1 ? "" : `完成条件：${request.completionCriteria.map((item) => `- ${item}`).join("\n")}`,
        request.addressesGaps.length ? `需回应的先前缺口：${request.addressesGaps.map((item) => `- ${item}`).join("\n")}` : "",
        priorGaps.length ? `上一轮 architect 指出的缺口：${priorGaps.map((item) => `- ${item}`).join("\n")}` : "",
        priorAcceptedFacts.length ? `本问题先前已接受事实（历史来源版本；仅在来源版本、当前 revision 绑定、适用范围及既有失效规则均仍有效时复用，不一概重新核实。仅在来源/范围实际变化、失效规则触发、明确刷新理由或影响决策的关键缺口时针对性核查；无法确认有效性时如实标为未确认，不得视作当前事实）：${priorAcceptedFacts.map((item) => `\n- ${item}`).join("")}` : "",
        "先按问题定位相关符号、直接调用方和测试，再精读必要范围。需要项目记忆时定向读取当前状态，历史决策、会话记录和踩坑按关键词定位，不默认整批读取。当前上下文已有且仍有效的事实、来源版本、已读范围和实际验证连续复用，只补关键缺口；版本变化、上下文缺失或必要安全复核可重读，不把已读范围当作当前版本有效性的证明。报告用现有 inspectedScope 与来源 location/version 简要保留实际检查范围，不新增字段，不把未读内容或未执行验证计作已完成。",
        "你是受派发的 docs-commit 取证角色。当前交接包只包含本次请求和相关历史事实，不得推断完整协作账本。围绕各请求的决策关键问题，核查必要的最新实现、直接调用方和相关测试；仅当这些内容影响问题回答或为完成条件所必需时查阅。只复用已能从当前协调状态确认满足来源版本、当前 revision 绑定、适用范围及既有失效规则的已接受事实；仅在来源/范围实际变化、失效规则触发、明确刷新理由或决策关键缺口时针对性核查，不为确认每条历史事实而扩大取证。无法确认有效性的历史事实及非阻塞未知项如实标为 unconfirmed，不得作为当前事实或机械触发补证。报告必须区分 fact/inference/unconfirmed/conflict，并给每条发现附来源 location 与当前版本。测试源码已定位与实际执行验证分开填写；没有运行的测试不得声称通过。不要代替 architect 接受证据、决定业务方案或派发开发。",
        batchRequests.length > 1
          ? '每个问题核对完成后分别调用 task_workflow(action="report-evidence", report={requestId: 对应 requestId, ...})；身份由运行时绑定，全部报告完成后停止。'
          : '完成后调用 task_workflow(action="report-evidence", report={...})；身份由运行时绑定，报告缺口如实列出。输入校验失败可在当前有效交接内修正后重提，不重复取证。',
      ].filter(Boolean).join("\n\n"),
    };
  }
  if (!report) throw coordinationError("COORDINATION_REPORT_NOT_FOUND", "架构审阅 handoff 缺少报告");
  const reportReviews = current.coordination.reviews.filter((item) => item.reportId === report.reportId);
  const review = reportReviews.at(-1);
  const reopening = current.coordination.reviewReopenings.findLast((item) => item.reportId === report.reportId
    && !current.coordination.reviews.some((candidate) => candidate.reopeningId === item.reopeningId));
  const previousBlockReview = reopening
    ? current.coordination.reviews.find((item) => item.reviewId === reopening.previousReviewId)
    : undefined;
  return {
    customType: COORDINATION_REVIEW_MESSAGE_TYPE,
    identity,
    content: [
      "[PI-INIT 证据审阅交接]",
      "本消息由运行时派发给 architect；恢复门已解除且消息仍有效时，直接审阅下列报告，不为确认重复 switch_role 或查询 status。遇到真实身份或恢复错误仍按原门控处理。",
      `兼容短引用（本轮身份自动绑定，可省略）：coordinationHandoffId="${handoff.handoffId}"`,
      `问题 ${request.questionId}：${request.question}`,
      `取证范围：${request.scope.join("；")}`,
      handoff.reportIds && handoff.reportIds.length > 1
        ? `本次为批量取证结果，共 ${handoff.reportIds.length} 份报告：\n${handoff.reportIds.map((id) => {
            const item = current.coordination.reports.find((candidate) => candidate.reportId === id);
            if (!item) return `- ${id}（未找到报告）`;
            const owner = current.coordination.requests.find((candidate) => candidate.requestId === item.requestId);
            return `报告 ${item.reportId}（问题 ${owner?.questionId ?? item.requestId}）：\n${item.findings.map((finding) => `  - [${finding.classification}] ${finding.statement}；来源：${finding.sources.map((source) => `${source.location} @ ${source.version}`).join("，") || "未提供"}`).join("\n")}`;
          }).join("\n")}`
        : "",
      `报告 ${report.reportId}：\n${report.findings.map((finding) => `- [${finding.classification}] ${finding.statement}；来源：${finding.sources.map((source) => `${source.location} @ ${source.version}`).join("，") || "未提供"}`).join("\n")}`,
      report.findings.some((finding) => finding.sources.length > 0)
        ? `可核对引用（findingId · sourceId · sourceVersion）：\n${report.findings.flatMap((finding) => finding.sources.map((source) => `- ${finding.findingId} · ${source.id} · ${source.version}（${finding.classification}）`)).join("\n")}`
        : "",
      priorAcceptedFacts.length ? `本问题之前已接受的事实（仅在来源版本、当前 revision 绑定、适用范围及既有失效规则仍有效时复用；本轮出现实际变化或决策关键缺口时再针对性核查）：${priorAcceptedFacts.map((item) => `\n- ${item}`).join("")}` : "",
      reopening && previousBlockReview
        ? `本轮为显式重开审阅（不是新取证）；重开原因：${reopening.reason}\n此前阻塞审阅：${previousBlockReview.reviewId}（${previousBlockReview.reason ?? previousBlockReview.gaps.join("；")}）`
        : "",
      `已检查范围：${report.inspectedScope.join("；")}`,
      report.testsLocated.length ? `已定位测试：${report.testsLocated.join("；")}` : "未列出测试位置。",
      report.testsRun.length ? `实际运行：${report.testsRun.map((result) => `${result.command} → ${result.result}`).join("；")}` : "报告未声称执行测试。",
      report.unresolved.length ? `未确认项：${report.unresolved.join("；")}` : "报告未列出未确认项。",
      reopening
        ? "当前为重开后的待审阅轮次；此前审阅记录保留在账本中。"
        : review ? `当前最新审阅 decision：${review.decision}` : "该报告尚未审阅。",
      `你是 architect，只做证据审阅和架构决策。调用 task_workflow(action="review-evidence", review={reportId, decision: accept|more|block, acceptedEvidence, gaps, reason})；从上方可核对引用中显式选择要接受的 fact。accept 必须逐条引用来源版本匹配的 fact，more 必须给出具体 gaps。身份由本轮运行时绑定，无需填写。若 decision=more，随后调用 request-evidence，设置 followUpOfRequestId 并明确 addressesGaps。不得执行取证或调用代码工具；关键证据未接受前不得 plan。accept 后若原用户目标仍需实现，继续规划未完成任务，不要等待用户再次要求继续。`,
    ].join("\n\n"),
  };
}
