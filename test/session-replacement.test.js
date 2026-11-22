import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  commitTransferDecision,
  findTransferTarget,
  readHandoffArchiveCached,
  readTransferDecision,
  withTransferLock,
} from "../extensions/session/session-replacement.ts";
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

test("transfer coordination lock and decision are atomic, idempotent, and fail-closed on symlinks or corruption", async () => {
  await withTempDirectory(async cwd => {
    const dir = path.join(cwd, "sessions");
    await mkdir(dir, { recursive: true });
    const sourceFile = path.join(dir, "source.jsonl");
    await writeFile(sourceFile, JSON.stringify({ type: "session", id: "src-1" }) + "\n");

    const key1 = { sourceFile, customType: "pi-init-session-handoff", sourceSessionId: "src-1", intentId: "intent-1" };
    assert.deepEqual(readTransferDecision(key1), { ok: true, decision: undefined });

    const activated = await withTransferLock(key1, () => commitTransferDecision(key1, {
      decision: "activated",
      targetSessionId: "tgt-a",
      targetFile: path.join(dir, "tgt-a.jsonl"),
    }));
    assert.equal(activated.ok, true);
    assert.equal(readTransferDecision(key1).decision?.decision, "activated");
    assert.equal(commitTransferDecision(key1, { decision: "activated", targetSessionId: "tgt-a" }).ok, true);
    assert.equal(commitTransferDecision(key1, { decision: "activated", targetSessionId: "tgt-b" }).code, "TRANSFER_ALREADY_ACTIVATED");
    assert.equal(commitTransferDecision(key1, { decision: "cancelled" }).code, "TRANSFER_ALREADY_ACTIVATED");

    const key2 = { sourceFile, customType: "pi-init-session-handoff", sourceSessionId: "src-1", intentId: "intent-2" };
    assert.equal((await withTransferLock(key2, () => commitTransferDecision(key2, { decision: "cancelled" }))).ok, true);
    assert.equal(commitTransferDecision(key2, { decision: "cancelled" }).ok, true);
    assert.equal(commitTransferDecision(key2, { decision: "activated", targetSessionId: "tgt-c" }).code, "TRANSFER_ALREADY_CANCELLED");

    const corruptKey = { sourceFile, customType: "pi-init-session-handoff", sourceSessionId: "src-1", intentId: "intent-corrupt" };
    const digest = createHash("sha256").update(JSON.stringify([corruptKey.customType, corruptKey.sourceSessionId, corruptKey.intentId])).digest("hex");
    await writeFile(path.join(dir, ".pi-init-transfers", `${digest}.decision.json`), "{broken");
    assert.equal(readTransferDecision(corruptKey).code, "TRANSFER_DECISION_CORRUPT");
    assert.equal(commitTransferDecision(corruptKey, { decision: "cancelled" }).code, "TRANSFER_DECISION_CORRUPT");

    const linkKey = { sourceFile, customType: "pi-init-session-handoff", sourceSessionId: "src-1", intentId: "intent-link" };
    const linkDigest = createHash("sha256").update(JSON.stringify([linkKey.customType, linkKey.sourceSessionId, linkKey.intentId])).digest("hex");
    const external = path.join(cwd, "outside.json");
    await writeFile(external, JSON.stringify({ version: 1, customType: linkKey.customType, id: linkKey.intentId, sourceSessionId: linkKey.sourceSessionId, decision: "cancelled", decidedAt: Date.now() }));
    await symlink(external, path.join(dir, ".pi-init-transfers", `${linkDigest}.decision.json`));
    assert.equal(readTransferDecision(linkKey).code, "UNSAFE_TRANSFER_LOCK_PATH");
  });

  await withTempDirectory(async cwd => {
    const dir = path.join(cwd, "sessions");
    await mkdir(dir, { recursive: true });
    const sourceFile = path.join(dir, "source.jsonl");
    await writeFile(sourceFile, JSON.stringify({ type: "session", id: "src-sym" }) + "\n");
    const outsideDir = path.join(cwd, "outside-coord");
    await mkdir(outsideDir);
    await symlink(outsideDir, path.join(dir, ".pi-init-transfers"));
    const key = { sourceFile, customType: "pi-init-session-handoff", sourceSessionId: "src-sym", intentId: "intent-sym" };
    assert.equal(readTransferDecision(key).code, "UNSAFE_TRANSFER_LOCK_PATH");
    await assert.rejects(() => withTransferLock(key, () => "never"), error => error.code === "UNSAFE_TRANSFER_LOCK_PATH");
  });
});

test("withTransferLock serializes concurrent callers and fails closed with TRANSFER_LOCK_BUSY on timeout", async () => {
  await withTempDirectory(async cwd => {
    const dir = path.join(cwd, "sessions");
    await mkdir(dir, { recursive: true });
    const sourceFile = path.join(dir, "source.jsonl");
    await writeFile(sourceFile, JSON.stringify({ type: "session", id: "src-lock" }) + "\n");
    const key = { sourceFile, customType: "pi-init-session-handoff", sourceSessionId: "src-lock", intentId: "intent-lock" };

    const events = [];
    const firstEntered = Promise.withResolvers();
    const releaseFirst = Promise.withResolvers();
    const first = withTransferLock(key, async () => {
      events.push("first:start");
      firstEntered.resolve();
      await releaseFirst.promise;
      events.push("first:end");
      return "first";
    });
    await firstEntered.promise;
    const second = withTransferLock(key, async () => {
      events.push("second:start");
      events.push("second:end");
      return "second";
    });
    await assert.rejects(
      () => withTransferLock(key, () => "busy", { attempts: 2, delayMs: 5 }),
      error => error.code === "TRANSFER_LOCK_BUSY",
    );
    releaseFirst.resolve();
    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  });
});
