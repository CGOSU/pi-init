import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const diagnosticRoot = (agent = getAgentDir()) => join(agent, "diagnostics", "pi-init");
const hash = (value) => createHash("sha256").update(value).digest("hex");
export const projectKey = (cwd) => hash("pi-init-project-v1\0" + resolve(cwd));
export const sessionKey = (cwd, id) => hash("pi-init-session-v1\0" + projectKey(cwd) + "\0" + id);

export function diagnosticPath(scope, ctx, agent) {
  const root = diagnosticRoot(agent);
  if (scope === "global") return join(root, "runtime.jsonl");
  return join(root, scope === "project" ? "sessions" : "handoff", projectKey(ctx.cwd), sessionKey(ctx.cwd, ctx.sessionManager.getSessionId()) + ".jsonl");
}
