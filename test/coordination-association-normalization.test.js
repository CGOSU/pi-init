import assert from "node:assert/strict";
import test from "node:test";

import {
  createExtensionHarness,
  emitExtensionEvent,
  mkdir,
  path,
  withTempDirectory,
  workflowMessageIdentity,
  writeFile,
} from "./helpers.js";
import {
  COORDINATION_EVIDENCE_MESSAGE_TYPE,
  COORDINATION_REVIEW_MESSAGE_TYPE,
} from "../extensions/coordination-runtime-protocol.ts";
import { taskWorkflowParameters } from "../extensions/contracts.ts";

const architect = { provider: "openai-codex", id: "gpt-5.6-sol" };
const docs = { provider: "openai-codex", id: "gpt-5.6-docs" };
const developer = { provider: "openai-codex", id: "gpt-5.6-luna" };

async function makeHarness(directory) {
  await mkdir(path.join(directory, ".pi"), { recursive: true });
  await writeFile(path.join(directory, ".pi", "role-models.json"), `${JSON.stringify({
    schemaVersion: 2,
    mode: "auto",
    workflowMode: "on",
    roleModels: {
      architect: { provider: architect.provider, model: architect.id, thinkingLevel: "max" },
      "docs-commit": { provider: docs.provider, model: docs.id, thinkingLevel: "high" },
      "developer-test": { provider: developer.provider, model: developer.id, thinkingLevel: "max" },
    },
  }, null, 2)}\n`);
  const harness = createExtensionHarness([], {
    cwd: directory,
    trusted: true,
    model: architect,
    availableModels: [architect, docs, developer],
    sessionId: "association-normalization-session",
  });
  await emitExtensionEvent(harness, "session_start");
  return harness;
}

function execute(harness, params) {
  return harness.tools.find((tool) => tool.name === "task_workflow")
    .execute("association-normalization-test", params, undefined, undefined, harness.context);
}

function latestCoordination(harness) {
  return harness.branch.findLast((entry) => entry.type === "custom" && entry.customType === "pi-init-coordination")?.data;
}

function visibleHandoffReference(harness, customType) {
  const message = harness.sentMessages.findLast(({ message: item }) => item.customType === customType)?.message;
  assert.ok(message, `missing ${customType} handoff message`);
  const match = message.content.match(/coordinationHandoffId="([^"]+)"/u);
  assert.ok(match, "handoff content must supply the model-visible short reference");
  return match[1];
}

async function startCurrentHandoff(harness, customType) {
  const eventIdentity = workflowMessageIdentity(harness, customType);
  assert.ok(eventIdentity, `missing runtime ${customType} message identity`);
  await emitExtensionEvent(harness, "agent_start");
  await emitExtensionEvent(harness, "message_start", {
    message: { role: "custom", customType, details: eventIdentity },
  });
}

test("model-visible handoff reference supplies associations without caller-maintained request IDs", async () => {
  await withTempDirectory(async (directory) => {
    const harness = await makeHarness(directory);
    const reportSchema = taskWorkflowParameters.properties.report;
    assert.equal(reportSchema.required.includes("requestId"), false, "report.requestId must be optional at the tool boundary");

    await execute(harness, {
      action: "request-evidence",
      request: {
        questionId: "resume-boundary",
        question: "核对恢复边界",
        rationale: "实现依赖当前恢复与测试语义。",
        scope: ["src/workflow-handoff.ts"],
        completionCriteria: ["列出当前状态与恢复守卫"],
      },
    });
    const originalRequestId = latestCoordination(harness).coordination.requests[0].requestId;
    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, docs.id);
    await startCurrentHandoff(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);
    const evidenceReference = visibleHandoffReference(harness, COORDINATION_EVIDENCE_MESSAGE_TYPE);

    await assert.rejects(execute(harness, {
      action: "report-evidence",
      coordinationHandoffId: evidenceReference,
      report: {
        requestId: "wrong-request",
        findings: [{
          findingId: "resume-fact",
          questionId: "resume-boundary",
          classification: "fact",
          statement: "已核对恢复状态会保留计划身份。",
          sources: [{ id: "workflow-source", location: "src/workflow-handoff.ts::recoverWorkflowState", version: "current-source" }],
        }],
        inspectedScope: ["src/workflow-handoff.ts"],
        unresolved: ["未验证真实宿主中断事件顺序。"],
      },
    }), (error) => error.code === "COORDINATION_REQUEST_ID_MISMATCH");

    await execute(harness, {
      action: "report-evidence",
      coordinationHandoffId: evidenceReference,
      report: {
        findings: [{
          findingId: "resume-fact",
          questionId: "resume-boundary",
          classification: "fact",
          statement: "已核对恢复状态会保留计划身份。",
          sources: [{ id: "workflow-source", location: "src/workflow-handoff.ts::recoverWorkflowState", version: "current-source" }],
        }],
        inspectedScope: ["src/workflow-handoff.ts"],
        unresolved: ["未验证真实宿主中断事件顺序。"],
      },
    });
    assert.equal(latestCoordination(harness).coordination.reports[0].requestId, originalRequestId);

    await emitExtensionEvent(harness, "agent_settled");
    assert.equal(harness.context.model.id, architect.id);
    await startCurrentHandoff(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
    const reviewReference = visibleHandoffReference(harness, COORDINATION_REVIEW_MESSAGE_TYPE);
    const reportId = latestCoordination(harness).coordination.reports[0].reportId;
    await execute(harness, {
      action: "review-evidence",
      coordinationHandoffId: reviewReference,
      review: {
        reportId,
        decision: "more",
        gaps: ["需核对真实中断到下一次 input 的宿主事件顺序"],
      },
    });

    await execute(harness, {
      action: "request-evidence",
      coordinationHandoffId: reviewReference,
      request: {
        questionId: "resume-boundary",
        question: "补充核对真实中断到下一次 input 的事件顺序",
        rationale: "只回答审阅明确指出的宿主生命周期缺口。",
        scope: ["Pi input/abort lifecycle"],
        completionCriteria: ["列出实际源码或日志证据；未核实项保持 unconfirmed"],
        addressesGaps: ["需核对真实中断到下一次 input 的宿主事件顺序"],
      },
    });
    const requests = latestCoordination(harness).coordination.requests;
    assert.equal(requests.length, 2);
    assert.equal(requests[1].followUpOfRequestId, originalRequestId);
    assert.notEqual(requests[1].requestId, originalRequestId);
  });
});
