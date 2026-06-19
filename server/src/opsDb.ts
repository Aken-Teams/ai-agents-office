/**
 * Ops database (db_Ops) — independent schema for the report / ticket system.
 *
 * Kept separate from the main app DB on purpose: the reporting data is meant to
 * be owned by a future centralized ops/maintenance system, so it lives in its
 * own schema with self-contained rows (it stores the source system, deploy mode
 * and the reporter's identity, with no cross-DB foreign keys).
 *
 * Same MySQL server as the main DB; only the database name differs.
 */

import mysql, { RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { config } from './config.js';

const opsPool = mysql.createPool({
  host: config.mysqlHost,
  port: config.mysqlPort,
  user: config.mysqlUser,
  password: config.mysqlPassword,
  database: config.opsMysqlDb,
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 0,
  charset: 'utf8mb4',
  timezone: 'local',
});

export async function opsGet<T = any>(sql: string, ...params: any[]): Promise<T | undefined> {
  const [rows] = await opsPool.query<RowDataPacket[]>(sql, params);
  return rows[0] as T | undefined;
}

export async function opsAll<T = any>(sql: string, ...params: any[]): Promise<T[]> {
  const [rows] = await opsPool.query<RowDataPacket[]>(sql, params);
  return rows as unknown as T[];
}

export async function opsRun(sql: string, ...params: any[]): Promise<ResultSetHeader> {
  const [result] = await opsPool.query<ResultSetHeader>(sql, params);
  return result;
}

export const OPS_TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'rejected'] as const;
export type OpsTicketStatus = (typeof OPS_TICKET_STATUSES)[number];

/** Create the report-system tables in db_Ops if they don't exist. */
export async function initOpsDb(): Promise<void> {
  try {
    await opsPool.query(`
      CREATE TABLE IF NOT EXISTS ops_tickets (
        id               VARCHAR(36) PRIMARY KEY,
        source_system    VARCHAR(50)  NOT NULL DEFAULT 'ai-agents-office',
        deploy_mode      VARCHAR(20),
        user_id          VARCHAR(36),
        user_email       VARCHAR(255),
        user_name        VARCHAR(255),
        type             VARCHAR(50)  NOT NULL,
        title            VARCHAR(500) NOT NULL,
        content          TEXT,
        conversation_url VARCHAR(1000),
        status           VARCHAR(20)  NOT NULL DEFAULT 'open',
        resolution_note  TEXT,
        resolved_by      VARCHAR(255),
        resolved_at      DATETIME,
        deleted_at       DATETIME,
        admin_hidden_at  DATETIME,
        created_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_ops_tickets_user (user_id),
        INDEX idx_ops_tickets_status (status),
        INDEX idx_ops_tickets_created (created_at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // Migration: add soft-delete columns to pre-existing tables.
    //   deleted_at      = the ticket is gone — set by a user withdrawing their own
    //                     report (while open) OR by an admin deleting it. Hidden from
    //                     everyone; the row is kept in db_Ops.
    //   admin_hidden_at = reserved for a future "hide from ops queue only" feature
    //                     (currently unused; admin delete uses deleted_at).
    for (const colName of ['deleted_at', 'admin_hidden_at']) {
      const col = await opsGet<{ n: number }>(
        "SELECT COUNT(*) AS n FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'ops_tickets' AND COLUMN_NAME = ?",
        config.opsMysqlDb, colName,
      );
      if (!col || col.n === 0) await opsPool.query(`ALTER TABLE ops_tickets ADD COLUMN ${colName} DATETIME NULL`);
    }

    await opsPool.query(`
      CREATE TABLE IF NOT EXISTS ops_ticket_images (
        id         VARCHAR(36) PRIMARY KEY,
        ticket_id  VARCHAR(36) NOT NULL,
        role       VARCHAR(20) NOT NULL DEFAULT 'report',
        file_path  VARCHAR(1000) NOT NULL,
        mime_type  VARCHAR(100),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_ops_images_ticket (ticket_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log(`[OpsDB] Connected to "${config.opsMysqlDb}" and ensured report tables.`);
  } catch (err) {
    // Don't crash the whole app if db_Ops is unreachable — the report feature
    // just won't work until it's fixed.
    console.error(`[OpsDB] Failed to init "${config.opsMysqlDb}":`, (err as Error).message);
  }
}

export default opsPool;
