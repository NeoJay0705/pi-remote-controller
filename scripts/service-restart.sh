#!/usr/bin/env bash
set -euo pipefail

if (($# != 0)); then
  printf 'service:restart: unexpected arguments\n' >&2
  exit 2
fi

repo_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
instance="$repo_root/.test-artifacts/live-instance"
cd "$repo_root"

exec 9>"$instance/service-restart.lock"
if ! /usr/bin/flock -n 9; then
  printf 'service:restart: another operation is in progress\n' >&2
  exit 1
fi

run_stage() {
  local stage=$1
  shift
  printf 'service:restart: %s\n' "$stage"
  if "$@" 9>&-; then
    return 0
  else
    local status=$?
    printf 'service:restart: %s failed (exit %s)\n' "$stage" "$status" >&2
    exit "$status"
  fi
}

run_stage stop node "$instance/stop.mjs"
run_stage build npm run build
run_stage start node "$instance/start.mjs"
