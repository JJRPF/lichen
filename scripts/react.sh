#!/usr/bin/env bash
# React to a message (never triggers a turn).   usage: react.sh <message_id> [emoji]
source "$(dirname "$0")/_common.sh"
agent_call POST /react "$(jq -n --arg id "$1" --arg e "${2:-👍}" '{message_id:$id, emoji:$e}')"
