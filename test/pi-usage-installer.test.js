import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
