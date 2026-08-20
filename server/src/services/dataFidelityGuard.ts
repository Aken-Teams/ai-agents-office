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
import { acquireAuxAiSlot } from './auxAiConcurrency.js';
import { logAiCall } from './aiCallLog.js';
import { agentRebuild, agentRegenerateInPlace } from './agentRebuilder.js';
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

/**
 * One cell as text, and NEVER throws.
 *
 * exceljs's `cell.text` getter blows up on a merged cell whose master is empty
 * ("Cannot read properties of null (reading 'toString')" from MergeValue) — and
 * a merged title bar over a table is how half the spreadsheets people upload are
 * laid out. One such cell used to abort the whole workbook read, which returned
 * "" and silently turned OFF the fidelity check for that document. A guard that
 * quietly stops guarding is worse than one that fails loudly.
 */
function xlsxCellText(cell: ExcelJS.Cell): string {
  try {
    // Dates first: exceljs renders them as "Thu Aug 20 2026 08:00:00 GMT+0800",
    // while the generated document will say 2026-08-20. This text is what the
    // checker compares against, so the tidier form makes a real match likelier.
    if (cell.value instanceof Date) return cell.value.toISOString().slice(0, 10);
    const t = cell.text;
    if (t != null && t !== '') return String(t);
  } catch { /* merged-with-empty-master — read the raw value instead */ }
  try {
    const v = cell.value as unknown;
    if (v === null || v === undefined) return '';
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.richText)) return (o.richText as { text?: string }[]).map(r => r.text ?? '').join('');
    if ('result' in o) return o.result == null ? '' : String(o.result);   // formula → its computed value
    if ('text' in o) return String(o.text ?? '');                          // hyperlink
    if ('error' in o) return String(o.error ?? '');                        // #REF! etc — keep it visible
    return '';
  } catch {
    return '';
  }
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
          row.eachCell({ includeEmpty: false }, cell => {
            const t = xlsxCellText(cell);
            if (t) cells.push(t);
          });
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
    if (e === 'html' || e === 'htm') {
      // Strip styling noise but KEEP inline <script> bodies — chart data (ECharts
      // option objects with the real numbers/names) lives inside <script>, so we
      // only drop <style>/comments and the tag angle-brackets, never script text.
      return buf.toString('utf8')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<!--[\s\S]*?-->/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ');
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
  const unreadable: string[] = [];
  for (const u of uploads) {
    const abs = path.isAbsolute(u.storage_path)
      ? u.storage_path
      : path.join(config.workspaceRoot, u.storage_path);
    const text = await extractFileText(abs);
    if (text.trim()) chunks.push(`=== ${u.original_name} ===\n${text}`);
    else unreadable.push(u.original_name);
  }
  // Say it out loud. An upload we cannot read means the generated document goes
  // out WITHOUT the fabrication check that is the whole point of this module,
  // and the only trace of that used to be one warn line about a stack trace.
  if (unreadable.length) {
    console.warn(
      `[FidelityGuard] ${unreadable.length}/${uploads.length} upload(s) produced no text — ` +
      `the fidelity check cannot verify against them: ${unreadable.join(', ')}`,
    );
  }
  return chunks.join('\n\n').slice(0, MAX_SOURCE_CHARS);
}

// ── Tool-less one-shot Claude call (stateless checker) ───────────────────────

