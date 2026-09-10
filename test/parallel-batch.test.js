import assert from "node:assert/strict";
import test from "node:test";
import {
  PARALLEL_RESULT_PROTOCOL,
  attachParallelIntegrationWorktree,
  attachParallelWorkerWorktree,
  beginParallelIntegration,
  cancelParallelBatch,
  createParallelBatch,
  hydrateParallelBatch,
  parallelBatchProgress,
  parseParallelWorkerResult,
  recordParallelIntegrationResult,
  recordParallelWorkerFailure,
  recordParallelWorkerResult,
  retryParallelWorker,
  startParallelBatch,
  startParallelWorker,
  validateParallelBatchInput,
} from "../src/parallel-batch.js";

const parentPath = process.platform === "win32" ? "C:\\repo" : "/repo";
const workerPath = (name) => process.platform === "win32" ? `C:\\work\\${name}` : `/work/${name}`;

function input(overrides = {}) {
  return {
    batchId: "batch-1",
    parentPath,
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    tasks: [
      { id: "api", task: "修改 API", files: ["src/api"], acceptanceCriteria: ["测试通过"] },
      { id: "ui", task: "修改 UI", files: ["src/ui"], acceptanceCriteria: ["测试通过"] },
    ],
    ...overrides,
  };
}

function completeResult(batchId = "batch-1", taskId = "api", attemptId = "attempt-api", changedFiles = ["src/api/index.js"]) {
  return JSON.stringify({
    protocol: PARALLEL_RESULT_PROTOCOL,
    outcome: "complete",
    batchId,
    taskId,
    attemptId,
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    completionSummary: "任务完成",
    implementationRationale: "保持任务范围隔离",
    verification: ["node --test：通过"],
    changedFiles,
  });
}

function preparedState() {
  let state = createParallelBatch(input(), 10);
  state = attachParallelWorkerWorktree(state, {
    taskId: "api",
    worktree: { name: "batch-1-api", path: workerPath("batch-1-api"), branch: "batch-1-api", commit: state.baseCommit },
  }, 11);
  state = attachParallelWorkerWorktree(state, {
    taskId: "ui",
    worktree: { name: "batch-1-ui", path: workerPath("batch-1-ui"), branch: "batch-1-ui", commit: state.baseCommit },
  }, 12);
  state = attachParallelIntegrationWorktree(state, {
    worktree: { name: "batch-1-integration", path: workerPath("batch-1-integration"), branch: "batch-1-integration", commit: state.baseCommit },
  }, 13);
  return startParallelBatch(state, 14);
}

test("并行批次严格限制数量、相对路径和不重叠范围", () => {
  assert.throws(() => validateParallelBatchInput(input({ tasks: [
    { id: "a", task: "A", files: ["src"], acceptanceCriteria: ["完成"] },
    { id: "b", task: "B", files: ["src/b"], acceptanceCriteria: ["完成"] },
  ] })), /范围重叠/);
  assert.throws(() => validateParallelBatchInput(input({ tasks: [
    { id: "a", task: "A", files: ["../src/a"], acceptanceCriteria: ["完成"] },
  ] })), /路径段/);
  assert.throws(() => validateParallelBatchInput(input({ tasks: [
    { id: "a", task: "A", files: ["C:\\src\\a"], acceptanceCriteria: ["完成"] },
  ] })), /相对路径/);
  assert.throws(() => validateParallelBatchInput(input({ tasks: [
    { id: "a", task: "A", files: ["src/a"], acceptanceCriteria: ["完成"] },
    { id: "b", task: "B", files: ["src/b"], acceptanceCriteria: ["完成"] },
    { id: "c", task: "C", files: ["src/c"], acceptanceCriteria: ["完成"] },
  ] })), /1-2/);
  assert.throws(() => validateParallelBatchInput(input({ tasks: [
    { id: "a", task: "A", files: ["src/a"], acceptanceCriteria: ["完成"], model: "sonnet" },
  ] })), /provider/);
});

test("并行批次要求所有 worktree 使用固定基线且 worker 范围互斥", () => {
  let state = createParallelBatch(input(), 10);
  assert.throws(() => attachParallelWorkerWorktree(state, {
    taskId: "api",
    worktree: { name: "api", path: parentPath, branch: "api", commit: state.baseCommit },
  }), /主工作区内/);
  assert.throws(() => attachParallelWorkerWorktree(state, {
    taskId: "api",
    worktree: { name: "api", path: workerPath("api"), branch: "api", commit: "fedcba987654321" },
  }), /固定基线/);
  state = attachParallelWorkerWorktree(state, {
    taskId: "api",
    worktree: { name: "api", path: workerPath("api"), branch: "api", commit: state.baseCommit },
  });
  assert.throws(() => attachParallelWorkerWorktree(state, {
    taskId: "ui",
    worktree: { name: "ui", path: workerPath("api"), branch: "ui", commit: state.baseCommit },
  }), /重复/);
});

