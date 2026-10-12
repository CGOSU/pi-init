import type { CoordinationState } from "./coordination-types.ts";

export type CoordinationRole = "docs-commit" | "architect";
export type CoordinationHandoffKind = "evidence" | "review";
export type CoordinationDispatchPhase = "prepared" | "dispatching" | "queued" | "executing" | "blocked";

export type CoordinationHandoff = {
  role: CoordinationRole;
  kind: CoordinationHandoffKind;
  requestId: string;
  reportId?: string;
  attemptId: string;
  handoffId: string;
  phase: CoordinationDispatchPhase;
  createdAt: number;
  failure?: { code: string; message: string };
};

export type CoordinationHandoffIdentity = {
  coordinationId: string;
  coordinationVersion: number;
  sessionId: string;
  recoveryGeneration: number;
  requestId: string;
  role: CoordinationRole;
  kind: CoordinationHandoffKind;
  attemptId: string;
  handoffId: string;
  reportId?: string;
};

/** Session-branch durable coordination data. It never owns executable tasks. */
export type CoordinationRuntimeState = {
  runtimeVersion: 1;
  coordination: CoordinationState;
  sessionId: string;
  recoveryGeneration: number;
  handoff?: CoordinationHandoff;
};

export type CoordinationRuntimeFailure = {
  ok: false;
  code: string;
  message: string;
};

export type CoordinationRuntimeResult<T> = { ok: true; value: T } | CoordinationRuntimeFailure;

export type CoordinationRestoreError = { code: string; message: string; sourceEntryId?: string };

export type CoordinationIdentityInput = unknown;
export type CoordinationRuntimeStateInput = unknown;
