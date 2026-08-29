import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import initProjectExtension from "../extensions/index.ts";
import { installLaunchers } from "../scripts/install-launchers.js";
import {
  dateRange,
  formatReport,
  PI_USAGE_VERSION,
  queryUsage,
  shouldRefreshUsage,
  summarizeUsage,
} from "../scripts/pi-usage.js";
import { createScaffold, formatEnvironmentInstructions } from "../src/scaffold.js";
import {
  DEFAULT_ROLE_CONFIG,
  DEFAULT_ROLE_MODELS,
  DEFAULT_WORKFLOW_EXECUTOR,
  DEFAULT_WORKFLOW_MODE,
  ROLE_LABELS,
  ROLE_MODE_LABELS,
  ROLE_SWITCH_COMPACTION_THRESHOLD,
  THINKING_LEVELS,
  filterRoleModels,
  findMatchingRole,
  normalizeModelReference,
  resolveRoleConfig,
  resolveRoleMode,
  resolveWorkflowExecutor,
  resolveWorkflowMode,
  resolveRoleModel,
  shouldOrchestrateWorkflow,
  shouldCompactOnRoleSwitch,
} from "../src/roles.js";
import {
  WORKFLOW_MAX_NUDGES,
  WORKFLOW_MAX_TASKS,
  blockWorkflowTask,
  beginWorkflowDelegation,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  getNextWorkflowTask,
  getWorkflowTask,
  getWorkflowTaskDuration,
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  hydrateWorkflowState,
  markWorkflowTaskStarted,
  recordWorkflowNudge,
  requestWorkflowReplan,
  appendWorkflowReplanDirection,
  applyWorkflowReplan,
  resumeWorkflow,
  retryWorkflowTask,
  startWorkflowTask,
  validateWorkflowPlan,
  requestWorkflowDelegationStop,
  workflowProgress,
} from "../src/workflow.js";
import {
  SUBTASK_RESULT_MAX_BYTES,
  SUBTASK_RESULT_PROTOCOL,
  extractSubtaskResultJson,
  parseSubtaskResult,
} from "../src/subtask.js";
import {
  completeRunTiming,
  createRunTiming,
  getRunTimingDuration,
  isExternalRunSource,
} from "../src/run-timing.js";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-init-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function createExtensionHarness(branch = [], options = {}) {
  const handlers = new Map();
  const commands = new Map();
  const entries = [];
  const notifications = [];
  const selectCalls = [];
  const customCalls = [];
  const statusCalls = [];
  const renderers = new Map();
  const tools = [];
  const aborts = [];
  const sentMessages = [];
  const defaultModel = options.model ?? { provider: "openai-codex", id: "gpt-5.6-luna" };
  const availableModels = options.availableModels ?? [defaultModel];
  const activeTools = options.activeTools ?? [];
  let context;
  const pi = {
    on(name, handler) {
      const registered = handlers.get(name) ?? [];
      registered.push(handler);
      handlers.set(name, registered);
    },
    events: {
      on() {
        return () => {};
      },
      emit() {},
    },
    appendEntry(type, data) {
      entries.push({ type, data });
    },
    registerCommand(name, command) {
      commands.set(name, command);
    },
    registerEntryRenderer(type, renderer) {
      renderers.set(type, renderer);
    },
    registerTool(tool) {
      tools.push(tool);
    },
    getThinkingLevel() {
      return options.thinkingLevel ?? "max";
    },
    setThinkingLevel() {},
    getActiveTools() {
      return activeTools;
    },
    async setModel(model) {
      if (options.setModelResult === false) return false;
      if (context) context.model = model;
      return true;
    },
    async sendMessage(message, options) {
      sentMessages.push({ message, options });
    },
  };
  initProjectExtension(pi);

  context = {
    cwd: options.cwd ?? process.cwd(),
    mode: options.mode ?? "rpc",
    hasUI: options.hasUI ?? true,
    model: defaultModel,
    scopedModels: options.scopedModels ?? [],
    modelRegistry: {
      find(provider, id) {
        return availableModels.find((model) => model.provider === provider && model.id === id);
      },
      getAvailable() {
        return availableModels;
      },
    },
    isProjectTrusted() {
      return options.trusted ?? false;
    },
    getContextUsage() {
      return { percent: 0 };
    },
    ui: {
      notify(message, level) {
        notifications.push({ message, level });
      },
      setStatus(name, text) {
        statusCalls.push({ name, text });
      },
      async select(title, items) {
        selectCalls.push({ title, items });
        return options.select?.(title, items);
      },
      async input(title, placeholder) {
        return options.input?.(title, placeholder);
      },
      async custom(factory, customOptions) {
        const call = { options: customOptions };
        customCalls.push(call);
        let result;
        const done = (value) => {
          call.done = true;
          result = value;
        };
        call.component = factory(
          { requestRender() {} },
          {
            fg: (_color, text) => text,
            bg: (_color, text) => text,
            bold: (text) => text,
          },
          {},
          done,
        );
        await options.custom?.(call);
        if (!call.done) done(undefined);
        return result;
      },
    },
    abort() {
      aborts.push(true);
    },
    sessionManager: {
      getBranch() {
        return branch;
      },
    },
  };
  return { handlers, commands, entries, notifications, selectCalls, customCalls, statusCalls, renderers, tools, aborts, context, sentMessages };
}

