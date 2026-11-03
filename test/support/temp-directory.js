import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

async function withTempDirectory(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-init-"));
  try {
    await run(directory);
  } finally {
    // 交接诊断日志（PI_INIT_HANDOFF_LOG=1 时启用）异步写入 .pi/logs；
    // maxRetries 让清理等待仍在进行的写入，避免 ENOTEMPTY 误报。
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

export { withTempDirectory };
