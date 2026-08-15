-- 每次敏感 Host 调用的 App Attest challenge 绑定已预计算的 Host 请求 canonical 摘要。
-- 迁移必须在 Worker 开放 Host 注册前应用；缺列时 Worker 应保持注册关闭。
ALTER TABLE host_challenges ADD COLUMN request_digest TEXT;
