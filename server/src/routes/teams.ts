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
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { TEAM_TEMPLATES, getTeamTemplate, type TeamAgentTemplate } from '../data/teamTemplates.js';
import { runTeam, estimateRunTokens, estimateCostUsd } from '../services/teamRun.js';
import { checkUserUsageLimit } from '../services/usageLimit.js';
import { analyzeInput, logSecurityEvent } from '../services/inputGuard.js';
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

// POST /api/teams — instantiate a team from a template.
// Body: { templateId, topic?, aiTune?: boolean }
router.post('/', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { templateId, topic, aiTune } = req.body as { templateId?: string; topic?: string; aiTune?: boolean };

  const template = templateId ? getTeamTemplate(templateId) : undefined;
  if (!template) { res.status(400).json({ error: 'Unknown templateId' }); return; }

  const cleanTopic = typeof topic === 'string' ? topic.trim() : '';
  const teamId = uuidv4();
  const teamTitle = cleanTopic || template.title;

  await dbRun(
    'INSERT INTO agent_teams (id, user_id, title, topic, template_id, icon) VALUES (?, ?, ?, ?, ?, ?)',
    teamId, userId, teamTitle, cleanTopic || null, template.id, template.icon,
  );

  // Optionally refine the role prompts for the topic (single DeepSeek call).
  let tuned: string[] | null = null;
  if (aiTune && cleanTopic) {
    tuned = await aiTuneRolePrompts(template.agents, cleanTopic);
  }

  for (let i = 0; i < template.agents.length; i++) {
    const agent = template.agents[i];
    const base = tuned ? tuned[i] : agent.rolePrompt;
    const systemPrompt = cleanTopic && !tuned ? `${base}\n\n【本團隊議題】${cleanTopic}` : base;
    const mode = agent.skillId ? 'direct' : null;
    await dbRun(
      'INSERT INTO conversations (id, user_id, title, skill_id, mode, category, system_prompt, icon, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      uuidv4(), userId, agent.name, agent.skillId, mode, 'assistant', systemPrompt, agent.icon, teamId,
    );
  }

  const team = await dbGet<AgentTeamRow>('SELECT * FROM agent_teams WHERE id = ?', teamId);
  const agents = await dbAll<Conversation>(
    "SELECT * FROM conversations WHERE team_id = ? AND status != 'deleted' ORDER BY created_at ASC",
    teamId,
  );
  res.status(201).json({ team, agents, aiTuned: !!tuned });
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

// GET /api/teams/:id/runs — recent collaboration runs (history).
router.get('/:id/runs', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const runs = await dbAll(
    `SELECT id, question, result, member_outputs, input_tokens, output_tokens, status, created_at
     FROM team_runs WHERE team_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT 20`,
    req.params.id, userId,
  );
  res.json({ runs });
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

export default router;
