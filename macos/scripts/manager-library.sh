#!/bin/bash
# Only the bundled core supplies these arguments; the platform operation lock serializes all writes.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"
. "$SCRIPT_DIR/theme-switch-lock-macos.sh"
APPLICATION_ROOT="${1:-}"
REQUEST_PATH="${2:-}"
[ "$#" -eq 2 ] && [ "${APPLICATION_ROOT:0:1}" = / ] || fail "Invalid library arguments."
acquire_theme_switch_lock "$(new_operation_token)"
trap 'release_theme_switch_lock' EXIT
export CODEX_MANAGER_LIBRARY_LOCK_HELD=1
"$APPLICATION_ROOT/runtime/node/node" "$APPLICATION_ROOT/shared/core/library-worker.mjs" "$APPLICATION_ROOT" "$REQUEST_PATH"
