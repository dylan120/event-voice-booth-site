-- 同一个已撤销 refresh token 只触发一次令牌家族失效，避免攻击者持续重放旧 token
-- 并反复提升 auth_epoch，造成合法 Host 无法稳定重新登录。
ALTER TABLE host_refresh_tokens ADD COLUMN replay_detected_at INTEGER;
-- refresh token 必须绑定签发时的 Host epoch。并发重放即使发生在新 token 写入之前，
-- epoch 提升后迟到的 token 也不能再次轮换。
ALTER TABLE host_refresh_tokens ADD COLUMN auth_epoch INTEGER NOT NULL DEFAULT 0;
-- expand 阶段保留现有七天登录：把历史有效/已撤销 token 都绑定到其 Host 当前 epoch。
-- 之后 Worker 新签发记录会显式写入 epoch，不依赖默认值。
UPDATE host_refresh_tokens
SET auth_epoch = COALESCE((SELECT hosts.auth_epoch FROM hosts WHERE hosts.id = host_refresh_tokens.host_id), 0);
