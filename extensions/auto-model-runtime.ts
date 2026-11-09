import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { AutoModelConfig, ResolvedRoleConfig, ThinkingLevel } from "../src/role-types.ts";
import { validateAutoModelCapabilities, validateAutoSuggestion } from "../src/auto-model.ts";
import { unwrapRoleResult } from "../src/roles.ts";
import { textOf } from "../src/error-utils.ts";
import type { ExtensionRuntimeState } from "./runtime-state.ts";
import { showMenu } from "./ui.ts";

const ENTRY = "pi-init-auto-model";
type AutoState = { key: string; manual: boolean; assessed: boolean; initialized?: boolean; task?: string; pendingBoundary?: boolean };

export function createAutoModelRuntime(pi: ExtensionAPI, state: ExtensionRuntimeState, readConfig: (ctx: ExtensionContext) => Promise<ResolvedRoleConfig>, onThinkingChanged: (ctx: ExtensionContext) => void = () => {}) {
  let memory: AutoState | undefined;
  let session: string | undefined;
  let ownThinkingChange = false;
  let selectingModel: AutoModelConfig | undefined;
  let manualEpoch = 0;

  function load(ctx: ExtensionContext, config: AutoModelConfig) {
    const id = ctx.sessionManager.getSessionId();
    const key = JSON.stringify(config);
    if (id !== session) {
      session = id;
      memory = undefined;
      for (const entry of ctx.sessionManager.getBranch()) {
        if (entry.type === "custom" && entry.customType === ENTRY) memory = entry.data as AutoState;
      }
    }
    if (memory?.key !== key) memory = { key, manual: false, assessed: false };
    return memory;
  }
  function save() { if (memory) pi.appendEntry(ENTRY, { ...memory }); }
  function mode(config: ResolvedRoleConfig) { return state.sessionModeOverride ?? config.mode; }
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

  async function ensure(ctx: ExtensionContext, config: ResolvedRoleConfig, explicit = false) {
    if (config.modelStrategy !== "auto") return;
    const fixed = config.autoModel!;
    const requestedLevel = targetLevel(ctx, config);
    const epoch = manualEpoch;
    const stoppedAtStart = state.userStopRequested || ctx.signal?.aborted;
    const model = fixedModel(ctx, fixed);
    const sameModel = ctx.model?.provider === fixed.provider && ctx.model?.id === fixed.model;
    if ((!sameModel || pi.getThinkingLevel() !== requestedLevel) && !explicit) {
      if (mode(config) === "manual") throw new Error("Auto 固定模型尚未应用；手动模式请执行 /pi-init role <role>");
      if (mode(config) === "confirm") {
        if (!ctx.hasUI || await showMenu(ctx, "应用 Auto 固定模型？", [{ value: "accept", label: `${fixed.provider}/${fixed.model}` }, { value: "cancel", label: "取消" }]) !== "accept") throw new Error("已取消应用 Auto 固定模型");
      }
      if (blocked(ctx)) throw new Error("Auto 模型应用被停止或恢复保护阻止");
    }
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) throw new Error("Auto 固定模型缺少可用凭据");
    if (!explicit && blocked(ctx)) throw new Error("Auto 模型应用被停止或恢复保护阻止");
    if (manualEpoch !== epoch) throw new Error("应用期间用户已调整强度，未覆盖手动选择");
    const latest = await readConfig(ctx);
    if (latest.modelStrategy !== "auto" || JSON.stringify(latest.autoModel) !== JSON.stringify(fixed) || mode(latest) !== mode(config)) throw new Error("Auto 配置在应用期间已改变，未应用旧配置");
    if ((!explicit && blocked(ctx)) || manualEpoch !== epoch) throw new Error("应用期间执行状态或用户强度已改变");
    const level = targetLevel(ctx, config);
    if (!sameModel) {
      selectingModel = fixed;
      try { if (!await pi.setModel(model)) throw new Error("Auto 固定模型应用失败"); }
      finally { selectingModel = undefined; }
    }
    if (manualEpoch !== epoch || (!stoppedAtStart && (state.userStopRequested || ctx.signal?.aborted))) throw new Error("模型应用期间用户已停止或手动调整，未继续调整强度");
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
    if (!reason?.trim()) return fail("AUTO_REASON_MISSING", "请提供基于任务复杂度或风险的调档理由");
    const fixed = config.autoModel!;
    const saved = load(ctx, fixed);
    const epoch = manualEpoch;
    if (saved.manual) return fail("AUTO_MANUAL_OVERRIDE", "用户已手动指定强度；请由用户在控制中心恢复 Auto");
    if (ctx.model?.provider !== fixed.provider || ctx.model?.id !== fixed.model) return fail("AUTO_MODEL_MISMATCH", "当前真实模型不是 Auto 固定模型；请重新应用模型配置");
    const task = state.workflowState?.currentTaskId;
    if (saved.task !== task) { saved.task = task; saved.assessed = false; }
    const model = fixedModel(ctx, fixed);
    if (taskBoundary && !task && saved.assessed && !saved.pendingBoundary) return fail("AUTO_TASK_BOUNDARY_UNAVAILABLE", "没有新的用户输入，不得声明新的普通任务边界");
    const check = validateAutoSuggestion(fixed, getSupportedThinkingLevels(model), level);
    if (!check.ok) return check;
    if (mode(config) === "manual") return fail("AUTO_MANUAL_MODE", "手动切换方式下不自动调整强度；请手动选择或改为自动/确认方式");
    if (pi.getThinkingLevel() !== level && mode(config) === "confirm") {
      if (!ctx.hasUI || await showMenu(ctx, `Auto 建议强度 ${level}`, [{ value: "accept", label: "采用建议", description: reason }, { value: "cancel", label: "取消" }]) !== "accept") return fail("AUTO_CANCELLED", "已取消强度建议，实际强度未改变");
    }
    if (blocked(ctx, signal)) return fail("AUTO_EXECUTION_PROTECTED", "确认期间执行已停止，未调整强度");
    const latest = await readConfig(ctx);
    if (latest.modelStrategy !== "auto" || JSON.stringify(latest.autoModel) !== saved.key || saved.manual || mode(latest) !== mode(config)) return fail("AUTO_CONFIG_CHANGED", "配置或手动强度在确认期间已变化，请重新评估");
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) return fail("AUTO_AUTH_UNAVAILABLE", "Auto 固定模型缺少可用凭据");
    if (blocked(ctx, signal)) return fail("AUTO_EXECUTION_PROTECTED", "执行已停止，未调整强度");
    if (saved.manual || manualEpoch !== epoch || memory !== saved || state.activeRole?.role !== role || state.workflowState?.currentTaskId !== task
      || ctx.model?.provider !== fixed.provider || ctx.model?.id !== fixed.model) return fail("AUTO_CONTEXT_CHANGED", "等待期间用户选择、模型或任务已改变，未应用建议");
    setLevel(level, ctx);
    saved.assessed = true;
    saved.pendingBoundary = false;
    save();
    return { ok: true as const, role, provider: fixed.provider, model: fixed.model, thinkingLevel: pi.getThinkingLevel(), message: "强度已应用，仅影响后续模型请求；未切换职责或重放工具" };
  }

  async function resume(ctx: ExtensionContext) {
    const config = await readConfig(ctx);
    if (config.modelStrategy !== "auto") throw new Error("当前未启用 Auto 模型策略");
    if (blocked(ctx)) throw new Error("停止或恢复保护中，恢复 Auto 不会解除任务暂停");
    const fixed = config.autoModel!;
    fixedModel(ctx, fixed);
    if (ctx.model?.provider !== fixed.provider || ctx.model?.id !== fixed.model) throw new Error("请先应用 Auto 固定模型，再恢复自动强度");
    const saved = load(ctx, fixed);
    saved.manual = false;
    saved.assessed = false;
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
    if (event.source === "extension" || state.workflowState?.currentTaskId) return;
    const config = await readConfig(ctx);
    if (config.modelStrategy !== "auto") return;
    load(ctx, config.autoModel!).pendingBoundary = true;
    save();
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
    const task = state.workflowState?.currentTaskId;
    if (saved.task !== task) { saved.task = task; saved.assessed = false; save(); }
    const sections = event.systemPromptOptions?.sections;
    if (!sections) return;
    sections.pi_init_auto_model = `模型策略 Auto：固定 ${fixed.provider}/${fixed.model}；允许强度 ${fixed.minThinkingLevel}–${fixed.maxThinkingLevel}；当前 ${pi.getThinkingLevel()}。${saved.manual ? "用户手动强度优先，自动调整暂停，只有用户在控制中心恢复 Auto 才解除。" : "在已确认职责后按任务复杂度和风险评估强度：调用 switch_role，role 为当前职责，同时提供 thinkingLevel 和非空 reason；这是调档建议，不是换角，不需结束当前任务。首次判断用起始强度，调整仅影响后续请求。同一任务内可按当前阶段复杂度和风险在允许范围内升降强度，无需声明新任务边界；普通会话仅在新的用户输入确实引入独立任务时传 taskBoundary=true，继续、补充说明和普通消息不是新任务；工作流边界由运行时确定。角色变化、普通工具失败或每轮消息本身不是调档依据。不额外调用分类模型。"} 职责权限、格式化、验证、文档和提交仍沿用共享流程。切换方式 ${mode(config)}；manual 不自动应用强度。`;
  });
  return { ensure, suggest, resume, validate: (ctx: ExtensionContext, config: ResolvedRoleConfig) => fixedModel(ctx, config.autoModel!) };
}
