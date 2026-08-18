-- 账号删除与 Guest finalize 互斥。非空值表示删除已取得服务端锁；Guest 写入必须停止。
ALTER TABLE hosts ADD COLUMN deleting_at INTEGER;
