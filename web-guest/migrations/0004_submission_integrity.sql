-- 上传 capability 必须先原子占用，避免同一短期 token 被并发 PUT 多次写入 R2。
ALTER TABLE capabilities ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'issued'
  CHECK(upload_state IN ('issued', 'uploading', 'uploaded', 'finalizing', 'finalized'));

-- Guest 只持有不可枚举 receipt，用于确认 Host ACK；绝不暴露 R2 对象路径。
ALTER TABLE submissions ADD COLUMN guest_receipt TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS submissions_guest_receipt_unique ON submissions(guest_receipt);
CREATE INDEX IF NOT EXISTS submissions_receipt_state ON submissions(guest_receipt, state);
