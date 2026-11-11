import { isBashToolResult, isEditToolResult, isPowerShellToolResult, isReadToolResult, isWriteToolResult, type ExtensionContext, type ToolResultEvent, type ToolResultEventResult } from "@earendil-works/pi-coding-agent";
import { FILE_REVIEW_THRESHOLD, normalizeReviewPath } from "../src/file-review.ts";
import type { IncrementalReviewCandidate } from "../src/review-incremental.ts";
import { verifyNativeRead } from "./file-review-read.ts";
import { branchEntryIds, type FileReviewSession } from "./file-review-session.ts";

export const STRUCTURE_REVIEW_GUIDANCE = "行数只标记候选，不等于本次任务必须审阅。明确局部、低风险且不改变职责结构的展示默认值/文案调整，不必仅因行数触发全文件读取或新增结构审阅；候选保持未审。新增职责、跨模块耦合、结构复杂度变化、用户明确要求或验收确需时再审阅，不能借小改动掩盖结构问题。";

function formatIncrementalCandidate(candidate: IncrementalReviewCandidate) {
  return `[结构] ${candidate.file.path} · ${candidate.file.lineCount} 行 · version ${candidate.file.fingerprint}`;
}

export function incrementalNotice(candidates: readonly IncrementalReviewCandidate[]) {
  if (candidates.length === 0) return undefined;
  return `[pi-init 增量审阅候选]\n${candidates.map(formatIncrementalCandidate).join("\n")}\n${STRUCTURE_REVIEW_GUIDANCE}`;
}

/** Attributes native tool results to the owning session and current original-text version. */
export function createFileReviewObserver(sessions: FileReviewSession) {
  const { refreshSpecificFile, scanCurrent, candidateQueue, unnotifiedCandidates, markNotified } = sessions;

  async function handleReadResult(
    event: Extract<ToolResultEvent, { toolName: "read" }>,
    ctx: ExtensionContext,
  ): Promise<ToolResultEventResult | undefined> {
    const owner = sessions.getState();
    if (event.isError || !owner || typeof event.input.path !== "string") return undefined;
    if (!normalizeReviewPath(owner.projectRoot, event.input.path).ok) return undefined;
    const refreshed = await refreshSpecificFile(ctx, event.input.path);
    if (!refreshed.ok) {
      return appendToolNotice(event, `[pi-init 大文件审阅] 文件读取状态未确认 ${refreshed.code}：${refreshed.message}`);
    }
    const current = refreshed.file;
    const truncation = event.details?.truncation;
    const start = Number.isInteger(event.input.offset) && Number(event.input.offset) > 0 ? Number(event.input.offset) : 1;
    const requestedLimit = Number.isInteger(event.input.limit) && Number(event.input.limit) > 0
      ? Number(event.input.limit)
      : truncation?.maxLines ?? 2000;
    const outputLines = truncation?.outputLines ?? Math.min(requestedLimit, current.lineCount - start + 1);
    const partialLines = truncation?.lastLinePartial ? 1 : 0;
    const currentSession = sessions.getState();
    if (!currentSession) return undefined;
    const branchIds = branchEntryIds(ctx);
    const end = Math.min(current.lineCount, start + outputLines - partialLines - 1);
    if (current.lineCount > FILE_REVIEW_THRESHOLD) {
      const returnedText = event.content.filter(part => part.type === "text").map(part => part.text).join("\n");
      const verified = await verifyNativeRead(currentSession.projectRoot, current, start, end, returnedText);
      if (!sessions.isCurrent(currentSession, ctx, branchIds)) return undefined;
      if (!verified.ok) return appendToolNotice(event, `[pi-init 大文件审阅] ${verified.code}：${verified.message}`);
    } else if (!sessions.isCurrent(currentSession, ctx, branchIds)) return undefined;
    sessions.recordRead(currentSession, current, start, end);
    const notices = unnotifiedCandidates(currentSession, candidateQueue(currentSession));
    const notice = incrementalNotice(notices);
    if (!notice) return undefined;
    const result = appendToolNotice(event, notice);
    markNotified(currentSession, notices);
    return result;
  }

  async function handleToolResult(event: ToolResultEvent, ctx: ExtensionContext) {
    if (isReadToolResult(event)) return handleReadResult(event, ctx);
    const isMutationOrShell = isEditToolResult(event) || isWriteToolResult(event)
      || isBashToolResult(event) || isPowerShellToolResult(event);
    const owner = sessions.getState();
    if (!isMutationOrShell || !owner) return undefined;

    const isDirectFileTool = isEditToolResult(event) || isWriteToolResult(event);
    if (isDirectFileTool && typeof event.input.path === "string"
      && !normalizeReviewPath(owner.projectRoot, event.input.path).ok) return undefined;
    const result = isDirectFileTool && typeof event.input.path === "string"
      ? await refreshSpecificFile(ctx, event.input.path)
      : await scanCurrent(ctx, [], true);
    if (!result.ok && result.code !== "PARTIAL_SCAN") {
      return appendToolNotice(event, `[pi-init 大文件审阅] 扫描失败 ${result.code}：${result.message}；状态未标记为已审。`);
    }
    const notices: string[] = [];
    if (!result.ok) notices.push(`[pi-init 大文件审阅] 扫描不完整：${result.message}；候选列表可能不完整。`);
    const current = sessions.getState();
    const queue = current ? candidateQueue(current) : undefined;
    const incrementalCandidates = current ? unnotifiedCandidates(current, queue) : [];
    const incremental = incrementalNotice(incrementalCandidates);
    if (incremental) notices.push(incremental);
    if (notices.length === 0) return undefined;
    const output = appendToolNotice(event, notices.join("\n\n"));
    if (current && incrementalCandidates.length > 0) markNotified(current, incrementalCandidates);
    return output;
  }

  function appendToolNotice(event: ToolResultEvent, notice: string) {
    const nextContent = [...event.content, { type: "text" as const, text: notice }];
    return event.structuredContent === undefined
      ? { content: nextContent }
      : { content: nextContent, structuredContent: event.structuredContent };
  }

  return handleToolResult;
}
