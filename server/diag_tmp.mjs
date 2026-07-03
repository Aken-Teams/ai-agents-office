// TEMP read-only — scope email-agent (信件助手) token usage across all users. Deleted after.
import fs from 'fs';
import path from 'path';
import mysql from 'mysql2/promise';

const env = {};
for (const line of fs.readFileSync(path.join(process.cwd(), '..', '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const conn = await mysql.createConnection({
  host: env.MYSQL_HOST, port: parseInt(env.MYSQL_PORT || '3306', 10),
  user: env.MYSQL_USER, password: env.MYSQL_PASSWORD, database: env.MYSQL_DB,
});

// Email-agent token rows = token_usage joined to a conversation titled '信件助手'.
const [perUser] = await conn.query(
  `SELECT u.email, u.display_name,
          COUNT(*) rows_, SUM(tu.input_tokens) in_tok, SUM(tu.output_tokens) out_tok,
          SUM(tu.input_tokens+tu.output_tokens) total
   FROM token_usage tu
   JOIN conversations c ON c.id = tu.conversation_id AND c.title = '信件助手'
   JOIN users u ON u.id = tu.user_id
   GROUP BY tu.user_id, u.email, u.display_name
   ORDER BY total DESC`);
console.log('=== Email-agent (信件助手) tokens per user ===');
console.table(perUser);

const [grand] = await conn.query(
  `SELECT COUNT(*) rows_, SUM(tu.input_tokens) in_tok, SUM(tu.output_tokens) out_tok
   FROM token_usage tu JOIN conversations c ON c.id = tu.conversation_id AND c.title = '信件助手'`);
console.log('\nGRAND TOTAL email-agent:', grand[0]);

// Split by Layer (L1 auto-summary <6k input vs L2 deep-analysis >=6k) so we can see
// how much is the re-scan waste vs deliberate deep analyses.
const [byBand] = await conn.query(
  `SELECT CASE WHEN tu.input_tokens < 6000 THEN 'L1 auto (<6k)' ELSE 'L2 deep (>=6k)' END band,
          COUNT(*) rows_, SUM(tu.input_tokens) in_tok, SUM(tu.output_tokens) out_tok
   FROM token_usage tu JOIN conversations c ON c.id = tu.conversation_id AND c.title = '信件助手'
   GROUP BY band`);
console.log('\nBy layer band:'); console.table(byBand);

await conn.end();
