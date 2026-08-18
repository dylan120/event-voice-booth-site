-- 一个 Host 只能有一张当前可投稿的二维码。已到期但尚未被 cron 清扫的 live
-- Session 会在创建路径先原子标记为 expired；部分唯一索引随后阻止重试或并发设备
-- 再插入第二张有效二维码。历史 revoked/expired Session 保留给 ACK 和审计使用。
UPDATE sessions
SET state = 'expired'
WHERE state = 'live'
  AND expires_at <= unixepoch();

CREATE UNIQUE INDEX IF NOT EXISTS sessions_one_live_per_host
  ON sessions(host_id)
  WHERE state = 'live';