async function emitExtensionEvent(harness, name, event = {}) {
  for (const handler of harness.handlers.get(name) ?? []) {
    await handler(event, harness.context);
  }
}

async function runExternalAgent(harness, source) {
  await emitExtensionEvent(harness, "input", { source });
  await emitExtensionEvent(harness, "before_agent_start");
  await emitExtensionEvent(harness, "agent_start");
  await emitExtensionEvent(harness, "agent_start");
  await emitExtensionEvent(harness, "agent_settled");
}

export {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
  os,
  path,
  initProjectExtension,
  installLaunchers,
  dateRange,
  formatReport,
  PI_USAGE_VERSION,
  queryUsage,
  shouldRefreshUsage,
  summarizeUsage,
  createScaffold,
  formatEnvironmentInstructions,
  DEFAULT_ROLE_CONFIG,
  DEFAULT_ROLE_MODELS,
  DEFAULT_WORKFLOW_EXECUTOR,
  DEFAULT_WORKFLOW_MODE,
  ROLE_LABELS,
  ROLE_MODE_LABELS,
  ROLE_SWITCH_COMPACTION_THRESHOLD,
  THINKING_LEVELS,
  filterRoleModels,
  findMatchingRole,
  normalizeModelReference,
  resolveRoleConfig,
  resolveRoleMode,
  resolveWorkflowExecutor,
  resolveWorkflowMode,
  resolveRoleModel,
  shouldOrchestrateWorkflow,
  shouldCompactOnRoleSwitch,
  WORKFLOW_MAX_NUDGES,
  WORKFLOW_MAX_TASKS,
  blockWorkflowTask,
  beginWorkflowDelegation,
  cancelWorkflow,
  completeWorkflowTask,
  createWorkflowState,
  getNextWorkflowTask,
  getWorkflowTask,
  getWorkflowTaskDuration,
  getWorkflowExecutionBounds,
  getWorkflowExecutionDuration,
  hydrateWorkflowState,
  markWorkflowTaskStarted,
  recordWorkflowNudge,
  requestWorkflowReplan,
  appendWorkflowReplanDirection,
  applyWorkflowReplan,
  resumeWorkflow,
  retryWorkflowTask,
  startWorkflowTask,
  validateWorkflowPlan,
  requestWorkflowDelegationStop,
  workflowProgress,
  SUBTASK_RESULT_MAX_BYTES,
  SUBTASK_RESULT_PROTOCOL,
  extractSubtaskResultJson,
  parseSubtaskResult,
  completeRunTiming,
  createRunTiming,
  getRunTimingDuration,
  isExternalRunSource,
  withTempDirectory,
  createExtensionHarness,
  emitExtensionEvent,
  runExternalAgent,
};
