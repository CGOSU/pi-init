import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FILE_REVIEW_THRESHOLD, type FileSnapshot } from "../src/file-review.ts";
import type { ReviewCandidate } from "../src/review-candidates.ts";
import type { ActiveRole } from "./runtime-state.ts";

const MAX_REPORT_FILES = 50;

export type LargeScanResult =
  | { ok: true; added: FileSnapshot[] }
  | { ok: false; code: string; message: string; added: FileSnapshot[] };

export type LargeReviewSnapshot = {
  generation: number;
  sessionId: string;
  files: FileSnapshot[];
  candidates: ReviewCandidate[];
  structuralConfirmed: boolean;
  testValueConfirmed: boolean;
  errors: Array<{ code: string; path: string; message: string }>;
};

type LargeCommandDependencies = {
  scan: (ctx: ExtensionContext) => Promise<LargeScanResult>;
  getSnapshot: () => LargeReviewSnapshot | undefined;
  getActiveRole: (ctx: ExtensionContext) => ActiveRole | undefined;
  roleRecoveryPending: () => boolean;
  canReview: () => boolean;
  getDispatchBlockReason: (ctx: ExtensionContext) => string | undefined;
};

function scanReport(snapshot: LargeReviewSnapshot, complete: boolean, reason?: string) {
  const structuralCandidates = snapshot.candidates.filter((candidate) => candidate.structuralReviewPending);
  const valueCandidates = snapshot.candidates.filter((candidate) => candidate.testValueReviewPending);
  const pendingKeys = new Set(structuralCandidates.map((candidate) => `${candidate.file.path}\u0000${candidate.file.fingerprint}`));
  const structuralLabel = snapshot.structuralConfirmed ? "结构待审" : "已发现结构候选（状态未确认）";
  const valueLabel = snapshot.testValueConfirmed ? "测试价值待审" : "已发现价值候选（状态未确认）";
  const lines = [complete
    ? `扫描完成：发现 ${snapshot.files.length} 个超过 ${FILE_REVIEW_THRESHOLD} 行的代码文件，${structuralLabel} ${structuralCandidates.length} 个版本，${valueLabel} ${valueCandidates.length} 个版本。`
    : `扫描不完整：${reason ?? "结果可能不完整"}；以下只列出已发现内容，未启动审阅。`];
  if (!snapshot.structuralConfirmed) lines.push("结构审阅状态无法确认；不能据此断言没有结构候选。");
  if (!snapshot.testValueConfirmed) lines.push("测试价值审阅状态无法确认；不能据此断言没有测试价值候选。");
  for (const file of snapshot.files.slice(0, MAX_REPORT_FILES)) {
    lines.push(`- ${file.path} · ${file.lineCount} 行${pendingKeys.has(`${file.path}\u0000${file.fingerprint}`) ? " · 结构待审" : ""}`);
  }
  if (snapshot.files.length > MAX_REPORT_FILES) {
    lines.push(`另有 ${snapshot.files.length - MAX_REPORT_FILES} 个超限文件未显示。`);
  }
  for (const candidate of structuralCandidates.slice(0, MAX_REPORT_FILES)) {
    lines.push(`- [结构] ${candidate.file.path} · ${candidate.file.lineCount} 行 · fingerprint ${candidate.file.fingerprint}`);
  }
  if (structuralCandidates.length > MAX_REPORT_FILES) {
    lines.push(`另有 ${structuralCandidates.length - MAX_REPORT_FILES} 个结构候选通过 file_review(action="list") 分页获取。`);
  }
  for (const candidate of valueCandidates.slice(0, MAX_REPORT_FILES)) {
    const invalidations = candidate.testValueInvalidations.length > 0
      ? ` · 失效原因 ${candidate.testValueInvalidations.map((item) => `${item.code}${item.path ? `(${item.path})` : ""}`).join(", ")}`
      : "";
    lines.push(`- [测试价值] ${candidate.file.path} · fingerprint ${candidate.file.fingerprint}${invalidations}`);
  }
  if (valueCandidates.length > MAX_REPORT_FILES) {
    lines.push(`另有 ${valueCandidates.length - MAX_REPORT_FILES} 个价值候选通过 file_review(action="list") 分页获取。`);
  }
  if (snapshot.candidates.length === 0 && complete && snapshot.structuralConfirmed && snapshot.testValueConfirmed) {
    lines.push("结构与测试价值两维均已确认；没有当前版本待审候选。");
  }
  if (snapshot.errors.length > 0) {
    for (const error of snapshot.errors.slice(0, 10)) {
      lines.push(`- [${error.code}] ${error.path || "."}: ${error.message}`);
    }
    if (snapshot.errors.length > 10) lines.push(`另有 ${snapshot.errors.length - 10} 个审阅/扫描错误未显示。`);
  }
  return lines.join("\n");
}

