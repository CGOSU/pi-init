#!/usr/bin/env sh
set -eu
unset PI_OFFLINE
if [ "$#" -eq 0 ]; then
  exec pi update --extensions
fi
exec pi update "$@"
