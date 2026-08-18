-- 所有媒体只能通过 Worker 的受控路径访问；R2 bucket 不配置 public access。
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  public_slug TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK(state IN ('live', 'revoked', 'expired')),
  revoke_version INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  max_bytes INTEGER NOT NULL,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  submission_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_host_state ON sessions(host_id, state);
-- 每个 Host 同一时刻只允许一条 live Session；到期记录先转为 expired 后才可新建。
CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_live_per_host ON sessions(host_id) WHERE state = 'live';

CREATE TABLE IF NOT EXISTS hosts (
  id TEXT PRIMARY KEY,
  public_key BLOB NOT NULL,
  app_attest_key_id TEXT,
  app_attest_public_key_pem TEXT,
  app_attest_sign_count INTEGER NOT NULL DEFAULT 0,
  transaction_id TEXT,
  original_transaction_id TEXT,
  -- Apple Sign in 的稳定匿名 subject 是 Host 主身份；不保存姓名、邮箱或 token。
  apple_subject TEXT UNIQUE,
  -- logout/安全恢复时递增，使此前签发的短 access token 立即失效。
  auth_epoch INTEGER NOT NULL DEFAULT 0,
  deleting_at INTEGER,
  -- 新订阅按 Apple JWS 的 expiresDate 刷新；旧 Lifetime 使用远期值兼容。
  subscription_expires_at INTEGER,
  -- 仅存脱敏失败阶段，帮助排查 App Attest，不记录断言、JWS 或媒体。
  last_assertion_failure TEXT,
  created_at INTEGER NOT NULL,
  registered_at INTEGER,
  last_attested_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS hosts_app_attest_key_id_unique ON hosts(app_attest_key_id) WHERE app_attest_key_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hosts_transaction_id_unique ON hosts(transaction_id) WHERE transaction_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hosts_original_transaction_id_unique ON hosts(original_transaction_id) WHERE original_transaction_id IS NOT NULL;

-- 免费试用按 Apple 稳定匿名 subject 的 HMAC 摘要累计，不能由卸载、本地清除或删除
-- Event 重置。账号删除仍会删除 Host 与媒体；这里只保留不可逆的反滥用额度摘要。
CREATE TABLE IF NOT EXISTS demo_quotas (
  subject_hash TEXT PRIMARY KEY,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count >= 0 AND message_count <= 3),
  last_recording_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS demo_message_claims (
  subject_hash TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  counted_at INTEGER,
  PRIMARY KEY(subject_hash, recording_id)
);

-- refresh token 只保存 SHA-256 摘要，单次轮换；原始 token 不持久化。
CREATE TABLE IF NOT EXISTS host_refresh_tokens (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  auth_epoch INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  replay_detected_at INTEGER
);
CREATE INDEX IF NOT EXISTS host_refresh_tokens_host_expiry ON host_refresh_tokens(host_id, expires_at);

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
  consumed_at INTEGER,
  upload_state TEXT NOT NULL DEFAULT 'issued' CHECK(upload_state IN ('issued', 'uploading', 'uploaded', 'finalizing', 'finalized'))
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('uploading', 'ready', 'claimed', 'acked', 'discarded')),
  audio_key TEXT,
  audio_bytes INTEGER,
  audio_sha256 TEXT,
  photo_manifest TEXT NOT NULL DEFAULT '[]',
  guest_receipt TEXT UNIQUE,
  guest_name TEXT,
  guest_relationship TEXT,
  created_at INTEGER NOT NULL,
  finalized_at INTEGER,
  -- Host 未在 24 小时内 ACK 的媒体必须从私有 R2 删除，不能变成云端长期备份。
  expires_at INTEGER NOT NULL,
  acked_at INTEGER
);
CREATE INDEX IF NOT EXISTS submissions_session_state ON submissions(session_id, state, created_at);
CREATE INDEX IF NOT EXISTS submissions_receipt_state ON submissions(guest_receipt, state);
CREATE INDEX IF NOT EXISTS submissions_ready_expiry ON submissions(state, expires_at);

-- App Attest/注册挑战由服务端单次签发；不得由客户端提供、复用或延长。
CREATE TABLE IF NOT EXISTS host_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('register', 'assert')),
  challenge BLOB NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  bound_host_id TEXT,
  bound_public_key BLOB,
  request_digest TEXT
);
CREATE INDEX IF NOT EXISTS host_challenges_expiry ON host_challenges(expires_at);

-- 仅保存不可逆的 scope；IP scope 是由 Worker 使用部署 secret 做 HMAC 后的摘要，
-- 不保存原始网络地址。固定窗口 UPSERT 的条件更新是请求限速的原子线性化点。
CREATE TABLE IF NOT EXISTS rate_windows (
  scope TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (scope, bucket_start)
);
CREATE INDEX IF NOT EXISTS rate_windows_expiry ON rate_windows(bucket_start);

-- 上传前签发短租约；租约过期可自行恢复，避免进程中断后永久占满并发名额。
CREATE TABLE IF NOT EXISTS upload_leases (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_leases_session_expiry ON upload_leases(session_id, expires_at);
CREATE INDEX IF NOT EXISTS upload_leases_ip_expiry ON upload_leases(ip_hash, expires_at);
