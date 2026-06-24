/**
 * Agent Teams API.
 *
 * A team groups several assistant conversations under one topic. Teams are
 * instantiated from preset templates (teamTemplates.ts); when a topic is given
 * and `aiTune` is on, DeepSeek rewrites each agent's role prompt to specialise
 * for that topic. The actual multi-agent "team run" (coordinator orchestration)
 * is a later phase — this file only handles CRUD + instantiation.
 */

import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { TEAM_TEMPLATES, getTeamTemplate, type TeamAgentTemplate } from '../data/teamTemplates.js';
import { runTeam, estimateRunTokens, estimateCostUsd } from '../services/teamRun.js';
import { checkUserUsageLimit } from '../services/usageLimit.js';
import { analyzeInput, logSecurityEvent } from '../services/inputGuard.js';
import { moderateTeamTopic } from '../services/contentSafety.js';
import { computeNextRun, mysqlDateTime, runScheduleNow } from '../services/teamScheduler.js';
import { generateTeamSpec, insertTeamWithAgents, type GeneratedAgent } from '../services/teamBuilder.js';
import type { Conversation } from '../types.js';

const router = Router();
router.use(authMiddleware);

interface AgentTeamRow {
  id: string;
  user_id: string;
  title: string;
  topic: string | null;
  template_id: string | null;
  icon: string | null;
  created_at: string;
}

// GET /api/teams/templates — the preset library for the create flow.
router.get('/templates', (_req: Request, res: Response) => {
  res.json({ templates: TEAM_TEMPLATES });
});

// GET /api/teams — the user's teams with member counts.
router.get('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const teams = await dbAll<AgentTeamRow & { member_count: number }>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM conversations c WHERE c.team_id = t.id AND c.status != 'deleted') AS member_count
     FROM agent_teams t WHERE t.user_id = ? ORDER BY t.created_at DESC`,
    userId,
  );
  res.json({ teams });
});

// GET /api/teams/:id — a team plus its agent conversations.
router.get('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const team = await dbGet<AgentTeamRow>('SELECT * FROM agent_teams WHERE id = ? AND user_id = ?', req.params.id, userId);
  if (!team) { res.status(404).json({ error: 'Team not found' }); return; }
  const agents = await dbAll<Conversation>(
    "SELECT * FROM conversations WHERE team_id = ? AND user_id = ? AND status != 'deleted' ORDER BY created_at ASC",
    team.id, userId,
  );
  res.json({ team, agents });
});

/**
 * One DeepSeek call that rewrites every agent's role prompt to specialise for
 * `topic`. Returns prompts in the SAME ORDER as `agents`, or null on any
 * failure (caller falls back to the base prompts). Kept to a single call +
 * bounded max_tokens so team creation stays cheap.
 */
async function aiTuneRolePrompts(agents: TeamAgentTemplate[], topic: string): Promise<string[] | null> {
  if (!config.deepseekApiKey) return null;
  const roster = agents.map((a, i) => `${i + 1}. ${a.name}：${a.rolePrompt}`).join('\n');
  const prompt = `你是 AI 團隊角色設定器。下面是一個團隊的成員與其通用角色描述。請依「議題」把每位成員的角色描述改寫得更貼合此議題、更具體可用。

議題：${topic}

成員：
${roster}

要求：
- 僅輸出一個 JSON 陣列，長度與成員數相同、順序一致，每個元素是該成員改寫後的角色描述字串
- 每段 80–160 字，繁體中文，保留該成員原本的專長定位
- 不要加任何說明文字或 markdown，只輸出純 JSON 陣列`;

  try {
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.deepseekApiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.6,
        max_tokens: 1500,
      }),
    });
    if (!dsRes.ok) { console.error('[teams] aiTune DeepSeek error:', await dsRes.text()); return null; }
    const data = await dsRes.json() as { choices: Array<{ message: { content: string } }> };
    let text = (data.choices?.[0]?.message?.content || '').trim();
    // Strip ```json fences if present.
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const arr = JSON.parse(text);
    if (!Array.isArray(arr) || arr.length !== agents.length) return null;
    if (!arr.every(s => typeof s === 'string' && s.trim())) return null;
    return arr.map(s => String(s).trim());
  } catch (err) {
    console.error('[teams] aiTune failed:', err);
    return null;
  }
}

