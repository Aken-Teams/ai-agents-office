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

  // DeepSeek
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',

  // Deploy mode: 'pro-panjit' (internal) | 'pro-out' (external, per-user quota)
  deployMode: (process.env.DEPLOY_MODE || 'pro-panjit') as 'pro-panjit' | 'pro-out',

  // AD (Active Directory) integration — pro-panjit only
  adApiUrl: process.env.AD_API_URL || 'https://apigw.panjit.com.tw/ldap/api/v1',
  adApiKey: process.env.AD_API_KEY || process.env.AD_API || '',
  // Whitelist: these emails can still use email/password login even in pro-panjit mode
  emailLoginWhitelist: (process.env.EMAIL_LOGIN_WHITELIST || 'admin@zhaoi.ai,aken1023@gmail.com').split(',').map(e => e.trim().toLowerCase()),

  // Version: 'Beta' = apply watermarks, 'Official' = no watermarks
  isBeta: (process.env.Version || 'Beta').toLowerCase() !== 'official',

  // Security
  maxMessageLength: 10_000,
  bcryptRounds: 12,

  // Rate limiting
  rateLimitWindowMs: 60_000,
  rateLimitMaxRequests: 30,

  // Storage quota (per user, in bytes)
  storageQuotaBytes: parseFloat(process.env.STORAGE_QUOTA_GB || '2') * 1024 * 1024 * 1024,
  storageWarningThreshold: 0.9, // warn at 90%
} as const;
