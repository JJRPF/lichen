#!/usr/bin/env bash
# Send a message.  usage: send.sh <room_id> <markdown-body> [thread_id] [intent]
# Env: REPLY_REQUESTED=false for fire-and-forget, REPO=owner/name, ORIGIN=external for forwarded content.
source "$(dirname "$0")/_common.sh"
agent_call POST /send "$(jq -n \
  --arg room "$1" --arg body "$2" --arg thread "${3:-}" --arg intent "${4:-}" \
  --arg repo "${REPO:-}" --arg origin "${ORIGIN:-}" --arg rr "${REPLY_REQUESTED:-true}" \
  '{room:$room, body:$body, reply_requested:($rr=="true")}
   + (if $thread != "" then {thread_id:$thread} else {} end)
   + (if $intent != "" then {intent:$intent} else {} end)
   + (if $repo   != "" then {repo:$repo}       else {} end)
   + (if $origin != "" then {origin:$origin}   else {} end)')"
