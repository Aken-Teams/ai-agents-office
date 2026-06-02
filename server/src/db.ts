import mysql, { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';

// ---------------------------------------------------------------------------
// Connection Pool
// ---------------------------------------------------------------------------

const pool = mysql.createPool({
  host: config.mysqlHost,
  port: config.mysqlPort,
  user: config.mysqlUser,
  password: config.mysqlPassword,
  database: config.mysqlDb,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: 'utf8mb4',
  // Use 'local' so mysql2 interprets DATETIME values using the system timezone
  // (data in MySQL is stored in local time via CURRENT_TIMESTAMP)
  timezone: 'local',
  // MySQL SUM/COUNT returns DECIMAL/LONGLONG as strings by default.
  // Convert them to JavaScript numbers so the API returns proper numeric values.
  typeCast: function (field: any, next: any) {
    if (field.type === 'NEWDECIMAL' || field.type === 'DECIMAL'
      || field.type === 'LONGLONG' || field.type === 'LONG'
      || field.type === 'INT24' || field.type === 'SHORT' || field.type === 'TINY') {
      const val = field.string();
      return val === null ? null : Number(val);
    }
    return next();
  },
});

// ---------------------------------------------------------------------------
// Helper functions (replacement for better-sqlite3 synchronous API)
// ---------------------------------------------------------------------------

/** SELECT single row — equivalent to db.prepare(sql).get(...params) */
export async function dbGet<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows[0] as T | undefined;
}

/** SELECT multiple rows — equivalent to db.prepare(sql).all(...params) */
export async function dbAll<T = any>(sql: string, ...params: any[]): Promise<T[]> {
  const [rows] = await pool.query<RowDataPacket[]>(sql, params);
  return rows as unknown as T[];
}

/** INSERT / UPDATE / DELETE — equivalent to db.prepare(sql).run(...params) */
export async function dbRun(sql: string, ...params: any[]): Promise<ResultSetHeader> {
  const [result] = await pool.query<ResultSetHeader>(sql, params);
  return result;
}

// ---------------------------------------------------------------------------
// Database Initialization
// ---------------------------------------------------------------------------

