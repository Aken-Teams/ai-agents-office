import Database from 'better-sqlite3';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config.js';

const db = new Database(config.dbPath);

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export function initializeDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      email         TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name  TEXT,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT NOT NULL DEFAULT 'New Conversation',
      skill_id      TEXT,
      session_id    TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_conversations_user ON conversations(user_id);

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      metadata        TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

    CREATE TABLE IF NOT EXISTS generated_files (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      filename        TEXT NOT NULL,
      file_path       TEXT NOT NULL,
      file_type       TEXT NOT NULL,
      file_size       INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_files_user ON generated_files(user_id);
    CREATE INDEX IF NOT EXISTS idx_files_conversation ON generated_files(conversation_id);

    CREATE TABLE IF NOT EXISTS token_usage (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      model           TEXT,
      duration_ms     INTEGER,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_usage_user ON token_usage(user_id);
    CREATE INDEX IF NOT EXISTS idx_usage_created ON token_usage(created_at);

    -- Task execution tracking (multi-agent orchestration)
    CREATE TABLE IF NOT EXISTS task_executions (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      pipeline_id     TEXT,
      skill_id        TEXT NOT NULL,
      description     TEXT,
      status          TEXT DEFAULT 'pending',
      result_summary  TEXT,
      input_tokens    INTEGER DEFAULT 0,
      output_tokens   INTEGER DEFAULT 0,
      started_at      TEXT,
      completed_at    TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_task_exec_conversation ON task_executions(conversation_id);

    -- Agent sessions (persistent across conversation turns)
    CREATE TABLE IF NOT EXISTS agent_sessions (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      skill_id        TEXT NOT NULL,
      session_uuid    TEXT NOT NULL,
      initialized     INTEGER DEFAULT 0,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(conversation_id, skill_id)
    );
  `);

  // Migration: add mode column to conversations if missing
  // Default NULL = auto-detect; 'direct' = forced direct; 'orchestrated' = forced orchestrated
  try {
    db.prepare("SELECT mode FROM conversations LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE conversations ADD COLUMN mode TEXT");
    db.exec("UPDATE conversations SET mode = 'direct' WHERE skill_id IS NOT NULL");
  }

  // Migration: add role + status columns to users if missing
  try {
    db.prepare("SELECT role FROM users LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }
  try {
    db.prepare("SELECT status FROM users LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  }

  // Migration: add locale + theme columns to users
  try { db.prepare("SELECT locale FROM users LIMIT 1").get(); }
  catch { db.exec("ALTER TABLE users ADD COLUMN locale TEXT NOT NULL DEFAULT 'zh-TW'"); }
  try { db.prepare("SELECT theme FROM users LIMIT 1").get(); }
  catch { db.exec("ALTER TABLE users ADD COLUMN theme TEXT NOT NULL DEFAULT 'dark'"); }

  // Migration: add conversation_id to user_uploads if missing
  try {
    db.prepare("SELECT conversation_id FROM user_uploads LIMIT 1").get();
  } catch {
    db.exec("ALTER TABLE user_uploads ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL");
  }

  // Admin audit log table
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id          TEXT PRIMARY KEY,
      admin_id    TEXT NOT NULL,
      action      TEXT NOT NULL,
      target_type TEXT,
      target_id   TEXT,
      details     TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_audit_admin ON admin_audit_log(admin_id);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON admin_audit_log(created_at);
  `);

  // Security events table (inputGuard logging)
  db.exec(`
    CREATE TABLE IF NOT EXISTS security_events (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      event_type  TEXT NOT NULL,
      severity    TEXT NOT NULL DEFAULT 'low',
      detail      TEXT,
      raw_input   TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_security_events_user ON security_events(user_id);
    CREATE INDEX IF NOT EXISTS idx_security_events_created ON security_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_security_events_severity ON security_events(severity);
  `);

  // User uploads table (user-provided files for analysis)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_uploads (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      filename        TEXT NOT NULL,
      original_name   TEXT NOT NULL,
      file_type       TEXT NOT NULL,
      mime_type       TEXT,
      file_size       INTEGER NOT NULL DEFAULT 0,
      scan_status     TEXT NOT NULL DEFAULT 'pending',
      scan_detail     TEXT,
      storage_path    TEXT NOT NULL,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_uploads_user ON user_uploads(user_id);
    CREATE INDEX IF NOT EXISTS idx_uploads_scan ON user_uploads(scan_status);
    CREATE INDEX IF NOT EXISTS idx_uploads_conv ON user_uploads(conversation_id);
  `);

  // System settings (key-value store for admin-configurable values)
  db.exec(`
    CREATE TABLE IF NOT EXISTS system_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Default system settings
  const defaults: Record<string, string> = {
    user_usage_limit_usd: '50',        // Per-user usage cap in x10 display dollars
    storage_quota_gb: '2',             // Per-user generated file storage quota (GB)
    upload_quota_mb: '500',            // Per-user upload storage quota (MB)
  };
  for (const [key, value] of Object.entries(defaults)) {
    const exists = db.prepare("SELECT key FROM system_settings WHERE key = ?").get(key);
    if (!exists) {
      db.prepare("INSERT INTO system_settings (key, value) VALUES (?, ?)").run(key, value);
    }
  }

  // Seed admin user
  const adminExists = db.prepare("SELECT id FROM users WHERE email = 'admin@zhaoi.ai'").get();
  if (!adminExists) {
    const hash = bcrypt.hashSync('zhaoi1023', 12);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO users (id, email, password_hash, display_name, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(uuidv4(), 'admin@zhaoi.ai', hash, 'System Admin', 'admin', 'active', now, now);
    console.log('Admin user seeded: admin@zhaoi.ai');
  }
}

export default db;
