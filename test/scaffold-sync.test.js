import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { syncScaffold, createScaffold } from "../src/scaffold.ts";
import { FAST_PATH_BLOCK, TEMPLATE_STATE_PATH, hashText, findManagedBlock } from "../src/template-sync.ts";

async function makeProject(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-init-sync-"));
  const target = path.join(root, name);
  await mkdir(target, { recursive: true });
  return { root, target };
}

async function cleanup(root) {
  await rm(root, { recursive: true, force: true });
}

function withoutManagedMarkers(content) {
  return content
    .replace(`${FAST_PATH_BLOCK.startMarker}\n`, "")
    .replace(`\n${FAST_PATH_BLOCK.endMarker}`, "");
}

test("同步老项目会插入托管区块、保留项目记忆并在第二次运行时幂等", async () => {
  const { root, target } = await makeProject("legacy-zh");
  try {
    await writeFile(
      path.join(target, "AGENTS.md"),
      "# Legacy\n\n## 项目规则\n\n保留的项目规则。\n\n## 会话收尾\n\n旧版收尾说明。\n",
      "utf8",
    );
    const history = "# 历史\n\n这段内容必须保留。\n";
    await mkdir(path.join(target, "docs"), { recursive: true });
    await writeFile(path.join(target, "docs/current-state.md"), history, "utf8");
    await writeFile(path.join(target, "docs/decisions.md"), history, "utf8");
    await writeFile(path.join(target, "docs/session-log.md"), history, "utf8");
    await writeFile(path.join(target, "docs/pitfalls.md"), history, "utf8");

    const first = await syncScaffold(target, { projectName: "Legacy" });
    assert.equal(first.conflicts.length, 0);
    assert.ok(first.updated.includes("AGENTS.md"));
    assert.ok(first.created.includes(TEMPLATE_STATE_PATH));
    assert.match(await readFile(path.join(target, "AGENTS.md"), "utf8"), /pi-init:managed:start fast-path-wrap-up/);
    for (const file of ["current-state.md", "decisions.md", "session-log.md", "pitfalls.md"]) {
      assert.equal(await readFile(path.join(target, "docs", file), "utf8"), history);
    }

    const second = await syncScaffold(target, { projectName: "Legacy" });
    assert.equal(second.changed, false);
    assert.deepEqual(second.created, []);
    assert.deepEqual(second.updated, []);
    assert.equal(second.conflicts.length, 0);
  } finally {
    await cleanup(root);
  }
});

