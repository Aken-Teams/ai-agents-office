/**
 * Team document generator — turns a team run's FORMAL REPORT into a real file
 * (Word / PDF / PPT / HTML) by running the SAME doc-gen agents the app already
 * uses, headlessly (NO conversation is created — content comes from the report,
 * output is read straight off the agent's sandbox and served for download).
 *
 * Slow (agents write + run a build script), so it runs as an in-memory async job
 * and the client polls + downloads — same pattern as the security report.
 */
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { dbGet } from '../db.js';
import { spawnClaude } from './claudeCli.js';
import { acquireAiSlot } from './aiConcurrency.js';
import { getSkill, buildSystemPrompt } from '../skills/loader.js';
import { getSandboxPath } from './sandbox.js';
import { recordTokenUsage } from './tokenTracker.js';

export type DocFormat = 'docx' | 'pdf' | 'pptx' | 'html';

const FORMAT_MAP: Record<DocFormat, { skill: string; ext: string; mime: string; label: string; timeoutMs: number }> = {
  docx: { skill: 'docx-gen',   ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word 文件', timeoutMs: 480_000 },
  pdf:  { skill: 'pdf-gen',    ext: '.pdf',  mime: 'application/pdf', label: 'PDF 文件', timeoutMs: 600_000 },
  pptx: { skill: 'pptx-gen',   ext: '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: '簡報', timeoutMs: 900_000 },
  html: { skill: 'slides-gen', ext: '.html', mime: 'text/html; charset=utf-8', label: '網頁簡報', timeoutMs: 600_000 },
};

/** Newest output file of the given extension in dir (ignores build-script sidecars), or null. */
function findOutputFile(dir: string, ext: string): string | null {
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.toLowerCase().endsWith(ext) && !f.includes('.v'))
      .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    return files.length ? path.join(dir, files[0].f) : null;
  } catch { return null; }
}

export interface DocJob {
  status: 'running' | 'done' | 'error';
  buffer?: Buffer;
  filename?: string;
  mime?: string;
  error?: string;
  createdAt: number;
}
const jobs = new Map<string, DocJob>();

export function getDocJob(jobId: string): DocJob | undefined { return jobs.get(jobId); }
export function pruneDocJobs(): void {
  const now = Date.now();
  for (const [id, j] of jobs) if (now - j.createdAt > 30 * 60_000) jobs.delete(id);
}

