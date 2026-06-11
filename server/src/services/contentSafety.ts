/**
 * Content Safety — moderation for the AI-team builder (and any free-form
 * "design something for me" entry point).
 *
 * The prompt-injection guard (inputGuard.ts) only catches attempts to subvert
 * the *system* (jailbreaks, prompt extraction, path traversal). It does NOT
 * judge whether the user's REQUEST is harmful. This module fills that gap:
 * it refuses scenarios about crime, hacking/breaking this system, stealing
 * company secrets, harassment/abuse, or harming other users.
 *
 * Defense in depth:
 *   1. A deterministic local blocklist (zh + en) — zero latency, catches the
 *      blatant cases even if the LLM layer is unavailable.
 *   2. An LLM classifier (DeepSeek) — catches paraphrased / keyword-evading
 *      intent the regex misses. Fail-open ONLY after the local layer passed.
 */

import { config } from '../config.js';

export interface ModerationResult {
  allowed: boolean;
  /** machine category, e.g. 'hacking', 'steal_secrets' — for logging */
  category?: string;
  /** user-facing refusal message (zh-TW) when not allowed */
  reason?: string;
}

/** Single user-facing refusal message — we never explain "how" we detected it. */
export const TEAM_REFUSAL_MESSAGE =
  '無法建立這個團隊。你描述的情境涉及不被允許的內容（例如犯罪、入侵或破壞系統、竊取機密、謾罵騷擾，或危害本系統與其他使用者的安全）。請改用合法、正當的目的重新描述。';

/* ============================================================
   Layer 1 — deterministic local blocklist
   Targets clearly-offensive verb + object combinations so legitimate
   security/defensive work ("資安防護稽核", "弱點修補建議") is NOT blocked.
   ============================================================ */
