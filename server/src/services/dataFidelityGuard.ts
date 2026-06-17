/**
 * Data Fidelity Guard (Phase C) — post-generation verification.
 *
 * After a document is generated from user-uploaded data, this compares the
 * generated content against the SOURCE data (the user's uploaded files) and
 * flags any company/customer/person name or key figure that is NOT in the
 * source and cannot be derived from it (sums / ratios / YoY are allowed).
 *
 * The check is an internal safety net — when violations are found the caller
 * regenerates the document to remove them BEFORE the user sees it (the user is
 * never asked to audit the AI's own mistake).
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import ExcelJS from 'exceljs';
import mammoth from 'mammoth';
import JSZip from 'jszip';
import { extractText, getDocumentProxy } from 'unpdf';
import { config } from '../config.js';
import { dbAll } from '../db.js';
import { resolveClaudeCliPath } from './resolveClaudeCli.js';
import { agentRebuild } from './agentRebuilder.js';
import type { DocumentBlock, GeneratedFile, SSEEvent } from '../types.js';

const MAX_SOURCE_CHARS = 40000;   // cap source text fed to the checker
const MAX_BLOCKS_CHARS = 40000;   // cap generated text fed to the checker
const CHECKER_TIMEOUT = 45000;

export interface FidelityViolation {
  value: string;
  type: string;   // company | customer | person | number | other
  reason: string;
}

// ── Source-file text extraction (the ground truth) ──────────────────────────

function extByName(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toLowerCase() : '';
}

function extractPptxText(buf: Buffer): Promise<string> {
  return JSZip.loadAsync(buf).then(async zip => {
    const parts: string[] = [];
    const names = Object.keys(zip.files).filter(n => /ppt\/slides\/slide\d+\.xml$/.test(n)).sort();
    for (const n of names) {
      const xml = await zip.files[n].async('text');
      const texts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => m[1]);
      if (texts.length) parts.push(texts.join(' '));
    }
    return parts.join('\n');
  });
}

export async function extractFileText(filePath: string): Promise<string> {
  const e = extByName(filePath);
  if (!fs.existsSync(filePath)) return '';
  const buf = fs.readFileSync(filePath);
  try {
    if (e === 'xlsx' || e === 'xls') {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const lines: string[] = [];
      wb.eachSheet(sheet => {
        lines.push(`# ${sheet.name}`);
        sheet.eachRow(row => {
          const cells: string[] = [];
          row.eachCell({ includeEmpty: false }, cell => cells.push(String(cell.text ?? '')));
          if (cells.length) lines.push(cells.join('\t'));
        });
      });
      return lines.join('\n');
    }
    if (e === 'pptx' || e === 'ppt') return await extractPptxText(buf);
    if (e === 'docx') return (await mammoth.extractRawText({ buffer: buf })).value;
    if (e === 'pdf') {
      const pdf = await getDocumentProxy(new Uint8Array(buf));
      const { text } = await extractText(pdf, { mergePages: true });
      return Array.isArray(text) ? text.join('\n') : text;
    }
    if (['csv', 'txt', 'md', 'json', 'tsv'].includes(e)) return buf.toString('utf8');
  } catch (err) {
    console.warn(`[FidelityGuard] extract failed for ${filePath}:`, err);
  }
  return '';
}

/** Build the source-of-truth text from a conversation's uploaded files. */
export async function buildSourceText(userId: string, conversationId: string): Promise<string> {
  const uploads = await dbAll<{ original_name: string; storage_path: string }>(
    `SELECT original_name, storage_path FROM user_uploads
     WHERE user_id = ? AND conversation_id = ? AND scan_status IN ('clean','suspicious')
     ORDER BY created_at ASC`, userId, conversationId);
  const chunks: string[] = [];
  for (const u of uploads) {
    const abs = path.isAbsolute(u.storage_path)
      ? u.storage_path
      : path.join(config.workspaceRoot, u.storage_path);
    const text = await extractFileText(abs);
    if (text.trim()) chunks.push(`=== ${u.original_name} ===\n${text}`);
  }
  return chunks.join('\n\n').slice(0, MAX_SOURCE_CHARS);
}

// ── Tool-less one-shot Claude call (stateless checker) ───────────────────────

