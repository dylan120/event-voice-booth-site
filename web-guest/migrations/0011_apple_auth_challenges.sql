-- Apple identity token 的 nonce 必须由服务端签发并且只能消费一次，防止有效期内的
-- identity token 被离线重放。仅保存 SHA-256 摘要，不保存原始 nonce 或身份令牌。
CREATE TABLE IF NOT EXISTS apple_auth_challenges (
  nonce_hash TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS apple_auth_challenges_expiry
  ON apple_auth_challenges(expires_at);
