import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  ROLE_MODES,
  findMatchingRole,
  roleLabel,
} from "../src/roles.js";
import {
  WORKFLOW_MAX_TASKS,
  getWorkflowTask,
  isWorkflowActive,
  markWorkflowTaskStarted,
  appendWorkflowReplanDirection,
  requestWorkflowReplan,
  workflowProgress,
} from "../src/workflow.js";
import { completeRunTiming, createRunTiming, isExternalRunSource } from "../src/run-timing.js";
import { Text } from "@earendil-works/pi-tui";
import { createRoleRuntime } from "./role-runtime.ts";
import { createExtensionRuntimeState, textOf } from "./runtime-state.ts";
import { createWorkflowActions } from "./workflow-actions.ts";
import { createWorkflowDispatch, type WorkflowDispatch } from "./workflow-dispatch.ts";
import { createWorkflowMessages } from "./workflow-messages.ts";
import { createWorkflowReport } from "./workflow-report.ts";
import {
  initProjectParameters,
  switchRoleParameters,
  taskWorkflowParameters,
  type ResolvedRoleConfig,
  type RunTimingEntryData,
} from "./contracts.ts";
type ControlCenterModule = typeof import("./control-center.ts");
type ControlCenter = ReturnType<ControlCenterModule["createControlCenter"]>;
type ScaffoldRuntime = typeof import("./scaffold-runtime.ts");
type ScaffoldOutcome = Awaited<ReturnType<ScaffoldRuntime["runScaffold"]>>;

