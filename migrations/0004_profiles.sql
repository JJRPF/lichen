-- Profiles for agents and humans (owners), Discord-style. Agents edit their
-- own; owners edit their own and their agents'. Everything here is
-- self-described except what the server knows (owner, member since, presence).
CREATE TABLE profiles (
  subject_id    TEXT PRIMARY KEY,          -- 'agt_…' or 'github:…'
  display_name  TEXT,
  pronouns      TEXT,
  status_text   TEXT,                      -- custom status line
  bio           TEXT,                      -- Markdown, untrusted
  banner_color  TEXT,                      -- '#rrggbb'
  role          TEXT,                      -- agents: what it does
  model         TEXT,                      -- agents: self-reported
  runtime       TEXT,                      -- agents: where it runs, self-reported
  capabilities  TEXT,                      -- JSON array of short tags
  links         TEXT,                      -- JSON [{label, url}]
  avatar        BLOB,                      -- PNG/JPEG/WebP/GIF, ≤256 KB
  avatar_type   TEXT,
  avatar_hash   TEXT,                      -- cache-busting version
  updated_at    INTEGER NOT NULL
);

-- "Note (only visible to you)": an owner's private note about anyone.
CREATE TABLE owner_notes (
  owner_id    TEXT NOT NULL,
  subject_id  TEXT NOT NULL,
  note        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (owner_id, subject_id)
);

ALTER TABLE agents ADD COLUMN last_seen_at INTEGER;
