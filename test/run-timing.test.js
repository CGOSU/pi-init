import assert from "node:assert/strict";
import test from "node:test";
import * as helpers from "./helpers.js";

const {
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
  applyWorkflowReplan,
  resumeWorkflow,
  retryWorkflowTask,
  startWorkflowTask,
  validateWorkflowPlan,
  workflowProgress,
  completeRunTiming,
  createRunTiming,
  getRunTimingDuration,
  isExternalRunSource,
  withTempDirectory,
  createExtensionHarness,
  emitExtensionEvent,
  runExternalAgent,
} = helpers;

test("普通执行计时限定外部来源并拒绝无效时间边界", () => {
  assert.equal(isExternalRunSource("interactive"), true);
  assert.equal(isExternalRunSource("rpc"), true);
  assert.equal(isExternalRunSource("extension"), false);
  assert.equal(isExternalRunSource(undefined), false);

  const started = createRunTiming("interactive", 100);
  assert.deepEqual(started, { source: "interactive", startedAt: 100 });
  assert.equal(getRunTimingDuration(started), undefined);
  assert.equal(createRunTiming("extension", 100), undefined);
  assert.equal(createRunTiming("interactive", Number.NaN), undefined);
  assert.equal(createRunTiming("interactive", Number.POSITIVE_INFINITY), undefined);

  const completed = completeRunTiming(started, 175);
  assert.deepEqual(completed, { source: "interactive", startedAt: 100, completedAt: 175 });
  assert.equal(getRunTimingDuration(completed), 75);
  assert.equal(completeRunTiming(started, 99), undefined);
  assert.equal(completeRunTiming(started, Number.NaN), undefined);
  assert.equal(completeRunTiming({ source: "extension", startedAt: 100 }, 175), undefined);
  assert.equal(getRunTimingDuration({ ...completed, completedAt: 99 }), undefined);
  assert.equal(getRunTimingDuration({ ...completed, completedAt: Number.POSITIVE_INFINITY }), undefined);
});

test("普通执行扩展按首次开始和最终 settled 写入 TUI 时间报告", async () => {
  const harness = createExtensionHarness();
  await runExternalAgent(harness, "interactive");
  await runExternalAgent(harness, "rpc");
  await runExternalAgent(harness, "extension");

  assert.equal(harness.entries.length, 2);
  assert.deepEqual(harness.entries.map(({ type, data }) => ({ type, source: data.source })), [
    { type: "pi-init-run-timing", source: "interactive" },
    { type: "pi-init-run-timing", source: "rpc" },
  ]);
  for (const entry of harness.entries) {
    assert.equal(typeof entry.data.startedAt, "number");
    assert.equal(typeof entry.data.completedAt, "number");
    assert.equal(getRunTimingDuration(entry.data), entry.data.completedAt - entry.data.startedAt);
  }

  const renderer = harness.renderers.get("pi-init-run-timing");
  assert.equal(typeof renderer, "function");
  const component = renderer(
    { data: harness.entries[0].data },
    { expanded: false },
    {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => `<bold>${text}</bold>`,
    },
  );
  const rendered = component.render(240).join("\n");
  assert.match(rendered, /<dim>─ Worked for \d+s ─+/);
  assert.doesNotMatch(rendered, /普通执行时间报告/);

  const longComponent = renderer(
    { data: { source: "interactive", startedAt: 0, completedAt: 4_669_000 } },
    { expanded: false },
    {
      fg: (color, text) => `<${color}>${text}</${color}>`,
      bold: (text) => `<bold>${text}</bold>`,
    },
  );
  assert.match(longComponent.render(80).join("\n"), /Worked for 1h 17m 49s/);
});

