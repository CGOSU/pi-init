import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SessionTailEntry {
  raw: string;
  parsed?: Record<string, unknown>;
}

export interface SessionTail {
  entries: SessionTailEntry[];
  malformed: number;
  truncated: boolean;
}

export function readSessionTail(filePath: string, limit = 20): SessionTail {
  if (limit <= 0 || !fs.existsSync(filePath)) return { entries: [], malformed: 0, truncated: false };
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  const selected = lines.slice(-Math.floor(limit));
  const entries: SessionTailEntry[] = [];
  let malformed = 0;
  for (const raw of selected) {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      entries.push({ raw, parsed });
    } catch {
      malformed += 1;
      entries.push({ raw });
    }
  }
  return { entries, malformed, truncated: selected.length < lines.length };
}

function assistantText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .filter((part): part is { type?: unknown; text?: unknown } => Boolean(part) && typeof part === "object")
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

export function formatSessionTail(tail: SessionTail): string {
  const lines: string[] = [];
  for (const entry of tail.entries) {
    const event = entry.parsed;
    const message = event?.message;
    if (message && typeof message === "object") {
      const record = message as Record<string, unknown>;
      const role = typeof record.role === "string" ? record.role : "message";
      const text = assistantText(record.content);
      if (text) {
        lines.push(`${role}: ${text}`);
        continue;
      }
    }
    if (event?.type === "session" && typeof event.id === "string") {
      lines.push(`session: ${event.id}`);
      continue;
    }
    lines.push(entry.raw.slice(0, 500));
  }
  if (tail.malformed > 0) lines.push(`(${tail.malformed} malformed JSONL line(s) skipped)`);
  if (tail.truncated) lines.unshift("(earlier session entries omitted)");
  return lines.join("\n");
}

export function findSessionFile(sessionId: string): string | undefined {
  if (!sessionId) return undefined;
  const root = join(homedir(), ".pi", "agent", "sessions");
  if (!fs.existsSync(root)) return undefined;
  const pending = [root];
  const suffix = `_${sessionId}.jsonl`;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(suffix)) {
        return fullPath;
      }
    }
  }
  return undefined;
}

export function lastAssistantText(filePath: string): string | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/).filter(Boolean);
  let last: string | undefined;
  for (const raw of lines) {
    try {
      const event = JSON.parse(raw) as Record<string, unknown>;
      const message = event.message;
      if (!message || typeof message !== "object") continue;
      const record = message as Record<string, unknown>;
      if (record.role !== "assistant") continue;
      const stopReason = record.stopReason ?? event.stopReason;
      if (stopReason === "toolUse") continue;
      const text = assistantText(record.content);
      if (text) last = text;
    } catch {
      // Ignore incomplete lines appended during a live session.
    }
  }
  return last;
}