async function runChecker(prompt: string): Promise<string | null> {
  // Auxiliary spawn: bypasses spawnClaude()'s AI_MAX_CONCURRENT gate, so cap it
  // here. Held across the api-key retry below (same logical job) and released
  // exactly once at a terminal state.
  const releaseAux = await acquireAuxAiSlot();
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
      } catch { cleanup(); releaseAux(); resolve(null); return; }

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
      // Cap stderr retention (last 16KB) — the old unbounded += grew this string
      // for the whole subprocess lifetime (same leak class fixed in claudeCli.ts).
      const MAX_STDERR = 16 * 1024;
      proc.stderr!.on('data', (d: Buffer) => {
        stderr += d.toString();
        if (stderr.length > MAX_STDERR) stderr = stderr.slice(-MAX_STDERR);
      });
      const timer = setTimeout(() => { try { proc.kill(); } catch { /* ignore */ } cleanup(); releaseAux(); resolve(output || null); }, CHECKER_TIMEOUT);
      proc.on('exit', code => {
        clearTimeout(timer);
        logAiCall({
          role: 'system', skillId: 'fidelity-guard',
          model: 'claude-haiku-4-5-20251001',
          authMode: useApiKey ? 'api_key' : 'account',
          reason: useApiKey ? 'account-quota-fallback' : 'primary',
          inputTokens: 0, outputTokens: 0, exitCode: code, success: !!output,
        });
        if (!useApiKey && code !== 0 && !output && /quota|rate.?limit|overloaded/i.test(stderr) && config.anthropicApiKey) {
          doSpawn(true); return;   // retry reuses the slot — do NOT release here
        }
        cleanup(); releaseAux(); resolve(output || null);
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
  return auditFidelityText(sourceText, blocksToText(blocks));
}

/**
 * Core audit over the generated document's TEXT (format-agnostic). Used so we
 * can verify ANY output type — pptx/docx/xlsx/pdf/html — by feeding the text
 * extracted from the generated file itself, not just block JSON.
 */
export async function auditFidelityText(sourceText: string, generatedText: string): Promise<FidelityViolation[]> {
  if (!sourceText.trim() || !generatedText.trim()) return [];

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
${generatedText}`;

  return parseViolations(await runChecker(prompt));
}

/** Extract the generated document's content as text for the fidelity audit.
 *  Reads the file itself (covers pptx/docx/xlsx/pdf/html); falls back to block
 *  JSON when file extraction yields nothing. */
async function generatedTextForAudit(file: GeneratedFile, blocks: DocumentBlock[] | undefined): Promise<string> {
  const abs = path.isAbsolute(file.file_path) ? file.file_path : path.join(config.workspaceRoot, file.file_path);
  const fromFile = await extractFileText(abs);
  if (fromFile.trim()) return fromFile.slice(0, MAX_BLOCKS_CHARS);
  return blocks ? blocksToText(blocks) : '';
}

// ── Enforcement: verify generated docs and auto-correct before the user sees them ──

// Verified against the source for ALL data document types the wizard produces.
const VERIFY_TYPES = new Set(['pptx', 'docx', 'xlsx', 'pdf', 'html']);
// pptx has a dedicated high-quality rebuild (slides.json aware); everything else
// is corrected by resuming its own generator session and regenerating in place.
const PPTX_REBUILD_TYPES = new Set(['pptx']);

/**
 * Build the removal instruction handed to the corrector agent.
 */
function buildFidelityFixInstruction(violations: FidelityViolation[]): string {
  const list = violations.map(v => `「${v.value}」`).join('、');
  return `【資料稽核 — 必須修正】這份文件中有以下內容**不存在於使用者上傳的來源資料**，屬於編造，請**全部移除**：${list}。\n移除後若版面因此變空，請改放來源中真實存在的資料；若沒有更多真實資料，就讓筆數變少或標「資料未提供」，**絕對不可再用其他公司名或自編數字填補**。所有內容只能來自來源資料、或由其數字計算得出（合計／成長率／佔比等可由來源算出的數字允許）。`;
}

/**
 * For data documents generated from uploaded files: verify each against the
 * source and auto-correct fabricated entities BEFORE the user relies on the
 * file. Covers pptx/docx/xlsx/pdf/html.
 *
 * - pptx → high-quality `agentRebuild` (slides.json aware).
 * - other types → when `resolveCorrection` yields a context for the file, resume
 *   that file's own generator session and regenerate it in place with the
 *   fabricated items removed. Works for BOTH the template-wizard (direct: base
 *   sandbox + conversation session) and orchestrated (auto: `_agents/{skillId}`
 *   + per-skill agent_session) flows. When no context is resolved, the violation
 *   is flagged for observability instead.
 *
 * Mutates `blocksByFile` to corrected blocks where applicable and returns a map
 * of any files that were rebuilt. Non-fatal — never throws.
 */
export async function enforceDataFidelity(
  files: GeneratedFile[],
  blocksByFile: Map<string, DocumentBlock[]>,
  userId: string,
  conversationId: string,
  emit: (event: SSEEvent) => void,
  resolveCorrection?: (file: GeneratedFile) => Promise<{ skillId: string; sessionId: string; sandboxSubdir?: string } | null>,
): Promise<Map<string, GeneratedFile>> {
  const rebuilt = new Map<string, GeneratedFile>();
  try {
    const verifiable = files.filter(f => VERIFY_TYPES.has(f.file_type));
    if (!verifiable.length) return rebuilt;

    const sourceText = await buildSourceText(userId, conversationId);
    if (!sourceText.trim()) return rebuilt;   // no uploaded source → nothing to verify against

    for (const file of verifiable) {
      const generatedText = await generatedTextForAudit(file, blocksByFile.get(file.id));
      const violations = await auditFidelityText(sourceText, generatedText);
      if (!violations.length) continue;

      const names = violations.map(v => v.value).join(', ');
      console.warn(`[FidelityGuard] ${file.filename}: ${violations.length} fabricated item(s) not in source: ${names}`);

      const instruction = buildFidelityFixInstruction(violations);

      // ── pptx: dedicated rebuild ──
      if (PPTX_REBUILD_TYPES.has(file.file_type)) {
        emit({ type: 'fidelity_check', data: { fileId: file.id, status: 'correcting', count: violations.length } });
        const result = await agentRebuild(file.id, userId, undefined, instruction);
        if (result?.blocks) {
          blocksByFile.set(file.id, result.blocks);
          rebuilt.set(file.id, result.file);
          const after = await auditFidelity(sourceText, result.blocks);
          emit({ type: 'fidelity_check', data: { fileId: file.id, status: after.length ? 'residual' : 'clean', count: after.length } });
        }
        continue;
      }

      // ── docx/xlsx/pdf/html: regenerate in place via the file's own session ──
      const ctx = resolveCorrection ? await resolveCorrection(file) : null;
      if (ctx) {
        emit({ type: 'fidelity_check', data: { fileId: file.id, status: 'correcting', count: violations.length } });
        const fixed = await agentRegenerateInPlace(
          file, userId, conversationId, ctx.skillId, ctx.sessionId, instruction, ctx.sandboxSubdir,
        );
        if (fixed) {
          rebuilt.set(file.id, fixed);
          const afterText = await generatedTextForAudit(fixed, blocksByFile.get(file.id));
          const after = await auditFidelityText(sourceText, afterText);
          emit({ type: 'fidelity_check', data: { fileId: file.id, status: after.length ? 'residual' : 'clean', count: after.length } });
          console.log(`[FidelityGuard] ${file.filename}: ${after.length ? after.length + ' still flagged' : 'clean'} after regenerate.`);
        } else {
          emit({ type: 'fidelity_check', data: { fileId: file.id, status: 'flagged', items: violations.map(v => v.value) } });
        }
        continue;
      }

      // No correction context resolved (e.g. no session / not a worker-dir file)
      // → flag for observability instead of silently leaving it.
      emit({ type: 'fidelity_check', data: { fileId: file.id, status: 'flagged', items: violations.map(v => v.value) } });
    }
  } catch (e) {
    console.warn('[FidelityGuard] enforce failed (non-fatal):', e);
  }
  return rebuilt;
}
