#!/bin/bash

set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"
assert_codex_user_environment || exit 1
. "$SCRIPT_DIR/theme-switch-lock-macos.sh"

PORT=9341
PORT_EXPLICIT="false"
RESTORE_BASE_THEME="false"
RESTART_CODEX="false"
UNINSTALL="false"
LOCK_TOKEN=""
MANAGER_REQUEST=""
MANAGER_APPLICATION_ROOT=""
MANAGER_PRECONDITION=""
MANAGER_MAINTENANCE="false"
RESTORE_EFFECT=false
DETACH_EFFECT=false
ARCHIVE_EFFECT=false
RESTART_EFFECT=false
RENDERER_EFFECT=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --port) PORT="${2:-}"; PORT_EXPLICIT="true"; shift 2 ;;
    --restore-base-theme) RESTORE_BASE_THEME="true"; shift ;;
    --restart-codex) RESTART_CODEX="true"; shift ;;
    --uninstall) UNINSTALL="true"; shift ;;
    --lock-token) LOCK_TOKEN="${2:-}"; shift 2 ;;
    --manager-request) MANAGER_REQUEST="${2:-}"; shift 2 ;;
    --manager-application-root) MANAGER_APPLICATION_ROOT="${2:-}"; shift 2 ;;
    --manager-precondition) MANAGER_PRECONDITION="${2:-}"; shift 2 ;;
    --manager-maintenance) MANAGER_MAINTENANCE="true"; shift ;;
    *) fail "Unknown restore argument: $1" ;;
  esac
done
restore_exit() {
  release_theme_switch_lock
  if [ -n "$MANAGER_REQUEST" ]; then
    "$MANAGER_APPLICATION_ROOT/runtime/node/node" -e '
const b=v=>v==="null"?null:v==="true";process.stdout.write(JSON.stringify({effects:{themeCommitted:false,rendererApplied:b(process.argv[5]),codexRestarted:b(process.argv[4]),pausedCommitted:false,rendererRemoved:null,appearanceRestored:b(process.argv[1]),runtimeDetached:b(process.argv[2]),backupArchived:b(process.argv[3])},committedRevision:null,verifiedRendererRevision:null,runtimeSessionId:null,rendererUnavailable:false})+"\n")
' "$RESTORE_EFFECT" "$DETACH_EFFECT" "$ARCHIVE_EFFECT" "$RESTART_EFFECT" "$RENDERER_EFFECT"
  fi
}
trap restore_exit EXIT
if [ -n "$MANAGER_REQUEST" ]; then
  [ "$RESTORE_BASE_THEME" = true ] && [ "$RESTART_CODEX" = true ] && [ "$UNINSTALL" = false ] &&
    [ -n "$MANAGER_APPLICATION_ROOT" ] && [ -n "$MANAGER_PRECONDITION" ] && [ -n "$LOCK_TOKEN" ] || fail "Invalid shared restore invocation."
fi
if [ "$MANAGER_MAINTENANCE" = true ]; then
  [ "${CODEX_MANAGER_RUNTIME_INTERNAL:-}" = 1 ] && [ "$RESTORE_BASE_THEME" = true ] &&
    [ "$RESTART_CODEX" = true ] && [ "$UNINSTALL" = true ] && [ -n "$LOCK_TOKEN" ] &&
    [ -z "$MANAGER_REQUEST" ] && [ "$PORT_EXPLICIT" = false ] || fail "Invalid shared maintenance restore invocation."
  assert_inherited_theme_switch_lock "$LOCK_TOKEN" "$PPID"
fi

# A native AppKit install deploys the engine before it validates Codex and the
# config. If that validation fails, the outer installer rolls the engine back;
# this branch also makes a stale partial engine safe to remove without asking
# for an official app or bundled Node that was never used to change config.
if [ "$UNINSTALL" = "true" ] && [ ! -e "$STATE_PATH" ] &&
    [ ! -e "$OPERATION_STATE_PATH" ] && [ ! -e "$OPERATION_ACK_PATH" ]; then
  if [ ! -e "$THEME_BACKUP_PATH" ]; then
    printf 'No active Dream Skin session or config backup was found; safe engine-only cleanup.\n'
    exit 0
  fi
  backup_appearance="$(/usr/bin/plutil -extract values.appearanceTheme raw -o - "$THEME_BACKUP_PATH" 2>/dev/null || true)"
  backup_dark_code="$(/usr/bin/plutil -extract values.appearanceDarkCodeThemeId raw -o - "$THEME_BACKUP_PATH" 2>/dev/null || true)"
  # Install may have pinned appearanceTheme even when the backup recorded no
  # original line; a pinned config still needs the full restore below.
  if [ "$backup_appearance" = "null" ] && [ "$backup_dark_code" = "null" ] &&
      ! /usr/bin/grep -E -q '^[[:space:]]*appearanceTheme[[:space:]]*=' "$CONFIG_PATH" 2>/dev/null; then
    # Shared maintenance keeps even a no-op installation backup for inspection.
    [ "$MANAGER_MAINTENANCE" = true ] || /bin/rm -f "$THEME_BACKUP_PATH"
    printf 'The install created no config overrides; safe engine-only cleanup.\n'
    exit 0
  fi
fi

discover_codex_app
require_macos_runtime
assert_codex_process_environment || exit 1
ensure_state_root
if [ -n "$LOCK_TOKEN" ]; then
  assert_inherited_theme_switch_lock "$LOCK_TOKEN" "$PPID"
else
  acquire_theme_switch_lock "$(new_operation_token)"
