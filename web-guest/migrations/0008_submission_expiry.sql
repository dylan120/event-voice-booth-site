-- 未 ACK 媒体仅作为 Host 本机原子导入前的短期缓冲，严格从 finalize 起保留 24 小时。
-- Worker cron 会把逾期 ready 投稿标为 discarded 并删除私有 R2 对象；读取 API 同样
-- 按 expires_at 拒绝，避免等待下一轮 cron 时仍可下载。
ALTER TABLE submissions ADD COLUMN expires_at INTEGER;
UPDATE submissions SET expires_at = COALESCE(finalized_at, created_at) + 86400 WHERE expires_at IS NULL;
CREATE INDEX IF NOT EXISTS submissions_ready_expiry ON submissions(state, expires_at);
