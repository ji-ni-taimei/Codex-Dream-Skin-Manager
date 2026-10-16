#!/bin/bash
set -euo pipefail
[ "$#" -ge 1 ] || exit 2
[ "$#" = 3 ] && [ "$1" = execute ] || exit 2
application_root="$2"; request_file="$3"
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"
. "$SCRIPT_DIR/theme-switch-lock-macos.sh"
acquire_theme_switch_lock "$(new_operation_token)"
trap release_theme_switch_lock EXIT
worker="$application_root/shared/core/maintenance-worker.mjs"
manager_node="$application_root/runtime/node/node"
checked="$("$manager_node" "$worker" check "$application_root" "$request_file")"
maintenance_action="$("$manager_node" -e 'process.stdout.write(JSON.parse(process.argv[1]).action)' "$checked")"
case "$maintenance_action" in
  engine.install)
    /bin/bash "$SCRIPT_DIR/install-dream-skin-macos.sh" --no-launch --manager-lock "$THEME_SWITCH_LOCK_TOKEN" --manager-lock-owner "$$" >&2 ;;
  engine.uninstall)
    /bin/bash "$SCRIPT_DIR/restore-dream-skin-macos.sh" --restore-base-theme --restart-codex --uninstall --manager-maintenance --lock-token "$THEME_SWITCH_LOCK_TOKEN" >&2
    "$manager_node" "$worker" retain "$application_root" "$request_file" >&2 ;;
  *) exit 2 ;;
esac
printf '{"completed":true}\n'
