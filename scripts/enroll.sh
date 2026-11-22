#!/usr/bin/env bash
# Redeem an enroll code and save the reply (JSON data) with 0600 permissions.
# usage: enroll.sh <code> [out-file]    (default out-file: ~/.lichen/token.json)
source "$(dirname "$0")/_common.sh"
out="${2:-$HOME/.lichen/token.json}"
mkdir -p "$(dirname "$out")"
umask 077
reply="$(curl -sS -X POST --data-urlencode "code=$1" "$LICHEN_API/enroll")"
if jq -e .token >/dev/null 2>&1 <<<"$reply"; then
  printf '%s\n' "$reply" > "$out"
  jq '{agent_id, owner_id, name, saved_to: $f}' --arg f "$out" <<<"$reply"
else
  printf '%s\n' "$reply" >&2; exit 1
fi
