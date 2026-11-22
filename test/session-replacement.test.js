import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { realpathSync } from "node:fs";
import { symlink, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { findTransferTarget, readHandoffArchiveCached } from "../extensions/session/session-replacement.ts";
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

test("findTransferTarget handles missing source, large siblings via prefix scan, and symlinks", async () => {
  await withTempDirectory(async cwd => {
    const missing = findTransferTarget(path.join(cwd, "missing.jsonl"), "pi-init-general-transfer", "intent-1");
    assert.match(missing.incomplete ?? "", /无法核对来源会话文件/);

    const source = path.join(cwd, "source.jsonl");
    await writeFile(source, JSON.stringify({ type: "session", id: "src" }) + "\n");

    const largeTarget = path.join(cwd, "target.jsonl");
    const incomingLine = JSON.stringify({
      type: "custom",
      customType: "pi-init-general-transfer",
      data: { kind: "incoming", id: "intent-large" },
    });
    const trailingLine = JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(300 * 1024) } });
    await writeFile(largeTarget, incomingLine + "\n" + trailingLine + "\n");
    assert.equal(findTransferTarget(source, "pi-init-general-transfer", "intent-large").found, largeTarget);

    const external = path.join(cwd, "external.target");
    await writeFile(external, JSON.stringify({
      type: "custom",
      customType: "pi-init-general-transfer",
      data: { kind: "incoming", id: "intent-symlink" },
    }) + "\n");
    await symlink(external, path.join(cwd, "linked.jsonl"));
    const linked = findTransferTarget(source, "pi-init-general-transfer", "intent-symlink");
    assert.equal(linked.found, undefined);
    assert.match(linked.incomplete ?? "", /linked\.jsonl/);
  });
});