function runChecker(prompt: string): Promise<string | null> {
  return new Promise(resolve => {
    const resolved = resolveClaudeCliPath(config.claudeCliPath);
    const args = [
      '-p', '--verbose', '--output-format', 'stream-json', '--max-turns', '1',
      '--model', 'claude-haiku-4-5-20251001',
      '--disallowedTools', 'Bash,Write,Read,Edit,WebSearch,WebFetch,Glob,Grep,Task,TodoWrite,NotebookEdit',
    ];
    const tmpDir = path.join(config.workspaceRoot, '_fidelity', Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    fs.mkdirSync(tmpDir, { recursive: true });
    const cleanup = () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ } };

    function doSpawn(useApiKey: boolean) {
      const env = { ...process.env };
      for (const k of Object.keys(env)) if (k.toUpperCase().startsWith('CLAUDE') || k === 'ANTHROPIC_API_KEY') delete env[k];
      if (useApiKey && config.anthropicApiKey) env['ANTHROPIC_API_KEY'] = config.anthropicApiKey;

      let proc;
      try {
        proc = spawn(resolved.bin, [...resolved.prefix, ...args], { cwd: tmpDir, shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
      } catch { cleanup(); resolve(null); return; }

      proc.stdin!.write(prompt); proc.stdin!.end();
      let output = '', buffer = '', stderr = '';
      proc.stdout!.on('data', (d: Buffer) => {
        buffer += d.toString();
        const lines = buffer.split('\n'); buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const p = JSON.parse(line);
            if (p.type === 'assistant') for (const b of (p.message?.content || [])) if (b.type === 'text') output += b.text;
            else if (p.type === 'result' && typeof p.result === 'string' && !output) output = p.result;
          } catch { /* skip */ }
        }
      });
      proc.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } cleanup(); resolve(output || null); }, CHECKER_TIMEOUT);
      proc.on('exit', code => {
        clearTimeout(timer);
        if (!useApiKey && code !== 0 && !output && /quota|rate.?limit|overloaded/i.test(stderr) && config.anthropicApiKey) {
          doSpawn(true); return;
        }
        cleanup(); resolve(output || null);
      });
    }
    doSpawn(false);
  });
}

// ── The audit ───────────────────────────────────────────────────────────────

function blocksToText(blocks: DocumentBlock[]): string {
  try { return JSON.stringify(blocks).slice(0, MAX_BLOCKS_CHARS); }
  catch { return ''; }
}

function parseViolations(raw: string | null): FidelityViolation[] {
  if (!raw) return [];
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const obj = JSON.parse(m[0]);
    const arr = Array.isArray(obj.violations) ? obj.violations : [];
    return arr
      .filter((v: any) => v && typeof v.value === 'string' && v.value.trim())
      .map((v: any) => ({ value: String(v.value).trim(), type: String(v.type || 'other'), reason: String(v.reason || '') }));
  } catch { return []; }
}

/**
 * Compare generated content against source data. Returns fabricated items
 * (names/numbers not in, and not derivable from, the source).
 */
export async function auditFidelity(sourceText: string, blocks: DocumentBlock[]): Promise<FidelityViolation[]> {
  if (!sourceText.trim() || !blocks.length) return [];
  const blocksText = blocksToText(blocks);
  if (!blocksText) return [];

  const prompt = `你是一個嚴格、保守的資料稽核員。下面有「來源資料」（使用者上傳檔案的真實內容）和「AI 生成文件的內容」。

【重要前提】來源資料是這份文件**唯一合法的資料依據**。使用者只提供了來源資料，AI 不得自行加入任何外部公司/客戶/人名。因此：**凡是出現在生成文件、但在來源資料中找不到的公司名／客戶名／人名，一律視為「被編造」**（即使它是真實存在的知名公司也一樣，因為它不在使用者的來源資料裡）。

你的任務：找出生成文件中，**公司名／客戶名／人名，或關鍵數字**，屬於「在來源資料裡完全找不到、且無法由來源數字計算得出」的項目 —— 這些是被編造的。

判斷規則（務必嚴格遵守，寧可少報也不要誤殺）：
- ✅ 合計、總和、平均、成長率(YoY)、佔比、差額等「由來源數字算得出來」的數字，**不算違規**，不要列。
- ✅ 同一實體的不同寫法（如「台達」vs「台達 GROUP」、全形/半形、有無「股份有限公司」）視為相同，**不要列**。
- ✅ 通用標題、設計用語、欄位名稱（如「銷貨金額」「毛利率」「警訊」）**不算資料**，不要列。
- ❌ 只列「來源完全沒有的公司/客戶/人名」，或「明顯不是衍生、來源也沒有的具體數字」。
- 只輸出 JSON，格式：{"violations":[{"value":"群創","type":"company","reason":"來源客戶清單中無此公司"}]}
- 若沒有任何違規，輸出 {"violations":[]}。不要輸出 JSON 以外的任何文字。

【來源資料（真相）】
${sourceText}

【AI 生成文件的內容】
${blocksText}`;

  return parseViolations(await runChecker(prompt));
}

