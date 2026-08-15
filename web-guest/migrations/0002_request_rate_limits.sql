-- Web Guest 请求限速与上传并发租约。可对已创建的 D1 数据库重复安全执行。
CREATE TABLE IF NOT EXISTS rate_windows (
  scope TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (scope, bucket_start)
);
CREATE INDEX IF NOT EXISTS rate_windows_expiry ON rate_windows(bucket_start);

CREATE TABLE IF NOT EXISTS upload_leases (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS upload_leases_session_expiry ON upload_leases(session_id, expires_at);
CREATE INDEX IF NOT EXISTS upload_leases_ip_expiry ON upload_leases(ip_hash, expires_at);
