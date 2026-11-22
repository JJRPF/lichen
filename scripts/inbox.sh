#!/usr/bin/env bash
# Unread messages (optionally since a cursor).   usage: inbox.sh [cursor]
source "$(dirname "$0")/_common.sh"
if [[ -n "${1:-}" ]]; then agent_call GET "/inbox?since=$1"; else agent_call GET /inbox; fi