function reviewRequest(snapshot: LargeReviewSnapshot, ctx: ExtensionContext, deps: LargeCommandDependencies) {
  const role = deps.getActiveRole(ctx)?.role ?? "未确认";
  const roleReady = role === "developer-test" && deps.canReview();
  const roleRecoveryPending = deps.roleRecoveryPending();
  const structuralCandidates = snapshot.candidates.filter((candidate) => candidate.structuralReviewPending);
  const valueCandidates = snapshot.candidates.filter((candidate) => candidate.testValueReviewPending);
  const listedStructural = structuralCandidates.slice(0, MAX_REPORT_FILES).map((candidate) =>
    `- ${candidate.file.path} · ${candidate.file.lineCount} 行 · fingerprint ${candidate.file.fingerprint}`,
  );
  const listedValue = valueCandidates.slice(0, MAX_REPORT_FILES).map((candidate) => {
    const invalidations = candidate.testValueInvalidations.length > 0
      ? ` · 需重新审阅：${candidate.testValueInvalidations.map((item) => `${item.code}${item.path ? `(${item.path})` : ""}`).join(", ")}`
      : "";
    return `- ${candidate.file.path} · fingerprint ${candidate.file.fingerprint}${invalidations}`;
  });
  if (structuralCandidates.length > MAX_REPORT_FILES) {
    listedStructural.push(`- 其余 ${structuralCandidates.length - MAX_REPORT_FILES} 个结构候选通过 file_review(action="list") 分页获取。`);
  }
  if (valueCandidates.length > MAX_REPORT_FILES) {
    listedValue.push(`- 其余 ${valueCandidates.length - MAX_REPORT_FILES} 个价值候选通过 file_review(action="list") 分页获取。`);
  }
  return [
    "用户通过 /large 明确启动了一次审阅请求。只完成建议，不修改、拆分或重构任何被审阅文件，不运行测试，不创建例行 task_workflow。",
    `本次扫描完整；结构待审 ${structuralCandidates.length} 项，测试价值待审 ${valueCandidates.length} 项。`,
    "结构候选：",
    ...(listedStructural.length > 0 ? listedStructural : ["- 无"]),
    "测试价值候选：",
    ...(listedValue.length > 0 ? listedValue : ["- 无"]),
    `当前匹配职责：${role}；职责恢复待确认：${roleRecoveryPending ? "是" : "否"}。`,
    roleReady
      ? "当前 developer-test 职责与恢复状态已确认；直接开始局部审阅，不重复 switch_role。"
      : "局部审阅先按公共 pi-init-role-routing Skill 确认并切换到 developer-test，再读取源码；若为 manual 模式，停止并请用户执行 /pi-init role developer-test，不要反复调用 switch_role。恢复门未确认时必须先完成角色确认，不得绕过。",
    "结构审阅：完整读取当前文件版本，结合职责和维护边界给出有理由的 keep 或 recommend-split；仅在完整读取后用当前 fingerprint 调用 file_review(action=\"complete\")。行数不是拆分要求。",
    "测试价值审阅：对每个测试显式给出 implementationPaths；完整读取测试及关联实现的当前版本后，用 reviewKind=\"test-value\" 调用 file_review(action=\"complete\") 并记录 keep/merge/rewrite/remove 建议。建议仅供审阅，不自动删除、合并或重写测试。",
    "如果判断涉及跨模块职责、公共契约、共享状态或依赖方向，不自行作架构决策：切换到 docs-commit 核对最新实现、直接调用方和测试并形成结构化证据，再交 architect 决策。architect 只思考和决策，不读取源码、不调用 file_review；决策后切回适当的非 architect 角色，在满足完整读取与 fingerprint 校验后登记结论。",
    "不因任何建议而自动实施；如需实际修改，等待用户提出独立实现请求。",
  ].join("\n");
}

