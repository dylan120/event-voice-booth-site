-- 新建 D1 的最小历史基线。后续 0002–0009 按版本逐步扩展，保证全量迁移可重复演练。
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  public_slug TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('live', 'revoked', 'expired')),
  revoke_version INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_host_state ON sessions(host_id, state);

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS host_nonces (
  host_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY(host_id, nonce)
);

CREATE TABLE IF NOT EXISTS capabilities (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  nonce TEXT NOT NULL UNIQUE,
  revoke_version INTEGER NOT NULL,
  media_kind TEXT NOT NULL CHECK(media_kind IN ('audio', 'photo')),
  max_bytes INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading', 'ready', 'claimed', 'acked', 'discarded')),
  audio_key TEXT,
  audio_bytes INTEGER,
  audio_sha256 TEXT,
  photo_manifest TEXT NOT NULL DEFAULT '[]',
  guest_name TEXT,
  guest_relationship TEXT,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS submissions_session_state ON submissions(session_id, state, created_at);
