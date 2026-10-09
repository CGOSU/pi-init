import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ActivityStatusOperation, ActivityStatusReporter } from "./activity-status.ts";

const TOOL_START_DELAY_MS = 140;
const TOOL_UPDATE_DELAY_MS = 50;
const TOOL_ERROR_DURATION_MS = 3_000;
const RETIRED_TOOL_ID_LIMIT = 256;

type ActiveTool = {
  category: string;
  startedAt: number;
  generation: number;
};

type ActivityLifecycleOptions = {
  now?: () => number;
  startDelayMs?: number;
  updateDelayMs?: number;
  toolErrorDurationMs?: number;
};

function toolCategory(toolName: string) {
  switch (toolName) {
    case "read": return "读取文件";
    case "write":
    case "edit": return "修改文件";
    case "bash": return "执行命令";
    case "find":
    case "grep":
    case "ls": return "搜索文件";
    default: return "调用工具";
  }
}

export function createActivityLifecycle(
  pi: ExtensionAPI,
  activityStatus: ActivityStatusReporter,
  options: ActivityLifecycleOptions = {},
) {
  const now = options.now ?? Date.now;
  const startDelayMs = options.startDelayMs ?? TOOL_START_DELAY_MS;
  const updateDelayMs = options.updateDelayMs ?? TOOL_UPDATE_DELAY_MS;
  const toolErrorDurationMs = options.toolErrorDurationMs ?? TOOL_ERROR_DURATION_MS;
  const tools = new Map<string, ActiveTool>();
  const retiredToolIds = new Set<string>();
  let generation = 0;
  let provider: Extract<ActivityStatusOperation, { kind: "provider" }> | undefined;
  let pendingOperationTimer: ReturnType<typeof setTimeout> | undefined;
  let alertTimer: ReturnType<typeof setTimeout> | undefined;
  let shownOperationSignature: string | undefined;
  let alertRevision = 0;

  function rememberRetiredToolId(toolCallId: string) {
    retiredToolIds.add(toolCallId);
    while (retiredToolIds.size > RETIRED_TOOL_ID_LIMIT) {
      const oldest = retiredToolIds.values().next().value;
      if (oldest === undefined) break;
      retiredToolIds.delete(oldest);
    }
  }

  function clearPendingOperationTimer() {
    if (pendingOperationTimer) clearTimeout(pendingOperationTimer);
    pendingOperationTimer = undefined;
  }

  function clearAlert(ctx?: ExtensionContext) {
    alertRevision += 1;
    if (alertTimer) clearTimeout(alertTimer);
    alertTimer = undefined;
    if (ctx) activityStatus.setAlert(ctx, undefined);
  }

  function currentOperation(): ActivityStatusOperation | undefined {
    if (tools.size > 0) {
      const active = [...tools.values()].filter((tool) => tool.generation === generation);
      if (active.length === 0) return undefined;
      const categories = new Set(active.map(({ category }) => category));
      return {
        kind: "tool",
        label: categories.size === 1 ? active[0].category : "工具执行",
        count: active.length,
        startedAt: Math.min(...active.map(({ startedAt }) => startedAt)),
      };
    }
    return provider;
  }

  function publishOperation(ctx: ExtensionContext) {
    const operation = currentOperation();
    if (!operation) {
      clearPendingOperationTimer();
      if (shownOperationSignature !== undefined) {
        shownOperationSignature = undefined;
        activityStatus.setOperation(ctx, undefined);
      }
      return;
    }

    const signature = JSON.stringify(operation);
    if (signature === shownOperationSignature || pendingOperationTimer) return;
    const scheduledGeneration = generation;
    const delay = shownOperationSignature === undefined ? startDelayMs : updateDelayMs;
    pendingOperationTimer = setTimeout(() => {
      pendingOperationTimer = undefined;
      if (generation !== scheduledGeneration) return;
      const current = currentOperation();
      if (!current) return;
      const currentSignature = JSON.stringify(current);
      if (currentSignature === shownOperationSignature) return;
      shownOperationSignature = currentSignature;
      activityStatus.setOperation(ctx, current);
    }, delay);
    pendingOperationTimer.unref?.();
  }

  function reportToolError(ctx: ExtensionContext, category: string) {
    clearAlert();
    const revision = alertRevision;
    activityStatus.setAlert(ctx, {
      text: category === "调用工具" ? "⚠ 工具调用失败" : `⚠ ${category}失败`,
      tone: "error",
    });
    alertTimer = setTimeout(() => {
      if (revision !== alertRevision) return;
      alertTimer = undefined;
      activityStatus.setAlert(ctx, undefined);
    }, toolErrorDurationMs);
    alertTimer.unref?.();
  }

  function clearOperations(ctx: ExtensionContext) {
    generation += 1;
    clearPendingOperationTimer();
    for (const toolCallId of tools.keys()) rememberRetiredToolId(toolCallId);
    tools.clear();
    provider = undefined;
    shownOperationSignature = undefined;
    activityStatus.setOperation(ctx, undefined);
    clearAlert(ctx);
  }

  pi.on("before_provider_request", (_event, ctx) => {
    provider = { kind: "provider", phase: "request", startedAt: now() };
    publishOperation(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    if (!provider || event.message?.role !== "assistant") return;
    const type = event.assistantMessageEvent?.type;
    if (!type || !["text_delta", "thinking_delta", "toolcall_delta"].includes(type)) return;
    if (provider.phase === "streaming") return;
    provider = { ...provider, phase: "streaming" };
    publishOperation(ctx);
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant" || !provider) return;
    provider = undefined;
    publishOperation(ctx);
  });

  pi.on("tool_execution_start", (event, ctx) => {
    const { toolCallId, toolName } = event;
    if (retiredToolIds.has(toolCallId) || tools.has(toolCallId)) return;
    tools.set(toolCallId, { category: toolCategory(toolName), startedAt: now(), generation });
    publishOperation(ctx);
  });

  pi.on("tool_execution_end", (event, ctx) => {
    const active = tools.get(event.toolCallId);
    if (!active) {
      retiredToolIds.delete(event.toolCallId);
      return;
    }
    if (active.generation !== generation) return;
    tools.delete(event.toolCallId);
    if (event.isError) reportToolError(ctx, active.category);
    publishOperation(ctx);
  });

  pi.on("agent_start", (_event, ctx) => clearOperations(ctx));
  pi.on("agent_settled", (_event, ctx) => clearOperations(ctx));
  pi.on("session_start", (_event, ctx) => clearOperations(ctx));
  pi.on("session_tree", (_event, ctx) => clearOperations(ctx));
  pi.on("session_shutdown", (_event, ctx) => clearOperations(ctx));
  pi.on("model_select", (_event, ctx) => clearOperations(ctx));

  return { clear: clearOperations };
}

export function registerActivityLifecycle(pi: ExtensionAPI, activityStatus: ActivityStatusReporter) {
  return createActivityLifecycle(pi, activityStatus);
}
