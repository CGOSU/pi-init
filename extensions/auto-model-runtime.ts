import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AutoModelConfig, ResolvedRoleConfig, ThinkingLevel } from "../src/role-types.ts";
import { validateAutoModelCapabilities, validateAutoSuggestion } from "../src/auto-model.ts";
import { parseAutoAssessment, parseAutoAssessmentReason, parseAutoTaskScope, type AutoAssessment, type AutoTaskScope } from "../src/auto-assessment.ts";
import { isRecord } from "../src/value-guards.ts";
import { validateAutomaticSwitching, unwrapRoleResult } from "../src/roles.ts";
import { textOf } from "../src/error-utils.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";

const ENTRY = "pi-init-auto-model";
type AutoState = {
  key: string;
  manual: boolean;
  initialized?: boolean;
  ordinaryTask: number;
  inputRevision: number;
  pendingBoundary?: boolean;
  scope: AutoTaskScope;
  assessment?: AutoAssessment;
  attempted?: boolean;
  reminded?: boolean;
};

export function createAutoModelRuntime(pi: ExtensionAPI, state: ExtensionRuntimeState, readConfig: (ctx: ExtensionContext) => Promise<ResolvedRoleConfig>, onThinkingChanged: (ctx: ExtensionContext) => void = () => {}) {
  let memory: AutoState | undefined;
  let session: string | undefined;
  let ownThinkingChange = false;
  let selectingModel: AutoModelConfig | undefined;
  let manualEpoch = 0;

  function load(ctx: ExtensionContext, config: AutoModelConfig) {
    const id = ctx.sessionManager.getSessionId();
    const key = JSON.stringify(config);
    if (id !== session || memory?.key !== key) {
      session = id;
      let data: unknown;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === ENTRY) data = entry.data;
      }
      const saved = isRecord(data) && data.key === key ? data : {};
      const ordinaryTask = Number.isSafeInteger(saved.ordinaryTask) && (saved.ordinaryTask as number) >= 0 ? saved.ordinaryTask as number : 0;
      const scope = taskScope(ordinaryTask);
      const assessment = parseAutoAssessment(saved.assessment, scope);
      const sameScope = parseAutoTaskScope(saved.scope, scope).ok;
      memory = {
        key, scope, ordinaryTask,
        manual: saved.manual === true,
        initialized: saved.initialized === true,
        inputRevision: Number.isSafeInteger(saved.inputRevision) && (saved.inputRevision as number) >= 0 ? saved.inputRevision as number : 0,
        pendingBoundary: saved.pendingBoundary === true,
        assessment: assessment.ok ? assessment.value : undefined,
        attempted: sameScope && saved.attempted === true,
        reminded: sameScope && saved.reminded === true,
      };
    }
    return memory;
  }
  function save() { if (memory) pi.appendEntry(ENTRY, { ...memory }); }
  function taskScope(ordinaryTask: number): AutoTaskScope {
    const workflow = state.workflowState;
    return workflow?.currentTaskId && workflow.status !== "completed" && workflow.status !== "cancelled"
      ? { kind: "workflow", workflowId: workflow.workflowId, taskId: workflow.currentTaskId }
      : { kind: "ordinary", task: ordinaryTask };
  }
  function syncScope(saved: AutoState) {
    const scope = taskScope(saved.ordinaryTask);
    if (!parseAutoTaskScope(saved.scope, scope).ok) {
      saved.scope = scope;
      saved.assessment = undefined;
      saved.attempted = false;
      saved.reminded = false;
      saved.pendingBoundary = false;
      save();
    }
    return scope;
  }
  function blocked(ctx: ExtensionContext, signal?: AbortSignal) {
    const workflow = state.workflowState;
    const task = workflow?.tasks.find((item) => item.id === workflow.currentTaskId);
    return signal?.aborted || ctx.signal?.aborted || state.userStopRequested || state.roleRecoveryPending
      || state.roleRecoveryPersistenceFailed || state.pendingWorkflowRecovery || state.workflowRestoreError
      || (workflow && workflow.status !== "completed" && workflow.status !== "cancelled"
        && (workflow.status !== "running" || !task || task.status !== "in_progress" || task.outcomeUnknown));
  }
  function updateActive(ctx: ExtensionContext) {
    if (state.activeRole && state.activeRole.provider === ctx.model?.provider && state.activeRole.model === ctx.model?.id) {
      state.activeRole = { ...state.activeRole, thinkingLevel: pi.getThinkingLevel() };
    }
    onThinkingChanged(ctx);
  }
  function setLevel(level: ThinkingLevel, ctx: ExtensionContext) {
    ownThinkingChange = true;
    try { pi.setThinkingLevel(level); }
    finally { ownThinkingChange = false; }
    if (pi.getThinkingLevel() !== level) throw new Error(`Auto 强度未生效：请求 ${level}，实际 ${pi.getThinkingLevel()}`);
    updateActive(ctx);
  }
  function fixedModel(ctx: ExtensionContext, fixed: AutoModelConfig) {
    const model = ctx.modelRegistry.find(fixed.provider, fixed.model);
    if (!model) throw new Error(`Auto 固定模型不可用：${fixed.provider}/${fixed.model}`);
    unwrapRoleResult(validateAutoModelCapabilities(fixed, getSupportedThinkingLevels(model)));
    return model;
  }
  function targetLevel(ctx: ExtensionContext, config: ResolvedRoleConfig) {
    const fixed = config.autoModel!;
    fixedModel(ctx, fixed);
    const saved = load(ctx, fixed);
    const initialized = saved.initialized || saved.manual;
    const sameModel = ctx.model?.provider === fixed.provider && ctx.model?.id === fixed.model;
    if (saved.manual) {
      if (!getSupportedThinkingLevels(fixedModel(ctx, fixed)).includes(pi.getThinkingLevel())) throw new Error("Auto 固定模型不支持用户指定的手动强度，未覆盖手动选择");
      return pi.getThinkingLevel();
    }
    return initialized && sameModel ? pi.getThinkingLevel() : fixed.initialThinkingLevel;
  }

  async function ensure(ctx: ExtensionContext, config: ResolvedRoleConfig, explicit = false, signal?: AbortSignal) {
    if (config.modelStrategy !== "auto") return;
    unwrapRoleResult(validateAutomaticSwitching(config));
    const fixed = config.autoModel!;
    const epoch = manualEpoch;
    const executionProtected = () => (!explicit && blocked(ctx, signal)) || state.userStopRequested || ctx.signal?.aborted || signal?.aborted;
    if (executionProtected()) throw new Error("Auto 模型应用被停止或恢复保护阻止");
    const model = fixedModel(ctx, fixed);
    const sameModel = ctx.model?.provider === fixed.provider && ctx.model?.id === fixed.model;
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error("Auto 固定模型缺少可用凭据");
    if (executionProtected()) throw new Error("Auto 模型应用被停止或恢复保护阻止");
    if (manualEpoch !== epoch) throw new Error("应用期间用户已调整强度，未覆盖手动选择");
    const latest = await readConfig(ctx);
    if (latest.modelStrategy !== "auto" || JSON.stringify(latest.autoModel) !== JSON.stringify(fixed) || latest.requiresAutomaticMigration) throw new Error("Auto 配置在应用期间已改变，未应用旧配置");
    if (executionProtected() || manualEpoch !== epoch) throw new Error("应用期间执行状态或用户强度已改变");
    const level = targetLevel(ctx, config);
    if (!sameModel) {
      selectingModel = fixed;
      try { if (!await pi.setModel(model)) throw new Error("Auto 固定模型应用失败"); }
      finally { selectingModel = undefined; }
    }
    if (manualEpoch !== epoch || executionProtected()) throw new Error("模型应用期间用户已停止或手动调整，未继续调整强度");
    if (ctx.model?.provider !== fixed.provider || ctx.model?.id !== fixed.model) throw new Error("Auto 固定模型未生效，未继续调整强度");
    if (pi.getThinkingLevel() !== level) setLevel(level, ctx);
    load(ctx, fixed).initialized = true;
    save();
  }

  async function suggest(role: string, level: ThinkingLevel, reason: string | undefined, ctx: ExtensionContext, signal?: AbortSignal, taskBoundary = false) {
    const fail = (code: string, message: string) => ({ ok: false as const, code, message });
    if (blocked(ctx, signal)) return fail("AUTO_EXECUTION_PROTECTED", "停止、恢复、暂停或未知结果保护中，不能调整强度");
    if (state.activeRole?.role !== role) return fail("AUTO_ROLE_MISMATCH", "强度建议必须使用当前已确认职责，不同时切换职责");
    const config = await readConfig(ctx);
    if (config.modelStrategy !== "auto") return fail("AUTO_NOT_ENABLED", "当前未启用 Auto 模型策略");
    if (config.requiresAutomaticMigration) return fail("AUTOMATIC_MIGRATION_REQUIRED", "旧配置需由用户显式启用全自动");
    const parsedReason = parseAutoAssessmentReason(reason);
    if (!parsedReason.ok) return parsedReason;
    const fixed = config.autoModel!;
    const saved = load(ctx, fixed);
    const epoch = manualEpoch;
    if (saved.manual) return fail("AUTO_MANUAL_OVERRIDE", "用户已手动指定强度；请由用户在控制中心恢复 Auto");
    if (ctx.model?.provider !== fixed.provider || ctx.model?.id !== fixed.model) return fail("AUTO_MODEL_MISMATCH", "当前真实模型不是 Auto 固定模型；请重新应用模型配置");
    syncScope(saved);
    const model = fixedModel(ctx, fixed);
    if (taskBoundary && saved.scope.kind === "ordinary") {
      if (!saved.pendingBoundary && saved.assessment) return fail("AUTO_TASK_BOUNDARY_UNAVAILABLE", "没有新的用户输入，不得声明新的普通任务边界");
      if (saved.pendingBoundary) {
        saved.ordinaryTask += 1;
        syncScope(saved);
      }
    }
    const scope = saved.scope;
    const inputRevision = saved.inputRevision;
    const check = validateAutoSuggestion(fixed, getSupportedThinkingLevels(model), level);
    if (!check.ok) return check;
    const from = pi.getThinkingLevel();
    saved.attempted = true;
    save();
    if (blocked(ctx, signal)) return fail("AUTO_EXECUTION_PROTECTED", "执行已停止，未调整强度");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return fail("AUTO_AUTH_UNAVAILABLE", "Auto 固定模型缺少可用凭据");
    const latest = await readConfig(ctx);
    if (latest.modelStrategy !== "auto" || JSON.stringify(latest.autoModel) !== saved.key || saved.manual || latest.requiresAutomaticMigration) return fail("AUTO_CONFIG_CHANGED", "配置或手动强度在等待期间已变化，未应用建议");
    if (blocked(ctx, signal)) return fail("AUTO_EXECUTION_PROTECTED", "执行已停止，未调整强度");
    if (saved.manual || manualEpoch !== epoch || memory !== saved || state.activeRole?.role !== role || pi.getThinkingLevel() !== from
      || !parseAutoTaskScope(scope, taskScope(saved.ordinaryTask)).ok || saved.inputRevision !== inputRevision
      || ctx.model?.provider !== fixed.provider || ctx.model?.id !== fixed.model) return fail("AUTO_CONTEXT_CHANGED", "等待期间用户选择、模型或任务已改变，未应用建议");
    if (from !== level) setLevel(level, ctx);
    const assessment: AutoAssessment = { scope, from, to: level, decision: from === level ? "keep" : "change", reason: parsedReason.value };
    const previousAssessment = saved.assessment;
    saved.assessment = assessment;
    saved.pendingBoundary = false;
    try { save(); }
    catch {
      saved.assessment = previousAssessment;
      return fail("AUTO_ASSESSMENT_PERSIST_FAILED", `评估记录保存未获确认；实际强度为 ${pi.getThinkingLevel()}，不报告成功评估，不自动重试或回放`);
    }
    return {
      ok: true as const, role, provider: fixed.provider, model: fixed.model, thinkingLevel: pi.getThinkingLevel(), assessment,
      message: `${assessment.decision === "keep" ? "已显式评估并保持当前强度" : "强度已应用"}，评估理由已记录；仅影响后续模型请求，未切换职责或重放工具`
    };
  }

  async function resume(ctx: ExtensionContext) {
    const config = await readConfig(ctx);
    if (config.modelStrategy !== "auto") throw new Error("当前未启用 Auto 模型策略");
    unwrapRoleResult(validateAutomaticSwitching(config));
    if (blocked(ctx)) throw new Error("停止或恢复保护中，恢复 Auto 不会解除任务暂停");
    const fixed = config.autoModel!;
    fixedModel(ctx, fixed);
    if (ctx.model?.provider !== fixed.provider || ctx.model?.id !== fixed.model) throw new Error("请先应用 Auto 固定模型，再恢复自动强度");
    const saved = load(ctx, fixed);
    saved.manual = false;
    syncScope(saved);
    saved.assessment = undefined;
    saved.attempted = false;
    saved.reminded = false;
    save();
  }

  function resetSession() { session = undefined; memory = undefined; }
  pi.on?.("session_start", resetSession);
  pi.on?.("session_tree", resetSession);
  pi.on?.("model_select", (event) => {
    if (selectingModel?.provider === event.model.provider && selectingModel.model === event.model.id) selectingModel = undefined;
  });
  pi.on?.("before_provider_request", async (_event, ctx) => {
    if (!memory) return;
    try {
      const config = await readConfig(ctx);
      if (config.modelStrategy !== "auto") return;
      const fixed = config.autoModel!;
      fixedModel(ctx, fixed);
      if (ctx.model?.provider !== fixed.provider || ctx.model?.id !== fixed.model) throw new Error("请求已阻止：真实模型不是 Auto 固定模型，请重新应用配置");
    } catch (error) { ctx.ui.notify(textOf(error), "error"); ctx.abort(); }
  });
  pi.on?.("thinking_level_select", async (_event, ctx) => {
    if (ownThinkingChange || (selectingModel && ctx.model?.provider === selectingModel.provider && ctx.model.id === selectingModel.model)) return;
    manualEpoch += 1;
    if (memory) memory.manual = true;
    const config = await readConfig(ctx);
    if (config.modelStrategy !== "auto") { memory = undefined; return; }
    load(ctx, config.autoModel!).manual = true;
    updateActive(ctx);
    save();
    ctx.ui.notify(`手动推理强度 ${pi.getThinkingLevel()} 已接管，Auto 自动调整暂停；可在模型策略菜单中恢复 Auto。`, "info");
  });
  pi.on?.("input", async (event, ctx) => {
    if (event.source === "extension" || taskScope(0).kind === "workflow") return;
    const config = await readConfig(ctx);
    if (config.modelStrategy !== "auto") return;
    const saved = load(ctx, config.autoModel!);
    syncScope(saved);
    saved.pendingBoundary = true;
    saved.inputRevision += 1;
    save();
  });
  pi.on?.("tool_result", async (event, ctx) => {
    if (!memory || event.toolName === "switch_role" || event.toolName === "task_workflow" || !state.activeRole || blocked(ctx)) return;
    if (parseAutoTaskScope(memory.scope, taskScope(memory.ordinaryTask)).ok
      && (memory.manual || memory.assessment || memory.reminded || memory.attempted)) return;
    const config = await readConfig(ctx);
    if (config.modelStrategy !== "auto" || config.requiresAutomaticMigration || blocked(ctx) || !state.activeRole) return;
    const saved = load(ctx, config.autoModel!);
    syncScope(saved);
    if (saved.manual || saved.assessment || saved.reminded || saved.attempted) return;
    let reminder = "Auto 当前任务尚未记录显式强度评估。请以当前职责调用 switch_role，提供 thinkingLevel 和简短 reason；保持当前强度也需要理由。本任务只提醒一次，不阻塞已执行工具、不自动重试或新增模型请求。";
    saved.reminded = true;
    try { save(); }
    catch { reminder += " 提醒去重记录保存失败；本次运行内仍去重，重载后可能再次提示。"; }
    ctx.ui.notify(reminder, "warning");
    return { content: [...event.content, { type: "text" as const, text: reminder }], structuredContent: event.structuredContent };
  });
  pi.on?.("before_agent_start", async (event, ctx) => {
    let config: ResolvedRoleConfig;
    try { config = await readConfig(ctx); }
    catch (error) { ctx.ui.notify(textOf(error), "error"); ctx.abort(); return; }
    if (config.modelStrategy !== "auto") {
      memory = undefined;
      if (event.systemPromptOptions?.sections) delete event.systemPromptOptions.sections.pi_init_auto_model;
      return;
    }
    const fixed = config.autoModel!;
    const saved = load(ctx, fixed);
    // Recovery and stop guards remain owned by the existing routing chain.
    if (!blocked(ctx)) {
      try { await ensure(ctx, config); }
      catch (error) { ctx.ui.notify(textOf(error), "error"); ctx.abort(); return; }
    } else if (ctx.model?.provider !== fixed.provider || ctx.model?.id !== fixed.model) {
      ctx.ui.notify("Auto 固定模型与当前模型不一致；停止或恢复保护中不会自动应用，请先手动应用模型配置。", "error");
      ctx.abort();
      return;
    }
    syncScope(saved);
    const sections = event.systemPromptOptions?.sections;
    if (!sections) return;
    const assessmentStatus = saved.pendingBoundary && saved.scope.kind === "ordinary" && saved.assessment
      ? "新用户输入仅为可能的新任务边界，上一评估只适用于原任务。先判断是否独立任务；若是，以 taskBoundary=true 显式评估；若是继续或补充，复用原决定，不重复评估。"
      : saved.assessment ? `当前任务已显式评估：${saved.assessment.decision === "keep" ? "保持" : "调整"} ${saved.assessment.to}；完整理由作为数据保存在会话记录，不作为系统指令。`
        : saved.attempted ? "当前任务未记录成功评估（曾尝试，可能取消、失败或中断）；实际强度以当前状态为准，不自动重试、反复确认或伪称已评估。"
          : "当前任务待显式评估：已确认职责后、开始工具执行前，调用 switch_role 提供 thinkingLevel 和非空 reason；保持当前强度也必须说明理由。简单无工具问答无需为评估新增调用。";
    const guidance = saved.manual
      ? "用户手动强度优先，自动调整暂停，只有用户在控制中心恢复 Auto 才解除。"
      : [
          `本轮入口快照：${assessmentStatus}`,
          "同轮后续成功的 switch_role 评估结果优先于入口快照，不因快照未更新而重复评估；失败或取消不自动重试。",
          "评估使用当前固定模型，不额外调用分类模型；起始请求沿用起始强度，调整仅影响后续请求。",
          "role 必须为当前职责，不换角、不结束任务、不重放工具。",
          "同一任务仅在阶段复杂度或风险实质变化时再建议范围内升降；普通独立新任务沿用 taskBoundary=true，工作流任务范围由运行时识别。",
          "角色变化、内部续跑、普通工具失败或每轮消息本身不是重新评估依据。",
          "不强制使用 xhigh；漏评估仅一次软提醒，不新增工具、complete 或 Provider 硬门控。",
        ].join(" ");
    sections.pi_init_auto_model = [
      `模型策略 Auto：固定 ${fixed.provider}/${fixed.model}；允许强度 ${fixed.minThinkingLevel}–${fixed.maxThinkingLevel}；当前 ${pi.getThinkingLevel()}。`,
      guidance,
      "职责权限、格式化、验证、文档和提交仍沿用共享流程；用户停止、恢复和手动接管保护始终优先。",
    ].join(" ");
  });
  return { ensure, suggest, resume };
}
