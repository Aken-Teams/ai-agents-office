-- =====================================================================
-- 對外 (External) DB — LINE Bot 整合所需資料表
-- =====================================================================
-- 用途：把 LINE bot 執行期會讀寫的 17 張表補到「對外」資料庫。
-- 安全性：全部使用 CREATE TABLE IF NOT EXISTS — 對外已存在的表不會被更動，
--         只會建立缺少的表。可重複執行 (idempotent)。
--
-- 欄位已合併 main/db.ts 後續 ALTER 補的欄位，所以新建出來即為完整結構。
-- 若對外「已有」某些共用表但缺欄位，請另跑檔案最下方的「Part 2 補欄位」區塊。
--
-- 表分兩類：
--   [新]   LINE 專屬：line_users / file_shares / line_webhook_events
--   [既有] LINE 也會讀寫的你既有功能表（共 14 張）
--
-- 依 FK 相依順序排列，請「由上往下」執行。
-- =====================================================================

SET NAMES utf8mb4;

-- ───────────────────────────────────────────────────────────────────
-- 1. users  [既有] — 綁定時自動建 LINE 使用者；含 LINE 路徑用到的欄位
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id             VARCHAR(36) PRIMARY KEY,
  email          VARCHAR(255) NOT NULL UNIQUE,
  password_hash  VARCHAR(255) NOT NULL,
  display_name   VARCHAR(100),
  role           VARCHAR(20) NOT NULL DEFAULT 'user',
  status         VARCHAR(20) NOT NULL DEFAULT 'active',
  locale         VARCHAR(10) NOT NULL DEFAULT 'zh-TW',
  theme          VARCHAR(10) NOT NULL DEFAULT 'light',
  oauth_provider VARCHAR(50),
  oauth_id       VARCHAR(255),
  quota_override DECIMAL(10,2) DEFAULT NULL,
  quota_group_id VARCHAR(36) DEFAULT NULL,
  invite_code_id VARCHAR(36) DEFAULT NULL,
  last_login_at  DATETIME DEFAULT NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 2. conversations  [既有] — LINE 對話（含 category/summary 欄位）
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id            VARCHAR(36) PRIMARY KEY,
  user_id       VARCHAR(36) NOT NULL,
  title         VARCHAR(255) NOT NULL DEFAULT 'New Conversation',
  skill_id      VARCHAR(50),
  session_id    VARCHAR(36),
  mode          VARCHAR(20),
  status        VARCHAR(20) NOT NULL DEFAULT 'active',
  summary       VARCHAR(500) DEFAULT NULL,
  category      VARCHAR(20) NOT NULL DEFAULT 'document',
  system_prompt TEXT DEFAULT NULL,
  icon          VARCHAR(50) DEFAULT NULL,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_conversations_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 3. messages  [既有] — 使用者/助理訊息
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS messages (
  id              VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  role            VARCHAR(20) NOT NULL,
  content         LONGTEXT NOT NULL,
  metadata        TEXT,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_messages_conversation (conversation_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 4. generated_files  [既有] — 圖表/檔案產出；file_shares 的 FK 目標
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS generated_files (
  id              VARCHAR(36) PRIMARY KEY,
  user_id         VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36),
  filename        VARCHAR(255) NOT NULL,
  file_path       VARCHAR(500) NOT NULL,
  file_type       VARCHAR(50) NOT NULL,
  file_size       BIGINT NOT NULL DEFAULT 0,
  version         INT NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_files_user (user_id),
  INDEX idx_files_conversation (conversation_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 5. token_usage  [既有] — token 用量記錄 + 額度檢查
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS token_usage (
  id              VARCHAR(36) PRIMARY KEY,
  user_id         VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36),
  input_tokens    INT NOT NULL DEFAULT 0,
  output_tokens   INT NOT NULL DEFAULT 0,
  model           VARCHAR(100),
  duration_ms     INT,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_usage_user (user_id),
  INDEX idx_usage_created (created_at),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 6. task_executions  [既有] — orchestrator 任務追蹤
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS task_executions (
  id              VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36),
  pipeline_id     VARCHAR(36),
  skill_id        VARCHAR(50) NOT NULL,
  description     TEXT,
  status          VARCHAR(20) DEFAULT 'pending',
  result_summary  TEXT,
  input_tokens    INT DEFAULT 0,
  output_tokens   INT DEFAULT 0,
  started_at      DATETIME,
  completed_at    DATETIME,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_task_exec_conversation (conversation_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 7. agent_sessions  [既有] — 每對話每 agent 的持久化 CLI session
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_sessions (
  id              VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36),
  skill_id        VARCHAR(50) NOT NULL,
  session_uuid    VARCHAR(36) NOT NULL,
  initialized     TINYINT DEFAULT 0,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY idx_agent_session_unique (conversation_id, skill_id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 8. security_events  [既有] — 防注入事件記錄 (inputGuard)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS security_events (
  id          VARCHAR(36) PRIMARY KEY,
  user_id     VARCHAR(36) NOT NULL,
  event_type  VARCHAR(50) NOT NULL,
  severity    VARCHAR(20) NOT NULL DEFAULT 'low',
  detail      TEXT,
  raw_input   TEXT,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_security_events_user (user_id),
  INDEX idx_security_events_created (created_at),
  INDEX idx_security_events_severity (severity)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 9. user_uploads  [既有] — LINE 收檔（方案 2，走既有 rag-analyst）
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_uploads (
  id              VARCHAR(36) PRIMARY KEY,
  user_id         VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36),
  filename        VARCHAR(255) NOT NULL,
  original_name   VARCHAR(500) NOT NULL,
  file_type       VARCHAR(50) NOT NULL,
  mime_type       VARCHAR(100),
  file_size       BIGINT NOT NULL DEFAULT 0,
  scan_status     VARCHAR(20) NOT NULL DEFAULT 'pending',
  scan_detail     TEXT,
  storage_path    VARCHAR(500) NOT NULL,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_uploads_user (user_id),
  INDEX idx_uploads_scan (scan_status),
  INDEX idx_uploads_conv (conversation_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 10. system_settings  [既有] — LINE 執行期設定 + 額度設定
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS system_settings (
  `key`   VARCHAR(100) PRIMARY KEY,
  value   TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 11. user_memories  [既有] — 記憶萃取 (含 memory_type 欄位)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_memories (
  id                     VARCHAR(36) PRIMARY KEY,
  user_id                VARCHAR(36) NOT NULL,
  content                VARCHAR(200) NOT NULL,
  category               VARCHAR(50) DEFAULT 'general',
  memory_type            VARCHAR(20) NOT NULL DEFAULT 'preference',
  source_conversation_id VARCHAR(36),
  created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_memories_user (user_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 12. quota_groups  [既有] — 額度群組 (usageLimit 讀取)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS quota_groups (
  id          VARCHAR(36) PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  limit_usd   DECIMAL(10,2) NOT NULL,
  description VARCHAR(255),
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 13. invite_codes  [既有] — /link 綁定碼 + QR 產碼
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invite_codes (
  id          VARCHAR(36) PRIMARY KEY,
  code        VARCHAR(50) NOT NULL UNIQUE,
  label       VARCHAR(100) NOT NULL,
  is_active   TINYINT NOT NULL DEFAULT 1,
  used_count  INT NOT NULL DEFAULT 0,
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 14. document_blocks  [既有] — fileManager 註冊產出檔的區塊資料
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS document_blocks (
  id              VARCHAR(36) PRIMARY KEY,
  file_id         VARCHAR(36) NOT NULL,
  user_id         VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36) NOT NULL,
  doc_type        VARCHAR(20) NOT NULL,
  doc_meta        TEXT DEFAULT NULL,
  blocks          LONGTEXT NOT NULL,
  version         INT NOT NULL DEFAULT 1,
  created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_blocks_file (file_id),
  INDEX idx_blocks_conv (conversation_id),
  FOREIGN KEY (file_id) REFERENCES generated_files(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ═══════════════════════════════════════════════════════════════════
-- 以下 3 張為 LINE 專屬新表 [新]
-- ═══════════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────────
-- 15. line_users  [新] — LINE 帳號 ↔ 內部 user 對應
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS line_users (
  line_user_id      VARCHAR(64) PRIMARY KEY,
  internal_user_id  VARCHAR(36) NOT NULL,
  display_name      VARCHAR(255),
  linked_via        VARCHAR(20) NOT NULL DEFAULT 'invite_code',
  current_conv_id   VARCHAR(36),
  last_message_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_line_internal (internal_user_id),
  FOREIGN KEY (internal_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 16. file_shares  [新] — 免登入檔案下載 token
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS file_shares (
  token            VARCHAR(16) PRIMARY KEY,
  file_id          VARCHAR(36) NOT NULL,
  user_id          VARCHAR(36) NOT NULL,
  source           VARCHAR(20) NOT NULL DEFAULT 'line',
  expires_at       DATETIME NOT NULL,
  download_count   INT NOT NULL DEFAULT 0,
  download_cap     INT NOT NULL DEFAULT 50,
  created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_file_share_file (file_id),
  INDEX idx_file_share_expires (expires_at),
  FOREIGN KEY (file_id) REFERENCES generated_files(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────────────────────────────────────────────────────────────────
-- 17. line_webhook_events  [新] — webhook 去重 (replay 防護)
-- ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS line_webhook_events (
  event_id    VARCHAR(64) PRIMARY KEY,
  received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_line_event_received (received_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- =====================================================================
-- Part 2（選用）：補欄位
-- 若對外「已存在」users / conversations / user_memories 等共用表，
-- 但這些表是舊版、缺下列欄位，請執行下方 ALTER。
-- MySQL 不支援 ADD COLUMN IF NOT EXISTS，若欄位已存在會報
-- "Duplicate column name" 錯誤 — 可安全略過該行。
-- =====================================================================
-- ALTER TABLE users         ADD COLUMN quota_override DECIMAL(10,2) DEFAULT NULL;
-- ALTER TABLE users         ADD COLUMN quota_group_id VARCHAR(36) DEFAULT NULL;
-- ALTER TABLE users         ADD COLUMN invite_code_id VARCHAR(36) DEFAULT NULL;
-- ALTER TABLE conversations ADD COLUMN summary  VARCHAR(500) DEFAULT NULL;
-- ALTER TABLE conversations ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'document';
-- ALTER TABLE user_memories ADD COLUMN memory_type VARCHAR(20) NOT NULL DEFAULT 'preference';

-- =====================================================================
-- 注意：本檔「不含」向量 RAG 的 user_documents / user_doc_chunks 兩張表，
-- 因為已決定不搬他的向量 RAG（LINE 收檔走既有 rag-analyst 機制）。
-- =====================================================================
