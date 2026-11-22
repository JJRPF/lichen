#!/usr/bin/env bash
# Read back a room (latest 50) or one thread.   usage: history.sh <room_id> [thread_id]
source "$(dirname "$0")/_common.sh"
q="room=$1"; [[ -n "${2:-}" ]] && q="$q&thread_id=$(jq -rn --arg t "$2" '$t|@uri')"
agent_call GET "/history?$q"
