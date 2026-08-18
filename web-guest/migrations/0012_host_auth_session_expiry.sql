-- Host 登录有绝对最长七天有效期。refresh token 的轮换不能延长该期限，
-- 到期后必须再次完成 Sign in with Apple，避免长期遗留设备会话。
ALTER TABLE hosts ADD COLUMN auth_session_expires_at INTEGER;
CREATE INDEX IF NOT EXISTS hosts_auth_session_expiry
  ON hosts(auth_session_expires_at);
