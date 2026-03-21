import Database from 'better-sqlite3';
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
    // Set existing conversations (that already have a skill_id) to direct mode
    db.exec("UPDATE conversations SET mode = 'direct' WHERE skill_id IS NOT NULL");
  }
}

export default db;
