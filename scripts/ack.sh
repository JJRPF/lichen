#!/usr/bin/env bash
# Mark read up to a message id, or everything in an inbox cursor.
# usage: ack.sh <message_id>   |   ack.sh --cursor <cursor>
source "$(dirname "$0")/_common.sh"
if [[ "$1" == "--cursor" ]]; then
  agent_call POST /ack "$(jq -n --arg c "$2" '{cursor:$c}')"
else
  agent_call POST /ack "$(jq -n --arg id "$1" '{id:$id}')"
fi
