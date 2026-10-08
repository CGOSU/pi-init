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

test("Pi's Jiti loader invokes workflow identity and role validation during dispatch", async () => {
  const helpers = await jiti.import(path.join(testDirectory, "helpers.js"));
  await helpers.withTempDirectory(async (cwd) => {
    const workflow = helpers.createWorkflowState({
      summary: "isolated loader regression",
      reviewRequired: true,
      tasks: [{ id: "task", task: "smoke", role: "developer-test", files: ["src"], acceptanceCriteria: ["valid"] }],
    });
    const harness = helpers.createExtensionHarness([
      { type: "custom", customType: "pi-init-workflow", data: workflow },
    ], { cwd });

    await helpers.emitExtensionEvent(harness, "session_start", { reason: "new" });

    assert.equal(harness.branch.at(-1).data.status, "paused");
    assert.equal(harness.notifications.length, 0);
  });

  const { createWorkflowDispatch } = await jiti.import(path.resolve(testDirectory, "../extensions/workflow-dispatch.ts"));
  const state = {
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
    workflowState: {
      workflowId: "identity-smoke",
      planVersion: 0,
      sessionId: "isolated-session",
      recoveryGeneration: 0,
      status: "paused",
      tasks: [{ id: "task", role: "developer-test", status: "pending" }],
    },
  };
  const dispatch = createWorkflowDispatch(state, {});

  await dispatch.scheduleWorkflow({}, {
    workflowId: "different-workflow",
    planVersion: 0,
    sessionId: "isolated-session",
    recoveryGeneration: 0,
  });
  await dispatch.scheduleWorkflow({});

  assert.equal(state.workflowDispatchInFlight, false);
  assert.equal(state.workflowState.tasks[0].status, "pending");
  assert.equal(state.workflowRestoreError, undefined);
});
