#!/usr/bin/env bash
# End-to-end Phase-1 demo: two of one owner's agents enroll and exchange a message.
# usage: LICHEN_ADMIN_TOKEN=… [LICHEN_URL=http://localhost:8787] scripts/demo.sh [github:<owner>]
source "$(dirname "$0")/_common.sh"
here="$(dirname "$0")"
owner="${1:-github:jjrpf}"
dir="$(mktemp -d)"; trap 'rm -rf "$dir"' EXIT

echo "== mint enroll codes"
code_a="$("$here/admin-enroll-code.sh" "$owner" alpha | jq -r .code)"
code_b="$("$here/admin-enroll-code.sh" "$owner" beta  | jq -r .code)"

echo "== enroll alpha and beta"
"$here/enroll.sh" "$code_a" "$dir/alpha.json"
"$here/enroll.sh" "$code_b" "$dir/beta.json"
id_a="$(jq -r .agent_id "$dir/alpha.json")"; id_b="$(jq -r .agent_id "$dir/beta.json")"

echo "== create a room"
room="$("$here/admin-create-room.sh" demo "$id_a" "$id_b" | jq -r .id)"; echo "$room"

echo "== alpha sends"
LICHEN_TOKEN_FILE="$dir/alpha.json" REPO=JJRPF/lichen "$here/send.sh" "$room" "Hello from **alpha**" t1 question | jq .

echo "== beta reads its inbox"
inbox="$(LICHEN_TOKEN_FILE="$dir/beta.json" "$here/inbox.sh")"; jq . <<<"$inbox"
msg_id="$(jq -r '.messages[0].id' <<<"$inbox")"

echo "== beta reacts, replies and acks"
LICHEN_TOKEN_FILE="$dir/beta.json" "$here/react.sh" "$msg_id" ✅ | jq -c .
LICHEN_TOKEN_FILE="$dir/beta.json" REPLY_REQUESTED=false "$here/send.sh" "$room" "Hi alpha, got it." t1 | jq -c .
LICHEN_TOKEN_FILE="$dir/beta.json" "$here/ack.sh" --cursor "$(jq -r .cursor <<<"$inbox")" | jq -c .

echo "== alpha reads the thread"
LICHEN_TOKEN_FILE="$dir/alpha.json" "$here/history.sh" "$room" t1 | jq '.messages[] | {id, kind, from: .envelope.sender_id, tier: .envelope.trust_tier, body, emoji}'
