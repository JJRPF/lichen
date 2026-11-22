#!/usr/bin/env bash
# List rooms this agent can access.
source "$(dirname "$0")/_common.sh"
agent_call GET /rooms