// POST /api/teams — instantiate a team from a template, OR (custom: true) have
// AI design the whole team from a free-form scenario (topic).
// Body: { templateId, topic?, aiTune?: boolean } | { custom: true, topic }
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { templateId, topic, aiTune, custom } = req.body as { templateId?: string; topic?: string; aiTune?: boolean; custom?: boolean };
  const cleanTopic = typeof topic === 'string' ? topic.trim() : '';

  // Content safety — refuse scenarios about crime, hacking/breaking this system,
  // stealing secrets, harassment, or harming other users. Runs whenever the user
  // supplied a free-form scenario (custom build, or template + topic tuning).
  if (cleanTopic) {
    const verdict = await moderateTeamTopic(cleanTopic, '無法建立這個團隊');
    if (!verdict.allowed) {
      logSecurityEvent(userId, 'blocked_request', 'high', `team-build blocked (category=${verdict.category})`, cleanTopic);
      res.status(403).json({ error: verdict.reason });
      return;
    }
  }

  let teamTitle: string, teamIcon: string, templateKey: string, aiTuned = false;
  let agents: GeneratedAgent[];

  if (custom) {
    if (!cleanTopic) { res.status(400).json({ error: '請先描述你的情境' }); return; }
    if (!config.deepseekApiKey) { res.status(503).json({ error: 'AI 服務未設定' }); return; }
    const spec = await generateTeamSpec(cleanTopic);
    if (!spec) { res.status(502).json({ error: 'AI 團隊生成失敗，請重試或改用範本' }); return; }
    teamTitle = spec.title; teamIcon = spec.icon; templateKey = 'custom'; agents = spec.agents; aiTuned = true;
  } else {
    const template = templateId ? getTeamTemplate(templateId) : undefined;
    if (!template) { res.status(400).json({ error: 'Unknown templateId' }); return; }
    teamTitle = cleanTopic || template.title; teamIcon = template.icon; templateKey = template.id;
    let tuned: string[] | null = null;
    if (aiTune && cleanTopic) tuned = await aiTuneRolePrompts(template.agents, cleanTopic);
    aiTuned = !!tuned;
    agents = template.agents.map((a, i) => ({
      name: a.name, icon: a.icon, skillId: a.skillId,
      rolePrompt: tuned ? tuned[i] : (cleanTopic ? `${a.rolePrompt}\n\n【本團隊議題】${cleanTopic}` : a.rolePrompt),
    }));
  }

  const teamId = await insertTeamWithAgents(userId, {
    title: teamTitle, icon: teamIcon, templateKey, topic: cleanTopic || null, agents,
  });

  const team = await dbGet<AgentTeamRow>('SELECT * FROM agent_teams WHERE id = ?', teamId);
  const created = await dbAll<Conversation>(
    "SELECT * FROM conversations WHERE team_id = ? AND status != 'deleted' ORDER BY created_at ASC",
    teamId,
  );
  res.status(201).json({ team, agents: created, aiTuned });
});

// DELETE /api/teams/:id — remove the team. Its agents are kept but detached
// (team_id → NULL) so they survive as standalone assistants and no history is
// lost. Pass ?withAgents=1 to soft-delete the agents too.
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const team = await dbGet<AgentTeamRow>('SELECT id FROM agent_teams WHERE id = ? AND user_id = ?', req.params.id, userId);
  if (!team) { res.status(404).json({ error: 'Team not found' }); return; }

  if (req.query.withAgents === '1') {
    await dbRun("UPDATE conversations SET status = 'deleted' WHERE team_id = ? AND user_id = ?", team.id, userId);
  } else {
    await dbRun('UPDATE conversations SET team_id = NULL WHERE team_id = ? AND user_id = ?', team.id, userId);
  }
  await dbRun('DELETE FROM agent_teams WHERE id = ? AND user_id = ?', team.id, userId);
  res.json({ success: true });
});

// GET /api/teams/:id/estimate — pre-run token/cost estimate for the UI.
router.get('/:id/estimate', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const row = await dbGet<{ c: number }>(
    "SELECT COUNT(*) AS c FROM conversations WHERE team_id = ? AND user_id = ? AND status != 'deleted'",
    req.params.id, userId,
  );
  const memberCount = row?.c ?? 0;
  const est = estimateRunTokens(memberCount);
  res.json({ memberCount, ...est, costUsd: estimateCostUsd(est.inputTokens, est.outputTokens) });
});

// GET /api/teams/:id/runs — recent collaboration runs (history) + cumulative total.
router.get('/:id/runs', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const runs = await dbAll(
    `SELECT id, question, result, member_outputs, input_tokens, output_tokens, status, created_at, share_token, schedule_id, emailed, attachments
     FROM team_runs WHERE team_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 30`,
    req.params.id, userId,
  );
  const agg = await dbGet<{ count: number; in_tok: number; out_tok: number }>(
    `SELECT COUNT(*) AS count, COALESCE(SUM(input_tokens), 0) AS in_tok, COALESCE(SUM(output_tokens), 0) AS out_tok
     FROM team_runs WHERE team_id = ? AND user_id = ?`,
    req.params.id, userId,
  );
  const inTok = agg?.in_tok ?? 0, outTok = agg?.out_tok ?? 0;
  res.json({
    runs,
    total: { count: agg?.count ?? 0, inputTokens: inTok, outputTokens: outTok, costUsd: estimateCostUsd(inTok, outTok) },
  });
});

