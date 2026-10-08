-- CunDrop D1 数据库结构
-- 初始化: wrangler d1 execute cundrop --file=./schema.sql

CREATE TABLE IF NOT EXISTS files (
  id         TEXT PRIMARY KEY,              -- UUID, 也是 R2 对象名的一部分
  name       TEXT NOT NULL,                 -- 原始文件名
  r2_key     TEXT NOT NULL,                 -- R2 中的对象 key, 形如 f/<id>
  size       INTEGER NOT NULL DEFAULT 0,    -- 字节数
  mime       TEXT NOT NULL DEFAULT 'application/octet-stream',
  created_at INTEGER NOT NULL              -- 毫秒时间戳
);
CREATE INDEX IF NOT EXISTS idx_files_created ON files (created_at DESC);

CREATE TABLE IF NOT EXISTS shares (
  token         TEXT PRIMARY KEY,  -- 分享 token, 形如 /f/xxxx
  file_id       TEXT NOT NULL,     -- 关联 files.id
  password_hash TEXT,              -- 分享密码的 SHA-256(加 SESSION_SECRET 作 pepper), 为空表示无密码
  expires_at    INTEGER,           -- 过期时间(毫秒), 为空表示永久
  max_views     INTEGER,           -- 最大查看次数, 为空表示不限
  views         INTEGER NOT NULL DEFAULT 0,
  revoked       INTEGER NOT NULL DEFAULT 0,  -- 1=已作废(卖家手动)
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_file ON shares (file_id);
