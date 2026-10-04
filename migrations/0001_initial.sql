PRAGMA foreign_keys = ON;

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL UNIQUE,
  account_id TEXT NOT NULL,
  account_email TEXT NOT NULL,
  region TEXT NOT NULL CHECK(region IN ('global', 'china')),
  cookies_cipher TEXT NOT NULL,
  service_url TEXT NOT NULL,
  client_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'connected',
  session_version INTEGER NOT NULL DEFAULT 1,
  last_sync TEXT,
  last_error TEXT,
  lease_token TEXT,
  lease_expires INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE aliases (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  email TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  note TEXT,
  active INTEGER NOT NULL CHECK(active IN (0, 1)),
  provider_created_at TEXT,
  version TEXT NOT NULL,
  verified_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE(connection_id, provider_id)
);
CREATE INDEX aliases_connection ON aliases(connection_id, deleted_at);

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  operation_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  action TEXT NOT NULL,
  alias_id TEXT,
  candidate TEXT,
  payload TEXT NOT NULL,
  phase TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  result TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(connection_id, operation_key)
);
CREATE INDEX operations_pending ON operations(connection_id, status);

CREATE TABLE sync_items (
  sync_id TEXT NOT NULL,
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  provider_id TEXT NOT NULL,
  email TEXT NOT NULL,
  label TEXT NOT NULL,
  note TEXT,
  active INTEGER NOT NULL,
  provider_created_at TEXT,
  version TEXT NOT NULL,
  PRIMARY KEY(sync_id, provider_id)
);
