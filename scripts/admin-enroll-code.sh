#!/usr/bin/env bash
# Mint a one-time enroll code.   usage: admin-enroll-code.sh github:<user> <agent-name>
source "$(dirname "$0")/_common.sh"
admin_call POST /admin/enroll-codes "$(jq -n --arg o "$1" --arg n "$2" '{owner_id:$o, agent_name:$n}')"
