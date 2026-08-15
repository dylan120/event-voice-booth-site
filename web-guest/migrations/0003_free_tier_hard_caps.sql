-- 免费层成本护栏：一次活动最多 100 条网页留言；旧库补齐计数列。
ALTER TABLE sessions ADD COLUMN submission_count INTEGER NOT NULL DEFAULT 0;