fi
if [ "$PORT_EXPLICIT" = "false" ] && [ -f "$STATE_PATH" ]; then
  PORT="$(state_field port)" || fail "Could not read the saved CDP port; state was preserved."
fi

if [ -n "$MANAGER_REQUEST" ]; then
  restore_probe="$(/bin/bash "$SCRIPT_DIR/manager-platform.sh" probe "$MANAGER_APPLICATION_ROOT")"
  restore_fingerprint="$("$NODE" -e 'process.stdout.write(JSON.parse(process.argv[1]).fingerprint)' "$restore_probe")"
  [ "$restore_fingerprint" = "$MANAGER_PRECONDITION" ] || fail "The confirmed restore session changed."
  "$MANAGER_APPLICATION_ROOT/runtime/node/node" "$MANAGER_APPLICATION_ROOT/shared/core/runtime-worker.mjs" check "$MANAGER_APPLICATION_ROOT" "$restore_probe" "$MANAGER_REQUEST" >/dev/null
  "$NODE" "$SCRIPT_DIR/theme-config.mjs" check-restore "$CONFIG_PATH" "$THEME_BACKUP_PATH" >/dev/null
  DETACH_EFFECT=null; RENDERER_EFFECT=null
  RESTORE_WAS_RUNNING="$("$NODE" -e 'process.stdout.write(String(JSON.parse(process.argv[1]).processRunning))' "$restore_probe")"
  [ "$RESTORE_WAS_RUNNING" != true ] || RESTART_EFFECT=null
fi
if [ -f "$STATE_PATH" ]; then
  stop_recorded_injector \
    || fail "Could not stop the recorded injector; restore state was preserved."
fi
# Always remove the themed ChatGPT launchd job so quitting ChatGPT stays quit.
release_codex_launchd_job || true
CODEX_RUNNING="false"
codex_is_running && CODEX_RUNNING="true"
[ -n "$MANAGER_REQUEST" ] || RESTORE_WAS_RUNNING="$CODEX_RUNNING"
DEBUG_READY="false"
verified_cdp_endpoint "$PORT" && DEBUG_READY="true"

if [ "$DEBUG_READY" = "true" ]; then
  "$NODE" "$INJECTOR" --remove --port "$PORT" --theme-dir "$THEME_DIR" --timeout-ms 8000 >/dev/null \
    || fail "The live skin could not be removed and verified; restore stopped safely."
elif [ "$CODEX_RUNNING" = "true" ] && [ "$RESTART_CODEX" = "false" ]; then
  fail "ChatGPT is still running but its saved CDP endpoint cannot be verified. Pass --restart-codex for a full restore."
fi

if [ "$RESTORE_BASE_THEME" = "true" ]; then
  if [ "$CODEX_RUNNING" = "true" ]; then
    [ "$RESTART_CODEX" = "true" ] \
      || fail "Close ChatGPT or pass --restart-codex before restoring config.toml."
    [ -z "$MANAGER_REQUEST" ] || RESTART_EFFECT=null
    stop_codex true
    CODEX_RUNNING="false"
  fi
  restore_mode=restore
  [ "$MANAGER_MAINTENANCE" = false ] || restore_mode=restore-archive
  if [ -n "$MANAGER_REQUEST" ]; then
    "$MANAGER_APPLICATION_ROOT/runtime/node/node" "$MANAGER_APPLICATION_ROOT/shared/core/runtime-worker.mjs" check-appearance "$MANAGER_APPLICATION_ROOT" '{}' "$MANAGER_REQUEST" >/dev/null
    RESTORE_EFFECT=null; ARCHIVE_EFFECT=null; restore_mode=restore-archive
  fi
  if [ -n "$MANAGER_REQUEST" ]; then
    restore_status=0
    restore_result="$("$NODE" "$SCRIPT_DIR/theme-config.mjs" "$restore_mode" "$CONFIG_PATH" "$THEME_BACKUP_PATH")" || restore_status=$?
    RESTORE_EFFECT="$("$NODE" -e 'const a=process.argv[1].trim().split("\n");process.stdout.write(String(JSON.parse(a[a.length-1]).effects.appearanceRestored))' "$restore_result")"
    ARCHIVE_EFFECT="$("$NODE" -e 'const a=process.argv[1].trim().split("\n");process.stdout.write(String(JSON.parse(a[a.length-1]).effects.backupArchived))' "$restore_result")"
    [ "$restore_status" -eq 0 ] || fail "Selective appearance restore or backup archive did not complete."
  else
    "$NODE" "$SCRIPT_DIR/theme-config.mjs" "$restore_mode" "$CONFIG_PATH" "$THEME_BACKUP_PATH" >/dev/null
  fi
fi

/bin/rm -f "$STATE_PATH"
clear_operation_state
/bin/rm -f "$OPERATION_ACK_PATH"
if [ -n "$MANAGER_REQUEST" ]; then
  [ ! -e "$STATE_PATH" ] && [ ! -e "$OPERATION_STATE_PATH" ] && [ ! -e "$OPERATION_ACK_PATH" ] && ! verified_cdp_endpoint "$PORT" || fail "The skin session did not detach."
  DETACH_EFFECT=true
fi
if [ "$RESTART_CODEX" = "true" ]; then
  [ "$CODEX_RUNNING" != "true" ] || { RESTART_EFFECT=null; stop_codex true; }
  RESTART_EFFECT=null
  launch_codex_normally
  if codex_is_running; then RESTART_EFFECT="$RESTORE_WAS_RUNNING"; fi
fi

[ -n "$MANAGER_REQUEST" ] || printf 'ChatGPT Dream Skin was removed and the requested macOS restore actions completed successfully.\n'
