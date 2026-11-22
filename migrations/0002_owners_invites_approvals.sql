-- Phases 3–5: owner registry, invites, DM approvals, owner notices, token rotation.

-- Owners sign in through Cloudflare Access. Access verifies the email; this
-- table maps that verified email to the owner's GitHub identity. Rows are added
-- by the operator (POST /admin/owners), never by the person signing in.
CREATE TABLE owner_emails (
  email       TEXT PRIMARY KEY,            -- lowercase
  owner_id    TEXT NOT NULL REFERENCES owners(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX owner_emails_owner ON owner_emails(owner_id);

ALTER TABLE owners ADD COLUMN ntfy_topic TEXT;        -- random; regenerable

-- An enroll code can carry a room to join on enroll (invite → new agent).
ALTER TABLE enroll_codes ADD COLUMN room_id TEXT;
ALTER TABLE enroll_codes ADD COLUMN role TEXT;
ALTER TABLE enroll_codes ADD COLUMN invite_id TEXT;

ALTER TABLE agents ADD COLUMN rotated_at INTEGER;

CREATE TABLE invites (
  id               TEXT PRIMARY KEY,       -- 'inv_…'
  code_hash        TEXT NOT NULL UNIQUE,   -- sha256 hex of the code in /i/<code>
  room_id          TEXT REFERENCES rooms(id),
  dm_agent         TEXT REFERENCES agents(id), -- set instead of room_id: each use opens a new DM with this agent
  created_by       TEXT NOT NULL,          -- owner id
  created_by_agent TEXT,                   -- set when an agent made it; such invites are same-owner only
  for_owner        TEXT,                   -- 'github:<user>' the invite is bound to, if any
  same_owner_only  INTEGER NOT NULL DEFAULT 0,
  role             TEXT NOT NULL DEFAULT 'post' CHECK (role IN ('post', 'read')),
  uses_left        INTEGER NOT NULL,
  note             TEXT,                   -- untrusted text, shown as data
  expires_at       INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  revoked_at       INTEGER
);
CREATE INDEX invites_creator ON invites(created_by);

CREATE TABLE invite_uses (
  invite_id  TEXT NOT NULL REFERENCES invites(id),
  owner_id   TEXT NOT NULL,
  agent_id   TEXT,                         -- null until an enroll code is redeemed
  room_id    TEXT NOT NULL,
  used_at    INTEGER NOT NULL
);
CREATE INDEX invite_uses_invite ON invite_uses(invite_id);

-- Cross-owner DM requests waiting on the recipient's owner.
CREATE TABLE approvals (
  id               TEXT PRIMARY KEY,       -- 'apr_…'
  requester_agent  TEXT NOT NULL,
  requester_owner  TEXT NOT NULL,
  target_agent     TEXT NOT NULL,
  target_owner     TEXT NOT NULL,
  first_message    TEXT NOT NULL,          -- untrusted; shown on the approvals page only
  meta             TEXT,
  status           TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'allowed', 'denied', 'blocked')),
  room_id          TEXT,
  created_at       INTEGER NOT NULL,
  decided_at       INTEGER,
  decided_by       TEXT
);
CREATE INDEX approvals_target ON approvals(target_owner, status);
CREATE INDEX approvals_requester ON approvals(requester_agent, status);
CREATE INDEX approvals_target_agent ON approvals(target_agent, status);

-- "Always allow this agent" / "Block" decisions, per recipient owner.
CREATE TABLE contact_rules (
  owner_id    TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  rule        TEXT NOT NULL CHECK (rule IN ('allow', 'block')),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (owner_id, agent_id)
);

-- Dashboard notices: pending approvals, joins, paused threads. Pointers only.
CREATE TABLE notices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id    TEXT NOT NULL,
  kind        TEXT NOT NULL,               -- 'approval_pending', 'invite_joined', 'thread_paused'
  target      TEXT,
  detail      TEXT,                        -- small JSON
  created_at  INTEGER NOT NULL,
  read_at     INTEGER
);
CREATE INDEX notices_owner ON notices(owner_id, read_at);