// POST /api/teams/:id/runs/:runId/share — mint (or reuse) a public read-only
// share token for one run. Returns the token; the public URL is built client-side.
router.post('/:id/runs/:runId/share', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const run = await dbGet<{ id: string; share_token: string | null }>(
    'SELECT id, share_token FROM team_runs WHERE id = ? AND team_id = ? AND user_id = ?',
    req.params.runId, req.params.id, userId,
  );
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  let token = run.share_token;
  if (!token) {
    token = crypto.randomBytes(8).toString('hex');
    await dbRun('UPDATE team_runs SET share_token = ? WHERE id = ?', token, run.id);
  }
  res.json({ token });
});

// POST /api/teams/:id/runs/:runId/report — generate a formal, consolidated
// report (Markdown) from a finished run via the local Claude CLI. Streamed as
// SSE: text chunks keep the connection alive (a 1–2 min silent request gets
// reset by the dev proxy) and give live progress; ends with a `done` event
// carrying the full markdown. The client renders it to a polished PDF.
router.post('/:id/runs/:runId/report', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  const send = (type: string, data?: unknown) => res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  send('start'); // flush headers immediately so the proxy sees bytes
  // Heartbeat: the model may think for 10–30s before the first token; keep the
  // connection alive so the proxy doesn't idle-reset it.
  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15_000);
  try {
    const { generateFormalReport } = await import('../services/teamReport.js');
    const out = await generateFormalReport({
      userId, teamId: String(req.params.id), runId: String(req.params.runId),
      onText: chunk => send('text', chunk),
    });
    send('done', { markdown: out.markdown });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Report generation failed';
    send('error', msg);
  } finally {
    clearInterval(heartbeat);
    res.end();
  }
});

// DELETE /api/teams/:id/runs/:runId — delete a single collaboration run.
router.delete('/:id/runs/:runId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await dbRun('DELETE FROM team_runs WHERE id = ? AND team_id = ? AND user_id = ?', req.params.runId, req.params.id, userId);
  res.json({ success: true });
});

// POST /api/teams/:id/run — run a team collaboration. Streams progress as SSE.
router.post('/:id/run', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { message, uploadIds, allowWeb } = req.body as { message?: string; uploadIds?: string[]; allowWeb?: boolean };
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const team = await dbGet<{ id: string }>('SELECT id FROM agent_teams WHERE id = ? AND user_id = ?', req.params.id, userId);
  if (!team) { res.status(404).json({ error: 'Team not found' }); return; }

  // Input safety — prompt-injection guard (same as the chat flow)…
  const guard = analyzeInput(message);
  if (guard.blocked) {
    logSecurityEvent(userId, 'prompt_injection', 'high', `team-run blocked (score=${guard.score})`, message);
    res.status(400).json({ error: '訊息內容被安全檢查阻擋' });
    return;
  }
  // …plus content safety: refuse crime / hacking / secret-theft / harassment /
  // harming the system or other users (the same gate as team creation). Runs
  // before the SSE stream starts so a plain JSON error can still be returned.
  const verdict = await moderateTeamTopic(message.trim(), '無法回答這個問題');
  if (!verdict.allowed) {
    logSecurityEvent(userId, 'blocked_request', 'high', `team-run blocked (category=${verdict.category})`, message);
    res.status(403).json({ error: verdict.reason });
    return;
  }

  // Quota — reuse the same accounting as the web/LINE flow.
  const usage = await checkUserUsageLimit(userId);
  if (usage.exceeded) {
    res.status(403).json({ error: `本月用量已達上限 USD $${usage.limit.toFixed(2)}` });
    return;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  // Flush headers + prime the stream immediately so the proxy starts forwarding
  // (without this the first events sit buffered during a member's silent think).
  res.flushHeaders?.();
  try { res.write(': connected\n\n'); } catch { /* closed */ }

  // Keepalive forces a periodic flush during silent stretches (member analysis).
  const keepalive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* closed */ } }, 10000);

  const writer = (event: { type: string; data?: unknown }) => {
    try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* client closed */ }
  };

  try {
    await runTeam({
      userId, teamId: String(req.params.id), question: message.trim(), writer,
      uploadIds: Array.isArray(uploadIds) ? uploadIds : [],
      allowWeb: typeof allowWeb === 'boolean' ? allowWeb : undefined,
    });
  } catch (err) {
    console.error('[teams] run failed:', err);
    writer({ type: 'error', data: { error: err instanceof Error ? err.message : String(err) } });
  } finally {
    clearInterval(keepalive);
    res.end();
  }
});

