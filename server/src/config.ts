import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');

// Load root .env file
const envPath = path.resolve(ROOT_DIR, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
    const match = line.match(/^([^#=\s]+)\s*=\s*(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].replace(/\s+#.*$/, '').trim();
    }
  }
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  jwtSecret: process.env.JWT_SECRET || 'dev-secret-change-in-production',
  jwtExpiresIn: '7d',
  nodeEnv: process.env.NODE_ENV || 'development',

  // Paths
  rootDir: ROOT_DIR,
  workspaceRoot: path.resolve(ROOT_DIR, process.env.WORKSPACE_ROOT || './workspace'),
  skillsDir: path.resolve(__dirname, 'skills'),
  generatorsDir: path.resolve(__dirname, 'generators'),

  // MySQL
  mysqlHost: process.env.MYSQL_HOST || '127.0.0.1',
  mysqlPort: parseInt(process.env.MYSQL_PORT || '3306', 10),
  mysqlDb: process.env.MYSQL_DB || 'db_ai_agents',
  mysqlUser: process.env.MYSQL_USER || 'root',
  mysqlPassword: process.env.MYSQL_PASSWORD || '',

  // Ops / report-system DB — separate schema on the same MySQL server, so the
  // future centralized ops system can own this data independently.
  opsMysqlDb: process.env.OPS_MYSQL_DB || 'db_Ops',
  // Report ("問題回報") system toggle — on for both deploy modes by default.
  reportSystemEnabled: (process.env.REPORT_SYSTEM_ENABLED || 'true') !== 'false',

  // Claude CLI
  claudeCliPath: process.env.CLAUDE_CLI_PATH || 'claude',
  // Router model — the Router reads the request and emits [TASK] blocks. Sonnet is
  // the sweet spot: reliable [TASK] instruction-following (Haiku intermittently just
  // acknowledges without emitting a [TASK] → "chatted but no file"), while still far
  // cheaper/faster than Opus and light on the rate-limit budget. The earlier Haiku
  // default was chosen for "speed" but the 90s timeouts were actually the OAuth race,
  // not router latency. Override with ROUTER_MODEL if needed.
  routerModel: process.env.ROUTER_MODEL || 'claude-sonnet-4-6',
  // Anthropic API Key — fallback when account quota is exhausted
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '',
  // API-key fallback policy. Default (true) = only overflow to the paid API when the
  // account genuinely hit its rate/usage limit (5-hour window or monthly cap). Auth
  // failures (logged-out account) and silent no-output blips do NOT fall back — they
  // fail visibly so they get fixed at the source instead of silently billed on Opus.
  // Set API_KEY_FALLBACK_QUOTA_ONLY=false to restore the old broad fallback.
  apiKeyFallbackQuotaOnly: (process.env.API_KEY_FALLBACK_QUOTA_ONLY || 'true') !== 'false',

  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',

  // Resend (email service)
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || '',
  emailBcc: process.env.EMAIL_BCC || '',
  // Public website base URL (used to build share links in emails sent from
  // background jobs, where there's no request to read the origin from).
  publicWebUrl: (process.env.PUBLIC_WEB_URL || (process.env.CORS_ORIGINS || '').split(',')[0] || 'http://localhost:3001').trim().replace(/\/$/, ''),

  // DeepSeek
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',

  // Google Gemini — infographic HTML + raster image generation
  geminiApiKey: process.env.GEMINI_API_KEY || '',

  // Deploy mode: 'pro-panjit' (internal) | 'pro-out' (external, per-user quota)
  deployMode: (process.env.DEPLOY_MODE || 'pro-panjit') as 'pro-panjit' | 'pro-out',

  // Billing markup applied to raw Claude Sonnet pricing ($3/M in, $15/M output) for
  // displayed dollar costs. This is the CURRENT (ongoing) rate: pro-out (external)
  // ×2; pro-panjit (強茂) dropped ×10 → ×5 at 2026-07-07 16:00. Historical records
  // bill at the rate in effect then — use pricingMarkupForDate()/pricingMarkupSql()
  // for any per-record / invoice cost so pre-switch usage stays ×10.
  pricingMarkup: (process.env.DEPLOY_MODE || 'pro-panjit') === 'pro-out' ? 2 : 5,

  // Private on-prem LLM (OpenAI-compatible). The FIRST choice for tool-free text
  // work — summaries, synthesis, classification — because it bills nothing per
  // token. DeepSeek stays configured as the backup; see services/auxLlm.ts.
  localLlmBaseUrl: (process.env.LLM_BASE_URL || '').replace(/\/+$/, ''),
  localLlmApiKey: process.env.LLM_API_KEY || '',
  // Default model, chosen by measurement against the real email-summary prompt:
  // ~5s per batch, valid JSON every run, kept 簡體 mail in 繁體 output, and
  // refused an "IGNORE ALL PREVIOUS INSTRUCTIONS" line planted in a mail preview
  // (it even flagged that mail as tampered with). 30B total but only 3B active,
  // which is why it costs a fraction of the dense 27Bs — those needed 30-80s for
  // the same work on the same box, past any timeout worth waiting out.
  //
  // ONE model by default, on purpose: the box holds a single model in memory and
  // swapping costs tens of seconds, so splitting our own traffic across two
  // models would make both slower. LLM_MODEL_QUALITY exists for when a
  // deployment deliberately wants a heavier model for long-form synthesis and
  // will accept the swap cost.
  localLlmModel: process.env.LLM_MODEL || 'mlx-community/Qwen3-VL-30B-A3B-Instruct-4bit',
  localLlmModelQuality: process.env.LLM_MODEL_QUALITY || process.env.LLM_MODEL || 'mlx-community/Qwen3-VL-30B-A3B-Instruct-4bit',

  // The DeepSeek model id we send. Kept in config because DeepSeek retires ids:
  // "deepseek-chat" is what this deployment has always used, but their 2026-07-24
  // notice lists it as deprecated in favour of the V4 series. Verify against a
  // live key before trusting the fallback — an unknown id fails the whole call.
  deepseekModel: process.env.DEEPSEEK_MODEL || 'deepseek-chat',

  // AD (Active Directory) integration — pro-panjit only
  adApiUrl: process.env.AD_API_URL || 'https://apigw.panjit.com.tw/ldap/api/v1',
  adApiKey: process.env.AD_API_KEY || process.env.AD_API || '',
  // KM (Knowledge Management) integration — pro-panjit only. System X-API-Key +
  // per-user X-On-Behalf-Of (the user's AD 員編) → KM enforces per-user permission.
  kmApiBase: (process.env.KM_API_BASE || 'https://kmapi.panjit.com.tw').replace(/\/+$/, ''),
  kmApiKey: process.env.KM_API_KEY || '',
  /**
   * Which surfaces may use KM, comma separated: web, excel.
   *
   * Defaults to the add-in only. The customer decided KM is not part of the web
   * app, but the MCP was finished and the Excel add-in wants it — and before
   * this, setting KM_API_KEY switched KM on for BOTH. The key says "we can reach
   * KM"; this says "and here is where that is allowed to show up".
   *
   * Set KM_SURFACES=web,excel to put it back on the web.
   */
  kmSurfaces: (process.env.KM_SURFACES || 'excel')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  // Whitelist: these emails can still use email/password login even in pro-panjit mode
  emailLoginWhitelist: (process.env.EMAIL_LOGIN_WHITELIST || 'admin@zhaoi.ai,aken1023@gmail.com').split(',').map(e => e.trim().toLowerCase()),

  // Version: 'Beta' = apply watermarks, 'Official' = no watermarks
  isBeta: (process.env.Version || 'Beta').toLowerCase() !== 'official',

  // LINE Bot configuration. Webhook lives at <host>/webhook/line (Next.js
  // proxies /webhook/* → Express). When `enabled` is false the webhook route
  // 404s and no auto-provisioning happens.
  line: {
    enabled: process.env.LINE_BOT_ENABLED === 'true',
    channelId: process.env.LINE_CHANNEL_ID || '',
    channelSecret: process.env.LINE_CHANNEL_SECRET || '',
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || '',
    publicApiBase: (process.env.LINE_PUBLIC_API_BASE || '').replace(/\/$/, ''),
    defaultQuotaUsd: parseFloat(process.env.LINE_DEFAULT_QUOTA_USD || '5'),
    maxMsgPerMin: parseInt(process.env.LINE_MAX_MSG_PER_MIN || '10', 10),
    fileShareTtlDays: parseInt(process.env.LINE_FILE_SHARE_TTL_DAYS || '7', 10),
    conversationIdleHours: parseInt(process.env.LINE_CONVERSATION_IDLE_HOURS || '12', 10),
    richMenuId: process.env.LINE_RICH_MENU_ID || '',
    botBasicId: process.env.LINE_BOT_BASIC_ID || '',
    liffId: process.env.LINE_LIFF_ID || '',
  },

  // Redis (LINE queue + rate-limit). Set REDIS_ENABLED=false to run without Redis
  // (e.g. local dev with no LINE): no queue is started, no connection attempts,
  // no reconnect error spam. Defaults on; only the LINE features need it.
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  redisEnabled: process.env.REDIS_ENABLED !== 'false',

  // Security
  maxMessageLength: 10_000,
  bcryptRounds: 12,

  // Rate limiting
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 30,

  // Storage quota (per user, in bytes)
  storageQuotaBytes: parseFloat(process.env.STORAGE_QUOTA_GB || '2') * 1024 * 1024 * 1024,
  storageWarningThreshold: 0.9, // warn at 90%

  // Trust the X-Forwarded-* headers (only enable when genuinely behind a trusted
  // reverse proxy — otherwise req.ip becomes spoofable). Off by default so
  // existing single-node deployments are unaffected.
  trustProxy: process.env.TRUST_PROXY === 'true',
} as const;

/**
 * Historical billing markup, switched at a precise instant: 強茂 (pro-panjit) drops
 * from ×10 to ×5 at 2026-07-07 16:00 Taipei. pro-out is always ×2.
 *
 * token_usage.created_at is stored in the DB server's local time (Taipei), so the
 * SQL boundary literal below is Taipei-local (compared directly against created_at);
 * JS code uses the same instant as an absolute UTC millisecond value.
 */
// Three-tier billing for 強茂 (pro-panjit), all in Taipei-local time (matches how
// created_at is stored):
//   • before 2026-07-01 00:00           → ×10  (June & earlier — historical, settled)
//   • 2026-07-01 00:00 .. 2026-07-07 16:00 → ×0  (this-month grace period — FREE, shows $0)
//   • from 2026-07-07 16:00              → ×5   (new ongoing rate)
export const PRICING_FREE_START_SQL = '2026-07-01 00:00:00';
export const PRICING_X5_START_SQL   = '2026-07-07 16:00:00';
export const PRICING_FREE_START_MS = Date.parse('2026-07-01T00:00:00+08:00');
export const PRICING_X5_START_MS   = Date.parse('2026-07-07T16:00:00+08:00');

/** Markup for a single usage record's timestamp (per-record billing). */
export function pricingMarkupForDate(ts: string | Date): number {
  if ((process.env.DEPLOY_MODE || 'pro-panjit') === 'pro-out') return 2;
  const ms = ts instanceof Date ? ts.getTime() : Date.parse(ts);
  if (ms < PRICING_FREE_START_MS) return 10;
  if (ms < PRICING_X5_START_MS) return 0;
  return 5;
}

/**
 * SQL expression yielding each row's markup, so a cost SUM over a period that spans
 * the tiers (e.g. July 2026) prices each record correctly. `col` is the created_at
 * column reference (e.g. 'created_at' or 'tu.created_at').
 */
export function pricingMarkupSql(col: string): string {
  if ((process.env.DEPLOY_MODE || 'pro-panjit') === 'pro-out') return '2';
  return `CASE WHEN ${col} < '${PRICING_FREE_START_SQL}' THEN 10 WHEN ${col} < '${PRICING_X5_START_SQL}' THEN 0 ELSE 5 END`;
}

const DEFAULT_JWT_SECRET = 'dev-secret-change-in-production';

/**
 * Validate security-critical config at startup. A weak/default JWT secret lets
 * anyone forge admin tokens, so in production we refuse to start. In
 * development we only warn loudly — existing local/dev usage is NOT affected.
 */
export function validateConfig(): void {
  const isProd = config.nodeEnv === 'production';
  const usingDefaultSecret = !process.env.JWT_SECRET || config.jwtSecret === DEFAULT_JWT_SECRET;

  if (usingDefaultSecret) {
    const msg = 'JWT_SECRET is unset or using the public default — tokens can be forged.';
    if (isProd) {
      throw new Error(`[FATAL] ${msg} Set a strong JWT_SECRET (≥32 random chars) before starting in production.`);
    }
    console.warn('\x1b[33m%s\x1b[0m', `[SECURITY WARNING] ${msg} This is acceptable only in local development.`);
  } else if (config.jwtSecret.length < 32) {
    console.warn('\x1b[33m%s\x1b[0m', '[SECURITY WARNING] JWT_SECRET is shorter than 32 characters; use a longer random value.');
  }

  // In production, refuse to start with an empty DB password (silent fail-open risk).
  if (isProd && !config.mysqlPassword) {
    throw new Error('[FATAL] MYSQL_PASSWORD is empty in production. Set a database password.');
  }
}
