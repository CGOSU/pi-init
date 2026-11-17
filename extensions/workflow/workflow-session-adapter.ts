import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../src/value-guards.ts";
import { workflowHandoffAnchorMatches } from "../../src/workflow-handoff.ts";
import type { WorkflowHandoffIdentity, WorkflowIdentityContext, WorkflowMessageAnchor } from "../../src/workflow-types.ts";

// Project Pi records without authorizing them: the domain checks identity and anchor scope.
function readWorkflowMessageAnchors(ctx: ExtensionContext): WorkflowMessageAnchor[] {
  const branch = ctx?.sessionManager?.getBranch?.();
  if (!Array.isArray(branch)) return [];
  return branch.flatMap((entry: unknown) => isRecord(entry)
    && entry.type === "custom_message"
    && typeof entry.customType === "string"
    ? [{ messageType: entry.customType, identity: entry.details }]
    : []);
}

export function readWorkflowIdentityContext(ctx: ExtensionContext): WorkflowIdentityContext {
  return {
    sessionId: ctx?.sessionManager?.getSessionId?.(),
    anchors: readWorkflowMessageAnchors(ctx),
  };
}

export function workflowHandoffMessageOnBranch(ctx: ExtensionContext, identity: WorkflowHandoffIdentity): boolean {
  return workflowHandoffAnchorMatches(readWorkflowMessageAnchors(ctx), identity);
}
