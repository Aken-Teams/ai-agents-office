/**
 * One-off cleanup: remove the 50 kaijing demo accounts + the 凱景鋼鐵 quota group
 * from db_ai_agents_out. User-confirmed. FK ON DELETE CASCADE removes their
 * conversations/files/etc.
 */
import pool, { dbGet, dbAll } from '../src/db.ts';

const cur = await dbGet<{ db: string }>('SELECT DATABASE() AS db');
if (cur?.db !== 'db_ai_agents_out') {
  console.error(`Refusing: connected to "${cur?.db}", expected db_ai_agents_out`);
  process.exit(1);
}

const targets = await dbAll<{ id: string; email: string }>(
  "SELECT id, email FROM users WHERE email LIKE 'kaijing%@demo.com' AND company = '凱景鋼鐵'"
);
console.log(`Found ${targets.length} kaijing accounts to delete.`);
if (targets.length === 0) { console.log('Nothing to delete.'); process.exit(0); }
if (targets.length > 60) {
  console.error('Safety stop: more rows than expected (>60). Aborting.');
  process.exit(1);
}

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();
  const ids = targets.map(t => t.id);
  const placeholders = ids.map(() => '?').join(',');
  const [del] = await conn.query<any>(`DELETE FROM users WHERE id IN (${placeholders})`, ids);
  // Remove the now-empty group (created solely for these demo accounts).
  const [grpDel] = await conn.query<any>("DELETE FROM quota_groups WHERE name = '凱景鋼鐵'");
  await conn.commit();
  console.log(`Deleted users: ${del.affectedRows}; deleted 凱景鋼鐵 group rows: ${grpDel.affectedRows}`);
} catch (e) {
  await conn.rollback();
  console.error('Failed, rolled back:', e);
  process.exit(1);
} finally {
  conn.release();
}
process.exit(0);
