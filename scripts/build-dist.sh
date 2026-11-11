#!/usr/bin/env bash
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
output="${1:-"$root/dist"}"
if [[ "$output" != /* ]]; then
  output="$PWD/$output"
fi
if [[ $# -gt 1 ]]; then
  echo "用法：npm run build:dist -- [空输出目录]" >&2
  exit 1
fi
if [[ -e "$output" ]] && { [[ ! -d "$output" ]] || [[ -n "$(ls -A -- "$output")" ]]; }; then
  echo "输出目录必须不存在或为空，拒绝覆盖：$output" >&2
  exit 1
fi

temporary="$(mktemp -d)"
trap 'rm -rf -- "$temporary"' EXIT
cd -- "$root"
npm pack --json --ignore-scripts --pack-destination "$temporary" > "$temporary/manifest.json"
archive="$(node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [archive] = JSON.parse(readFileSync(process.argv[1], "utf8"));
  console.log(archive.filename);
' "$temporary/manifest.json")"

mkdir -p -- "$output"
tar -xzf "$temporary/$archive" --strip-components=1 -C "$output"
node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const file = process.argv[1];
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  delete manifest.devDependencies;
  for (const name of ["test", "typecheck", "pack:plugin", "build:dist"]) {
    delete manifest.scripts[name];
  }
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
' "$output/package.json"
echo "已生成精简 Git 分发目录：$output"