test("同步英文项目并支持 dry-run，不写入文件", async () => {
  const { root, target } = await makeProject("legacy-en");
  try {
    await writeFile(path.join(target, "AGENTS.md"), "# Legacy\n\n## Session Wrap-up\n\nLegacy wrap-up.\n", "utf8");
    const preview = await syncScaffold(target, { language: "en", dryRun: true });
    assert.equal(preview.dryRun, true);
    assert.ok(preview.updated.includes("AGENTS.md"));
    assert.ok(preview.created.includes(TEMPLATE_STATE_PATH));
    assert.match(await readFile(path.join(target, "AGENTS.md"), "utf8"), /## Session Wrap-up/);
    await assert.rejects(readFile(path.join(target, TEMPLATE_STATE_PATH), "utf8"), { code: "ENOENT" });

    const result = await syncScaffold(target, { language: "en" });
    assert.equal(result.conflicts.length, 0);
    assert.match(await readFile(path.join(target, "AGENTS.md"), "utf8"), /Fast Path Wrap-up Priority/);
    const state = JSON.parse(await readFile(path.join(target, TEMPLATE_STATE_PATH), "utf8"));
    assert.equal(state.language, "en");
  } finally {
    await cleanup(root);
  }
});

test("本地修改托管区块时报告冲突并保持原文件和状态不变", async () => {
  const { root, target } = await makeProject("modified");
  try {
    await createScaffold(target, { projectName: "Modified" });
    const agentsPath = path.join(target, "AGENTS.md");
    const before = (await readFile(agentsPath, "utf8"))
      .replace("本节优先于下方通用会话收尾规则", "本地自定义规则");
    await writeFile(agentsPath, before, "utf8");
    const stateBefore = await readFile(path.join(target, TEMPLATE_STATE_PATH), "utf8");

    const result = await syncScaffold(target);
    assert.equal(result.changed, false);
    assert.deepEqual(result.conflicts.map(({ code }) => code), ["MANAGED_BLOCK_MODIFIED"]);
    assert.equal(await readFile(agentsPath, "utf8"), before);
    assert.equal(await readFile(path.join(target, TEMPLATE_STATE_PATH), "utf8"), stateBefore);
  } finally {
    await cleanup(root);
  }
});

test("没有状态文件的旧版托管区块被修改时不静默覆盖", async () => {
  const { root, target } = await makeProject("legacy-modified");
  try {
    await createScaffold(target, { projectName: "Legacy Modified" });
    const agentsPath = path.join(target, "AGENTS.md");
    const statePath = path.join(target, TEMPLATE_STATE_PATH);
    const legacy = withoutManagedMarkers(await readFile(agentsPath, "utf8"))
      .replace("本节优先于下方通用会话收尾规则", "旧项目自定义规则");
    await writeFile(agentsPath, legacy, "utf8");
    await rm(statePath);

    const result = await syncScaffold(target);
    assert.deepEqual(result.conflicts.map(({ code }) => code), ["LEGACY_BLOCK_MODIFIED"]);
    assert.equal(await readFile(agentsPath, "utf8"), legacy);
    await assert.rejects(readFile(statePath, "utf8"), { code: "ENOENT" });
  } finally {
    await cleanup(root);
  }
});

test("lightweight display changes bypass archive preload without weakening high-risk rules", async () => {
  for (const language of ["zh-CN", "en"]) {
    const { root, target } = await makeProject("light-" + language);
    try {
      await createScaffold(target, { projectName: "Light", language });
      const content = await readFile(path.join(target, "AGENTS.md"), "utf8");
      const block = findManagedBlock(content).content;
      assert.match(block, language === "en" ? /default grouping/ : /默认分组/);
      assert.match(block, language === "en" ? /before.*history|history.*before/ : /会话开始.*历史|历史.*会话开始/);
      assert.match(block, language === "en" ? /actual.*routing/ : /实际.*路由/);
      assert.match(block, language === "en" ? /explicit.*validation|explicit.*checks/ : /明确.*验证/);
    } finally { await cleanup(root); }
  }
});
test("known old managed policy updates without touching custom instructions or historical documents", async () => {
  const { root, target } = await makeProject("old-policy");
  try {
    await createScaffold(target, { projectName: "Custom" });
    const agentsPath = path.join(target, "AGENTS.md");
    const generated = await readFile(agentsPath, "utf8");
    const current = findManagedBlock(generated);
    const oldBlock = FAST_PATH_BLOCK.startMarker + "\n## Fast Path 收尾优先级\n\n旧规则：任何交互变化都退出。\n" + FAST_PATH_BLOCK.endMarker;
    const prefix = "# 自定义规则\n不要覆盖本段。\n\n";
    await writeFile(agentsPath, prefix + generated.slice(0, current.start) + oldBlock + generated.slice(current.end));
    const statePath = path.join(target, TEMPLATE_STATE_PATH);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    state.managedBlocks[FAST_PATH_BLOCK.id].hash = hashText(oldBlock);
    await writeFile(statePath, JSON.stringify(state));
    const historyPath = path.join(target, "docs/session-log.md");
    const history = await readFile(historyPath, "utf8");
    const result = await syncScaffold(target, { projectName: "Custom" });
    assert.equal(result.conflicts.length, 0);
    const updated = await readFile(agentsPath, "utf8");
    assert.ok(updated.startsWith(prefix));
    assert.match(findManagedBlock(updated).content, /默认分组/);
    assert.equal(await readFile(historyPath, "utf8"), history);
    assert.equal((await syncScaffold(target, { projectName: "Custom" })).changed, false);
  } finally { await cleanup(root); }
});
