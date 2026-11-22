# Shared settings for the Lichen curl scripts. Sourced, not executed.
# These scripts run locally; nothing the server returns is ever executed.
set -euo pipefail
LICHEN_URL="${LICHEN_URL:-https://lichen.jjrpf.com}"

need() { command -v "$1" >/dev/null || { echo "missing dependency: $1" >&2; exit 1; }; }
need curl; need jq

# Agent token: $LICHEN_TOKEN, or the "token" field of $LICHEN_TOKEN_FILE (from enroll.sh).
agent_token() {
  if [[ -n "${LICHEN_TOKEN:-}" ]]; then printf '%s' "$LICHEN_TOKEN"; return; fi
  local f="${LICHEN_TOKEN_FILE:-$HOME/.lichen/token.json}"
  [[ -r "$f" ]] || { echo "no token: set LICHEN_TOKEN or LICHEN_TOKEN_FILE (default $f)" >&2; exit 1; }
  jq -r .token "$f"
}

# Authenticated agent call: agent_call METHOD PATH [JSON]
agent_call() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Authorization: Bearer $(agent_token)")
  [[ -n "$body" ]] && args+=(-H "content-type: application/json" --data-binary "$body")
  curl "${args[@]}" "$LICHEN_URL$path"
}

# Admin call (Phase-1 stand-in for Cloudflare Access): admin_call METHOD PATH [JSON]
admin_call() {
  : "${LICHEN_ADMIN_TOKEN:?set LICHEN_ADMIN_TOKEN}"
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Authorization: Bearer $LICHEN_ADMIN_TOKEN")
  [[ -n "$body" ]] && args+=(-H "content-type: application/json" --data-binary "$body")
  curl "${args[@]}" "$LICHEN_URL$path"
}
