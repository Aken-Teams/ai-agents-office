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
import { getSkill, buildSystemPrompt } from '../skills/loader.js';
import { getSandboxPath } from './sandbox.js';
import { recordTokenUsage } from './tokenTracker.js';

export type DocFormat = 'docx' | 'pdf' | 'pptx' | 'html';

const FORMAT_MAP: Record<DocFormat, { skill: string; ext: string; mime: string; label: string; timeoutMs: number }> = {
  docx: { skill: 'docx-gen',   ext: '.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', label: 'Word 文件', timeoutMs: 300_000 },
  pdf:  { skill: 'pdf-gen',    ext: '.pdf',  mime: 'application/pdf', label: 'PDF 文件', timeoutMs: 480_000 },
  pptx: { skill: 'pptx-gen',   ext: '.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', label: '簡報', timeoutMs: 600_000 },
  html: { skill: 'slides-gen', ext: '.html', mime: 'text/html; charset=utf-8', label: '網頁簡報', timeoutMs: 480_000 },
};

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
function runDocAgent(opts: {
  userId: string; format: DocFormat; reportMd: string; stylePrompt: string; teamTitle: string;
}): Promise<{ buffer: Buffer; filename: string }> {
  const { userId, format, reportMd, stylePrompt, teamTitle } = opts;
  const spec = FORMAT_MAP[format];
  const skill = getSkill(spec.skill);
  if (!skill) throw new Error(`找不到產生器：${spec.skill}`);

  // Headless: a throwaway sandbox keyed by a random id (no DB conversation).
  const pseudoConvId = `teamdoc-${uuidv4()}`;
  const agentDir = path.join(getSandboxPath(userId, pseudoConvId), '_agents', spec.skill);
  fs.mkdirSync(agentDir, { recursive: true });

  const systemPrompt = buildSystemPrompt(skill, config.generatorsDir, 'zh-TW');
  const message = [
    `請根據以下「團隊分析報告」的內容，製作一份專業的${spec.label}。`,
    stylePrompt?.trim() ? `\n風格要求：${stylePrompt.trim()}` : '',
    '\n內容必須忠於下面的報告，不要新增報告裡沒有的資料或數字。\n',
    '===== 報告內容 =====',
    reportMd,
  ].join('\n');

  return new Promise((resolve, reject) => {
    let settled = false;
    const usage = { inTok: 0, outTok: 0, model: '' };
    const { emitter, abort } = spawnClaude(message, systemPrompt, {
      userId,
      conversationId: pseudoConvId,
      role: 'worker',
      skillId: spec.skill,
      sandboxSubdir: `_agents/${spec.skill}`,
    });

    const timeout = setTimeout(() => {
      if (settled) return; settled = true;
      try { abort(); } catch { /* */ }
      cleanup();
      reject(new Error(`${spec.label}產生逾時`));
    }, spec.timeoutMs);

    const cleanup = () => {
      try { fs.rmSync(getSandboxPath(userId, pseudoConvId), { recursive: true, force: true }); } catch { /* */ }
    };

    emitter.on('event', async (event: { type: string; data?: unknown }) => {
      if (settled) return;
      if (event.type === 'usage') {
        const u = event.data as { inputTokens?: number; outputTokens?: number; model?: string };
        usage.inTok = u.inputTokens || 0; usage.outTok = u.outputTokens || 0; usage.model = u.model || '';
      } else if (event.type === 'error') {
        settled = true; clearTimeout(timeout); cleanup();
        reject(new Error(typeof event.data === 'string' ? event.data : `${spec.label}產生失敗`));
      } else if (event.type === 'done') {
        settled = true; clearTimeout(timeout);
        try {
          const files = fs.readdirSync(agentDir)
            .filter(f => f.toLowerCase().endsWith(spec.ext) && !f.includes('.v'))
            .map(f => ({ f, m: fs.statSync(path.join(agentDir, f)).mtimeMs }))
            .sort((a, b) => b.m - a.m);
          if (files.length === 0) throw new Error(`未產生${spec.label}檔案`);
          const buffer = fs.readFileSync(path.join(agentDir, files[0].f));
          // Best-effort billing (headless → no conversation; conversation_id nullable).
          if (usage.inTok || usage.outTok) {
            recordTokenUsage({ userId, conversationId: null as unknown as string, inputTokens: usage.inTok, outputTokens: usage.outTok, model: usage.model || spec.skill }).catch(() => {});
          }
          cleanup();
          resolve({ buffer, filename: `${safeName(teamTitle || '團隊報告')}${spec.ext}` });
        } catch (e) {
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
