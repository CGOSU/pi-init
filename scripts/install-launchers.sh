#!/usr/bin/env sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
pi_path=$(command -v pi || true)
if [ -z "$pi_path" ]; then
  printf '%s\n' '找不到 pi。请先安装 Pi，并确保其目录已加入 PATH。' >&2
  exit 1
fi

pi_dir=$(dirname -- "$pi_path")
if [ ! -w "$pi_dir" ]; then
  pi_dir=${XDG_BIN_HOME:-"$HOME/.local/bin"}
  mkdir -p "$pi_dir"
  case ":${PATH:-}:" in
    *:"$pi_dir":*) ;;
    *) printf '请将 %s 加入 PATH 后重新打开 shell。\n' "$pi_dir" >&2 ;;
  esac
fi

install -m 755 "$source_dir/pi-fast.sh" "$pi_dir/pi-fast"
install -m 755 "$source_dir/pi-update.sh" "$pi_dir/pi-update"
printf '已安装到：%s\n日常启动：pi-fast\n更新扩展：pi-update\n' "$pi_dir"
