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
  // Anthropic API Key — fallback when account quota is exhausted
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '',

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
  // ×2; pro-panjit (強茂) dropped ×10 → ×5 at 2026-07-03 16:00. Historical records
  // bill at the rate in effect then — use pricingMarkupForDate()/pricingMarkupSql()
  // for any per-record / invoice cost so pre-switch usage stays ×10.
  pricingMarkup: (process.env.DEPLOY_MODE || 'pro-panjit') === 'pro-out' ? 2 : 5,

  // AD (Active Directory) integration — pro-panjit only
  adApiUrl: process.env.AD_API_URL || 'https://apigw.panjit.com.tw/ldap/api/v1',
  adApiKey: process.env.AD_API_KEY || process.env.AD_API || '',
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
 * from ×10 to ×5 at 2026-07-03 16:00 Taipei. pro-out is always ×2.
 *
 * token_usage.created_at is stored in the DB server's local time (Taipei), so the
 * SQL boundary literal below is Taipei-local (compared directly against created_at);
 * JS code uses the same instant as an absolute UTC millisecond value.
 */
export const PRICING_X5_START_SQL = '2026-07-03 16:00:00';               // vs DB created_at (local)
export const PRICING_X5_START_MS = Date.parse('2026-07-03T16:00:00+08:00');

/** Markup for a single usage record's timestamp (per-record billing). */
export function pricingMarkupForDate(ts: string | Date): number {
  if ((process.env.DEPLOY_MODE || 'pro-panjit') === 'pro-out') return 2;
  const ms = ts instanceof Date ? ts.getTime() : Date.parse(ts);
  return ms < PRICING_X5_START_MS ? 10 : 5;
}

/**
 * SQL expression yielding each row's markup, so a cost SUM over a period that spans
 * the switch (e.g. July 2026) prices each record correctly. `col` is the created_at
 * column reference (e.g. 'created_at' or 'tu.created_at').
 */
export function pricingMarkupSql(col: string): string {
  if ((process.env.DEPLOY_MODE || 'pro-panjit') === 'pro-out') return '2';
  return `CASE WHEN ${col} < '${PRICING_X5_START_SQL}' THEN 10 ELSE 5 END`;
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