export function registerLargeCommand(pi: ExtensionAPI, deps: LargeCommandDependencies) {
  let handlerInFlight = false;
  let activeReview: { sessionId: string; generation: number } | undefined;

  function clearActiveReview() {
    activeReview = undefined;
  }

  pi.on("session_start", clearActiveReview);
  pi.on("session_shutdown", clearActiveReview);
  pi.on("session_tree", clearActiveReview);
  pi.on("agent_settled", (_event, ctx) => {
    if (activeReview?.sessionId === ctx.sessionManager.getSessionId()) clearActiveReview();
  });

  pi.registerCommand("large", {
    description: "扫描结构与测试价值候选，并主动启动待审阅项的建议审阅",
    handler: async (args, ctx) => {
      if (args.trim()) return ctx.ui.notify("用法：/large", "warning");
      if (handlerInFlight) return ctx.ui.notify("/large 正在扫描或启动审阅；没有重复派发。", "warning");
      const initial = deps.getSnapshot();
      if (!initial) return ctx.ui.notify("当前 Pi session 尚未完成大文件扫描。", "warning");

      handlerInFlight = true;
      let dispatchedReview: { sessionId: string; generation: number } | undefined;
      try {
        const result = await deps.scan(ctx);
        const current = deps.getSnapshot();
        if (!current) return ctx.ui.notify("大文件扫描失败：当前 Pi session 已变化。", "error");
        if (
          current.sessionId !== initial.sessionId ||
          current.generation !== initial.generation ||
          ctx.sessionManager.getSessionId() !== initial.sessionId
        ) {
          return ctx.ui.notify("扫描期间 Pi session 已变化；未启动审阅。", "warning");
        }
        if (!result.ok) {
          return ctx.ui.notify(scanReport(current, false, result.message), "warning");
        }

        if (activeReview?.sessionId === current.sessionId && activeReview.generation === current.generation) {
          return ctx.ui.notify(`${scanReport(current, true)}\n已有 /large 审阅请求正在处理；没有重复派发。`, "info");
        }
        if (!current.structuralConfirmed || !current.testValueConfirmed) {
          return ctx.ui.notify(`${scanReport(current, true)}\n未启动审阅：至少一个候选维度无法确认；先解决上列状态错误。`, "warning");
        }
        if (current.candidates.length === 0) {
          return ctx.ui.notify(scanReport(current, true), "info");
        }

        const blocked = deps.getDispatchBlockReason(ctx);
        if (blocked) return ctx.ui.notify(`${scanReport(current, true)}\n未启动审阅：${blocked}`, "warning");
        if (!ctx.isIdle()) return ctx.ui.notify(`${scanReport(current, true)}\nAgent 正忙；未启动或排队审阅。`, "warning");

        dispatchedReview = { sessionId: current.sessionId, generation: current.generation };
        activeReview = dispatchedReview;
        try {
          await pi.sendUserMessage(reviewRequest(current, ctx, deps));
        } catch (error) {
          if (activeReview === dispatchedReview) clearActiveReview();
          const message = error instanceof Error ? error.message : String(error);
          return ctx.ui.notify(`${scanReport(current, true)}\n启动审阅失败：${message}`, "error");
        }
        ctx.ui.notify(`${scanReport(current, true)}\n已启动主动审阅。`, "info");
      } catch (error) {
        if (dispatchedReview && activeReview === dispatchedReview) clearActiveReview();
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`大文件扫描或审阅启动失败：${message}`, "error");
      } finally {
        handlerInFlight = false;
      }
    },
  });
}