const RUN_TIMING_ENTRY_TYPE = "pi-init-run-timing";
export default function initProjectExtension(pi: ExtensionAPI) {
  const runtimeState = createExtensionRuntimeState();
  let pendingExternalRunSource: string | undefined;
  let acceptedExternalRunSource: string | undefined;
  let externalRunTiming: ReturnType<typeof createRunTiming>;
  let workflowDispatch: WorkflowDispatch;

  const workflowMessages = createWorkflowMessages(runtimeState, {
    pi,
    setInternalContinuationPending: (value) => {
      runtimeState.internalContinuationPending = value;
    },
  });
  const roleRuntime = createRoleRuntime(pi, runtimeState, {
    getWorkflowState: () => runtimeState.workflowState,
    setWorkflowDispatchInFlight: (value) => {
      runtimeState.workflowDispatchInFlight = value;
    },
    setInternalContinuationPending: (value) => {
      runtimeState.internalContinuationPending = value;
    },
    sendWorkflowTaskMessage: (ctx, taskId, note) => workflowMessages.sendWorkflowTaskMessage(ctx, taskId, note),
    scheduleWorkflow: (ctx) => workflowDispatch.scheduleWorkflow(ctx),
    sendWorkflowReplanMessage: (ctx) => workflowMessages.sendWorkflowReplanMessage(ctx),
  });
  const workflowReport = createWorkflowReport(runtimeState, { pi, roleRuntime });
  workflowDispatch = createWorkflowDispatch(runtimeState, {
    roleRuntime,
    messages: workflowMessages,
    report: workflowReport,
    getActiveTools: () => typeof pi.getActiveTools === "function" ? pi.getActiveTools() : [],
    setCurrentContext: (ctx) => {
      runtimeState.currentContext = ctx;
    },
  });
  const workflowActions = createWorkflowActions(runtimeState, {
    roleRuntime,
    dispatch: workflowDispatch,
    report: workflowReport,
  });
  let scaffoldRuntimePromise: Promise<ScaffoldRuntime> | undefined;
  let controlCenterPromise: Promise<ControlCenter> | undefined;

  function loadScaffoldRuntime() {
    return scaffoldRuntimePromise ??= import("./scaffold-runtime.ts");
  }

  function loadControlCenter() {
    return controlCenterPromise ??= import("./control-center.ts").then(({ createControlCenter }) =>
      createControlCenter({
        state: runtimeState,
        roleRuntime,
        quickInit: async (targetDir, ctx) => (await loadScaffoldRuntime()).quickInit(targetDir, ctx),
        advancedInit: async (targetDir, ctx) => (await loadScaffoldRuntime()).advancedInit(targetDir, ctx),
        getThinkingLevel: () => pi.getThinkingLevel(),
        workflowCommand: workflowActions.workflowCommand,
      }),
    );
  }

  function settleExternalRunTiming() {
    const timing = externalRunTiming;
    externalRunTiming = undefined;
    pendingExternalRunSource = undefined;
    acceptedExternalRunSource = undefined;
    if (!timing || (runtimeState.workflowState && isWorkflowActive(runtimeState.workflowState))) return;

    const completed = completeRunTiming(timing);
    if (completed) pi.appendEntry(RUN_TIMING_ENTRY_TYPE, completed);
  }

  pi.registerEntryRenderer<RunTimingEntryData>(RUN_TIMING_ENTRY_TYPE, (entry, _options, theme) => {
    const data = entry.data && typeof entry.data === "object"
      ? entry.data as RunTimingEntryData
      : {};
    return new Text(workflowReport.styleReportText(workflowReport.formatRunTimingReport(data), theme), 0, 0);
  });

  pi.on("model_select", async (event, ctx) => {
    runtimeState.currentContext = ctx;

    let config: ResolvedRoleConfig;
    try {
      config = await roleRuntime.readSessionRoleConfig(ctx);
    } catch {
      roleRuntime.refreshRoleStatus(ctx, runtimeState.roleModeStatus);
      return;
    }
    if (roleRuntime.isManualRoleMode(config)) {
      await roleRuntime.writeBackManualModelSelection(event, ctx, config);
    }
    roleRuntime.refreshRoleStatus(ctx, roleRuntime.effectiveRoleMode(config));
  });

  function captureWorkflowRevisionInput(
    event: { text?: unknown; source?: unknown },
    ctx: ExtensionContext,
  ) {
    if (
      !runtimeState.workflowState ||
      !["running", "replanning"].includes(runtimeState.workflowState.status) ||
      !isExternalRunSource(event.source) ||
      typeof event.text !== "string" ||
      !event.text.trim() ||
      event.text.trim().startsWith("/")
    ) return false;

    if (runtimeState.workflowState.pendingRevision) {
      const revision = runtimeState.workflowState.pendingRevision;
      try {
        const next = appendWorkflowReplanDirection(runtimeState.workflowState, event.text.trim());
        workflowReport.persistWorkflowState(next, ctx);
        ctx.ui.notify(
          `已将新指令合并到待处理 revision ${revision.revisionId}，将在任务边界交给架构师重规划。`,
          "info",
        );
      } catch (error) {
        ctx.ui.notify(`无法记录工作流方向变更：${textOf(error)}`, "warning");
      }
      return true;
    }

    try {
      const next = requestWorkflowReplan(runtimeState.workflowState, { direction: event.text.trim() });
      workflowReport.persistWorkflowState(next, ctx);
      ctx.ui.notify(
        next.currentTaskId
          ? `已记录工作流方向变更，将在当前任务 ${next.currentTaskId} 完成后交给架构师重规划。`
          : "已记录工作流方向变更，等待架构师重规划。",
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`无法记录工作流方向变更：${textOf(error)}`, "warning");
    }
    return true;
  }

  pi.on("input", async (event, ctx) => {
    if (typeof event.text === "string" && event.text.trim().startsWith("/")) {
      return { action: "continue" };
    }
    if (captureWorkflowRevisionInput(event, ctx)) return { action: "handled" };
    if (!isExternalRunSource(event.source)) return { action: "continue" };
    if (runtimeState.workflowState && isWorkflowActive(runtimeState.workflowState)) {
      pendingExternalRunSource = undefined;
      acceptedExternalRunSource = undefined;
      return { action: "continue" };
    }
    if (!externalRunTiming) pendingExternalRunSource = event.source;
    return { action: "continue" };
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (runtimeState.internalContinuationPending) {
      runtimeState.internalContinuationPending = false;
      pendingExternalRunSource = undefined;
      acceptedExternalRunSource = undefined;
      return;
    }
    if (!pendingExternalRunSource) return;
    if (externalRunTiming || (runtimeState.workflowState && isWorkflowActive(runtimeState.workflowState))) {
      pendingExternalRunSource = undefined;
      acceptedExternalRunSource = undefined;
      return;
    }
    acceptedExternalRunSource = pendingExternalRunSource;
    pendingExternalRunSource = undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    runtimeState.currentContext = ctx;
    runtimeState.internalContinuationPending = false;
    const source = acceptedExternalRunSource;
    acceptedExternalRunSource = undefined;
    pendingExternalRunSource = undefined;
    if (runtimeState.workflowState && isWorkflowActive(runtimeState.workflowState)) {
      externalRunTiming = undefined;
    } else if (!externalRunTiming && source) {
      externalRunTiming = createRunTiming(source);
    }

    if (
      !runtimeState.workflowState ||
      runtimeState.workflowState.executor === "subtask" ||
      !runtimeState.workflowState.currentTaskId ||
      !isWorkflowActive(runtimeState.workflowState)
    ) return;
    const task = getWorkflowTask(runtimeState.workflowState, runtimeState.workflowState.currentTaskId);
    if (!task || task.executionStartedAt !== undefined) return;
    workflowReport.persistWorkflowState(markWorkflowTaskStarted(runtimeState.workflowState, task.id), ctx);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    runtimeState.currentContext = ctx;
    settleExternalRunTiming();
    roleRuntime.startPendingRoleCompaction(ctx);
    await workflowDispatch.scheduleWorkflow(ctx);
  });

  pi.on("session_shutdown", async () => {
    runtimeState.runtimeDisposed = true;
    pendingExternalRunSource = undefined;
    acceptedExternalRunSource = undefined;
    externalRunTiming = undefined;
    runtimeState.internalContinuationPending = false;
    runtimeState.configuredRoleNames = [];
    runtimeState.currentContext = undefined;
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      runtimeState.runtimeDisposed = false;
      runtimeState.sessionRoleConfigOverrides = {};
      runtimeState.configuredRoleNames = [];
      const config = await roleRuntime.readSessionRoleConfig(ctx);
      runtimeState.currentContext = ctx;
      runtimeState.workflowModeStatus = config.workflowMode;
      runtimeState.workflowExecutorStatus = config.workflowExecutor;
      const role = findMatchingRole(config, ctx.model, pi.getThinkingLevel());
      runtimeState.activeRole = role && ctx.model
        ? {
            role,
            provider: ctx.model.provider,
            model: ctx.model.id,
            thinkingLevel: pi.getThinkingLevel(),
          }
        : undefined;
      workflowDispatch.restoreWorkflowState(ctx);
      roleRuntime.setRoleStatus(ctx, runtimeState.sessionModeOverride ?? config.mode);
      await workflowDispatch.scheduleWorkflow(ctx);
    } catch (error) {
      ctx.ui.notify(textOf(error), "error");
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    workflowDispatch.restoreWorkflowState(ctx);
    roleRuntime.refreshRoleStatus(ctx, runtimeState.roleModeStatus);
  });

  pi.registerCommand("pi-init", {
    description: "打开 Pi Init 控制中心：初始化项目、配置角色和切换模型",
    getArgumentCompletions: (prefix) => {
      const tokens = prefix.trim().split(/\s+/).filter(Boolean);
      if (tokens.length <= 1 && !prefix.endsWith(" ")) {
        const values = ["init", "advanced", "config", "save", "role", "mode", "workflow"];
        const matches = values.filter((value) => value.startsWith(tokens[0] ?? ""));
        return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
      }
      const action = tokens[0];
      const values = action === "role"
        ? runtimeState.configuredRoleNames
        : action === "config"
          ? [...runtimeState.configuredRoleNames, "workflow"]
          : action === "mode"
          ? ROLE_MODES
          : action === "workflow"
            ? ["status", "resume", "retry", "cancel"]
            : [];
      const partial = prefix.endsWith(" ") ? "" : tokens.at(-1) ?? "";
      const matches = values.filter((value) => value.startsWith(partial));
      return matches.length > 0 ? matches.map((value) => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const action = tokens.shift();
      try {
        if (!action) return (await loadControlCenter()).showControlCenter(ctx);
        if (action === "init") return (await loadScaffoldRuntime()).quickInit(tokens.join(" ") || ".", ctx);
        if (action === "advanced") return (await loadScaffoldRuntime()).advancedInit(tokens.join(" ") || ".", ctx);
        if (action === "config") return (await loadControlCenter()).configureRole(tokens[0], ctx);
        if (action === "save") return roleRuntime.saveRoleConfig(ctx);
        if (action === "role") return (await loadControlCenter()).switchRole(tokens[0], ctx);
        if (action === "mode") return (await loadControlCenter()).setSessionMode(tokens[0], ctx);
        if (action === "workflow") return workflowActions.workflowCommand(tokens.shift(), tokens.shift(), ctx);
        ctx.ui.notify("用法：/pi-init [init|advanced|config|save|role|mode|workflow] [参数]", "error");
      } catch (error) {
        ctx.ui.notify(textOf(error), "error");
      }
    },
  });

  pi.registerTool({
    name: "init_project",
    label: "Initialize Project",
    description:
      "Generate AGENTS.md, project memory docs, and .pi/role-models.json. The package-published pi-init-role-routing Skill provides shared role semantics; project AGENTS.md references it and no project-level role Skill is generated. AGENTS.md also records the host platform and command conventions detected during initialization. Existing generated files may be overwritten after confirmation.",
    promptSnippet: "Initialize project context files and use the package-published pi-init-role-routing Skill",
    promptGuidelines: [
      "Use init_project when the user asks to initialize a project with AI Coding collaboration context.",
      "Before calling init_project, inspect available project metadata and provide description and testCommand when known.",
      "init_project records the current Pi host platform in AGENTS.md; if the target runs in WSL, a container, or a remote environment, mention that difference and update the generated context.",
      "Use init_project with dryRun=true first when the target project may already contain generated files.",
    ],
    parameters: initProjectParameters,
    renderCall(args, theme) {
      const target = typeof args.targetDir === "string" ? args.targetDir : ".";
      return new Text(
        theme.fg("toolTitle", theme.bold("pi-init ")) + theme.fg("muted", `初始化 ${target}`),
        0,
        0,
      );
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as ScaffoldOutcome | undefined;
      if (!details || !Array.isArray(details.files)) return new Text(theme.fg("error", "初始化失败"), 0, 0);
      if (details.cancelled) return new Text(theme.fg("warning", "已取消初始化"), 0, 0);
      const prefix = details.dryRun ? "预览" : "已生成";
      const lines = [
        theme.fg("success", `✓ ${prefix} ${details.files.length} 个文件`),
        details.conflicts.length > 0
          ? theme.fg("warning", `覆盖 ${details.conflicts.length} 个已有文件`)
          : theme.fg("muted", "无文件冲突"),
      ];
      if (expanded) lines.push(...details.files.map((file) => theme.fg("dim", `  ${file}`)));
      return new Text(lines.join("\n"), 0, 0);
    },
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "已取消，没有写入文件。" }], details: {} };
      }

      const targetDir = params.targetDir ?? ".";
      const options = {
        projectName: params.projectName,
        description: params.description,
        language: params.language,
        testCommand: params.testCommand,
        dryRun: params.dryRun,
        roleModels: params.roleModels,
      };
      const scaffold = await loadScaffoldRuntime();
      const result = await scaffold.runScaffold(ctx, targetDir, options, "conflicts");
      const text = scaffold.formatResult(result);

      return {
        content: [{ type: "text", text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: "task_workflow",
    label: "Task Workflow",
    description:
      `Manage an architecture-led sequential task workflow with up to ${WORKFLOW_MAX_TASKS} tasks. The Architect creates an ordered plan, Development and Test Engineers complete one task at a time, and the next task starts automatically after verified completion. Pause only for an explicit architecture review or a real blocker.`,
    promptSnippet: "Create and advance an architecture-led sequential implementation task workflow",
    promptGuidelines: [
      "Use task_workflow action=plan only after the Architect has inspected the repository and frozen the plan, constraints, files, dependencies, and acceptance criteria.",
      "The project workflowMode defaults to auto: a valid plan with one or two tasks returns a bypass notice without creating state or scheduling; continue those tasks directly in order. Use on when orchestration is required for a small plan.",
      "Set reviewRequired=true only when the user's initial request explicitly asks to inspect the architecture before implementation; otherwise leave it false so the workflow advances automatically without asking for choices.",
      "Use task_workflow action=complete only after the current task is actually implemented and verified; include real commands and results in verification.",
      "Use task_workflow action=block for missing requirements, permissions, credentials, destructive-operation approval, product decisions, or unrecoverable failures; do not mark an uncertain task complete.",
      "When a task completes, the workflow automatically switches to its assigned role and starts the next ready task unless a pending revision exists; with a pending revision, wait for the Architect to call action=replan before any old or new future task starts.",
      "Only the Architect may call action=replan. Use the exact revisionId from the hidden replan prompt, keep valid unfinished tasks with retainTaskIds, and use new IDs for added tasks.",
    ],
    parameters: taskWorkflowParameters,
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "...";
      const taskCount = Array.isArray(args.tasks) ? ` · ${args.tasks.length} 个任务` : "";
      return new Text(theme.fg("toolTitle", theme.bold("工作流 ")) + theme.fg("muted", `${action}${taskCount}`), 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      if (result.isError) return new Text(theme.fg("error", "工作流操作失败"), 0, 0);
      const firstContent = result.content[0];
      const contentText = firstContent?.type === "text" ? firstContent.text : "";
      if (contentText.startsWith("任务完成报告") || contentText.startsWith("工作流完成报告")) {
        return new Text(workflowReport.styleReportText(contentText, theme), 0, 0);
      }

      const details = result.details as import("./runtime-state.ts").WorkflowState | undefined;
      if (!details || !Array.isArray(details.tasks)) {
        return new Text(contentText || "工作流已更新", 0, 0);
      }
      const progress = workflowProgress(details);
      const current = progress.currentTaskId ? ` · ${progress.currentTaskId}` : "";
      let text = theme.fg("success", "✓ ") + theme.fg("accent", `工作流 ${progress.completed}/${progress.total}`) + theme.fg("muted", current);
      if (details.status === "paused") text += theme.fg("warning", " · 已暂停");
      if (details.status === "replanning") text += theme.fg("warning", " · 等待架构师重规划");
      if (expanded) text += `\n${details.tasks.map((task) => `  [${task.status}] ${task.id} · ${task.task}`).join("\n")}`;
      return new Text(text, 0, 0);
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      return workflowActions.runTaskWorkflowAction(params, signal, ctx);
    },
  });

  pi.registerTool({
    name: "switch_role",
    label: "Switch Role",
    description:
      "Switch the active Pi model and reasoning level for a configured responsibility. Reads the project roleModels mapping and current-session overrides; switching never writes .pi/role-models.json. Modes: auto applies immediately, confirm asks before automatic changes, manual requires /pi-init role. Use /pi-init save to explicitly persist staged role configuration.",
    promptSnippet: "Switch model and reasoning level for a configured project role",
    promptGuidelines: [
      "Call switch_role before starting a responsibility selected by the project's role-routing Skill and again at every role boundary.",
      "Use the role ID required by the current task; architect remains the planning role, while other configured role IDs may execute their assigned work.",
      "In manual mode, switch_role does not change models; ask the user to run /pi-init role <role> and retry.",
    ],
    parameters: switchRoleParameters,
    renderCall(args, theme) {
      return new Text(theme.fg("toolTitle", theme.bold("角色切换 ")) + theme.fg("muted", roleLabel(args.role)), 0, 0);
    },
    renderResult(result, _options, theme) {
      if (result.isError) return new Text(theme.fg("error", "角色切换失败"), 0, 0);
      const details = result.details as { role?: string; model?: string; thinkingLevel?: string } | undefined;
      return new Text(
        theme.fg("success", "✓ ") + theme.fg("accent", roleLabel(details?.role ?? "")) +
          theme.fg("muted", ` · ${shortModelName(details?.model ?? "")}/${details?.thinkingLevel ?? "off"}`),
        0,
        0,
      );
    },
    executionMode: "sequential",
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "角色切换已取消。" }], details: {} };
      }
      const selection = await roleRuntime.automaticRole(params.role, ctx);
      const result = selection.result;
      const prefix = selection.requestedRole === result.role ? "已切换到" : `已按确认选择切换到 ${result.role}（建议为 ${selection.requestedRole}）`;
      return {
        content: [
          {
            type: "text",
            text: `${prefix}：${result.provider}/${result.model}，推理强度 ${result.thinkingLevel}，模式 ${selection.mode}`,
          },
        ],
        details: { ...result, mode: selection.mode, requestedRole: selection.requestedRole },
      };
    },
  });
}
