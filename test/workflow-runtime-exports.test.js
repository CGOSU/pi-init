import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const piEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piDistDirectory = path.dirname(piEntry);
const piRequire = createRequire(piEntry);
const jitiPackageDirectory = path.dirname(piRequire.resolve("jiti/package.json"));
const { createJiti } = await import(pathToFileURL(path.join(jitiPackageDirectory, "lib/jiti-static.mjs")));
const { VIRTUAL_MODULES } = await import(pathToFileURL(path.join(piDistDirectory, "core/extensions/virtual-modules.js")));
const jiti = createJiti(
  pathToFileURL(path.join(piDistDirectory, "core/extensions/loader.js")).href,
  { moduleCache: false, virtualModules: VIRTUAL_MODULES, tryNative: false },
);

function createDispatchState(workflowState) {
  return {
    sessionRoleConfigOverrides: {},
    configuredRoleNames: [],
    controlCenterGuideShown: false,
    roleModeStatus: "auto",
    workflowModeStatus: "auto",
    roleRecoveryPending: false,
    roleRecoveryPersistenceFailed: false,
    roleContextGeneration: 0,
    roleTransitionGeneration: 0,
    roleCompactionPhase: "idle",
    roleCompactionStalled: false,
    roleCompactionInFlight: false,
    workflowDispatchInFlight: false,
    internalContinuationPending: false,
    runtimeDisposed: false,
    workflowState,
  };
}

function runnableWorkflow(helpers, role = "developer-test") {
  const planned = helpers.createWorkflowState({
    workflowId: "dispatch-regression",
    sessionId: "isolated-session",
    summary: "dispatch guard regression",
    tasks: [{ id: "task", task: "dispatch", role, files: ["src"], acceptanceCriteria: ["valid"] }],
  }, 100);
  return helpers.startWorkflowTask(planned, "task", 101);
}

test("Pi's Jiti loader rejects stale workflow identity and forbidden execution roles", async () => {
  const helpers = await jiti.import(path.join(testDirectory, "helpers.js"));
  const { createWorkflowDispatch } = await jiti.import(path.resolve(testDirectory, "../extensions/workflow-dispatch.ts"));

  await helpers.withTempDirectory(async (cwd) => {
    const pausedWorkflow = helpers.createWorkflowState({
      workflowId: "loader-smoke",
      sessionId: "isolated-session",
      summary: "loader integration",
      reviewRequired: true,
      tasks: [{ id: "task", task: "smoke", role: "developer-test", files: ["src"], acceptanceCriteria: ["valid"] }],
    });
    const harness = helpers.createExtensionHarness([
      { type: "custom", customType: "pi-init-workflow", data: pausedWorkflow },
    ], { cwd, sessionId: "isolated-session" });

    await helpers.emitExtensionEvent(harness, "session_start", { reason: "new" });

    assert.equal(harness.branch.at(-1).data.status, "paused");
    assert.equal(harness.sentMessages.length, 0);

    const sentTaskMessages = [];
    const makeDependencies = (state, sentMessages) => ({
      roleRuntime: {
        automaticRole: async (role) => ({ mode: "auto", requestedRole: role, result: { role } }),
      },
      messages: {
        sendWorkflowTaskMessage: (_ctx, taskId, _note, identity) => sentMessages.push({ taskId, identity }),
      },
      report: {
        persistWorkflowState: (next) => { state.workflowState = next; },
        updateWorkflowStatus: () => {},
        formatWorkflowPauseSummary: () => "暂停",
      },
      setCurrentContext: () => {},
    });

    const validState = createDispatchState(runnableWorkflow(helpers));
    const dispatch = createWorkflowDispatch(validState, makeDependencies(validState, sentTaskMessages));
    const currentIdentity = {
      workflowId: validState.workflowState.workflowId,
      planVersion: validState.workflowState.planVersion,
      sessionId: validState.workflowState.sessionId,
      recoveryGeneration: validState.workflowState.recoveryGeneration,
    };

    await dispatch.scheduleWorkflow(harness.context, { ...currentIdentity, workflowId: "stale-workflow" });

    assert.equal(validState.workflowDispatchInFlight, false);
    assert.equal(validState.workflowState.handoff.phase, "prepared");
    assert.equal(validState.workflowState.tasks[0].status, "in_progress");
    assert.deepEqual(sentTaskMessages, []);

    await dispatch.scheduleWorkflow(harness.context, currentIdentity);

    assert.equal(sentTaskMessages.length, 1);
    assert.equal(sentTaskMessages[0].taskId, "task");
    assert.equal(sentTaskMessages[0].identity.workflowId, currentIdentity.workflowId);
    assert.equal(sentTaskMessages[0].identity.handoffId, validState.workflowState.handoff.handoffId);

    const invalidState = createDispatchState(runnableWorkflow(helpers));
    invalidState.workflowState.tasks[0].role = "architect";
    const invalidMessages = [];
    const invalidDispatch = createWorkflowDispatch(invalidState, makeDependencies(invalidState, invalidMessages));

    await invalidDispatch.scheduleWorkflow(harness.context);

    assert.equal(invalidState.workflowRestoreError.code, "WORKFLOW_EXECUTION_ROLE_FORBIDDEN");
    assert.equal(invalidState.workflowDispatchInFlight, false);
    assert.equal(invalidState.workflowState.tasks[0].status, "in_progress");
    assert.deepEqual(invalidMessages, []);
    assert.ok(harness.notifications.some(({ message }) => message.includes("WORKFLOW_EXECUTION_ROLE_FORBIDDEN")));
  });
});
