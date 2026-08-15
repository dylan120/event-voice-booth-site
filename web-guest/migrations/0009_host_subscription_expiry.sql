-- 自动续期订阅的到期时间由每次已验证 Apple transaction JWS 刷新。
-- 旧 Host Lifetime 写入远期时间，保持已付费用户的永久权益。
ALTER TABLE hosts ADD COLUMN subscription_expires_at INTEGER;
UPDATE hosts
SET subscription_expires_at = 253402300799
WHERE original_transaction_id IS NOT NULL AND subscription_expires_at IS NULL;
CREATE INDEX IF NOT EXISTS hosts_subscription_expiry ON hosts(subscription_expires_at);
