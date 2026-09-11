import * as fs from "node:fs";
import { join } from "node:path";
import type {
  CollaborationDirs,
  ListedRun,
  RunStatus,
  SubagentRunRecord,
} from "./collaboration-types.ts";
import { ensureCollaborationDirs } from "./collaboration-paths.ts";
import { isStaleRun } from "./collaboration-registry.ts";

const MAX_PREVIEW = 2000;

function recordPath(dirs: CollaborationDirs, id: string): string | undefined {
  if (!id || /[\\/\0]/.test(id)) return undefined;
  return join(dirs.runs, `${id}.json`);
}

function read<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function write(filePath: string, value: unknown): boolean {
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, filePath);
    return true;
  } catch {
    fs.rmSync(temporary, { force: true });
    return false;
  }
}

function preview(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_PREVIEW ? `${value.slice(0, MAX_PREVIEW - 20)}…[truncated]` : value;
}

export function writeRun(dirs: CollaborationDirs, record: SubagentRunRecord): boolean {
  ensureCollaborationDirs(dirs);
  const filePath = recordPath(dirs, record.recordId);
  return filePath ? write(filePath, { ...record, taskPreview: preview(record.taskPreview), outputPreview: preview(record.outputPreview) }) : false;
}

export function updateRun(
  dirs: CollaborationDirs,
  id: string,
  patch: Partial<SubagentRunRecord>,
): boolean {
  ensureCollaborationDirs(dirs);
  const filePath = recordPath(dirs, id);
  if (!filePath) return false;
  const current = read<SubagentRunRecord>(filePath);
  if (!current) return false;
  return write(filePath, {
    ...current,
    ...patch,
    recordId: current.recordId,
    batchRunId: current.batchRunId,
    taskIndex: current.taskIndex,
    taskPreview: preview(patch.taskPreview ?? current.taskPreview),
    outputPreview: preview(patch.outputPreview ?? current.outputPreview),
  });
}

export function listRuns(
  dirs: CollaborationDirs,
  options: { parentAgent?: string; parentSessionId?: string; includeCompleted?: boolean } = {},
): ListedRun[] {
  ensureCollaborationDirs(dirs);
  const result: ListedRun[] = [];
  for (const name of fs.readdirSync(dirs.runs).filter((item) => item.endsWith(".json"))) {
    const record = read<SubagentRunRecord>(join(dirs.runs, name));
    if (!record || (options.parentAgent && record.parentAgent !== options.parentAgent)
      || (options.parentSessionId && record.parentSessionId !== options.parentSessionId)
      || (options.includeCompleted === false && !["launching", "running"].includes(record.status))) continue;
    result.push({ ...record, isStale: isStaleRun(record.lastSeenAt, record.status) });
  }
  return result.sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
}

export function runStatusText(status: RunStatus): string {
  return status === "launching" ? "launching" : status === "running" ? "running" : status === "completed" ? "completed" : "failed";
}
