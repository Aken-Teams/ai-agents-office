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

export interface LocalLlmProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /**
   * Provider role. 'chat' (default) for completion-style generation, 'embedding'
   * for vector models used by personal RAG. The provider system is the same
   * either way — we just route to /chat/completions or /embeddings on call.
   */
  kind?: 'chat' | 'embedding';
  /**
   * Thinking models split output into reasoning + final answer; need a higher
   * max_tokens floor and the gateway-cooked non-stream response (raw stream
   * leaks harmony tokens like <|channel|>analysis|>...).
   */
  thinking?: boolean;
  /** Floor for max_tokens (default 1500 when thinking=true). */
  minMaxTokens?: number;
  /** System prompt prepended when caller didn't supply one — overrides identity. */
  identityOverride?: string;
  /** If true, stream calls fall back to non-stream internally. */
  forceNonStream?: boolean;
}

function buildLocalLlmProviders(): Record<string, LocalLlmProvider> {
  const out: Record<string, LocalLlmProvider> = {};

  // Legacy single-provider env vars → "default" provider
  if (process.env.LOCAL_LLM_BASE_URL && process.env.LOCAL_LLM_API_KEY) {
    out.default = {
      name: 'default',
      baseUrl: (process.env.LOCAL_LLM_BASE_URL || '').replace(/\/$/, ''),
      apiKey: process.env.LOCAL_LLM_API_KEY || '',
      model: process.env.LOCAL_LLM_DEFAULT_MODEL || '',
    };
  }

  // Additional providers from JSON env var
  const raw = process.env.LOCAL_LLM_PROVIDERS_JSON;
  if (raw && raw.trim()) {
    try {
      const arr = JSON.parse(raw) as Array<Partial<LocalLlmProvider>>;
      if (!Array.isArray(arr)) {
        throw new Error('LOCAL_LLM_PROVIDERS_JSON must be a JSON array');
      }
      for (const p of arr) {
        if (!p || !p.name || !p.baseUrl || !p.apiKey || !p.model) {
          console.warn('[config] Skipping incomplete LOCAL_LLM provider:', p);
          continue;
        }
        out[p.name] = {
          name: p.name,
          baseUrl: p.baseUrl.replace(/\/$/, ''),
          apiKey: p.apiKey,
          model: p.model,
          kind: p.kind,
          thinking: p.thinking,
          minMaxTokens: p.minMaxTokens,
          identityOverride: p.identityOverride,
          forceNonStream: p.forceNonStream,
        };
      }
    } catch (err) {
      console.error('[config] Failed to parse LOCAL_LLM_PROVIDERS_JSON:', (err as Error).message);
    }
  }

  return out;
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
  // Isolated Claude CLI config dir (contains apiKeyHelper) — forces spawned
  // CLI to use a service-account API key instead of the operator's personal
  // OAuth token at ~/.claude/.credentials.json, which 401s intermittently
  // under heavy PPT-generation load.
  claudeCliConfigDir: process.env.AGENTS_OFFICE_CLAUDE_CONFIG_DIR || '',

  // Agent engine for the orchestrator's router + worker agents:
  //   'claude' (default) → Claude CLI (spawnClaude)
  //   'codex'            → Codex CLI  (spawnCodex)
  // Both drive the same SSE protocol; switching is a drop-in. Codex requires
  // `codex login` (or CODEX_HOME with stored auth) on the host.
  agentEngine: ((process.env.AGENTS_OFFICE_AGENT_ENGINE || 'claude').toLowerCase() === 'codex'
    ? 'codex'
    : 'claude') as 'claude' | 'codex',

  // Codex CLI (OpenAI). Used when agentEngine === 'codex'. Sandbox maps to
  // Codex's own policy: workers run 'workspace-write', router runs 'read-only'.
  codexCli: {
    path: process.env.CODEX_CLI_PATH || 'codex',
    model: process.env.CODEX_CLI_MODEL || '',                       // empty = Codex default
    sandbox: process.env.CODEX_CLI_SANDBOX || 'workspace-write',    // worker sandbox policy
    // CODEX_HOME for isolated auth/config/session storage (analogous to
    // claudeCliConfigDir). Empty → Codex's default (~/.codex).
    home: process.env.AGENTS_OFFICE_CODEX_HOME || process.env.CODEX_HOME || '',
  },

  // Personal RAG hybrid search tuning. `vectorWeight` is the LEANN-style
  // fusion knob: 1.0 = pure semantic (HNSW only), 0.0 = pure keyword (BM25
  // only). 0.7 is LEANN's default and a good starting point for zh text.
  rag: {
    vectorWeight: Math.max(0, Math.min(1, parseFloat(process.env.RAG_VECTOR_WEIGHT || '0.7'))),
    hybridMinScore: Math.max(0, parseFloat(process.env.RAG_HYBRID_MIN_SCORE || '0.35')),
  },

  // Lightweight, tool-free text generation (greeting + memory extraction).
  // These run through the Claude CLI (runClaudeText), NOT the raw Claude API —
  // the whole service goes through local CLIs. Only the model names are
  // configurable here; auth comes from the CLI's own config dir.
  claudeText: {
    greetingModel: process.env.CLAUDE_TEXT_GREETING_MODEL || process.env.CLAUDE_API_GREETING_MODEL || 'claude-haiku-4-5',
    extractionModel: process.env.CLAUDE_TEXT_EXTRACTION_MODEL || process.env.CLAUDE_API_EXTRACTION_MODEL || 'claude-haiku-4-5',
  },

  // Google OAuth
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',

  // Resend (email service)
  resendApiKey: process.env.RESEND_API_KEY || '',
  emailFrom: process.env.EMAIL_FROM || '',
  emailBcc: process.env.EMAIL_BCC || '',

  // DeepSeek
  deepseekApiKey: process.env.DEEPSEEK_API_KEY || '',

  // Local / on-prem OpenAI-compatible LLM (Ollama gateway etc.)
  // Used for lightweight tasks alongside the main Claude CLI orchestration to save tokens.
  //
  // Two configuration paths coexist:
  //   1) Legacy LOCAL_LLM_BASE_URL/API_KEY/DEFAULT_MODEL — registered as provider "default".
  //   2) LOCAL_LLM_PROVIDERS_JSON — JSON array of additional providers, each can declare
  //      thinking-model quirks (forceNonStream, minMaxTokens, identityOverride).
  // Pick a provider via LocalLlmRequest.provider; omit to use defaultProviderName.
  localLlm: {
    baseUrl: (process.env.LOCAL_LLM_BASE_URL || '').replace(/\/$/, ''),
    apiKey: process.env.LOCAL_LLM_API_KEY || '',
    defaultModel: process.env.LOCAL_LLM_DEFAULT_MODEL || '',
    timeoutMs: parseInt(process.env.LOCAL_LLM_TIMEOUT_MS || '120000', 10),
    providers: buildLocalLlmProviders(),
    defaultProviderName: process.env.LOCAL_LLM_DEFAULT_PROVIDER || 'default',
    /** Pre-router gating: classify intent locally, only escalate complex tasks to Claude. */
    preRouter: {
      enabled: process.env.LOCAL_LLM_PRE_ROUTER_ENABLED === 'true',
      maxInputChars: parseInt(process.env.LOCAL_LLM_PRE_ROUTER_MAX_INPUT_CHARS || '400', 10),
    },
  },

  // LINE Bot configuration. Webhook lives at agents.theaken.com/webhook/line
  // (Next.js proxies /webhook/* → Express). When `enabled` is false the
  // webhook route 404s and no auto-provisioning happens.
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

  // Redis (queue, rate-limit, cache)
  redisUrl: process.env.REDIS_URL || 'redis://127.0.0.1:6379',

  // Deploy mode: 'pro-panjit' (internal) | 'pro-out' (external, per-user quota)
  deployMode: (process.env.DEPLOY_MODE || 'pro-panjit') as 'pro-panjit' | 'pro-out',

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

/** AI orchestration engine. Both drive the same spawn signature + SSE protocol. */
export type AgentEngine = 'claude' | 'codex';

/**
 * Coerce an arbitrary value (e.g. a request body field) into a valid
 * AgentEngine. Returns undefined for anything that isn't a recognised engine,
 * so callers can fall back to a stored/default choice.
 */
export function normalizeEngine(value: unknown): AgentEngine | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return v === 'claude' || v === 'codex' ? v : undefined;
}
