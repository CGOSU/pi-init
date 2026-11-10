import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { installLaunchers } from "../scripts/install-launchers.js";
import { parseArguments, PI_USAGE_VERSION } from "../scripts/pi-usage.js";
import { withTempDirectory } from "./support/temp-directory.js";

test("跨平台 Pi 用量统计启动器指向共享脚本", async () => {
  const files = {
    windowsUsage: await readFile(path.join(process.cwd(), "scripts", "pi-usage.cmd"), "utf8"),
    posixUsage: await readFile(path.join(process.cwd(), "scripts", "pi-usage.sh"), "utf8"),
  };

  assert.match(files.windowsUsage, /pi-usage\.js/);
  assert.match(files.posixUsage, /pi-usage\.js/);
});

test("pi-init 与 pi-usage 共用版本号", async () => {
  const packageManifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
  assert.equal(PI_USAGE_VERSION, packageManifest.version);
});

test("Pi package 更新时自动刷新 pi-usage 启动器", async () => {
  await withTempDirectory(async (directory) => {
    const packageManifest = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"));
    assert.equal(packageManifest.scripts.postinstall, "node scripts/install-launchers.js");

    assert.equal(await installLaunchers({ targetDir: directory, platform: "win32" }), true);
    assert.equal(await installLaunchers({ targetDir: directory, platform: "linux" }), true);
    assert.match(await readFile(path.join(directory, "pi-usage.cmd"), "utf8"), /pi-usage\.js/);
    assert.match(await readFile(path.join(directory, "pi-usage"), "utf8"), /pi-usage\.js/);
    const installedUsage = await readFile(path.join(directory, "pi-usage.js"), "utf8");
    const installedVersion = await readFile(path.join(directory, "pi-usage-lib", "version.js"), "utf8");
    const installedCore = await readFile(path.join(directory, "pi-usage-lib", "core.js"), "utf8");
    assert.match(installedUsage, /\.\/pi-usage-lib\/version\.js/);
    assert.match(installedCore, /DUCKDB_PACKAGE/);
    assert.ok(installedVersion.includes(`const EMBEDDED_PACKAGE_VERSION = "${packageManifest.version}";`));
  });
});

test("npm 生命周期 PATH 中的本地 pi shim 不会遮蔽实际 Pi 目录", async () => {
  await withTempDirectory(async (directory) => {
    // 跨平台文件系统行为必须在宿主平台上验证：用 POSIX 目录配 path.win32 会拼出宿主无法命中的路径，
    // 使 findPiPath 直接返回 undefined，从而掩盖真正的 PATH 排除逻辑。
    const platform = process.platform;
    const commandName = platform === "win32" ? "pi.cmd" : "pi";
    const pathSeparator = platform === "win32" ? ";" : ":";
    const packageDir = path.join(directory, "package");
    const sourceDir = path.join(packageDir, "scripts");
    const localBinDir = path.join(packageDir, "node_modules", ".bin");
    const actualPiDir = path.join(directory, "pi-bin");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(localBinDir, { recursive: true });
    await mkdir(actualPiDir, { recursive: true });
    await writeFile(path.join(packageDir, "package.json"), JSON.stringify({ version: "test-version" }));
    await writeFile(
      path.join(sourceDir, "pi-usage.js"),
      await readFile(path.join(process.cwd(), "scripts", "pi-usage.js")),
    );
    await writeFile(
      path.join(sourceDir, "pi-usage.cmd"),
      await readFile(path.join(process.cwd(), "scripts", "pi-usage.cmd")),
    );
    await writeFile(
      path.join(sourceDir, "pi-usage.sh"),
      await readFile(path.join(process.cwd(), "scripts", "pi-usage.sh")),
    );
    const supportSourceDir = path.join(process.cwd(), "scripts", "pi-usage");
    const supportTargetDir = path.join(sourceDir, "pi-usage");
    await mkdir(supportTargetDir, { recursive: true });
    for (const supportFile of [
      "version.js",
      "core.js",
      "database.js",
      "refresh.js",
      "query.js",
      "report.js",
      "bill.js",
      "cli.js",
    ]) {
      await writeFile(
        path.join(supportTargetDir, supportFile),
        await readFile(path.join(supportSourceDir, supportFile), "utf8"),
      );
    }
    await writeFile(path.join(localBinDir, commandName), "local npm shim");
    await writeFile(path.join(actualPiDir, commandName), "actual Pi CLI");

    assert.equal(
      await installLaunchers({
        sourceDir,
        platform,
        pathValue: [localBinDir, actualPiDir].join(pathSeparator),
      }),
      true,
    );
    const installedVersion = await readFile(path.join(actualPiDir, "pi-usage-lib", "version.js"), "utf8");
    assert.ok(installedVersion.includes('const EMBEDDED_PACKAGE_VERSION = "test-version";'));
    await assert.rejects(readFile(path.join(localBinDir, "pi-usage.js")));
  });
});

