import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { realpathSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { readHandoffArchiveCached } from "../extensions/session/session-replacement.ts";
import { withTempDirectory } from "./support/temp-directory.js";

test("cached archive reads reuse an unchanged source and re-read once it changes", async () => {
  await withTempDirectory(async cwd => {
    const root = realpathSync(cwd);
    const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
    manager.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
    const file = manager.getSessionFile();
    const first = readHandoffArchiveCached(file, root, manager.getSessionId());
    assert.equal(first.ok, true);
    assert.equal(readHandoffArchiveCached(file, root, manager.getSessionId()).value, first.value);
    manager.appendCustomEntry("probe", { n: 1 });
    const changed = readHandoffArchiveCached(file, root, manager.getSessionId());
    assert.equal(changed.ok, true);
    assert.notEqual(changed.value, first.value);
    assert.ok(changed.value.getEntry(manager.getLeafId()), "the re-read manager sees the appended entry");
  });
});

test("cached archive reads still reject a session identity mismatch", async () => {
  await withTempDirectory(async cwd => {
    const root = realpathSync(cwd);
    const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
    manager.appendMessage({ role: "user", content: "source", timestamp: Date.now() });
    assert.equal(readHandoffArchiveCached(manager.getSessionFile(), root, manager.getSessionId()).ok, true);
    assert.equal(readHandoffArchiveCached(manager.getSessionFile(), root, "another-session").ok, false);
  });
});
