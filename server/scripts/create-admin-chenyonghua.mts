/**
 * One-off: create (or upgrade) an admin account in db_ai_agents (pro-panjit).
 *
 *   name:     陳詠樺
 *   email:    aa0909211095@icloud.com
 *   password: Hua000817
 *   role:     admin
 *
 * Idempotent: if the email already exists, it is promoted to admin and the
 * password/display_name are reset.
 */
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import pool, { dbGet } from '../src/db.ts';

const EMAIL = 'aa0909211095@icloud.com';
const NAME = '陳詠樺';
const PASSWORD = 'Hua000817';

const cur = await dbGet<{ db: string }>('SELECT DATABASE() AS db');
if (cur?.db !== 'db_ai_agents') {
  console.error(`Refusing to run: connected to "${cur?.db}", expected db_ai_agents`);
  process.exit(1);
}
console.log('Target DB:', cur.db);

const hash = bcrypt.hashSync(PASSWORD, 12);
const conn = await pool.getConnection();
try {
  const [exists] = await conn.query<any[]>('SELECT id, role FROM users WHERE email = ?', [EMAIL]);
  if (exists.length > 0) {
    await conn.query(
      `UPDATE users
         SET password_hash = ?, display_name = ?, role = 'admin', status = 'active', updated_at = NOW()
       WHERE email = ?`,
      [hash, NAME, EMAIL],
    );
    console.log(`Updated existing user (${exists[0].id}, was role="${exists[0].role}") → admin.`);
  } else {
    await conn.query(
      `INSERT INTO users
         (id, email, password_hash, display_name, role, status, locale,
          onboarding_completed, terms_accepted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'admin', 'active', 'zh-TW', 1, NOW(), NOW(), NOW())`,
      [uuidv4(), EMAIL, hash, NAME],
    );
    console.log('Created new admin user.');
  }
  const row = await dbGet<any>('SELECT id, email, display_name, role, status FROM users WHERE email = ?', [EMAIL]);
  console.log('Result:', row);
} catch (e) {
  console.error('Failed:', e);
  process.exit(1);
} finally {
  conn.release();
}
process.exit(0);
