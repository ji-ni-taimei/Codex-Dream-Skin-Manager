#!/bin/bash
# Fixed manager adapter; preserve the old community transaction's lock and exact
# active snapshot rollback. No arbitrary URL, library path or shell input.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd -P)/common-macos.sh"
APPLICATION_ROOT="${1:-}"
REQUEST_PATH="${2:-}"
CORE_NODE="$APPLICATION_ROOT/runtime/node/node"
field() { "$CORE_NODE" -e 'const v=JSON.parse(process.argv[1])[process.argv[2]];if(v!==undefined&&v!==null)process.stdout.write(String(v))' "$1" "$2"; }
emit() {
  "$CORE_NODE" -e 'const b=v=>v==="null"?null:v==="true";process.stdout.write(JSON.stringify({effects:{themeCommitted:b(process.argv[1]),rendererApplied:b(process.argv[2]),codexRestarted:false,rollbackVerified:b(process.argv[3])},committedRevision:null,verifiedRendererRevision:null,runtimeSessionId:null,...(process.argv[4]?{recoveryTransaction:process.argv[4]}:{})})+"\n")' "$1" "$2" "$3" "${TRANSACTION:-}"
}
TRANSACTION=""
probe="$(/bin/bash "$SCRIPT_DIR/manager-platform.sh" probe "$APPLICATION_ROOT")" || { emit false false false; exit 0; }
guard="$("$CORE_NODE" "$APPLICATION_ROOT/shared/core/community-worker.mjs" "$APPLICATION_ROOT" "$REQUEST_PATH" "$probe")" || { emit false false false; exit 0; }
TRANSACTION="$(field "$guard" recoveryTransaction)"
work_root="$STATE_ROOT/$TRANSACTION"
[ ! -e "$work_root" ] && [ ! -L "$work_root" ] || { emit false false false; exit 0; }
/bin/mkdir -m 700 "$work_root"
theme_id="$("$CORE_NODE" -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(r.theme.id)' "$REQUEST_PATH")"
# The manager transaction uses its immutable snapshot under the same lock.
# Keep syntactically valid legacy arguments; they do not select its candidate.
code=0
/bin/bash "$SCRIPT_DIR/apply-community-theme-macos.sh" --id "$theme_id" --expect-fingerprint "$(field "$guard" expectedRevision)" \
  --expect-active-id "$(field "$guard" activeId)" --transaction-root "$work_root" \
  --manager-request "$REQUEST_PATH" --manager-application-root "$APPLICATION_ROOT" >&2 || code=$?
if [ "$code" -eq 20 ]; then emit false false true; exit 0; fi
if [ "$code" -ne 0 ]; then emit null null null; exit 0; fi
inspection="$(/bin/bash "$SCRIPT_DIR/manager-platform.sh" commitcommunity "$APPLICATION_ROOT" "$REQUEST_PATH")" || { emit true null false; exit 0; }
"$CORE_NODE" -e 'const x=JSON.parse(process.argv[1]);x.recoveryTransaction=process.argv[2];process.stdout.write(JSON.stringify(x)+"\n")' "$inspection" "$TRANSACTION"
