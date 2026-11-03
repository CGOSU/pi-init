// Use the installed SDK recorder, not a hand-written approximation of its receipt contract.
import { NestedCallRecorder } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/nested-tool-calls.js";

export function sdkReceipt({ root = "root", count = 1, size = 9000, failed = false, unfinished = false } = {}) {
  const recorder = new NestedCallRecorder();
  for (let index = 1; index <= count; index++) {
    const call = recorder.start({ id: `${root}/${index}`, name: "write", arguments: { content: "x".repeat(size) } });
    if (!unfinished) recorder.finish(call, failed, failed ? "historical failure" : undefined);
  }
  return recorder.snapshot();
}
