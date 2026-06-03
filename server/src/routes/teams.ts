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
import { computeNextRun, mysqlDateTime } from '../services/teamScheduler.js';
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

const CUSTOM_SKILLS = ['research', 'data-analyst', 'reviewer', 'pptx-gen', 'docx-gen'];
interface GeneratedAgent { name: string; icon: string; rolePrompt: string; skillId: string | null }
interface GeneratedSpec { title: string; icon: string; agents: GeneratedAgent[] }

/**
 * Ask DeepSeek to design a whole team (title + icon + 3–5 specialist agents)
 * from a free-form scenario. Returns null on any failure.
 */
async function generateTeamSpec(topic: string): Promise<GeneratedSpec | null> {
  if (!config.deepseekApiKey) return null;
  const prompt = `你是 AI 團隊設計師。使用者描述了一個情境/議題，請設計一個 3–5 人、分工互補的 AI 助手團隊來協作處理它。

情境：${topic}

每個成員可綁定一個技能（skillId），依角色選最合適的，或用 null（一般推理/規劃）：
- "research"：網路研究、資料蒐集
- "data-analyst"：數據/量化分析
- "reviewer"：審閱、校訂、把關
- "pptx-gen"：簡報產出
- "docx-gen"：文件產出
- null：一般分析、策略、規劃

只輸出一個 JSON 物件（不要任何說明、不要 markdown）：
{
  "title": "團隊名稱（簡短，4-10字）",
  "icon": "一個 Google Material Symbols 名稱（小寫底線，如 favorite, psychology, public, insights）",
  "agents": [
    { "name": "角色名稱", "icon": "Material Symbols 名稱", "rolePrompt": "此角色的定位、專長與工作方式（繁體中文 60-140字）", "skillId": "research" 或 null }
  ]
}
要求：3–5 個 agent，角色彼此分工互補、緊貼此情境。`;

  try {
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.deepseekApiKey}` },
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], temperature: 0.7, max_tokens: 1800 }),
    });
    if (!dsRes.ok) { console.error('[teams] generateTeamSpec DeepSeek error:', await dsRes.text()); return null; }
    const data = await dsRes.json() as { choices: Array<{ message: { content: string } }> };
    let text = (data.choices?.[0]?.message?.content || '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const obj = JSON.parse(text);
    if (!obj || !Array.isArray(obj.agents)) return null;
    const agents: GeneratedAgent[] = obj.agents.slice(0, 5).map((a: any) => ({
      name: String(a?.name || '助手').slice(0, 40),
      icon: typeof a?.icon === 'string' && a.icon.trim() ? a.icon.trim() : 'smart_toy',
      rolePrompt: String(a?.rolePrompt || a?.name || '').slice(0, 600),
      skillId: CUSTOM_SKILLS.includes(a?.skillId) ? a.skillId : null,
    })).filter((a: GeneratedAgent) => a.name && a.rolePrompt);
    if (agents.length < 1) return null;
    return {
      title: String(obj.title || topic).slice(0, 60),
      icon: typeof obj.icon === 'string' && obj.icon.trim() ? obj.icon.trim() : 'groups',
      agents,
    };
  } catch (err) {
    console.error('[teams] generateTeamSpec failed:', err);
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

  const teamId = uuidv4();
  await dbRun(
    'INSERT INTO agent_teams (id, user_id, title, topic, template_id, icon) VALUES (?, ?, ?, ?, ?, ?)',
    teamId, userId, teamTitle, cleanTopic || null, templateKey, teamIcon,
  );
  for (const agent of agents) {
    const mode = agent.skillId ? 'direct' : null;
    await dbRun(
      'INSERT INTO conversations (id, user_id, title, skill_id, mode, category, system_prompt, icon, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      uuidv4(), userId, agent.name, agent.skillId, mode, 'assistant', agent.rolePrompt, agent.icon, teamId,
    );
  }

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
    `SELECT id, question, result, member_outputs, input_tokens, output_tokens, status, created_at, share_token, schedule_id, emailed
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

// DELETE /api/teams/:id/runs/:runId — delete a single collaboration run.
router.delete('/:id/runs/:runId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await dbRun('DELETE FROM team_runs WHERE id = ? AND team_id = ? AND user_id = ?', req.params.runId, req.params.id, userId);
  res.json({ success: true });
});

// POST /api/teams/:id/run — run a team collaboration. Streams progress as SSE.
router.post('/:id/run', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { message } = req.body as { message?: string };
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const team = await dbGet<{ id: string }>('SELECT id FROM agent_teams WHERE id = ? AND user_id = ?', req.params.id, userId);
  if (!team) { res.status(404).json({ error: 'Team not found' }); return; }

  // Input safety — reuse the same guard as the chat flow.
  const guard = analyzeInput(message);
  if (guard.blocked) {
    logSecurityEvent(userId, 'prompt_injection', 'high', `team-run blocked (score=${guard.score})`, message);
    res.status(400).json({ error: '訊息內容被安全檢查阻擋' });
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
    await runTeam({ userId, teamId: String(req.params.id), question: message.trim(), writer });
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

  const { question, frequency, hour, minute, dayOfWeek, email } = req.body as {
    question?: string; frequency?: string; hour?: number; minute?: number; dayOfWeek?: number; email?: string;
  };
  if (!question?.trim()) { res.status(400).json({ error: '請填入要分析的議題' }); return; }
  if (!email?.trim()) { res.status(400).json({ error: '請填入收件 email' }); return; }

  const freq = frequency === 'weekly' ? 'weekly' : 'daily';
  const h = Math.max(0, Math.min(23, Number(hour) || 0));
  const m = Math.max(0, Math.min(59, Number(minute) || 0));
  const dow = freq === 'weekly' ? Math.max(0, Math.min(6, Number(dayOfWeek) || 0)) : null;
  const next = computeNextRun(freq, h, m, dow);

  const id = uuidv4();
  await dbRun(
    'INSERT INTO team_schedules (id, team_id, user_id, question, frequency, hour, minute, day_of_week, email, next_run_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, req.params.id, userId, question.trim(), freq, h, m, dow, email.trim(), mysqlDateTime(next),
  );
  const schedule = await dbGet('SELECT * FROM team_schedules WHERE id = ?', id);
  res.status(201).json({ schedule });
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

// DELETE /api/teams/:id/schedules/:sid
router.delete('/:id/schedules/:sid', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  await dbRun('DELETE FROM team_schedules WHERE id = ? AND team_id = ? AND user_id = ?', req.params.sid, req.params.id, userId);
  res.json({ success: true });
});

export default router;
