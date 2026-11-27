-- Optional remote MCP server (/mcp) with OAuth 2.1, so an MCP client such as
-- a claude.ai custom connector can act as one of an owner's agents. The owner
-- approves each connection signed in (Cloudflare Access) and picks the agent.
-- Agents' curl tokens, sockets and webhooks are unchanged.

-- Clients registered through dynamic client registration (RFC 7591).
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,          -- 'mcl_…' (client_id)
  secret_hash   TEXT,                      -- sha256 hex; NULL for public clients (PKCE only)
  auth_method   TEXT NOT NULL CHECK (auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  name          TEXT NOT NULL,             -- self-described, shown as data
  redirect_uris TEXT NOT NULL,             -- JSON array
  created_at    INTEGER NOT NULL
);

-- One authorization attempt: created by /oauth/authorize, decided by an owner
-- on /accept?connect=<id>, then redeemed once at /oauth/token.
CREATE TABLE oauth_requests (
  id             TEXT PRIMARY KEY,         -- 'oar_…'
  client_id      TEXT NOT NULL REFERENCES oauth_clients(id),
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,            -- PKCE S256
  state          TEXT,
  resource       TEXT,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  owner_id       TEXT,                     -- set when approved
  agent_id       TEXT,
  code_hash      TEXT UNIQUE,              -- sha256 hex of the one-time code
  code_expires_at INTEGER,
  decided_at     INTEGER,
  used_at        INTEGER
);

-- A live connection: an MCP client acting as one agent. Access tokens last an
-- hour; refresh tokens rotate on every use. Revoking the agent ends it too.
CREATE TABLE oauth_grants (
  id                 TEXT PRIMARY KEY,     -- 'grt_…'
  client_id          TEXT NOT NULL REFERENCES oauth_clients(id),
  owner_id           TEXT NOT NULL,
  agent_id           TEXT NOT NULL REFERENCES agents(id),
  access_hash        TEXT NOT NULL UNIQUE,
  access_expires_at  INTEGER NOT NULL,
  refresh_hash       TEXT NOT NULL UNIQUE,
  refresh_expires_at INTEGER NOT NULL,
  created_at         INTEGER NOT NULL,
  last_used_at       INTEGER,
  revoked_at         INTEGER
);
CREATE INDEX oauth_grants_owner ON oauth_grants(owner_id);
CREATE INDEX oauth_grants_agent ON oauth_grants(agent_id);
