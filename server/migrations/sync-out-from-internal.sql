-- =====================================================================
-- 對外 DB (db_ai_agents_out) 同步補丁 — 從對內 db_ai_agents 真實結構產生
-- =====================================================================
-- 用途：把對外缺的 6 張表 + 共同表缺的欄位補齊，使對外結構 = 對內。
-- 安全：CREATE TABLE 已改為 IF NOT EXISTS；欄位 ALTER 若已存在會報
--       Duplicate column，可安全略過該行。請由上往下執行。
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ───────── document_blocks  [LINE 需要] ─────────
CREATE TABLE IF NOT EXISTS `document_blocks` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `file_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `conversation_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `doc_type` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL,
  `doc_meta` text COLLATE utf8mb4_unicode_ci,
  `blocks` longtext COLLATE utf8mb4_unicode_ci NOT NULL,
  `version` int NOT NULL DEFAULT '1',
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_blocks_file` (`file_id`),
  KEY `idx_blocks_conv` (`conversation_id`),
  KEY `user_id` (`user_id`),
  CONSTRAINT `document_blocks_ibfk_1` FOREIGN KEY (`file_id`) REFERENCES `generated_files` (`id`) ON DELETE CASCADE,
  CONSTRAINT `document_blocks_ibfk_2` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `document_blocks_ibfk_3` FOREIGN KEY (`conversation_id`) REFERENCES `conversations` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────── email_agent_state  [內部功能，可選] ─────────
CREATE TABLE IF NOT EXISTS `email_agent_state` (
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `last_seen_ids` text COLLATE utf8mb4_unicode_ci,
  `last_poll_at` datetime DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_overview` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `email_agent_state_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────── outlook_tokens  [內部功能，可選] ─────────
CREATE TABLE IF NOT EXISTS `outlook_tokens` (
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `mail_token` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `expires_at` datetime NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `credentials_enc` text COLLATE utf8mb4_unicode_ci,
  PRIMARY KEY (`user_id`),
  CONSTRAINT `outlook_tokens_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────── email_summary_cache  [內部功能，可選] ─────────
CREATE TABLE IF NOT EXISTS `email_summary_cache` (
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `email_id` varchar(500) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `summary` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `priority` varchar(5) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '中',
  `category` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT '一般',
  `analysis` longtext COLLATE utf8mb4_unicode_ci,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `email_subject` varchar(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  PRIMARY KEY (`user_id`,`email_id`),
  KEY `idx_summary_cache_user` (`user_id`),
  CONSTRAINT `email_summary_cache_ibfk_1` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────── ad_claim_tokens  [內部功能，可選] ─────────
CREATE TABLE IF NOT EXISTS `ad_claim_tokens` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ad_username` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `ad_domain` varchar(50) COLLATE utf8mb4_unicode_ci NOT NULL,
  `claim_email` varchar(255) COLLATE utf8mb4_unicode_ci NOT NULL,
  `code` varchar(10) COLLATE utf8mb4_unicode_ci NOT NULL,
  `attempts` int NOT NULL DEFAULT '0',
  `expires_at` datetime NOT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `idx_claim_unique` (`ad_username`,`ad_domain`),
  KEY `idx_claim_email` (`claim_email`),
  KEY `idx_claim_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ───────── quota_requests  [內部功能，可選] ─────────
CREATE TABLE IF NOT EXISTS `quota_requests` (
  `id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `user_id` varchar(36) COLLATE utf8mb4_unicode_ci NOT NULL,
  `current_limit` decimal(10,2) NOT NULL,
  `current_cost` decimal(10,2) NOT NULL,
  `reason` text COLLATE utf8mb4_unicode_ci NOT NULL,
  `status` varchar(20) COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending',
  `new_limit` decimal(10,2) DEFAULT NULL,
  `admin_notes` text COLLATE utf8mb4_unicode_ci,
  `reviewed_by` varchar(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
  `created_at` datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `reviewed_at` datetime DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ═══════════ 共同表欄位補丁（已存在會報 Duplicate column，略過即可）═══════════
ALTER TABLE conversations ADD COLUMN system_prompt TEXT DEFAULT NULL;
ALTER TABLE conversations ADD COLUMN icon VARCHAR(50) DEFAULT NULL;
ALTER TABLE users ADD COLUMN ad_username VARCHAR(50) DEFAULT NULL;
ALTER TABLE users ADD COLUMN ad_domain VARCHAR(50) DEFAULT NULL;
ALTER TABLE users ADD COLUMN auth_provider VARCHAR(20) DEFAULT NULL;
ALTER TABLE users ADD COLUMN terms_accepted_at DATETIME DEFAULT NULL;

SET FOREIGN_KEY_CHECKS = 1;
