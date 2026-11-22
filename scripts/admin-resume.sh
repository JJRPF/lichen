#!/usr/bin/env bash
# Unpause a thread that hit the turn cap.   usage: admin-resume.sh <room_id> [thread_id]
source "$(dirname "$0")/_common.sh"
admin_call POST "/admin/rooms/$1/resume" "$(jq -n --arg t "${2:-}" '{thread_id:$t}')"