test("pi-usage SVG 输出复用查询时间范围", () => {
  const parsed = parseArguments(["yesterday", "--output", "bill.svg"], "agent");
  assert.equal(parsed.outputPath, "bill.svg");
  assert.deepEqual(parsed.rangeArguments, ["yesterday"]);
  assert.equal(parsed.databasePath, path.join("agent", "pi-usage.duckdb"));
  assert.deepEqual(parseArguments(["7d", "--output", "range.svg"], "agent").rangeArguments, ["7d"]);
  assert.deepEqual(
    parseArguments(["2026-08-01", "2026-08-25", "--output", "month.svg"], "agent").rangeArguments,
    ["2026-08-01", "2026-08-25"],
  );
  assert.throws(() => parseArguments(["--output"], "agent"), /--output 需要输出路径/);
  assert.throws(() => parseArguments(["--output", "bill.png"], "agent"), /--output 目前仅支持 \.svg 文件/);
});

test("manual installer reports failure instead of returning success", async () => {
  await withTempDirectory(async (directory) => {
    const file = path.join(directory, "not-a-directory");
    await writeFile(file, "keep");
    const result = spawnSync(process.execPath, ["scripts/install-launchers.js", "--target-dir", file], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(file, "utf8"), "keep");
  });
});

for (const args of [["--unknown"], ["--target-dir"], ["--target-dir", "TARGET", "--unknown"]]) {
  test(`invalid installer arguments are rejected before side effects: ${args.join(" ")}`, async () => {
    await withTempDirectory(async (directory) => {
      const result = spawnSync(process.execPath, ["scripts/install-launchers.js", ...args.map(arg => arg === "TARGET" ? directory : arg)], {
        encoding: "utf8", env: { ...process.env, PATH: directory },
      });
      assert.notEqual(result.status, 0);
      await assert.rejects(readFile(path.join(directory, "pi-usage.js")), { code: "ENOENT" });
    });
  });
}

for (const platform of ["win32", "linux"]) {
  test(`installed ${platform} module tree executes without the source package`, async () => {
    await withTempDirectory(async (directory) => {
      installLaunchers({ targetDir: directory, platform });
      const output = execFileSync(process.execPath, [path.join(directory, "pi-usage.js"), "--db", path.join(directory, "usage.duckdb")], {
        encoding: "utf8", env: {
          ...process.env, NODE_PATH: path.join(process.cwd(), "node_modules"),
          PI_CODING_AGENT_DIR: path.join(directory, "agent"), PI_CODING_AGENT_SESSION_DIR: path.join(directory, "sessions"),
        },
      });
      assert.ok(output.includes(PI_USAGE_VERSION));
    });
  });
}

test("POSIX 安装脚本会安装 pi-usage 所需的共享模块", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-usage-installer-"));
  try {
    const binDirectory = path.join(directory, "bin");
    await mkdir(binDirectory);
    const piPath = path.join(binDirectory, "pi");
    await writeFile(piPath, "#!/bin/sh\n");
    await chmod(piPath, 0o755);

    const installer = fileURLToPath(new URL("../scripts/install-launchers.sh", import.meta.url));
    const output = execFileSync("sh", [installer], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: [binDirectory, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
      },
    });

    const installedCli = await readFile(path.join(binDirectory, "pi-usage.js"), "utf8");
    const installedLauncher = await readFile(path.join(binDirectory, "pi-usage"), "utf8");
    const installedCore = await readFile(path.join(binDirectory, "pi-usage-lib", "core.js"), "utf8");
    assert.match(output, /已安装到/);
    assert.match(installedLauncher, /pi-usage\.js/);
    assert.match(installedCli, /\.\/pi-usage-lib\/cli\.js/);
    assert.match(installedCore, /DUCKDB_PACKAGE/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
