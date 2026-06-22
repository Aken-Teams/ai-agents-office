/**
 * READ-ONLY inspection of the target DB before the demo seeding.
 * Confirms we're on db_ai_agents_out and the expected columns exist.
 */
import { dbGet, dbAll } from '../src/db.ts';

const cur = await dbGet<{ db: string }>('SELECT DATABASE() AS db');
console.log('Connected DB:', cur?.db);

const userCols = await dbAll<{ Field: string; Type: string }>('SHOW COLUMNS FROM users');
const want = ['id', 'email', 'password_hash', 'display_name', 'role', 'status', 'company', 'quota_group_id', 'onboarding_completed', 'terms_accepted_at', 'quota_override'];
console.log('\nusers columns present:');
for (const w of want) console.log(`  ${want.includes(w) ? '' : ''}${w}: ${userCols.find(c => c.Field === w) ? 'YES' : 'MISSING'}`);

const qgCols = await dbAll<{ Field: string; Type: string }>('SHOW COLUMNS FROM quota_groups');
console.log('\nquota_groups columns:', qgCols.map(c => `${c.Field}(${c.Type})`).join(', '));

const userCount = await dbGet<{ n: number }>('SELECT COUNT(*) AS n FROM users');
console.log('\nTotal users:', userCount?.n);

const existing = await dbAll<{ email: string; company: string }>(
  "SELECT email, company FROM users WHERE company LIKE '%凱景%' OR email LIKE 'kaijing%'"
);
console.log('Existing 凱景/kaijing users:', existing.length);
for (const e of existing.slice(0, 10)) console.log('  ', e.email, '|', e.company);

const groups = await dbAll<{ name: string; limit_usd: number }>('SELECT name, limit_usd FROM quota_groups');
console.log('\nExisting quota groups:', groups.map(g => `${g.name}($${g.limit_usd})`).join(', ') || '(none)');

process.exit(0);
