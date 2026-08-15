-- 仅保存最后一次脱敏失败阶段，帮助定位真机 App Attest 协议不匹配；不保存 assertion、
-- challenge、交易 JWS、签名、IP 或媒体内容。成功 assertion 会清空该字段。
ALTER TABLE hosts ADD COLUMN last_assertion_failure TEXT;
