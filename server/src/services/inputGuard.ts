/**
 * Input Guard — Multi-layer prompt injection detection engine.
 *
 * Analyzes user input for potential prompt injection attacks and returns
 * a risk assessment with flags and sanitized output.
 */

import { dbRun } from '../db.js';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GuardResult {
  safe: boolean;        // true if score < BLOCK_THRESHOLD
  score: number;        // 0–100 risk score
  flags: string[];      // which detectors triggered
  sanitized: string;    // cleaned input (tags stripped)
  blocked: boolean;     // true if score >= BLOCK_THRESHOLD
}

type Detector = (input: string) => { score: number; flag: string } | null;

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

const BLOCK_THRESHOLD = 60;   // >= 60 → block and log
const WARN_THRESHOLD  = 30;   // >= 30 → log but allow (with system prompt warning)

// ---------------------------------------------------------------------------
// Detector: Dangerous XML/HTML tags (enhanced)
// ---------------------------------------------------------------------------

function detectDangerousTags(input: string): { score: number; flag: string } | null {
  // Match tags even with mixed case, inserted whitespace, unicode lookalikes
  const normalized = input
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')   // strip zero-width chars first
    .replace(/\s+/g, ' ');

  const patterns = [
    /<\/?(?:system|role|admin|prompt|instruction|override|ignore|assistant|human|tool_use|tool_result|function_call|function)[^>]*>/gi,
    /\[(?:SYSTEM|INST|\/INST|SYS)\]/gi,                      // Llama/Mistral format
    /```(?:system|prompt|instruction)/gi,                     // fenced block tricks
    /<<\s*(?:SYS|SYSTEM|PROMPT)>>/gi,                         // heredoc-style
  ];

  for (const p of patterns) {
    if (p.test(normalized)) {
      return { score: 40, flag: 'dangerous_tags' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detector: Natural language injection (中 + 英)
// ---------------------------------------------------------------------------

function detectNaturalLanguageInjection(input: string): { score: number; flag: string } | null {
  const lower = input.toLowerCase();
  const normalized = lower.replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '');

  const highRisk: RegExp[] = [
    // English
    /ignore\s+(all\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?|context)/i,
    /disregard\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|guidelines?)/i,
    /override\s+(?:system|safety|security)\s+(?:prompt|instructions?|settings?|rules?)/i,
    /you\s+are\s+now\s+(?:a\s+)?(?:dan|evil|unrestricted|jailbroken|developer\s+mode)/i,
    /(?:enter|switch\s+to|activate|enable)\s+(?:developer|god|sudo|admin|unrestricted|jailbreak)\s+mode/i,
    /forget\s+(?:all\s+)?(?:your|previous|prior)\s+(?:instructions?|rules?|training|programming)/i,
    /pretend\s+(?:you\s+are|to\s+be|that)\s+(?:a\s+)?(?:different|evil|unrestricted|hacked)/i,
    /do\s+not\s+follow\s+(?:your|the|any)\s+(?:rules?|guidelines?|instructions?|restrictions?)/i,
    /new\s+(?:system\s+)?(?:prompt|instructions?|rules?|persona)\s*:/i,
    /from\s+now\s+on[,.]?\s+(?:you\s+(?:are|will|must|should)|ignore|forget)/i,

    // Chinese
    /忽略(?:之前|先前|以上|所有)(?:的)?(?:指令|指示|規則|提示|設定)/,
    /無視(?:之前|先前|以上|所有)(?:的)?(?:指令|指示|規則)/,
    /覆蓋(?:系統|安全)?(?:提示|指令|設定|規則)/,
    /你(?:現在|從現在開始)是(?:一個)?(?:邪惡|不受限|越獄)/,
    /進入(?:開發者|管理員|上帝|越獄|無限制)\s*模式/,
    /忘記(?:所有|之前|你的)(?:指令|規則|訓練|設定)/,
    /假裝(?:你是|自己是)(?:一個)?(?:不同的|邪惡的|被駭的)/,
    /不要遵守(?:你的|任何)?(?:規則|指令|限制)/,
    /新(?:的)?(?:系統)?(?:提示|指令|規則)\s*[:：]/,
  ];

  // Count ALL matching high-risk patterns (not just first)
  let hitCount = 0;
  for (const p of highRisk) {
    if (p.test(normalized)) hitCount++;
  }
  // Single match = 50, each additional adds 20 (2 matches = 70, 3 = 90)
  if (hitCount > 0) {
    return { score: 50 + (hitCount - 1) * 20, flag: 'prompt_injection_natural_language' };
  }

  // Medium risk — suspicious phrases
  const mediumRisk: RegExp[] = [
    /(?:act|behave)\s+as\s+(?:if|though)\s+(?:you|there)\s+(?:are|were)\s+no\s+(?:rules|limits|restrictions)/i,
    /what\s+(?:are|were)\s+your\s+(?:system|initial|original)\s+(?:prompt|instructions?|rules?)/i,
    /reveal\s+(?:your|the)\s+(?:system|hidden|internal|secret)\s+(?:prompt|instructions?|rules?)/i,
    /(?:print|output|show|display|repeat)\s+(?:your|the)\s+(?:system|initial|above)\s+(?:prompt|instructions?|message)/i,
    /(?:透露|顯示|輸出|告訴我)(?:你的)?(?:系統|內部|隱藏)(?:提示|指令|設定)/,
  ];

  let mediumHits = 0;
  for (const p of mediumRisk) {
    if (p.test(normalized)) mediumHits++;
  }
  if (mediumHits > 0) {
    return { score: 30 + (mediumHits - 1) * 15, flag: 'prompt_extraction_attempt' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Detector: Unicode obfuscation
// ---------------------------------------------------------------------------

function detectUnicodeObfuscation(input: string): { score: number; flag: string } | null {
  let count = 0;

  // Zero-width characters
  const zeroWidth = /[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD]/g;
  const zwMatches = input.match(zeroWidth);
  if (zwMatches) count += zwMatches.length;

  // RTL/LTR override characters (can hide text direction)
  const bidi = /[\u202A-\u202E\u2066-\u2069]/g;
  const bidiMatches = input.match(bidi);
  if (bidiMatches) count += bidiMatches.length * 3;

  // Tag characters (U+E0000-U+E007F) — used in some obfuscation
  const tagChars = /[\uDB40][\uDC00-\uDC7F]/g;
  const tagMatches = input.match(tagChars);
  if (tagMatches) count += tagMatches.length * 2;

  if (count >= 10) return { score: 40, flag: 'unicode_obfuscation_heavy' };
  if (count >= 3)  return { score: 20, flag: 'unicode_obfuscation_light' };
  return null;
}

// ---------------------------------------------------------------------------
// Detector: Base64 / encoded payloads
// ---------------------------------------------------------------------------

function detectEncodedPayloads(input: string): { score: number; flag: string } | null {
  // Look for instructions asking to decode base64
  const decodePatterns = [
    /(?:decode|decipher|interpret|translate|convert)\s+(?:this|the\s+following)?\s*(?:from\s+)?base64/i,
    /base64[:\s]+[A-Za-z0-9+/]{20,}={0,2}/i,
    /(?:解碼|解密|轉換)\s*(?:這個|以下)?\s*base64/i,
    /atob\s*\(\s*['"][A-Za-z0-9+/]{20,}/i,
  ];

  for (const p of decodePatterns) {
    if (p.test(input)) {
      return { score: 35, flag: 'encoded_payload' };
    }
  }

  // Standalone long base64 strings (suspicious if > 100 chars)
  const longB64 = /[A-Za-z0-9+/]{100,}={0,2}/;
  if (longB64.test(input)) {
    return { score: 15, flag: 'long_base64_string' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Detector: Path traversal & system access
// ---------------------------------------------------------------------------

function detectPathTraversal(input: string): { score: number; flag: string } | null {
  if (/\.\.[\\/]/.test(input)) {
    return { score: 50, flag: 'path_traversal' };
  }

  const systemPaths = /(?:C:\\Windows|\/etc\/|\/usr\/|\/root\/|%SYSTEMROOT%|%WINDIR%|\/proc\/|\/sys\/|~\/\.ssh|~\/\.aws|~\/\.env)/i;
  if (systemPaths.test(input)) {
    return { score: 40, flag: 'system_path_reference' };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Detector: CSV / formula injection (for uploaded files context)
// ---------------------------------------------------------------------------

function detectFormulaInjection(input: string): { score: number; flag: string } | null {
  // Detect Excel formula injection patterns
  const formulaPatterns = [
    /^[=+\-@]\s*(?:CMD|HYPERLINK|IMPORTXML|IMPORTDATA|IMPORTRANGE)/im,
    /=\s*(?:EXEC|SHELL|SYSTEM|CMD)\s*\(/i,
  ];

  for (const p of formulaPatterns) {
    if (p.test(input)) {
      return { score: 40, flag: 'formula_injection' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detector: Multi-turn escalation patterns
// ---------------------------------------------------------------------------

function detectEscalationPatterns(input: string): { score: number; flag: string } | null {
  const patterns = [
    /(?:now|ok|good|great|perfect)[,.]?\s*(?:now\s+)?(?:ignore|forget|override|disregard)/i,
    /(?:that\s+was\s+a\s+test|just\s+kidding|the\s+real\s+(?:task|instruction|prompt)\s+is)/i,
    /(?:actually|but\s+first|before\s+(?:that|you\s+do))[,.]?\s*(?:ignore|forget|override|I\s+need\s+you\s+to)/i,
    /(?:其實|但是先|在那之前)[，,]?\s*(?:忽略|忘記|覆蓋|我需要你)/,
  ];

  for (const p of patterns) {
    if (p.test(input)) {
      return { score: 25, flag: 'escalation_pattern' };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Detector: System architecture / infrastructure probing
// ---------------------------------------------------------------------------

function detectArchitectureProbing(input: string): { score: number; flag: string } | null {
  const normalized = input
    .replace(/[\u200B-\u200D\uFEFF\u00AD]/g, '')
    .toLowerCase();

  const highRisk: RegExp[] = [
    // Direct infrastructure probing (EN)
    /(?:show|list|tell|reveal|describe|explain)\s+(?:me\s+)?(?:your|the|system)\s+(?:directory|folder|file)\s+(?:structure|tree|layout|paths?)/i,
    /(?:show|list|tell|reveal|describe|explain)\s+(?:me\s+)?(?:the\s+)?(?:system|server|internal|project)\s+(?:directory|folder|file)\s+(?:structure|tree|layout|paths?)/i,
    /(?:what|where)\s+(?:is|are)\s+(?:your|the)\s+(?:working|current|root|home|base|server|project)\s+(?:directory|folder|path)/i,
    /(?:list|show|scan|enumerate)\s+(?:all\s+)?(?:agents?|skills?|workers?|tools?|processes?|services?)\s+(?:available|running|active|installed)/i,
    /(?:what|which|how\s+many)\s+(?:agents?|skills?|tools?|models?)\s+(?:do\s+you|are|can\s+you)\s+(?:have|use|access|run)/i,
    // Memory / config probing (EN)
    /(?:show|list|read|tell|reveal|what(?:'s| is| are))\s+(?:me\s+)?(?:your|the|my)\s+(?:memory|config|configuration|settings?)\s+(?:files?|data|contents?|entries?|directory)/i,
    /(?:what|where)\s+(?:is|are)\s+(?:in\s+)?(?:your|the|my)\s+(?:memory|config|claude\.?md|\.claude)/i,
    /what\s+(?:is|are)\s+in\s+my\s+(?:memory|config|settings?|files?)/i,
    /(?:read|show|cat|list|open)\s+(?:the\s+)?(?:\.claude|claude\.md|memory\.md|CLAUDE\.md)/i,
    // Direct infrastructure probing (ZH)
    /(?:你的|系統的|內部的)?(?:底層|內部|系統|伺服器|目錄|檔案|資料夾)(?:結構|架構|路徑|配置|設定|佈局)/,
    /(?:列出|顯示|告訴我|說明)(?:你的|所有的?)?(?:代理|技能|工具|模組|服務|進程|工作者)/,
    /(?:你|系統)(?:有|用了?|跑了?|啟動了?)(?:幾個|多少|哪些)(?:代理|技能|agent|skill|worker|tool)/,
    /(?:你的|系統的)(?:工作|執行|運行|部署)(?:目錄|路徑|環境|資料夾)/,
    // Memory / config probing (ZH)
    /(?:我的|你的)?(?:記憶|記憶檔|記憶體|memory|config|設定檔|配置檔)(?:有什麼|有哪些|裡面|內容|是什麼|在哪)/,
    /(?:列出|顯示|讀取|打開|看一下)(?:我的|你的)?(?:記憶|記憶檔|memory|config|設定|配置)/,
    /(?:你|系統)(?:記得|記住|存了)(?:什麼|哪些|多少)/,
    /(?:claude\.?md|\.claude|CLAUDE\.MD)/i,
  ];

  for (const p of highRisk) {
    if (p.test(normalized) || p.test(input)) {
      return { score: 25, flag: 'architecture_probing' };
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// All detectors
// ---------------------------------------------------------------------------

const ALL_DETECTORS: Detector[] = [
  detectDangerousTags,
  detectNaturalLanguageInjection,
  detectUnicodeObfuscation,
  detectEncodedPayloads,
  detectPathTraversal,
  detectFormulaInjection,
  detectEscalationPatterns,
  detectArchitectureProbing,
];

// ---------------------------------------------------------------------------
// Sanitizer: strip dangerous content from input
// ---------------------------------------------------------------------------

function sanitize(input: string): string {
  let s = input;

  // Remove zero-width and invisible characters
  s = s.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD]/g, '');

  // Remove RTL/LTR overrides
  s = s.replace(/[\u202A-\u202E\u2066-\u2069]/g, '');

  // Strip dangerous XML-like tags (broad match)
  s = s.replace(/<\/?(?:system|role|admin|prompt|instruction|override|ignore|assistant|human|tool_use|tool_result|function_call|function)[^>]*>/gi, '');

  // Strip Llama/Mistral-style tokens
  s = s.replace(/\[(?:SYSTEM|INST|\/INST|SYS)\]/gi, '');

  return s.trim();
}

// ---------------------------------------------------------------------------
// Main analysis function
// ---------------------------------------------------------------------------

export function analyzeInput(input: string): GuardResult {
  // Length check
  if (input.length > config.maxMessageLength) {
    return {
      safe: false,
      score: 100,
      flags: ['message_too_long'],
      sanitized: input.slice(0, config.maxMessageLength),
      blocked: true,
    };
  }

  const flags: string[] = [];
  let totalScore = 0;

  for (const detector of ALL_DETECTORS) {
    const result = detector(input);
    if (result) {
      flags.push(result.flag);
      totalScore += result.score;
    }
  }

  // Cap at 100
  totalScore = Math.min(totalScore, 100);

  const blocked = totalScore >= BLOCK_THRESHOLD;
  const sanitized = sanitize(input);

  return {
    safe: totalScore < WARN_THRESHOLD,
    score: totalScore,
    flags,
    sanitized,
    blocked,
  };
}

// ---------------------------------------------------------------------------
// Analyze file content (for uploaded files)
// ---------------------------------------------------------------------------

export function analyzeFileContent(content: string, filename: string): GuardResult {
  // Run standard analysis
  const result = analyzeInput(content);

  // Extra check: filename-based patterns
  const suspiciousNames = /\.(exe|bat|cmd|ps1|sh|vbs|js|msi|scr|com|pif|reg)$/i;
  if (suspiciousNames.test(filename)) {
    result.flags.push('suspicious_filename');
    result.score = Math.min(result.score + 50, 100);
    result.blocked = result.score >= BLOCK_THRESHOLD;
    result.safe = result.score < WARN_THRESHOLD;
  }

  return result;
}

/**
 * Scan arbitrarily-long extracted file text WITHOUT tripping the message-length
 * block. analyzeInput() hard-blocks anything over config.maxMessageLength as
 * "message_too_long" — fine for chat, but it would false-block a long legitimate
 * attachment (a 40k-char PDF/Excel) that we now feed to the AI in full for
 * accuracy. So we split into maxMessageLength-sized chunks, scan each (the length
 * check never fires within a chunk), and aggregate: a real injection anywhere is
 * still caught, but sheer length no longer blocks. The per-filename check is
 * applied identically to every chunk.
 */
export function analyzeFileContentChunked(content: string, filename: string): GuardResult {
  const size = config.maxMessageLength;
  if (content.length <= size) return analyzeFileContent(content, filename);

  let worst: GuardResult | null = null;
  for (let i = 0; i < content.length; i += size) {
    const r = analyzeFileContent(content.slice(i, i + size), filename);
    // A real injection (not merely "too long") → block immediately.
    if (r.blocked && !r.flags.includes('message_too_long')) return r;
    if (!worst || r.score > worst.score) worst = r;
  }
  return worst!;
}

// ---------------------------------------------------------------------------
// Log security event to DB
// ---------------------------------------------------------------------------

export function logSecurityEvent(
  userId: string,
  eventType: 'prompt_injection' | 'file_scan' | 'suspicious_upload' | 'blocked_request',
  severity: 'low' | 'medium' | 'high' | 'critical',
  detail: string,
  rawInput?: string,
): void {
  try {
    dbRun(
      `INSERT INTO security_events (id, user_id, event_type, severity, detail, raw_input, created_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      uuidv4(),
      userId,
      eventType,
      severity,
      detail,
      rawInput ? rawInput.slice(0, 500) : null,
    ).catch(e => console.error('Failed to log security event:', e));
  } catch (e) {
    console.error('Failed to log security event:', e);
  }
}

// ---------------------------------------------------------------------------
// Thresholds export (for external use)
// ---------------------------------------------------------------------------

export { BLOCK_THRESHOLD, WARN_THRESHOLD };
