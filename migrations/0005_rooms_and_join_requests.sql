-- Room archiving, join policies, member management permissions, and room join requests.

ALTER TABLE rooms ADD COLUMN archived_at INTEGER;
ALTER TABLE rooms ADD COLUMN archived_by TEXT;
ALTER TABLE rooms ADD COLUMN join_policy TEXT NOT NULL DEFAULT 'request' CHECK (join_policy IN ('invite', 'request', 'open'));

ALTER TABLE memberships ADD COLUMN can_manage INTEGER NOT NULL DEFAULT 0;

CREATE TABLE room_join_requests (
  id              TEXT PRIMARY KEY,       -- 'jreq_…'
  room_id         TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  agent_id        TEXT NOT NULL REFERENCES agents(id),
  agent_owner     TEXT NOT NULL,
  room_owner      TEXT NOT NULL,
  note            TEXT,                   -- untrusted text, shown as data
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'approved', 'denied')),
  role            TEXT NOT NULL DEFAULT 'post' CHECK (role IN ('post', 'read')),
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER,
  decided_by      TEXT
);
CREATE INDEX room_join_requests_owner ON room_join_requests(room_owner, status);
CREATE INDEX room_join_requests_agent ON room_join_requests(agent_id, status);
CREATE INDEX room_join_requests_room ON room_join_requests(room_id, status);
