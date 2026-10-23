import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { syncScaffold } from "../src/scaffold.ts";
for (const dryRun of [false, true]) {
    for (const state of [undefined, "invalid JSON", '{"schemaVersion":999}', '{"schemaVersion":1,"templateSchemaVersion":1,"managedBlocks":{}}']) {
        test("退役同步零写入 dryRun=" + dryRun + " state=" + state, async () => {
            const root = await mkdtemp(path.join(os.tmpdir(), "pi-init-retired-"));
            try {
                await mkdir(path.join(root, ".pi"));
                await mkdir(path.join(root, "docs"));
                const files = ["AGENTS.md", "docs/current-state.md", "docs/decisions.md", "docs/session-log.md", "docs/pitfalls.md", "docs/clean-code.md", ".pi/role-models.json"];
                const bytes = Buffer.from("# Custom\r\n<!-- pi-init:managed:start fast-path-wrap-up -->\r\nmodified, incomplete legacy block\0");
                for (const file of files)
                    await writeFile(path.join(root, file), bytes);
                if (state !== undefined)
                    await writeFile(path.join(root, ".pi/pi-init-state.json"), state);
                const before = await readdir(root, { recursive: true });
                await assert.rejects(syncScaffold(root, { dryRun, language: "invalid", roleModels: false }), { code: "TEMPLATE_SYNC_RETIRED" });
                assert.deepEqual(await readdir(root, { recursive: true }), before);
                for (const file of files)
                    assert.deepEqual(await readFile(path.join(root, file)), bytes);
                if (state !== undefined)
                    assert.equal(await readFile(path.join(root, ".pi/pi-init-state.json"), "utf8"), state);
                else
                    await assert.rejects(lstat(path.join(root, ".pi/pi-init-state.json")), { code: "ENOENT" });
                const missing = path.join(root, "missing");
                await assert.rejects(syncScaffold(missing, { dryRun }), { code: "TEMPLATE_SYNC_RETIRED" });
                await assert.rejects(lstat(missing), { code: "ENOENT" });
            }
            finally {
                await rm(root, { recursive: true, force: true });
            }
        });
    }
}
