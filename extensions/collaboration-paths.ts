import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { CollaborationDirs } from "./collaboration-types.ts";

function homeDirectory(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

export function resolveCollaborationDirs(): CollaborationDirs {
  const base = process.env.COLLABORATING_AGENTS_DIR?.trim()
    || join(homeDirectory(), ".pi", "agent", "collaborating-agents");
  return {
    base,
    registry: join(base, "registry"),
    inbox: join(base, "inbox"),
    runs: join(base, "runs"),
    messageLog: join(base, "messages.jsonl"),
  };
}

export function ensureCollaborationDirs(dirs = resolveCollaborationDirs()): CollaborationDirs {
  mkdirSync(dirs.base, { recursive: true });
  mkdirSync(dirs.registry, { recursive: true });
  mkdirSync(dirs.inbox, { recursive: true });
  mkdirSync(dirs.runs, { recursive: true });
  return dirs;
}
