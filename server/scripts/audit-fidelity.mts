/**
 * Data-fidelity audit CLI.
 *
 * Given a conversation ID, pulls that conversation's uploaded files (the source
 * of truth) and every generated pptx/docx/xlsx, then reports any company /
 * customer / person name or figure in the output that is NOT in the source —
 * i.e. fabricated data. Run on the server where uploaded files exist on disk.
 *
 *   tsx scripts/audit-fidelity.mts <conversationId>
 */
import { dbAll } from '../src/db.js';
import { buildSourceText, auditFidelity } from '../src/services/dataFidelityGuard.js';

const convId = process.argv[2];
if (!convId) {
  console.error('用法: tsx scripts/audit-fidelity.mts <conversationId>');
  process.exit(1);
}

const conv = await dbAll<{ user_id: string; title: string }>(
  'SELECT user_id, title FROM conversations WHERE id = ?', convId,
);
if (!conv.length) {
  console.error('找不到對話:', convId);
  process.exit(1);
}
const userId = conv[0].user_id;
console.log(`對話：${conv[0].title}`);
console.log(`user：${userId}\n`);

const sourceText = await buildSourceText(userId, convId);
console.log(`來源資料（上傳檔萃取）長度：${sourceText.length} 字`);
if (!sourceText.length) {
  console.log('→ 此對話沒有可讀的上傳檔，無法稽核（生成內容沒有「真相」可對照）。');
  process.exit(0);
}
console.log('');

const files = await dbAll<{ id: string; filename: string; file_type: string; blocks: string }>(
  `SELECT g.id, g.filename, g.file_type, db.blocks
   FROM generated_files g JOIN document_blocks db ON db.file_id = g.id
   WHERE g.conversation_id = ? AND g.file_type IN ('pptx','docx','xlsx')
   ORDER BY g.created_at DESC`, convId,
);
if (!files.length) {
  console.log('此對話沒有 pptx/docx/xlsx 生成檔可稽核。');
  process.exit(0);
}

let totalViolations = 0;
for (const f of files) {
  let blocks: any[] = [];
  try { const p = JSON.parse(f.blocks); blocks = Array.isArray(p) ? p : (p.blocks || []); } catch { /* ignore */ }
  if (!blocks.length) { console.log(`📄 ${f.filename} (${f.file_type}) → 無 block 資料，略過`); continue; }
  const v = await auditFidelity(sourceText, blocks);
  totalViolations += v.length;
  console.log(`📄 ${f.filename} (${f.file_type}) → ${v.length ? `⚠ ${v.length} 個疑似編造` : '✅ 乾淨'}`);
  for (const x of v) console.log(`     - ${x.value} [${x.type}] — ${x.reason}`);
}

console.log(`\n=== 共 ${files.length} 份文件，${totalViolations} 個疑似編造項 ===`);
process.exit(0);
