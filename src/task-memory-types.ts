import type { WorkflowHandoffIdentity } from "./workflow-types.ts";

export type TaskObservation = {
  id: string; messageEntryId: string; toolCallId: string; toolName: string;
  inputHash: string; outputHash: string; outcome: "tool-ok" | "tool-error" | "unknown";
  summary: string; truncated: boolean;
};
export type TaskSourceVersion = { path: string; hash: string };
export type TaskCheckpoint = {
  step: string; accomplished: { summary: string; evidenceIds: string[] }[];
  remaining: string[]; blockers: string[]; nextStep: string; files?: TaskSourceVersion[];
};
export type TaskMemory = {
  version: 1; identity: WorkflowHandoffIdentity; revision: number; progressRevision: number; watermark?: string; derivation?: number;
  observations: TaskObservation[]; omittedObservations: number; checkpoint?: TaskCheckpoint;
};
