import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { FILE_REVIEW_THRESHOLD, type FileSnapshot } from "../src/file-review.ts";
import type { ActiveRole } from "./runtime-state.ts";

const MAX_REPORT_FILES = 50;

export type LargeScanResult =
  | { ok: true; added: FileSnapshot[] }
  | { ok: false; code: string; message: string; added: FileSnapshot[] };

export type LargeReviewSnapshot = {
  generation: number;
  sessionId: string;
  files: FileSnapshot[];
  candidates: FileSnapshot[];
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
  const pendingKeys = new Set(snapshot.candidates.map((file) => `${file.path}\u0000${file.fingerprint}`));
  const lines = [complete
    ? `扫描完成：发现 ${snapshot.files.length} 个超过 ${FILE_REVIEW_THRESHOLD} 行的代码文件，${snapshot.candidates.length} 个待审版本。`
    : `扫描不完整：${reason ?? "结果可能不完整"}；以下只列出已发现内容，未启动审阅。`];
  for (const file of snapshot.files.slice(0, MAX_REPORT_FILES)) {
    lines.push(`- ${file.path} · ${file.lineCount} 行${pendingKeys.has(`${file.path}\u0000${file.fingerprint}`) ? " · 待审" : ""}`);
  }
  if (snapshot.files.length > MAX_REPORT_FILES) {
    lines.push(`另有 ${snapshot.files.length - MAX_REPORT_FILES} 个超限文件未显示。`);
  }
  if (snapshot.candidates.length === 0 && complete) lines.push("没有当前版本待审的文件。");
  if (!complete) {
    for (const error of snapshot.errors.slice(0, 10)) {
      lines.push(`- [${error.code}] ${error.path || "."}: ${error.message}`);
    }
    if (snapshot.errors.length > 10) lines.push(`另有 ${snapshot.errors.length - 10} 个扫描错误未显示。`);
  }
  return lines.join("\n");
}

function reviewRequest(snapshot: LargeReviewSnapshot, ctx: ExtensionContext, deps: LargeCommandDependencies) {
  const role = deps.getActiveRole(ctx)?.role ?? "未确认";
  const roleReady = role === "developer-test" && deps.canReview();
  const roleRecoveryPending = deps.roleRecoveryPending();
  const listedCandidates = snapshot.candidates.slice(0, MAX_REPORT_FILES).map((file) =>
    `- ${file.path} · ${file.lineCount} 行 · fingerprint ${file.fingerprint}`,
  );
  if (snapshot.candidates.length > MAX_REPORT_FILES) {
    listedCandidates.push(`- 其余 ${snapshot.candidates.length - MAX_REPORT_FILES} 个候选通过 file_review(action="list") 分页获取。`);
  }
  return [
    "用户通过 /large 明确启动了一次大文件结构审阅。只完成审阅结论，不修改、拆分或重构源码，不运行测试，不创建例行 task_workflow。",
    `本次扫描完整；当前项目有 ${snapshot.candidates.length} 个超过 ${FILE_REVIEW_THRESHOLD} 行且当前内容版本未审的候选：`,
    ...listedCandidates,
    `当前匹配职责：${role}；职责恢复待确认：${roleRecoveryPending ? "是" : "否"}。`,
    roleReady
      ? "当前 developer-test 职责与恢复状态已确认；直接开始局部审阅，不重复 switch_role。"
      : "局部审阅先按公共 pi-init-role-routing Skill 确认并切换到 developer-test，再读取源码；若为 manual 模式，停止并请用户执行 /pi-init role developer-test，不要反复调用 switch_role。恢复门未确认时必须先完成角色确认，不得绕过。",
    "逐个完整读取当前文件版本，结合实际职责、直接调用关系和维护边界给出 keep 或 recommend-split 的理由；仅在完整读取后调用 file_review(action=\"complete\")，使用该工具最新 fingerprint。行数不是拆分要求。",
    "如果判断涉及跨模块职责、公共契约、共享状态或依赖方向，不自行作架构决策：切换到 docs-commit 核对最新实现、直接调用方和测试并形成结构化证据，再交 architect 决策。architect 只思考和决策，不读取源码、不调用 file_review；决策后切回适当的非 architect 角色，在满足完整读取与 fingerprint 校验后登记结论。",
    "不因建议拆分而自动实施；如需实际修改，等待用户提出独立实现请求。",
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
    description: "扫描大文件并主动启动待审候选的结构审阅",
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