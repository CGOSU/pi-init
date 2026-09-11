import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import type {
  CollaborationDirs,
  InboxMessage,
  MessageLogEvent,
} from "./collaboration-types.ts";
import { ensureCollaborationDirs } from "./collaboration-paths.ts";
import {
  getReservationConflicts,
  listActiveAgents,
  resolveAgentName,
} from "./collaboration-registry.ts";

function safeName(value: string): boolean {
  return Boolean(value) && !/[\\/\0]/.test(value);
}

function readJson<T>(filePath: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function inboxPath(dirs: CollaborationDirs, name: string): string {
  return join(dirs.inbox, name);
}

function appendLog(dirs: CollaborationDirs, event: MessageLogEvent): void {
  ensureCollaborationDirs(dirs);
  try {
    fs.appendFileSync(dirs.messageLog, `${JSON.stringify(event)}\n`, "utf8");
  } catch {
    // A message remains in the inbox even if the append-only log is unavailable.
  }
}

function enqueue(dirs: CollaborationDirs, message: InboxMessage): void {
  if (!safeName(message.to)) throw new Error("invalid recipient name");
  const directory = inboxPath(dirs, message.to);
  fs.mkdirSync(directory, { recursive: true });
  const base = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const temporary = join(directory, `${base}.tmp`);
  const target = join(directory, `${base}.json`);
  fs.writeFileSync(temporary, JSON.stringify(message, null, 2), "utf8");
  try {
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
}

export function readMessageLog(dirs: CollaborationDirs): MessageLogEvent[] {
  if (!fs.existsSync(dirs.messageLog)) return [];
  const content = fs.readFileSync(dirs.messageLog, "utf8");
  const events: MessageLogEvent[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as MessageLogEvent;
      if (parsed && typeof parsed.id === "string") events.push(parsed);
    } catch {
      // A concurrently appended partial line is ignored until a later read.
    }
  }
  return events;
}

export function readMessageLogTail(dirs: CollaborationDirs, limit = 20): MessageLogEvent[] {
  return limit > 0 ? readMessageLog(dirs).slice(-Math.floor(limit)) : [];
}

export function sendDirect(
  dirs: CollaborationDirs,
  from: string,
  to: string,
  text: string,
  options: { urgent?: boolean; replyTo?: string } = {},
): { ok: true; id: string } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Message is empty" };
  const resolved = resolveAgentName(dirs, to);
  if (!resolved.ok) return resolved;
  if (resolved.name === from) return { ok: false, error: "Cannot send direct message to yourself" };
  const timestamp = new Date().toISOString();
  const message: InboxMessage = {
    id: randomUUID(),
    from,
    to: resolved.name,
    text: trimmed,
    kind: "direct",
    timestamp,
    urgent: options.urgent === true,
    replyTo: options.replyTo ?? null,
  };
  try {
    enqueue(dirs, message);
    appendLog(dirs, { ...message, to: resolved.name });
    return { ok: true, id: message.id };
  } catch (error) {
    return { ok: false, error: `Failed to send direct message: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function sendBroadcast(
  dirs: CollaborationDirs,
  from: string,
  text: string,
  urgent = false,
): { ok: true; delivered: string[]; failed: string[] } | { ok: false; error: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, error: "Message is empty" };
  const recipients = listActiveAgents(dirs, from).map((agent) => agent.name);
  if (recipients.length === 0) return { ok: false, error: "No active recipients" };
  const id = randomUUID();
  const timestamp = new Date().toISOString();
  const delivered: string[] = [];
  const failed: string[] = [];
  for (const to of recipients) {
    try {
      enqueue(dirs, { id, from, to, text: trimmed, kind: "broadcast", timestamp, urgent });
      delivered.push(to);
    } catch {
      failed.push(to);
    }
  }
  appendLog(dirs, { id, from, to: "all", text: trimmed, kind: "broadcast", timestamp, urgent, recipients });
  return { ok: true, delivered, failed };
}

export function processInbox(
  dirs: CollaborationDirs,
  selfName: string,
  onMessage: (message: InboxMessage) => void,
): number {
  if (!safeName(selfName)) return 0;
  const directory = inboxPath(dirs, selfName);
  fs.mkdirSync(directory, { recursive: true });
  const quarantine = join(directory, ".invalid");
  let delivered = 0;
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
    const filePath = join(directory, name);
    let message: InboxMessage | undefined;
    try {
      message = JSON.parse(fs.readFileSync(filePath, "utf8")) as InboxMessage;
    } catch {
      fs.mkdirSync(quarantine, { recursive: true });
      fs.renameSync(filePath, join(quarantine, `${Date.now()}-${name}`));
      continue;
    }
    if (!message || typeof message.id !== "string" || typeof message.text !== "string" || message.to !== selfName) {
      fs.mkdirSync(quarantine, { recursive: true });
      fs.renameSync(filePath, join(quarantine, `${Date.now()}-${name}`));
      continue;
    }
    try {
      onMessage(message);
      fs.rmSync(filePath, { force: true });
      delivered += 1;
    } catch {
      // Keep the inbox item for a later retry if delivery failed.
    }
  }
  return delivered;
}

export function reservationConflictsForMessage(
  dirs: CollaborationDirs,
  selfName: string,
  path: string,
  cwd: string,
) {
  return getReservationConflicts(dirs, selfName, path, cwd);
}
