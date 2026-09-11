import type * as fs from "node:fs";

export type CollaborationRole = "orchestrator" | "subagent";
export type DeliveryKind = "direct" | "broadcast";
export type LaunchMode = "process" | "cmux-pane";
export type RunStatus = "launching" | "running" | "completed" | "failed";
export type SubagentTerminationReason = "timeout" | "cancelled" | "killed";

export interface FileReservation {
  pattern: string;
  reason?: string;
  since: string;
}

export interface AgentRegistration {
  name: string;
  pid: number;
  sessionId: string;
  sessionFile?: string;
  cwd: string;
  model: string;
  startedAt: string;
  lastSeenAt: string;
  role?: CollaborationRole;
  reservations?: FileReservation[];
}

export interface InboxMessage {
  id: string;
  from: string;
  to: string;
  text: string;
  kind: DeliveryKind;
  timestamp: string;
  urgent?: boolean;
  replyTo?: string | null;
}

export interface MessageLogEvent {
  id: string;
  from: string;
  to: string | "all";
  text: string;
  kind: DeliveryKind;
  timestamp: string;
  urgent?: boolean;
  recipients?: string[];
  replyTo?: string | null;
}

export interface ReservationConflict {
  path: string;
  agent: string;
  pattern: string;
  reason?: string;
  registration: AgentRegistration;
}

export interface CollaborationDirs {
  base: string;
  registry: string;
  inbox: string;
  runs: string;
  messageLog: string;
}

export interface SubagentTask {
  task: string;
  cwd?: string;
  files?: string[];
  acceptanceCriteria?: string[];
}

export interface AgentProfile {
  role: string;
  provider: string;
  model: string;
  thinkingLevel: string;
  systemPrompt: string;
  allowedTools: string[];
}

export interface SubagentRunRecord {
  recordId: string;
  batchRunId: string;
  taskIndex: number;
  parentAgent: string;
  parentSessionId?: string;
  parentPid?: number;
  name: string;
  taskPreview: string;
  requestedCwd?: string;
  cwd: string;
  status: RunStatus;
  sessionId?: string;
  sessionFile?: string;
  model?: string;
  launchMode: LaunchMode;
  startedAt: string;
  lastSeenAt: string;
  timeoutMs?: number;
  terminationReason?: SubagentTerminationReason;
  completedAt?: string;
  exitCode?: number;
  outputPreview?: string;
  error?: string;
}

export interface ListedRun extends SubagentRunRecord {
  isStale: boolean;
}

export interface SettledSubagent {
  record: SubagentRunRecord;
  resultText?: string;
}

export interface CollaborationState {
  agentName?: string;
  registered: boolean;
  reservations: FileReservation[];
  watcher?: fs.FSWatcher;
  watcherTimer?: ReturnType<typeof setTimeout>;
  lastContext?: any;
  activeRuns: Map<string, AbortController>;
  workflowRuns: Map<string, string>;
  disposed: boolean;
}
