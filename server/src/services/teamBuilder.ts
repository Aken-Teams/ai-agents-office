/**
 * Team construction — shared by the web API (routes/teams.ts) and the LINE bot
 * (services/line/commands.ts). Designs a team from a free-form scenario via
 * DeepSeek and persists it (an `agent_teams` row + one `conversations` row per
 * member). Keeping this here lets both entry points build identical teams.
 */

import { v4 as uuidv4 } from 'uuid';
import { dbRun } from '../db.js';
import { config } from '../config.js';
import { auxChat, auxLlmAvailable, parseJsonLoose } from './auxLlm.js';

/**
 * Skills an AI-designed team member may hold.
 *
 * Document generators are deliberately absent: a team run is analysis →
 * discussion → synthesis, and a "簡報設計師" asked about a sick dog has nothing to
 * contribute but an apology. Documents are produced from the team's conclusions
 * afterwards (teamDocument.ts), which needs no member of its own.
 */
export const CUSTOM_SKILLS = ['research', 'data-analyst', 'reviewer'];

export interface GeneratedAgent { name: string; icon: string; rolePrompt: string; skillId: string | null }
export interface GeneratedSpec { title: string; icon: string; agents: GeneratedAgent[] }

/**
 * Ask the aux LLM to design a whole team (title + icon + 3–5 specialist agents)
 * from a free-form scenario. Returns null on any failure.
 */
export async function generateTeamSpec(topic: string): Promise<GeneratedSpec | null> {
  if (!auxLlmAvailable()) return null;
  const prompt = `你是 AI 團隊設計師。使用者描述了一個情境/議題，請設計一個 3–5 人、分工互補的 AI 助手團隊來協作處理它。

情境：${topic}

每個成員可綁定一個技能（skillId），依角色選最合適的，或用 null（一般推理/規劃）：
- "research"：網路研究、資料蒐集
- "data-analyst"：數據/量化分析
- "reviewer"：審閱、校訂、把關
- null：一般分析、策略、規劃

**每位成員都必須能對「這個情境本身」提出實質分析。**團隊運作的方式是：每位成員各自分析同一個議題 → 互相參考後補充 → 最後統整成結論。所以：
- **不要設計純產出型角色**（如「簡報設計師」「文件排版師」「文件生成員」）。那種角色面對議題本身無話可說，只會回一句「這超出我的專業」，讓整個團隊看起來壞掉。文件是團隊得出結論「之後」才產生的，不需要派人。
- 每位成員要有**不同的分析切入角度**（例如：找證據的、算數字的、評估風險的、挑戰假設的、把結論轉成行動建議的），而不是同一件事講五遍。

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
    const aux = await auxChat(prompt, { temperature: 0.7, maxTokens: 1800, timeoutMs: 60_000, feature: 'team-builder' });
    if (!aux) return null;
    const obj = parseJsonLoose<any>(aux.text);
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
    console.error('[teamBuilder] generateTeamSpec failed:', err);
    return null;
  }
}

/**
 * Persist a team: one `agent_teams` row + one `conversations` row per member.
 * Members with a skillId run in 'direct' mode; otherwise general reasoning.
 * Returns the new team id.
 */
export async function insertTeamWithAgents(
  userId: string,
  opts: { title: string; icon: string; templateKey: string; topic: string | null; agents: GeneratedAgent[] },
): Promise<string> {
  const teamId = uuidv4();
  await dbRun(
    'INSERT INTO agent_teams (id, user_id, title, topic, template_id, icon) VALUES (?, ?, ?, ?, ?, ?)',
    teamId, userId, opts.title, opts.topic, opts.templateKey, opts.icon,
  );
  for (const agent of opts.agents) {
    const mode = agent.skillId ? 'direct' : null;
    await dbRun(
      'INSERT INTO conversations (id, user_id, title, skill_id, mode, category, system_prompt, icon, team_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      uuidv4(), userId, agent.name, agent.skillId, mode, 'assistant', agent.rolePrompt, agent.icon, teamId,
    );
  }
  return teamId;
}

/**
 * One-shot: design + persist an AI team from a scenario. Used by the LINE bot
 * (`/newteam <情境>`). Returns null if AI generation is unavailable or fails.
 */
export async function createCustomTeam(
  userId: string,
  topic: string,
): Promise<{ teamId: string; title: string; memberCount: number } | null> {
  if (!auxLlmAvailable()) return null;
  const spec = await generateTeamSpec(topic);
  if (!spec) return null;
  const teamId = await insertTeamWithAgents(userId, {
    title: spec.title, icon: spec.icon, templateKey: 'custom', topic, agents: spec.agents,
  });
  return { teamId, title: spec.title, memberCount: spec.agents.length };
}
