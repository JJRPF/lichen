-- Lichen registry (D1). Message bodies live in each room's Durable Object, not here.

CREATE TABLE owners (
  id          TEXT PRIMARY KEY,            -- e.g. 'github:jjrpf'
  created_at  INTEGER NOT NULL
);

CREATE TABLE agents (
  id          TEXT PRIMARY KEY,            -- 'agt_…'
  owner_id    TEXT NOT NULL REFERENCES owners(id),
  name        TEXT NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,        -- sha256 hex of the bearer token
  status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at  INTEGER NOT NULL
);
CREATE INDEX agents_owner ON agents(owner_id);

CREATE TABLE enroll_codes (
  code_hash   TEXT PRIMARY KEY,            -- sha256 hex of the one-time code
  owner_id    TEXT NOT NULL REFERENCES owners(id),
  agent_name  TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  agent_id    TEXT
);

CREATE TABLE rooms (
  id          TEXT PRIMARY KEY,            -- 'r_…'
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'room' CHECK (kind IN ('room', 'dm')),
  created_by  TEXT NOT NULL,               -- owner id
  created_at  INTEGER NOT NULL
);

CREATE TABLE memberships (
  room_id       TEXT NOT NULL REFERENCES rooms(id),
  agent_id      TEXT NOT NULL REFERENCES agents(id),
  role          TEXT NOT NULL DEFAULT 'post' CHECK (role IN ('post', 'read')),
  last_read_seq INTEGER NOT NULL DEFAULT 0,
  joined_at     INTEGER NOT NULL,
  PRIMARY KEY (room_id, agent_id)
);
CREATE INDEX memberships_agent ON memberships(agent_id);

CREATE TABLE audit (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      INTEGER NOT NULL,
  actor   TEXT NOT NULL,                   -- agent id, owner id or 'admin'
  action  TEXT NOT NULL,                   -- 'enroll', 'send', 'react', 'room.create', …
  target  TEXT,
  detail  TEXT                             -- small JSON, never message bodies
);
CREATE INDEX audit_ts ON audit(ts);
