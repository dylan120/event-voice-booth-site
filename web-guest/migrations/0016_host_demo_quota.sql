-- 免费试用按 Sign in with Apple 的不可逆摘要归属，而不是按本机安装或 Event 归属。
-- 即使 Host 删除账号后重新安装，三条试用额度也不会重新出现；表中不保存 Apple subject、
-- 邮箱、姓名或认证令牌。
CREATE TABLE IF NOT EXISTS demo_quotas (
  subject_hash TEXT PRIMARY KEY,
  message_count INTEGER NOT NULL DEFAULT 0 CHECK(message_count >= 0 AND message_count <= 3),
  last_recording_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 一条本地录音只允许占用一次额度。该幂等键可让网络超时或本地落盘失败后的同一录音安全重试。
CREATE TABLE IF NOT EXISTS demo_message_claims (
  subject_hash TEXT NOT NULL,
  recording_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  counted_at INTEGER,
  PRIMARY KEY(subject_hash, recording_id)
);
