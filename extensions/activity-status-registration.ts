import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCacheStatus } from "./diagnostics/cache-status.ts";
import { registerActivityStatus } from "./activity-status.ts";
import { registerActivityLifecycle } from "./activity-lifecycle.ts";
import { registerSessionWorkTime } from "./session/session-work-time-runtime.ts";

export function registerActivityStatusSources(pi: ExtensionAPI) {
  const activityStatus = registerActivityStatus(pi);
  createCacheStatus(pi, activityStatus);
  registerActivityLifecycle(pi, activityStatus);
  registerSessionWorkTime(pi, activityStatus);
  return activityStatus;
}
