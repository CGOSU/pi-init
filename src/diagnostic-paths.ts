import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

export type DiagnosticScope = "project" | "global" | "handoff";
export const DIAGNOSTIC_BASE = ["diagnostics", "pi-init"] as const;
export const DIAGNOSTIC_STREAMS = { project: "sessions", handoff: "handoff" } as const;
export const SIDECAR_LIMIT = 128;
export const DIAGNOSTIC_RETENTION_MS = 7 * 86_400_000;
export const DIAGNOSTIC_MAX_BYTES = 2 * 1024 * 1024;
// Bound traversal even if foreign files are placed in the managed tree.
export const DIAGNOSTIC_ENTRY_LIMIT = SIDECAR_LIMIT * 3;
export const DIAGNOSTIC_FILENAME = /^([a-f0-9]{64})\.jsonl(?:\.1)?$/;

function hash(domain: string, value: string) {
  return createHash("sha256").update(domain + "\0" + value).digest("hex");
}

export function diagnosticProjectKey(cwd: string) {
  return hash("pi-init-project-v1", resolve(cwd));
}

export function diagnosticKeys(cwd: string, sessionId: string) {
  const projectKey = diagnosticProjectKey(cwd);
  return { projectKey, sessionKey: hash("pi-init-session-v1", projectKey + "\0" + sessionId) };
}

export function isDiagnosticSessionKey(key: string) { return /^[a-f0-9]{64}$/.test(key); }

export function diagnosticLocation(root: string, scope: DiagnosticScope, cwd: string, sessionKey?: string) {
  root = resolve(root);
  const parts: string[] = [...DIAGNOSTIC_BASE];
  if (scope !== "global") parts.push(DIAGNOSTIC_STREAMS[scope], diagnosticProjectKey(cwd));
  const name = scope === "global" ? "runtime.jsonl" : sessionKey === undefined ? undefined : sessionKey + ".jsonl";
  if (scope !== "global" && sessionKey !== undefined && !isDiagnosticSessionKey(sessionKey)) {
    throw Object.assign(new Error("会话标识不是诊断会话键"), { code: "INVALID_DIAGNOSTIC_SESSION" });
  }
  const lock = scope === "global" ? "runtime.lock" : "sidecar.lock";
  return { root, scope, parts, name, lock, path: join(root, ...parts, ...(name ? [name] : [])) } as const;
}
