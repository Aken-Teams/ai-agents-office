/**
 * Demo seeding (db_ai_agents_out): create the "凱景鋼鐵" quota group (limit $30)
 * and 50 demo accounts bound to it.
 *
 *   emails:   kaijing01@demo.com … kaijing50@demo.com
 *   password: demo1234 (shared)
 *
 * Idempotent: re-running skips accounts/groups that already exist.
 */
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import pool, { dbGet } from '../src/db.ts';

const CLIENT = '凱景鋼鐵';
const GROUP_NAME = '凱景鋼鐵';
const GROUP_LIMIT = 30;
const PASSWORD = 'demo1234';
const COUNT = 50;

const cur = await dbGet<{ db: string }>('SELECT DATABASE() AS db');
if (cur?.db !== 'db_ai_agents_out') {
  console.error(`Refusing to run: connected to "${cur?.db}", expected db_ai_agents_out`);
  process.exit(1);
}
console.log('Target DB:', cur.db);

const conn = await pool.getConnection();
try {
  await conn.beginTransaction();

  // 1. Quota group (reuse if it already exists by name)
  const [grpRows] = await conn.query<any[]>('SELECT id, limit_usd FROM quota_groups WHERE name = ?', [GROUP_NAME]);
  let groupId: string;
  if (grpRows.length > 0) {
    groupId = grpRows[0].id;
    console.log(`Group "${GROUP_NAME}" already exists (${groupId}) — reusing.`);
  } else {
    groupId = uuidv4();
    await conn.query(
      'INSERT INTO quota_groups (id, name, limit_usd, description) VALUES (?, ?, ?, ?)',
      [groupId, GROUP_NAME, GROUP_LIMIT, `${CLIENT} demo 帳號群組`],
    );
    console.log(`Created group "${GROUP_NAME}" ($${GROUP_LIMIT}) → ${groupId}`);
  }

  // 2. 50 accounts (skip any that already exist)
  const hash = bcrypt.hashSync(PASSWORD, 12); // same password → one hash reused
  let created = 0, skipped = 0;
  for (let i = 1; i <= COUNT; i++) {
    const nn = String(i).padStart(2, '0');
    const email = `kaijing${nn}@demo.com`;
    const [exists] = await conn.query<any[]>('SELECT id FROM users WHERE email = ?', [email]);
    if (exists.length > 0) { skipped++; continue; }
    await conn.query(
      `INSERT INTO users
         (id, email, password_hash, display_name, role, status, locale, company,
          quota_group_id, onboarding_completed, terms_accepted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'user', 'active', 'zh-TW', ?, ?, 1, NOW(), NOW(), NOW())`,
      [uuidv4(), email, hash, `${CLIENT} ${nn}`, CLIENT, groupId],
    );
    created++;
  }

  await conn.commit();
  console.log(`\nDone. Accounts created: ${created}, skipped (already existed): ${skipped}`);

  const [memberCount] = await conn.query<any[]>('SELECT COUNT(*) AS n FROM users WHERE quota_group_id = ?', [groupId]);
  console.log(`Group "${GROUP_NAME}" now has ${memberCount[0].n} members.`);
  console.log(`\nLogin: kaijing01@demo.com … kaijing${String(COUNT).padStart(2, '0')}@demo.com  /  password: ${PASSWORD}`);
} catch (e) {
  await conn.rollback();
  console.error('Failed, rolled back:', e);
  process.exit(1);
} finally {
  conn.release();
}
process.exit(0);
