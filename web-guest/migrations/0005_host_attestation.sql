-- Host 身份只能由已验证的 App Attest + StoreKit 交易建立；绝不把本机布尔值当授权。
ALTER TABLE hosts ADD COLUMN app_attest_key_id TEXT;
ALTER TABLE hosts ADD COLUMN app_attest_public_key_pem TEXT;
ALTER TABLE hosts ADD COLUMN app_attest_sign_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE hosts ADD COLUMN transaction_id TEXT;
ALTER TABLE hosts ADD COLUMN original_transaction_id TEXT;
ALTER TABLE hosts ADD COLUMN registered_at INTEGER;
ALTER TABLE hosts ADD COLUMN last_attested_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS hosts_app_attest_key_id_unique ON hosts(app_attest_key_id) WHERE app_attest_key_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hosts_transaction_id_unique ON hosts(transaction_id) WHERE transaction_id IS NOT NULL;

-- Server challenge 是一次性且短期的；删除/更新条件为验证的原子线性化点。
CREATE TABLE IF NOT EXISTS host_challenges (
  id TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK(purpose IN ('register', 'assert')),
  challenge BLOB NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  bound_host_id TEXT,
  bound_public_key BLOB
);
CREATE INDEX IF NOT EXISTS host_challenges_expiry ON host_challenges(expires_at);