function safeName(s: string): string {
  return (s || 'report').replace(/[\\/:*?"<>|\n\r]+/g, ' ').trim().slice(0, 60) || 'report';
}

/** Ensure the run has a formal report (report_md); generate it if missing. */
async function ensureReportMarkdown(userId: string, teamId: string, runId: string): Promise<string> {
  const run = await dbGet<{ report_md: string | null; report_status: string | null }>(
    'SELECT report_md, report_status FROM team_runs WHERE id = ? AND team_id = ? AND user_id = ?',
    runId, teamId, userId);
  if (!run) throw new Error('找不到這次協作紀錄');
  if (run.report_md && run.report_status === 'done') return run.report_md;
  // Generate the cohesive formal report first (this is the document's content).
  const { generateFormalReport } = await import('./teamReport.js');
  const out = await generateFormalReport({ userId, teamId, runId });
  if (!out?.markdown?.trim()) throw new Error('報告內容為空，無法產生文件');
  return out.markdown;
}

/** Run a doc-gen agent headlessly and read its output file. */
async function runDocAgent(opts: {
  userId: string; format: DocFormat; reportMd: string; stylePrompt: string; teamTitle: string;
}): Promise<{ buffer: Buffer; filename: string }> {
  const { userId, format, reportMd, stylePrompt, teamTitle } = opts;
  const spec = FORMAT_MAP[format];
  const skill = getSkill(spec.skill);
  if (!skill) throw new Error(`找不到產生器：${spec.skill}`);
  // Doc-gen (Claude CLI + python) is heavy, but the system-wide cap now lives
  // inside spawnClaude — taking a slot here too would deadlock against it.

  // Headless: a throwaway sandbox keyed by a random id (no DB conversation).
  const pseudoConvId = `teamdoc-${uuidv4()}`;
  const agentDir = path.join(getSandboxPath(userId, pseudoConvId), '_agents', spec.skill);
  fs.mkdirSync(agentDir, { recursive: true });

  const systemPrompt = buildSystemPrompt(skill, config.generatorsDir, 'zh-TW');
  const message = [
    `請根據以下「團隊分析報告」的內容，製作一份專業的${spec.label}。`,
    stylePrompt?.trim() ? `\n風格要求：${stylePrompt.trim()}` : '',
    '',
    '【資料來源鐵則】',
    '- 這份文件的內容**只能來自下方的報告**。你的工作是「把這份報告做成文件」，不是「重新研究這個題目」。',
    '- **不要上網查資料**，也不要用你自己既有的知識補充報告裡沒有的數字、公司名、日期或事件。',
    '- 報告沒寫到但版面看起來需要的欄位，寧可留白或寫「報告未提供」，也不要自己補。',
    '- 團隊已經查證過這些內容，使用者收到的文件必須和他在畫面上看到的團隊結論一致；一旦你另外查了別的資料，兩邊就對不起來了。',
    '',
    '===== 報告內容 =====',
    reportMd,
  ].join('\n');

  return await new Promise<{ buffer: Buffer; filename: string }>((resolve, reject) => {
    let settled = false;
    const usage = { inTok: 0, outTok: 0, model: '' };
    const { emitter, abort } = spawnClaude(message, systemPrompt, {
      userId,
      conversationId: pseudoConvId,
      role: 'worker',
      skillId: spec.skill,
      sandboxSubdir: `_agents/${spec.skill}`,
      // No WebSearch/WebFetch. The default worker toolset includes them, and the
      // generator skills are written to research their topic — so this agent went
      // and looked things up on its own, and the emailed file ended up carrying
      // numbers the team never saw. Telling it not to in the prompt is not enough
      // when the tool is sitting right there. It keeps Bash/Write/Read because
      // that is how it runs the generator script and writes the output file.
      customAllowedTools: ['Bash', 'Write', 'Read'],
    });

    const cleanup = () => {
      try { fs.rmSync(getSandboxPath(userId, pseudoConvId), { recursive: true, force: true }); } catch { /* */ }
    };

    // Deliver a produced file if one exists (used on done, and to salvage on
    // timeout/error — generation is slow and the file is often already written).
    const deliver = (): boolean => {
      const out = findOutputFile(agentDir, spec.ext);
      if (!out) return false;
      const buffer = fs.readFileSync(out);
      if (usage.inTok || usage.outTok) {
        recordTokenUsage({ userId, conversationId: null as unknown as string, inputTokens: usage.inTok, outputTokens: usage.outTok, model: usage.model || spec.skill }).catch(() => {});
      }
      cleanup();
      resolve({ buffer, filename: `${safeName(teamTitle || '團隊報告')}${spec.ext}` });
      return true;
    };

    const timeout = setTimeout(() => {
      if (settled) return; settled = true;
      try { abort(); } catch { /* */ }
      // Salvage: the agent may have finished the file without emitting 'done'.
      try { if (deliver()) { console.warn(`[teamDocument] ${spec.skill} timed out but a file was produced — delivering it`); return; } } catch { /* */ }
      cleanup();
      reject(new Error(`${spec.label}產生逾時（超過 ${Math.round(spec.timeoutMs / 60000)} 分鐘）`));
    }, spec.timeoutMs);

    emitter.on('event', async (event: { type: string; data?: unknown }) => {
      if (settled) return;
      if (event.type === 'usage') {
        const u = event.data as { inputTokens?: number; outputTokens?: number; model?: string };
        usage.inTok = u.inputTokens || 0; usage.outTok = u.outputTokens || 0; usage.model = u.model || '';
      } else if (event.type === 'error') {
        settled = true; clearTimeout(timeout);
        const errMsg = typeof event.data === 'string' ? event.data : `${spec.label}產生失敗`;
        // The agent may have produced the file before erroring on a later step — use it.
        try { if (deliver()) { console.warn(`[teamDocument] ${spec.skill} reported an error but a file was produced — delivering it (err: ${errMsg})`); return; } } catch { /* */ }
        console.error(`[teamDocument] ${spec.skill} failed with no output file: ${errMsg}`);
        cleanup();
        reject(new Error(errMsg));
      } else if (event.type === 'done') {
        settled = true; clearTimeout(timeout);
        try {
          if (!deliver()) throw new Error(`未產生${spec.label}檔案（產生器已結束但找不到輸出檔）`);
        } catch (e) {
          console.error(`[teamDocument] ${spec.skill} done but delivery failed:`, e);
          cleanup();
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });
  });
}

/** Start an async job that generates the document; returns a jobId to poll. */
export function startTeamDocumentJob(args: {
  userId: string; teamId: string; runId: string; format: DocFormat; stylePrompt: string; teamTitle: string;
}): string {
  pruneDocJobs();
  const jobId = uuidv4();
  jobs.set(jobId, { status: 'running', createdAt: Date.now() });

  (async () => {
    const { userId, teamId, runId, format, stylePrompt, teamTitle } = args;
    const reportMd = await ensureReportMarkdown(userId, teamId, runId);
    return runDocAgent({ userId, format, reportMd, stylePrompt, teamTitle });
  })()
    .then(({ buffer, filename }) => {
      jobs.set(jobId, { status: 'done', buffer, filename, mime: FORMAT_MAP[args.format].mime, createdAt: Date.now() });
    })
    .catch((err) => {
      console.error('[teamDocument] generation failed:', err);
      jobs.set(jobId, { status: 'error', error: err?.message || '產生失敗', createdAt: Date.now() });
    });

  return jobId;
}

// ─── Scheduled documents ─────────────────────────────────────────────────────
// A schedule can opt to also produce a file each run. Unlike the interactive job
// above (in-memory buffer, polled + downloaded immediately), a scheduled doc is
// persisted to a stable per-run location and delivered later via a share link.

/** Stable on-disk path for a scheduled run's document (runId is a UUID → safe). */
function scheduledDocPath(userId: string, runId: string, ext: string): string {
  return path.join(getSandboxPath(userId, `scheduleddoc-${runId}`), `report${ext}`);
}

/**
 * Generate the document for a scheduled run and persist it so it can be downloaded
 * later via a share link. Slow (runs a doc-gen agent) — call off the scheduler tick.
 */
export async function generateScheduledDoc(args: {
  userId: string; teamId: string; runId: string; format: DocFormat; stylePrompt: string; teamTitle: string;
}): Promise<{ filename: string }> {
  const { userId, teamId, runId, format, stylePrompt, teamTitle } = args;
  const spec = FORMAT_MAP[format];
  const reportMd = await ensureReportMarkdown(userId, teamId, runId);
  const { buffer, filename } = await runDocAgent({ userId, format, reportMd, stylePrompt, teamTitle });
  const dest = scheduledDocPath(userId, runId, spec.ext);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return { filename };
}

/** Read a previously-generated scheduled document for download (null if missing). */
export function readScheduledDoc(userId: string, runId: string, format: DocFormat, teamTitle?: string): { buffer: Buffer; filename: string; mime: string } | null {
  const spec = FORMAT_MAP[format];
  const p = scheduledDocPath(userId, runId, spec.ext);
  if (!fs.existsSync(p)) return null;
  return { buffer: fs.readFileSync(p), filename: `${safeName(teamTitle || '團隊報告')}${spec.ext}`, mime: spec.mime };
}

/** Format metadata (label / ext / mime) — shared by the email link + download route. */
export function docFormatMeta(format: DocFormat): { label: string; ext: string; mime: string } {
  const s = FORMAT_MAP[format];
  return { label: s.label, ext: s.ext, mime: s.mime };
}

/** Is this a valid doc format string? */
export function isDocFormat(v: unknown): v is DocFormat {
  return v === 'docx' || v === 'pdf' || v === 'pptx' || v === 'html';
}
