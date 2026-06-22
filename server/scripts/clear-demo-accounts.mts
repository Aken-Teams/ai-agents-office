/**
 * MANUAL cleanup of guest demo accounts (db_ai_agents_out).
 * Deletes ONLY users with is_demo=1 (and their data via FK cascade). Safe to run
 * anytime after an event. Pass --expired-only to delete just the expired ones.
 *
 *   pnpm --filter ai-agents-office-server exec tsx scripts/clear-demo-accounts.mts
 *   pnpm --filter ai-agents-office-server exec tsx scripts/clear-demo-accounts.mts --expired-only
 */
import pool, { dbGet, dbAll } from '../src/db.ts';

const cur = await dbGet<{ db: string }>('SELECT DATABASE() AS db');
if (cur?.db !== 'db_ai_agents_out') {
  console.error(`Refusing: connected to "${cur?.db}", expected db_ai_agents_out`);
  process.exit(1);
}

const expiredOnly = process.argv.includes('--expired-only');
const where = expiredOnly
  ? 'is_demo = 1 AND demo_expires_at IS NOT NULL AND demo_expires_at < NOW()'
  : 'is_demo = 1';

const rows = await dbAll<{ id: string; display_name: string; demo_expires_at: string }>(
  `SELECT id, display_name, demo_expires_at FROM users WHERE ${where}`,
);
console.log(`${expiredOnly ? 'Expired' : 'All'} demo accounts to delete: ${rows.length}`);
if (!rows.length) { console.log('Nothing to delete.'); process.exit(0); }

const ids = rows.map(r => r.id);
const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const placeholders = ids.map(() => '?').join(',');
  const [del] = await conn.query<any>(`DELETE FROM users WHERE id IN (${placeholders})`, ids);
  await conn.commit();
  console.log(`Deleted ${del.affectedRows} demo account(s).`);
} catch (e) {
  await conn.rollback();
  console.error('Failed, rolled back:', e);
  process.exit(1);
} finally {
  conn.release();
}
process.exit(0);