const LOCAL_PATTERNS: { re: RegExp; category: string }[] = [
  // Steal / exfiltrate secrets (zh)
  { re: /(竊取|盜取|偷取|抓取|抓|套取|騙取|外洩|洩漏|洩露|竊|盜|外傳).{0,8}(公司|企業|公司的|內部)?.{0,4}(機密|機敏|商業機密|營業祕密|營業秘密|秘密|內部資料|敏感資料|客戶資料|個資)/, category: 'steal_secrets' },
  // Break into / attack the system (zh)
  { re: /(突破|入侵|駭入|駭進|攻擊|滲透攻擊|繞過|破解|越權|提權|拿下|攻破|搞垮|癱瘓).{0,8}(系統|伺服器|主機|後台|資料庫|權限|驗證|登入|帳號|防火牆|安全機制|防護|沙盒|sandbox)/, category: 'hacking' },
  // Find/exploit a vuln for offense (zh) — e.g. "公司機密漏洞", "找系統漏洞來..."
  { re: /(機密|系統|公司|平台|網站).{0,6}(漏洞|弱點|破口).{0,8}(利用|入侵|攻擊|拿|抓|偷|exploit)/, category: 'hacking' },
  { re: /(利用|找出|挖).{0,6}(漏洞|弱點|破口).{0,8}(入侵|攻擊|偷|竊|提權|拿下)/, category: 'hacking' },
  // Crime / violence (zh)
  { re: /(製造|製作|自製|合成|如何做).{0,6}(炸彈|爆裂物|爆炸物|毒品|槍枝|武器|生化武器)/, category: 'crime_violence' },
  { re: /(洗錢|綁架|勒索|販毒|人口販賣|教唆|教.{0,3}(犯罪|詐騙|偷竊|搶劫)|如何.{0,4}(詐騙|逃稅|走私))/, category: 'crime_violence' },
  // Harassment / abuse / hate (zh)
  { re: /(謾罵|辱罵|羞辱|霸凌|騷擾|仇恨言論|人身攻擊|歧視|恐嚇|威脅他人)/, category: 'harassment' },
  // Harm OTHER users of this system (zh)
  { re: /(其他|別的|他人|別人).{0,4}(使用者|用戶|帳號|會員).{0,8}(資料|密碼|帳號|個資|隱私|檔案)/, category: 'harm_others' },
  { re: /(盜取|竊取|入侵|破解|接管).{0,4}(他人|別人|其他人|別的?)?.{0,2}(帳號|帳戶|密碼)/, category: 'harm_others' },

  // English
  { re: /(steal|exfiltrate|leak|extract|dump|siphon).{0,16}(secret|confidential|credential|proprietary|trade\s*secret|sensitive\s+data|customer\s+data)/i, category: 'steal_secrets' },
  { re: /(hack|exploit|breach|penetrate|bypass|crack|escalate|compromise|pwn|take\s*over).{0,16}(system|server|database|auth|authentication|password|firewall|account|privilege|sandbox)/i, category: 'hacking' },
  { re: /(make|build|create|synthesize).{0,10}(bomb|explosive|weapon|malware|virus|ransomware|trojan)/i, category: 'crime_violence' },
  { re: /\b(ddos|sql\s*injection|privilege\s+escalation|backdoor|keylogger)\b/i, category: 'hacking' },
  { re: /(other|another)\s+users?'?\s+(data|password|account|credential|private|files?)/i, category: 'harm_others' },
];

export function screenTopicLocally(topic: string): { category: string } | null {
  const t = topic.normalize('NFKC');
  for (const { re, category } of LOCAL_PATTERNS) {
    if (re.test(t)) return { category };
  }
  return null;
}

/* ============================================================
   Layer 2 — LLM classifier (semantic catch-all)
   ============================================================ */
async function classifyWithLlm(topic: string): Promise<ModerationResult | null> {
  if (!config.deepseekApiKey) return null; // no key → skip (caller fails open)

  const prompt = `你是內容安全審查員，負責判斷使用者描述的「AI 助手團隊」情境是否可被允許。

【一律拒絕（disallowed）】只要情境的「目的」涉及下列任何一項：
- 犯罪或暴力：製造武器/炸彈/毒品、詐騙、洗錢、綁架、教唆犯罪等
- 入侵或破壞資訊系統：駭入/攻擊/滲透/繞過驗證/提權/利用漏洞入侵、破壞或癱瘓系統（含「突破/破解我們這個系統」）
- 竊取機密：竊取/外洩公司或他人的商業機密、營業秘密、客戶資料、個資、帳密
- 謾罵與騷擾：人身攻擊、仇恨言論、霸凌、騷擾、恐嚇
- 危害其他使用者：取得、竊取或濫用本系統上其他使用者的資料、帳號或隱私

【允許（allowed）】正當、合法的目的，例如：資安「防禦」與稽核、弱點「修補」建議、合規、教育、研究、行銷、企劃、數據分析等。注意：防禦性資安（如何保護、如何防止外洩）是允許的；攻擊性意圖（如何竊取、如何入侵）才拒絕。

情境：「${topic}」

只輸出一個 JSON 物件（不要任何說明、不要 markdown）：
{"allowed": true 或 false, "category": "若拒絕，從 crime_violence/hacking/steal_secrets/harassment/harm_others 擇一，否則 safe"}`;

  try {
    const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${config.deepseekApiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 60,
      }),
    });
    if (!dsRes.ok) { console.error('[contentSafety] classify DeepSeek error:', await dsRes.text()); return null; }
    const data = await dsRes.json() as { choices: Array<{ message: { content: string } }> };
    let text = (data.choices?.[0]?.message?.content || '').trim();
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const obj = JSON.parse(text) as { allowed?: boolean; category?: string };
    if (typeof obj.allowed !== 'boolean') return null;
    if (obj.allowed) return { allowed: true };
    return { allowed: false, category: obj.category || 'unsafe', reason: TEAM_REFUSAL_MESSAGE };
  } catch (err) {
    console.error('[contentSafety] classify failed:', err);
    return null; // caller fails open (local layer already screened blatant cases)
  }
}

/**
 * Moderate a free-form team-builder scenario. Returns { allowed: false, reason }
 * if it must be refused. Local blocklist runs first (deterministic); the LLM
 * classifier is a semantic backstop. If the LLM is unavailable/errors, we fail
 * open — but only after the local blocklist has already passed.
 */
export async function moderateTeamTopic(topic: string): Promise<ModerationResult> {
  const clean = (topic || '').trim();
  if (!clean) return { allowed: true };

  const local = screenTopicLocally(clean);
  if (local) return { allowed: false, category: local.category, reason: TEAM_REFUSAL_MESSAGE };

  const llm = await classifyWithLlm(clean);
  if (llm && !llm.allowed) return llm;

  return { allowed: true };
}
