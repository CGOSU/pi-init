export type EvidenceClassification = "fact" | "inference" | "unconfirmed" | "conflict";
export type EvidenceRequestStatus = "pending" | "reported" | "accepted" | "follow-up-needed" | "blocked" | "superseded";
export type EvidenceReviewDecision = "accept" | "more" | "block";
export type CoordinationPhase = "evidence-gathering" | "evidence-review" | "ready" | "blocked";

export type EvidenceSource = {
  id: string;
  location: string;
  version: string;
};

export type AcceptedEvidenceReference = {
  findingId: string;
  sourceId: string;
  sourceVersion: string;
};

export type EvidenceRequest = {
  requestId: string;
  questionId: string;
  question: string;
  rationale: string;
  scope: string[];
  exclusions: string[];
  completionCriteria: string[];
  addressesGaps: string[];
  followUpOfRequestId?: string;
  refreshReason?: string;
  round: number;
  status: EvidenceRequestStatus;
  createdAt: number;
};

export type EvidenceFinding = {
  findingId: string;
  questionId: string;
  classification: EvidenceClassification;
  statement: string;
  sources: EvidenceSource[];
};

export type EvidenceTestResult = {
  command: string;
  result: string;
};

export type EvidenceReport = {
  reportId: string;
  requestId: string;
  findings: EvidenceFinding[];
  inspectedScope: string[];
  testsLocated: string[];
  testsRun: EvidenceTestResult[];
  unresolved: string[];
  createdAt: number;
};

export type EvidenceReview = {
  reviewId: string;
  reportId: string;
  decision: EvidenceReviewDecision;
  acceptedEvidence: AcceptedEvidenceReference[];
  gaps: string[];
  reason?: string;
  reviewedAt: number;
};

export type CoordinationWorkflowLink = {
  workflowId: string;
  planVersion: number;
  recoveryGeneration: number;
};

/** Durable evidence protocol state; it never owns or dispatches executable tasks. */
export type CoordinationState = {
  version: 1;
  coordinationId: string;
  sessionId: string;
  phase: CoordinationPhase;
  requests: EvidenceRequest[];
  reports: EvidenceReport[];
  reviews: EvidenceReview[];
  workflowLink?: CoordinationWorkflowLink;
  createdAt: number;
  updatedAt: number;
};

export type WorkflowTaskClarificationResolution = {
  issueId: string;
  resolutionKind: "evidence" | "contract" | "decision";
  resolution: string;
  sideEffectDisposition: "none" | "reconciled" | "no-replay";
};

/** Optional task contract. Its absence keeps historical/local tasks compatible. */
export type WorkflowTaskContract = {
  version: 1;
  outcome: string;
  requirementSources: string[];
  expectedBehavior: string[];
  evidence: AcceptedEvidenceReference[];
  clarificationResolutions: WorkflowTaskClarificationResolution[];
  fixedDecisions: string[];
  invariants: string[];
  nonGoals: string[];
  blockingQuestions: string[];
  engineeringDiscretion: string[];
  verification: string[];
};

export type CoordinationFailure = {
  ok: false;
  code: string;
  message: string;
  field?: string;
};

export type CoordinationResult<T> = { ok: true; value: T } | CoordinationFailure;

export type CoordinationReadiness =
  | { ok: true; value: { ready: true; acceptedEvidence: AcceptedEvidenceReference[] } }
  | CoordinationFailure;

export type TaskContractReadiness =
  | { ok: true; value: { ready: true } }
  | CoordinationFailure;

export type EvidenceRequestInput = {
  requestId?: unknown;
  questionId: unknown;
  question: unknown;
  rationale: unknown;
  scope: unknown;
  exclusions?: unknown;
  completionCriteria: unknown;
  addressesGaps?: unknown;
  followUpOfRequestId?: unknown;
  refreshReason?: unknown;
};

export type EvidenceReportInput = {
  reportId?: unknown;
  requestId: unknown;
  findings: unknown;
  inspectedScope: unknown;
  testsLocated?: unknown;
  testsRun?: unknown;
  unresolved?: unknown;
};

export type EvidenceReviewInput = {
  reviewId?: unknown;
  reportId: unknown;
  decision: unknown;
  acceptedEvidence?: unknown;
  gaps?: unknown;
  reason?: unknown;
};

export type CoordinationStateInput = unknown;
export type WorkflowTaskContractInput = unknown;