export async function initializeDatabase(): Promise<void> {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS users (
        id            VARCHAR(36) PRIMARY KEY,
        email         VARCHAR(255) NOT NULL UNIQUE,
        password_hash VARCHAR(255) NOT NULL,
        display_name  VARCHAR(100),
        role          VARCHAR(20) NOT NULL DEFAULT 'user',
        status        VARCHAR(20) NOT NULL DEFAULT 'active',
        locale        VARCHAR(10) NOT NULL DEFAULT 'zh-TW',
        theme         VARCHAR(10) NOT NULL DEFAULT 'light',
        oauth_provider VARCHAR(50),
        oauth_id      VARCHAR(255),
        quota_override DECIMAL(10,2) DEFAULT NULL,
        last_login_at DATETIME DEFAULT NULL,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Add quota_override column if not exists (migration for existing databases)
    try {
      await conn.query('ALTER TABLE users ADD COLUMN quota_override DECIMAL(10,2) DEFAULT NULL');
    } catch { /* column already exists */ }

    // Add last_login_at column if not exists (migration for existing databases)
    try {
      await conn.query('ALTER TABLE users ADD COLUMN last_login_at DATETIME DEFAULT NULL');
    } catch { /* column already exists */ }
    // Backfill: set last_login_at to created_at for users who haven't logged in since migration
    await conn.query('UPDATE users SET last_login_at = created_at WHERE last_login_at IS NULL');

    await conn.query(`
      CREATE TABLE IF NOT EXISTS conversations (
        id            VARCHAR(36) PRIMARY KEY,
        user_id       VARCHAR(36) NOT NULL,
        title         VARCHAR(255) NOT NULL DEFAULT 'New Conversation',
        skill_id      VARCHAR(50),
        session_id    VARCHAR(36),
        mode          VARCHAR(20),
        status        VARCHAR(20) NOT NULL DEFAULT 'active',
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_conversations_user (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id              VARCHAR(36) PRIMARY KEY,
        conversation_id VARCHAR(36) NOT NULL,
        role            VARCHAR(20) NOT NULL,
        content         LONGTEXT NOT NULL,
        metadata        TEXT,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_messages_conversation (conversation_id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS token_usage (
        id              VARCHAR(36) PRIMARY KEY,
        user_id         VARCHAR(36) NOT NULL,
        conversation_id VARCHAR(36),
        input_tokens    INT NOT NULL DEFAULT 0,
        output_tokens   INT NOT NULL DEFAULT 0,
        model           VARCHAR(100),
        provider        VARCHAR(20),
        duration_ms     INT,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_usage_user (user_id),
        INDEX idx_usage_created (created_at),
        INDEX idx_usage_provider (provider),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Migration: add `provider` column to existing token_usage rows (no-op if already present).
    // Backfill rule: model starting with "claude" → claude; "mlx" / "local" / "ollama" → local-llm; else claude.
    try {
      await conn.query('ALTER TABLE token_usage ADD COLUMN provider VARCHAR(20)');
      await conn.query('ALTER TABLE token_usage ADD INDEX idx_usage_provider (provider)');
    } catch (e) {
      const msg = (e as { code?: string }).code || '';
      if (msg !== 'ER_DUP_FIELDNAME' && msg !== 'ER_DUP_KEYNAME') throw e;
    }
    await conn.query(`
      UPDATE token_usage SET provider = CASE
        WHEN model LIKE 'claude%' THEN 'claude'
        WHEN model LIKE 'mlx%' OR model LIKE 'local%' OR model LIKE 'ollama%' THEN 'local-llm'
        WHEN model LIKE 'deepseek%' THEN 'deepseek'
        ELSE 'claude'
      END WHERE provider IS NULL
    `);

    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id              VARCHAR(36) PRIMARY KEY,
        conversation_id VARCHAR(36),
        skill_id        VARCHAR(50) NOT NULL,
        session_uuid    VARCHAR(36) NOT NULL,
        initialized     TINYINT DEFAULT 0,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY idx_agent_session_unique (conversation_id, skill_id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id          VARCHAR(36) PRIMARY KEY,
        admin_id    VARCHAR(36) NOT NULL,
        action      VARCHAR(100) NOT NULL,
        target_type VARCHAR(50),
        target_id   VARCHAR(36),
        details     TEXT,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_audit_admin (admin_id),
        INDEX idx_audit_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS conversation_shares (
        id              VARCHAR(36) PRIMARY KEY,
        conversation_id VARCHAR(36) NOT NULL,
        user_id         VARCHAR(36) NOT NULL,
        token           VARCHAR(64) NOT NULL UNIQUE,
        created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_shares_token (token),
        INDEX idx_shares_conversation (conversation_id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS system_settings (
        \`key\`   VARCHAR(100) PRIMARY KEY,
        value   TEXT NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS email_verification_codes (
        id          VARCHAR(36) PRIMARY KEY,
        email       VARCHAR(255) NOT NULL,
        code        VARCHAR(10) NOT NULL,
        attempts    INT NOT NULL DEFAULT 0,
        expires_at  DATETIME NOT NULL,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_verify_email (email),
        INDEX idx_verify_expires (expires_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        id          VARCHAR(36) PRIMARY KEY,
        user_id     VARCHAR(36) NOT NULL,
        token       VARCHAR(64) NOT NULL UNIQUE,
        used        TINYINT NOT NULL DEFAULT 0,
        expires_at  DATETIME NOT NULL,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_reset_token (token),
        INDEX idx_reset_user (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS announcements (
        id            VARCHAR(36) PRIMARY KEY,
        title         VARCHAR(200) NOT NULL,
        content       TEXT NOT NULL,
        created_by    VARCHAR(36) NOT NULL,
        start_date    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        end_date      DATETIME NOT NULL,
        is_active     TINYINT NOT NULL DEFAULT 1,
        created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Migration: active_days → start_date/end_date
    const [annCols] = await conn.execute(`SHOW COLUMNS FROM announcements LIKE 'active_days'`) as any[];
    if (annCols.length > 0) {
      await conn.execute(`ALTER TABLE announcements ADD COLUMN start_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER created_by`);
      await conn.execute(`ALTER TABLE announcements ADD COLUMN end_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER start_date`);
      await conn.execute(`UPDATE announcements SET start_date = created_at, end_date = DATE_ADD(created_at, INTERVAL active_days DAY)`);
      await conn.execute(`ALTER TABLE announcements DROP COLUMN active_days`);
      console.log('[DB] Migrated announcements: active_days → start_date/end_date');
    }

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS user_memories (
        id                     VARCHAR(36) PRIMARY KEY,
        user_id                VARCHAR(36) NOT NULL,
        content                VARCHAR(200) NOT NULL,
        category               VARCHAR(50) DEFAULT 'general',
        source_conversation_id VARCHAR(36),
        created_at             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_memories_user (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (source_conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS quota_groups (
        id          VARCHAR(36) PRIMARY KEY,
        name        VARCHAR(100) NOT NULL,
        limit_usd   DECIMAL(10,2) NOT NULL,
        description VARCHAR(255),
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Add quota_group_id column to users if not exists
    try {
      await conn.query('ALTER TABLE users ADD COLUMN quota_group_id VARCHAR(36) DEFAULT NULL');
    } catch { /* column already exists */ }

    // ─── LINE Bot integration tables ─────────────────────────────
    // LINE user ↔ internal user mapping. One internal user per LINE account.
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Token-based public file download (mirrors conversation_shares pattern).
    // Used to push LINE-friendly download URLs without requiring auth.
    await conn.query(`
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
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Replay protection — LINE retries failed deliveries; we INSERT IGNORE here.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS line_webhook_events (
        event_id    VARCHAR(64) PRIMARY KEY,
        received_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_line_event_received (received_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Personal RAG document registry.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_documents (
        id               VARCHAR(36) PRIMARY KEY,
        user_id          VARCHAR(36) NOT NULL,
        source_upload_id VARCHAR(36),
        filename         VARCHAR(500) NOT NULL,
        file_type        VARCHAR(20) NOT NULL,
        status           VARCHAR(20) NOT NULL DEFAULT 'pending',
        total_chunks     INT NOT NULL DEFAULT 0,
        error            TEXT,
        created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        indexed_at       DATETIME,
        INDEX idx_userdoc_user (user_id),
        INDEX idx_userdoc_status (status),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Personal RAG chunks with embeddings stored as JSON array.
    // 50K rows at 50-100 users × 50 chunks each handles the planned 50-1000
    // user range comfortably with in-app cosine similarity. Migrate to pgvector
    // when row count exceeds ~500K.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS user_doc_chunks (
        id           BIGINT PRIMARY KEY AUTO_INCREMENT,
        user_id      VARCHAR(36) NOT NULL,
        doc_id       VARCHAR(36) NOT NULL,
        chunk_index  INT NOT NULL,
        content      TEXT NOT NULL,
        embedding    JSON NOT NULL,
        tokens       INT NOT NULL DEFAULT 0,
        created_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_chunk_user (user_id),
        INDEX idx_chunk_doc (doc_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (doc_id) REFERENCES user_documents(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);
    // ─── end LINE Bot integration tables ─────────────────────────

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS invite_codes (
        id          VARCHAR(36) PRIMARY KEY,
        code        VARCHAR(50) NOT NULL UNIQUE,
        label       VARCHAR(100) NOT NULL,
        is_active   TINYINT NOT NULL DEFAULT 1,
        used_count  INT NOT NULL DEFAULT 0,
        created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Add invite_code_id column to users if not exists
    try {
      await conn.query('ALTER TABLE users ADD COLUMN invite_code_id VARCHAR(36) DEFAULT NULL');
    } catch { /* column already exists */ }

    // Add summary column to conversations if not exists
    try {
      await conn.query('ALTER TABLE conversations ADD COLUMN summary VARCHAR(500) DEFAULT NULL');
    } catch { /* column already exists */ }

    // Add category column to conversations if not exists
    try {
      await conn.query("ALTER TABLE conversations ADD COLUMN category VARCHAR(20) NOT NULL DEFAULT 'document'");
    } catch { /* column already exists */ }

    // Add agent_engine column to conversations if not exists.
    // Stores the per-conversation AI engine choice ('claude' | 'codex').
    // NULL → fall back to the global config.agentEngine default.
    try {
      await conn.query('ALTER TABLE conversations ADD COLUMN agent_engine VARCHAR(16) DEFAULT NULL');
    } catch { /* column already exists */ }

    // Add agent_instructions column to conversations if not exists.
    // Per-assistant custom persona/task instructions (category='assistant'),
    // injected into the router system prompt so each assistant specialises.
    try {
      await conn.query('ALTER TABLE conversations ADD COLUMN agent_instructions TEXT DEFAULT NULL');
    } catch { /* column already exists */ }

    // Add memory_type column to user_memories if not exists
    try {
      await conn.query("ALTER TABLE user_memories ADD COLUMN memory_type VARCHAR(20) NOT NULL DEFAULT 'preference'");
    } catch { /* column already exists */ }

    // Add onboarding columns to users if not exists
    try {
      await conn.query('ALTER TABLE users ADD COLUMN company VARCHAR(100) DEFAULT NULL');
    } catch { /* column already exists */ }
    try {
      await conn.query('ALTER TABLE users ADD COLUMN onboarding_completed TINYINT(1) NOT NULL DEFAULT 0');
    } catch { /* column already exists */ }

    // Personal RAG: track HNSW lazy-build state per document.
    //   'json' = embedding only in MySQL (legacy / not yet ported to HNSW)
    //   'hnsw' = HNSW file on disk is the source of truth (Phase 4 compacted)
    //   'both' = MySQL JSON + HNSW file present (current default after Phase 1)
    try {
      await conn.query("ALTER TABLE user_documents ADD COLUMN embedding_format VARCHAR(10) NOT NULL DEFAULT 'json'");
    } catch { /* column already exists */ }

    // Personal RAG Phase 3: per-chunk metadata for filter DSL.
    // Defaults set by indexDocument: {filename, fileType, source, uploadedAt, chunkIndex}
    // plus any caller-supplied tags/categories. NULL allowed for legacy rows.
    try {
      await conn.query('ALTER TABLE user_doc_chunks ADD COLUMN metadata JSON DEFAULT NULL');
    } catch { /* column already exists */ }

    // Default system settings
    const defaults: Record<string, string> = {
      user_usage_limit_usd: '50',
      storage_quota_gb: '2',
      upload_quota_mb: '500',
    };
    for (const [key, value] of Object.entries(defaults)) {
      const [rows] = await conn.execute<RowDataPacket[]>(
        'SELECT `key` FROM system_settings WHERE `key` = ?', [key]
      );
      if (rows.length === 0) {
        await conn.execute(
          'INSERT INTO system_settings (`key`, value) VALUES (?, ?)', [key, value]
        );
      }
    }

    // Seed admin user
    const [adminRows] = await conn.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = 'admin@zhaoi.ai'"
    );
    if (adminRows.length === 0) {
      const hash = bcrypt.hashSync('zhaoi1023', 12);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      await conn.execute(
        'INSERT INTO users (id, email, password_hash, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), 'admin@zhaoi.ai', hash, 'System Admin', 'admin', 'active', now, now]
      );
      console.log('Admin user seeded: admin@zhaoi.ai');
    }

    // Seed demo user (used by /api/auth/demo-login one-click entry button)
    const [demoRows] = await conn.execute<RowDataPacket[]>(
      "SELECT id FROM users WHERE email = 'demo@theaken.com'"
    );
    if (demoRows.length === 0) {
      // Random unguessable password — demo entry must go through the
      // dedicated /demo-login endpoint, not the password form.
      const hash = bcrypt.hashSync(uuidv4() + uuidv4(), 12);
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      await conn.execute(
        'INSERT INTO users (id, email, password_hash, display_name, role, status, onboarding_completed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [uuidv4(), 'demo@theaken.com', hash, '試用訪客', 'user', 'active', 1, now, now]
      );
      console.log('Demo user seeded: demo@theaken.com');
    }
  } finally {
    conn.release();
  }
}

export default pool;