test("两个独立 worker 可以并发启动，结果到齐后只能进入隔离集成", () => {
  let state = preparedState();
  state = startParallelWorker(state, { taskId: "api", attemptId: "attempt-api" }, 20);
  state = startParallelWorker(state, { taskId: "ui", attemptId: "attempt-ui" }, 21);
  assert.equal(parallelBatchProgress(state).running, 2);
  assert.throws(() => startParallelWorker(state, { taskId: "api", attemptId: "attempt-api-2" }), /不可启动/);
  state = recordParallelWorkerResult(state, completeResult("batch-1", "api", "attempt-api", ["src/api/index.js"]), 30);
  assert.equal(state.status, "running");
  state = recordParallelWorkerResult(state, completeResult("batch-1", "ui", "attempt-ui", ["src/ui/index.js"]), 31);
  assert.equal(state.status, "awaiting-integration");
  state = beginParallelIntegration(state, 32);
  assert.equal(state.integration.status, "running");
  state = recordParallelIntegrationResult(state, {
    outcome: "complete",
    verification: ["npm test：通过"],
    changedFiles: ["src/api/index.js", "src/ui/index.js"],
  }, 33);
  assert.equal(state.status, "completed");
  assert.equal(state.integration.status, "completed");
});

test("worker 结果严格绑定 batch/task/attempt/base，并拒绝越界或缺少验证", () => {
  const expected = {
    batchId: "batch-1",
    taskId: "api",
    attemptId: "attempt-api",
    baseCommit: "0123456789abcdef0123456789abcdef01234567",
    files: ["src/api"],
  };
  assert.equal(parseParallelWorkerResult(completeResult(), expected).outcome, "complete");
  assert.throws(() => parseParallelWorkerResult(completeResult("other"), expected), /batchId/);
  assert.throws(() => parseParallelWorkerResult(completeResult("batch-1", "api", "attempt-api", ["src/ui/x.js"]), expected), /范围外/);
  assert.throws(() => parseParallelWorkerResult(JSON.stringify({ ...JSON.parse(completeResult()), verification: [] }), expected), /verification/);
  assert.throws(() => parseParallelWorkerResult(JSON.stringify({ ...JSON.parse(completeResult()), extra: true }), expected), /不支持/);
});

test("失败、取消和重试保持 attempt 历史，恢复不会重复派发", () => {
  let state = preparedState();
  state = startParallelWorker(state, { taskId: "api", attemptId: "attempt-api" }, 20);
  state = startParallelWorker(state, { taskId: "ui", attemptId: "attempt-ui" }, 21);
  state = recordParallelWorkerFailure(state, { taskId: "api", attemptId: "attempt-api", reason: "worker 退出" }, 30);
  assert.equal(state.status, "blocked");
  assert.throws(() => recordParallelWorkerResult(state, completeResult(), 31), /不接收/);
  state = retryParallelWorker(state, "api", 32);
  state = startParallelWorker(state, { taskId: "api", attemptId: "attempt-api-2" }, 33);
  assert.throws(() => startParallelWorker(state, { taskId: "api", attemptId: "attempt-api" }), /不可启动/);
  const cancelled = cancelParallelBatch(state, "用户停止", 34);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.tasks.find((task) => task.id === "api").status, "cancel-requested");
  assert.equal(cancelled.tasks.find((task) => task.id === "ui").status, "cancel-requested");
  const restored = hydrateParallelBatch(JSON.parse(JSON.stringify(cancelled)));
  assert.equal(restored.status, "cancelled");
  assert.equal(restored.tasks.find((task) => task.id === "api").attempts.length, 2);
});

test("集成严格拒绝范围外变更和缺少验证，并保留阻塞产物", () => {
  let state = preparedState();
  state = startParallelWorker(state, { taskId: "api", attemptId: "attempt-api" });
  state = startParallelWorker(state, { taskId: "ui", attemptId: "attempt-ui" });
  state = recordParallelWorkerResult(state, completeResult("batch-1", "api", "attempt-api", ["src/api/x.js"]));
  state = recordParallelWorkerResult(state, completeResult("batch-1", "ui", "attempt-ui", ["src/ui/x.js"]));
  state = beginParallelIntegration(state);
  assert.throws(() => recordParallelIntegrationResult(state, { outcome: "complete", verification: [], changedFiles: [] }), /verification/);
  assert.throws(() => recordParallelIntegrationResult(state, { outcome: "complete", verification: ["通过"], changedFiles: ["package.json"] }), /范围外/);
  const blocked = recordParallelIntegrationResult(state, { outcome: "blocked", verification: ["冲突复现"], changedFiles: ["src/api/x.js"], reason: "集成冲突" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.integration.reason, "集成冲突");
});
