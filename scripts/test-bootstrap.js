import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each process owns only this fresh directory. Never clean an inherited path,
// including a caller's PI_CODING_AGENT_DIR; fixtures may override it afterwards.
const directory = mkdtempSync(join(tmpdir(), "pi-init-test-agent-"));
process.env.PI_CODING_AGENT_DIR = directory;
process.once("exit", () => {
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* Interrupted tests may leave their temporary directory. */ }
});