// ── Scheduled runs ──────────────────────────────────────────────────────────

// GET /api/teams/:id/schedules — list this team's schedules.
router.get('/:id/schedules', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const schedules = await dbAll(
    'SELECT * FROM team_schedules WHERE team_id = ? AND user_id = ? ORDER BY created_at DESC',
    req.params.id, userId,
  );
  res.json({ schedules });
});

// POST /api/teams/:id/schedules — create a schedule.
// Body: { question, frequency: 'daily'|'weekly', hour, minute, dayOfWeek?, email }
router.post('/:id/schedules', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const team = await dbGet<{ id: string }>('SELECT id FROM agent_teams WHERE id = ? AND user_id = ?', req.params.id, userId);
  if (!team) { res.status(404).json({ error: 'Team not found' }); return; }

  const { name, question, frequency, hour, minute, dayOfWeek, email } = req.body as {
    name?: string; question?: string; frequency?: string; hour?: number; minute?: number; dayOfWeek?: number; email?: string;
  };
  if (!question?.trim()) { res.status(400).json({ error: '請填入要分析的議題' }); return; }
  if (!email?.trim()) { res.status(400).json({ error: '請填入收件 email' }); return; }

  // Content safety — vet the scheduled question up front so every future run is
  // pre-approved (the scheduler runs it headless, with no chance to refuse).
  const verdict = await moderateTeamTopic(question.trim(), '無法建立這個排程');
  if (!verdict.allowed) {
    logSecurityEvent(userId, 'blocked_request', 'high', `team-schedule blocked (category=${verdict.category})`, question);
    res.status(403).json({ error: verdict.reason });
    return;
  }

  const freq = frequency === 'weekly' ? 'weekly' : 'daily';
  const h = Math.max(0, Math.min(23, Number(hour) || 0));
  const m = Math.max(0, Math.min(59, Number(minute) || 0));
  const dow = freq === 'weekly' ? Math.max(0, Math.min(6, Number(dayOfWeek) || 0)) : null;
  const next = computeNextRun(freq, h, m, dow);
  const schedName = name?.trim() ? name.trim().slice(0, 255) : null;

  const id = uuidv4();
  try {
    await dbRun(
      'INSERT INTO team_schedules (id, team_id, user_id, name, question, frequency, hour, minute, day_of_week, email, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, req.params.id, userId, schedName, question.trim(), freq, h, m, dow, email.trim(), mysqlDateTime(next),
    );
    const schedule = await dbGet('SELECT * FROM team_schedules WHERE id = ?', id);
    res.status(201).json({ schedule });
  } catch (err) {
    console.error('[teams] create schedule failed:', err);
    res.status(500).json({ error: '建立排程時發生錯誤，請稍後再試。' });
  }
});

// PATCH /api/teams/:id/schedules/:sid — enable/disable (re-enabling recomputes next run).
router.patch('/:id/schedules/:sid', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const s = await dbGet<{ id: string; frequency: string; hour: number; minute: number; day_of_week: number | null }>(
    'SELECT id, frequency, hour, minute, day_of_week FROM team_schedules WHERE id = ? AND team_id = ? AND user_id = ?',
    req.params.sid, req.params.id, userId,
  );
  if (!s) { res.status(404).json({ error: 'Schedule not found' }); return; }
  const { enabled } = req.body as { enabled?: boolean };
  if (enabled !== undefined) {
    await dbRun('UPDATE team_schedules SET enabled = ? WHERE id = ?', enabled ? 1 : 0, s.id);
    if (enabled) {
      await dbRun('UPDATE team_schedules SET next_run_at = ? WHERE id = ?', mysqlDateTime(computeNextRun(s.frequency, s.hour, s.minute, s.day_of_week)), s.id);
    }
  }
  res.json({ success: true });
});

// POST /api/teams/:id/schedules/:sid/run-now — run a schedule immediately (test).
// Fire-and-forget: the run takes ~1 min; the result lands in history + email.
router.post('/:id/schedules/:sid/run-now', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const s = await dbGet<{ id: string }>('SELECT id FROM team_schedules WHERE id = ? AND team_id = ? AND user_id = ?', req.params.sid, req.params.id, userId);
  if (!s) { res.status(404).json({ error: 'Schedule not found' }); return; }
  runScheduleNow(String(req.params.sid), userId).catch(err => console.error('[teams] run-now failed:', err));
  res.json({ started: true });
});

// DELETE /api/teams/:id/schedules/:sid
router.delete('/:id/schedules/:sid', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await dbRun('DELETE FROM team_schedules WHERE id = ? AND team_id = ? AND user_id = ?', req.params.sid, req.params.id, userId);
  res.json({ success: true });
});

export default router;
