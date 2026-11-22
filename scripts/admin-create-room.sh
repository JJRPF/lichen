#!/usr/bin/env bash
# Create a room with members.    usage: admin-create-room.sh <name> <agent_id>...
source "$(dirname "$0")/_common.sh"
name="$1"; shift
admin_call POST /admin/rooms "$(jq -n --arg n "$name" '{name:$n, members:$ARGS.positional}' --args "$@")"