// ── Enforcement: verify generated docs and auto-correct before the user sees them ──

const REBUILDABLE_TYPES = new Set(['pptx']);                // agentRebuild supports pptx only
const VERIFY_TYPES = new Set(['pptx', 'docx', 'xlsx']);

/**
 * For data documents generated from uploaded files: verify each against the
 * source and auto-correct fabricated entities (pptx) before the user relies on
 * the file. Mutates `blocksByFile` to the corrected blocks and returns a map of
 * any files that were rebuilt (new records). Non-fatal — never throws.
 */
export async function enforceDataFidelity(
  files: GeneratedFile[],
  blocksByFile: Map<string, DocumentBlock[]>,
  userId: string,
  conversationId: string,
  emit: (event: SSEEvent) => void,
): Promise<Map<string, GeneratedFile>> {
  const rebuilt = new Map<string, GeneratedFile>();
  try {
    const verifiable = files.filter(f => VERIFY_TYPES.has(f.file_type) && (blocksByFile.get(f.id)?.length ?? 0) > 0);
    if (!verifiable.length) return rebuilt;

    const sourceText = await buildSourceText(userId, conversationId);
    if (!sourceText.trim()) return rebuilt;   // no uploaded source → nothing to verify against

    for (const file of verifiable) {
      const blocks = blocksByFile.get(file.id)!;
      const violations = await auditFidelity(sourceText, blocks);
      if (!violations.length) continue;

      const names = violations.map(v => v.value).join(', ');
      console.warn(`[FidelityGuard] ${file.filename}: ${violations.length} fabricated item(s) not in source: ${names}`);

      if (!REBUILDABLE_TYPES.has(file.file_type)) {
        // No auto-rebuild path for this type yet — flag for observability; prevention
        // is L1 (fidelity rule) + complete data hand-off.
        emit({ type: 'fidelity_check', data: { fileId: file.id, status: 'flagged', items: violations.map(v => v.value) } });
        continue;
      }

      emit({ type: 'fidelity_check', data: { fileId: file.id, status: 'correcting', count: violations.length } });
      const list = violations.map(v => `「${v.value}」`).join('、');
      const instruction = `【資料稽核 — 必須修正】這份文件中有以下內容**不存在於使用者上傳的來源資料**，屬於編造，請**全部移除**：${list}。\n移除後若版面因此變空，請改放來源中真實存在的資料；若沒有更多真實資料，就讓筆數變少或標「資料未提供」，**絕對不可再用其他公司名或自編數字填補**。所有內容只能來自來源資料、或由其數字計算得出。`;

      const result = await agentRebuild(file.id, userId, undefined, instruction);
      if (result?.blocks) {
        blocksByFile.set(file.id, result.blocks);
        rebuilt.set(file.id, result.file);
        const after = await auditFidelity(sourceText, result.blocks);
        emit({ type: 'fidelity_check', data: { fileId: file.id, status: after.length ? 'residual' : 'clean', count: after.length } });
        console.log(`[FidelityGuard] ${file.filename}: ${after.length ? after.length + ' still flagged' : 'clean'} after rebuild.`);
      }
    }
  } catch (e) {
    console.warn('[FidelityGuard] enforce failed (non-fatal):', e);
  }
  return rebuilt;
}
