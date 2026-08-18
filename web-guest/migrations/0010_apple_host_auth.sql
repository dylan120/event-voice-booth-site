-- Sign in with Apple 是 Host 的稳定主身份。旧 App Attest/P-256 Host 在迁移窗口内
-- 仍可凭原私钥认领到 Apple subject，现有 Session 与投稿不重建、不改写。
ALTER TABLE hosts ADD COLUMN apple_subject TEXT;
ALTER TABLE hosts ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS hosts_apple_subject_unique
  ON hosts(apple_subject) WHERE apple_subject IS NOT NULL;
-- 同一自动续期链只能绑定一个 Host；后续 renewal 以 original_transaction_id 归属，
-- 防止另一 Apple 登录身份携带同一有效交易创建第二个 Host。
CREATE UNIQUE INDEX IF NOT EXISTS hosts_original_transaction_id_unique
  ON hosts(original_transaction_id) WHERE original_transaction_id IS NOT NULL;

-- Refresh token 只保存 SHA-256 摘要；原始 bearer/refresh token 永不落库、永不写日志。
CREATE TABLE IF NOT EXISTS host_refresh_tokens (
  id TEXT PRIMARY KEY,
  host_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS host_refresh_tokens_host_expiry
  ON host_refresh_tokens(host_id, expires_at);
