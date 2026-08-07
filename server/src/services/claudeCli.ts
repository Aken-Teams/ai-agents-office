import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { config } from '../config.js';
import { getSandboxPath } from './sandbox.js';
import { resolveClaudeCliPath } from './resolveClaudeCli.js';
import { acquireAuthSlot } from './claudeAuthGate.js';
import { logAiCall } from './aiCallLog.js';
import type { SSEEvent } from '../types.js';

// Max time to hold the auth gate for one spawn if it never produces output (the
// exact hang we are preventing) — releases the gate so a stuck spawn cannot block
// the queue. Warm spawns release far sooner, on their first output.
const AUTH_WARMUP_TIMEOUT_MS = Math.max(1000, parseInt(process.env.AUTH_WARMUP_TIMEOUT_MS || '', 10) || 8000);

/**
 * Translate known Claude CLI error messages to user-friendly Chinese.
 * Returns translated string if matched, null otherwise.
 */
function humanizeClaudeError(text: string): string | null {
  const t = text.trim();

  // FRONTEND PRIVACY: any Claude usage / session / rate / capacity limit becomes a
  // GENERIC "busy" message. This deliberately hides that we run on Claude auth — the
  // raw CLI wording ("You've hit your session limit · resets 3:10pm") would reveal the
  // provider AND a subscription-style reset time (which is volatile and unhelpful).
  // Returned as a translated string → emitted as an 'error' event (not shown as chat
  // content), so it never leaks into the visible response.
  if (
    /you[''’]ve (?:hit|reached) your \S* ?limit/i.test(t) ||
    /(session|usage|weekly|monthly|5[\s-]?hour|hourly|daily)[\s-]?limit/i.test(t) ||
    /resets?\s+\d{1,2}(?::\d{2})?\s*[ap]m/i.test(t) ||
    (/(rate.?limit|too many requests|429|overloaded|over.?capacity|503|quota)/i.test(t) && t.length < 1500)
  ) {
    return 'AI 服務忙碌中，請稍後再試。';
  }

  // "You've hit your limit · resets 4pm (Asia/Taipei)"
  const limitMatch = t.match(/You[''\u2019]ve hit your limit.*?resets?\s+(\d{1,2}(?::\d{2})?\s*[ap]m)(?:\s*\(([^)]+)\))?/i);
  if (limitMatch) {
    const time = limitMatch[1];
    const tz = limitMatch[2] || '';
    return `AI 服務使用額度已達上限，預計於 ${time}${tz ? ` (${tz})` : ''} 重置。請稍後再試。`;
  }

  // Generic "hit your limit" without reset time
  if (/you[''\u2019]ve hit your limit/i.test(t)) {
    return 'AI 服務使用額度已達上限，請稍後再試。';
  }

  // "rate limit" / "too many requests" / 429
  if (/rate.?limit|too many requests|429/i.test(t) && t.length < 500) {
    return '請求過於頻繁，請稍候幾秒再試。';
  }

  // "overloaded" / "capacity"
  if (/overloaded|over.?capacity|503/i.test(t) && t.length < 500) {
    return 'AI 服務目前繁忙，請稍後再試。';
  }

  // "credit" / "billing" / "payment"
  if (/insufficient.?credit|billing|payment.*required/i.test(t) && t.length < 500) {
    return 'AI 服務帳戶額度不足，請聯繫管理員。';
  }

  // "invalid api key" / "unauthorized" / 401
  if (/invalid.?api.?key|unauthorized|401/i.test(t) && t.length < 500) {
    return 'AI 服務認證失敗，請聯繫管理員檢查設定。';
  }

  return null;
}

/**
 * Detect whether stderr indicates an account quota / rate limit error
 * that can be retried with an API key.
 */
function isQuotaLimitError(text: string): boolean {
  if (!text) return false;
  const t = text.toLowerCase();
  // Subscription usage limits (5-hour rolling / weekly / monthly). Real wording seen
  // in production: "You've hit your session limit \u00b7 resets 3:10pm (Asia/Taipei)".
  // Match the whole family loosely \u2014 narrow patterns kept blocking the API-key overflow:
  //   "you've hit/reached your <session|usage|\u2026> limit", "\u2026limit \u00b7 resets 3:10pm",
  //   "limit will reset at 4pm", "5-hour limit reached", "weekly/monthly limit", etc.
  if (/you[''\u2019]ve (hit|reached) your \S* ?limit\b/.test(t)) return true;         // your <word> limit
  if (/(session|usage|weekly|monthly|5[\s-]?hour|hourly|daily|rate)[\s-]?limit\b/.test(t)) return true;
  if (/\blimit\b/.test(t) && /reset|resets?\s+\d/.test(t)) return true;          // "limit \u2026 resets 3:10pm"
  if (/resets?\s+\d{1,2}(:\d{2})?\s*[ap]m/.test(t)) return true;                 // "resets 3:10pm / 4pm"
  // Rate limiting / capacity / explicit "limit reached" \u2014 paid API has its own window.
  if (/(rate.?limit|too many requests|429|overloaded|over.?capacity|503|quota|limit reached|limit exceeded)/.test(t) && t.length < 1500) return true;
  return false;
}

/**
 * Detect whether a failure looks like an account-auth / OAuth-token problem
 * (expired token, refresh race during concurrent spawns, not-logged-in, 401/403).
 * Used mainly for clearer logging — the API-key fallback itself also fires on
 * any no-output failure (see the close handler), since a token blip can kill
 * the process before it writes any diagnostic to stderr.
 */
function isAuthError(text: string): boolean {
  return /invalid.?api.?key|unauthorized|forbidden|401|403|authentication|oauth|token.*(expired|refresh|invalid)|credential|please run.*login|not logged in|登入|認證/i
    .test(text) && text.length < 800;
}

// ---------------------------------------------------------------------------
// Output sanitizer — redact system paths from AI responses before sending
// to the user. This is the last line of defense: even if the AI ignores
// prompt rules, leaked paths are scrubbed from the output.
// ---------------------------------------------------------------------------

/** Patterns that match system / infrastructure paths the user should never see. */
const REDACT_PATTERNS: RegExp[] = [
  // Unix home directories: /home/username/...
  /\/home\/[a-zA-Z0-9_.-]+\/[^\s'"`)\]},]*/g,
  // Root home: /root/...
  /\/root\/[^\s'"`)\]},]*/g,
  // Windows user profiles: C:\Users\username\...
  /[A-Z]:\\Users\\[a-zA-Z0-9_.-]+\\[^\s'"`)\]},]*/gi,
  // Git-bash style drives: /d/github/... /c/Users/...
  /\/[a-z]\/(?:github|Users|home|projects?|repos?|src|code)\/[^\s'"`)\]},]*/gi,
  // .claude directories anywhere in a path
  /[^\s'"`]*\.claude\/[^\s'"`)\]},]*/g,
  // node_modules with absolute prefix
  /(?:\/|[A-Z]:\\)[^\s'"`]*node_modules\/[^\s'"`)\]},]*/gi,
  // Workspace agent internals: _agents/skillId/...
  /[^\s'"`]*\/_agents\/[^\s'"`)\]},]*/g,
  // /usr, /etc, /proc, /sys paths
  /\/(?:usr|etc|proc|sys)\/[^\s'"`)\]},]*/g,
  // /tmp with deep paths (but not bare /tmp)
  /\/tmp\/[^\s'"`)\]},]{10,}/g,
];

const REDACT_REPLACEMENT = '[路徑已隱藏]';

/**
 * Scrub system paths from text before it reaches the user.
 * Intentionally aggressive: better to over-redact than to leak server internals.
 */
function sanitizeOutput(text: string): string {
  let result = text;
  for (const pattern of REDACT_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACT_REPLACEMENT);
  }
  return result;
}

export interface ClaudeCliOptions {
  userId: string;
  conversationId: string;
  sessionId?: string;
  isResume?: boolean;  // true = --resume (existing session), false = --session-id (new)
  skillId?: string;
  role?: 'router' | 'worker';          // Agent role (affects tool permissions)
  customAllowedTools?: string[];        // Override default allowed tools
  customDisallowedTools?: string[];     // Override default disallowed tools
  sandboxSubdir?: string;              // Subdirectory within sandbox (e.g. _agents/research)
  useApiKey?: boolean;                 // Internal: force API key auth (set by retry logic)
  model?: string;                      // Override default model (e.g. 'claude-haiku-4-5-20251001' for fast edits)
  maxTurns?: number;                   // Cap tool-loop turns (e.g. bounded WebSearch for team members)
  images?: { media_type: string; data: string }[];  // base64 image blocks delivered via stream-json input (vision)
  // Data-source MCP: when set, attach the email-mcp stdio server carrying THIS
  // user's Outlook mail JWT, so the agent can pull the user's own mail (search /
  // read message) to build a document. Identity is the token — no cross-user access.
  mcpEmailToken?: string;
  // Data-source MCP: when set, attach the km-mcp stdio server carrying THIS user's
  // 員編 (X-On-Behalf-Of), so the agent can search/read KM documents the user is
  // permitted to see. May be combined with mcpEmailToken (both MCPs mount together).
  mcpKmOnBehalf?: string;
}

interface ClaudeResult {
  emitter: EventEmitter;
  abort: () => void;
  sessionId: string | undefined;
}

// Tools worker agents are allowed to use in sandbox
// Bash is broadly allowed; dangerous patterns are blocked via DISALLOWED_TOOLS
const ALLOWED_TOOLS = [
  'Bash',
  'Write',
  'Read',
  'WebSearch',
  'WebFetch',
];

// Tools explicitly blocked for worker agents (security)
const DISALLOWED_TOOLS = [
  'Edit',
  'Bash(rm:*)',
  'Bash(del:*)',
  'Bash(sudo:*)',
  'Bash(curl:*)',
  'Bash(wget:*)',
  'Bash(powershell:*)',
  'Bash(cmd:*)',
  'Bash(chmod:*)',
  'Bash(chown:*)',
  'Bash(mklink:*)',
  'Bash(net:*)',
  // Block filesystem exploration outside sandbox
  'Bash(find:*)',
  'Bash(locate:*)',
  'Bash(which:*)',
  'Bash(whereis:*)',
  'Bash(whoami:*)',
  'Bash(env:*)',
  'Bash(printenv:*)',
  'Bash(set:*)',
  'Bash(cat /etc:*)',
  'Bash(cat /home:*)',
  'Bash(cat /usr:*)',
  'Bash(cat /root:*)',
  'Bash(cat /proc:*)',
  'Bash(cat /sys:*)',
  'Bash(cat C\\:*)',
  'Bash(ls /:*)',
  'Bash(ls /home:*)',
  'Bash(ls /etc:*)',
  'Bash(ls /root:*)',
  'Bash(ls /usr:*)',
  'Bash(ls /proc:*)',
  'Bash(ls ..:*)',
  'Bash(ls C\\:*)',
  'Bash(tree:*)',
  'Bash(dir:*)',
  'Bash(type C\\:*)',
  // Block pwd and path discovery
  'Bash(pwd:*)',
  'Bash(realpath:*)',
  'Bash(readlink:*)',
  // Block broader parent directory traversal patterns
  'Bash(cat ..:*)',
  'Bash(head ..:*)',
  'Bash(tail ..:*)',
  // Block .claude directory access
  'Bash(ls .claude:*)',
  'Bash(cat .claude:*)',
  'Bash(ls */.claude:*)',
  'Bash(cat */.claude:*)',
  'Bash(head .claude:*)',
  'Bash(tail .claude:*)',
  // Block inline-eval runtimes — generators run `node <script>.ts`, never inline
  // eval, so blocking -e/-p/--eval stops the trivial `node -e "fs.readFileSync(...)"`
  // file-exfiltration one-liner without affecting legitimate generator runs.
  'Bash(node -e:*)',
  'Bash(node -p:*)',
  'Bash(node --eval:*)',
  'Bash(node --print:*)',
  'Bash(python -c:*)',
  'Bash(python3 -c:*)',
  'Bash(perl -e:*)',
  'Bash(ruby -e:*)',
  // Plug case/format holes in the drive-letter cat/type blocks above
  'Bash(cat /d:*)', 'Bash(cat /c:*)', 'Bash(type d\\:*)',
  'Bash(more:*)', 'Bash(Get-Content:*)', 'Bash(gc:*)',
];

// Router agents: NO tools — they only analyze requests and output [TASK] blocks.
// Having tools (even WebSearch) causes the router to attempt searches itself
// instead of delegating to research agent, which leads to hanging/timeouts.
const ROUTER_ALLOWED_TOOLS: string[] = [];

const ROUTER_DISALLOWED_TOOLS = [
  ...DISALLOWED_TOOLS,
  'Write',
  'Read',
  'Bash',
  'Glob',
  'Grep',
  'Task',
  'Edit',
  'WebSearch',
  'WebFetch',
  'ToolSearch',
  'TodoWrite',
  'NotebookEdit',
];

/**
 * Spawn a Claude CLI process with sandbox restrictions.
 *
 * System prompt is written to CLAUDE.md in the sandbox directory,
 * which Claude CLI reads automatically. This avoids Windows command line
 * length limits and special character escaping issues.
 *
 * When the account quota is exhausted and ANTHROPIC_API_KEY is configured,
 * the function transparently retries with API key authentication.
 */
export function spawnClaude(
  message: string,
  systemPrompt: string,
  options: ClaudeCliOptions,
): ClaudeResult {
  const emitter = new EventEmitter();
  const baseSandboxPath = getSandboxPath(options.userId, options.conversationId);

  // Support agent subdirectories (e.g. _agents/research)
  const sandboxPath = options.sandboxSubdir
    ? path.join(baseSandboxPath, options.sandboxSubdir)
    : baseSandboxPath;

  // Ensure sandbox directory exists
  fs.mkdirSync(sandboxPath, { recursive: true });

  // Write system prompt as CLAUDE.md in the sandbox directory
  // Claude CLI automatically reads this as project instructions
  const claudeMdPath = path.join(sandboxPath, 'CLAUDE.md');
  fs.writeFileSync(claudeMdPath, systemPrompt, 'utf-8');

  // Build CLI arguments (shared across retries)
  const args: string[] = [
    '-p',                              // Print mode (non-interactive)
    '--output-format', 'stream-json',  // Structured streaming output
    '--verbose',
  ];

  // Model override: use a faster model for lightweight tasks (e.g. block edits)
  if (options.model) {
    args.push('--model', options.model);
  }

  // Vision: when image blocks are supplied, deliver the user message as
  // stream-json so it can carry base64 image content alongside the text.
  const hasImages = !!(options.images && options.images.length);
  if (hasImages) {
    args.push('--input-format', 'stream-json');
  }

  // Note: Claude CLI auto-memory is per-project (based on cwd path hash).
  // Each user/conversation/skill gets a unique sandbox path, so auto-memory is already isolated.

  // Session management for multi-turn conversations
  // --session-id creates a NEW session; --resume continues an EXISTING one
  if (options.sessionId) {
    if (options.isResume) {
      args.push('--resume', options.sessionId);
    } else {
      args.push('--session-id', options.sessionId);
    }
  }

  // Role-based tool selection
  // Router agents get NO tools; workers get full tool access
  const allowedTools = options.customAllowedTools
    || (options.role === 'router' ? ROUTER_ALLOWED_TOOLS : ALLOWED_TOOLS);
  // Disallowed tools: merge global + per-skill restrictions (additive, not replace)
  const baseDisallowed = options.role === 'router' ? ROUTER_DISALLOWED_TOOLS : DISALLOWED_TOOLS;
  let disallowedTools = options.customDisallowedTools
    ? [...new Set([...baseDisallowed, ...options.customDisallowedTools])]
    : [...baseDisallowed];

  // Data-source MCP servers (stdio, per-run). When requested, attach the
  // email-mcp carrying THIS user's mail JWT via env — identity lives in the
  // token, so the agent can only ever reach the run owner's mailbox. The tool
  // names are added to the allow-list so the model may call them.
  const mcpToolNames: string[] = [];
  // Data-source MCPs: mount email-mcp and/or km-mcp, each carrying THIS run owner's
  // own credentials (mail JWT / 員編) so an agent can only ever reach the owner's
  // data — no cross-user access. Both can mount together.
  if (options.mcpEmailToken || options.mcpKmOnBehalf) {
    const mcpConfigPath = path.join(sandboxPath, '.mcp-servers.json');
    // Portable dev↔prod: prefer the COMPILED .js (production `tsc` build) run with
    // plain node — no tsx, no source .ts needed. Fall back to the TS source via the
    // tsx loader in dev. All paths derive from config.rootDir (runtime), so this
    // works on any machine — nothing is hard-coded to this box.
    //
    // WHY the tsx loader must be an ABSOLUTE file:// URL (not bare `--import tsx`):
    // ESM's --import resolution does NOT consult NODE_PATH, and the CLI spawns the MCP
    // with cwd=repo-root where pnpm has no top-level `tsx` → `ERR_MODULE_NOT_FOUND` →
    // the MCP never boots, no tools register, agents thrash on ToolSearch. The
    // absolute loader URL resolves from any cwd.
    // Detect dev↔prod from where THIS module is loaded (not a stale-dist heuristic):
    // tsx-watch dev → .../server/src/services/claudeCli.ts; compiled prod → .../dist/....
    const runningCompiled = import.meta.url.includes('/dist/');
    const tsxLoader = pathToFileURL(path.join(config.rootDir, 'server', 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
    const mcpSpawnArgs = (mcpName: string): string[] => {
      const distMcp = path.join(config.rootDir, 'server', 'dist', 'mcp', `${mcpName}.js`);
      const srcMcp = path.join(config.rootDir, 'server', 'src', 'mcp', `${mcpName}.ts`);
      return runningCompiled ? [distMcp] : ['--import', tsxLoader, srcMcp];
    };
    const nodePath = path.join(config.rootDir, 'server', 'node_modules');
    // Debug logs (the CLI swallows MCP stderr). Gated OFF in production unless
    // EMAIL_MCP_DEBUG is explicitly set.
    const debugEnv = (file: string) =>
      (config.nodeEnv !== 'production' || process.env.EMAIL_MCP_DEBUG)
        ? { MCP_DEBUG_LOG: path.join(config.workspaceRoot, file) }
        : {};

    const mcpServers: Record<string, any> = {};
    if (options.mcpEmailToken) {
      mcpServers.email = {
        command: process.execPath,             // absolute node binary — robust cross-platform
        args: mcpSpawnArgs('emailMcp'),
        env: {
          NODE_PATH: nodePath,
          MCP_MAIL_TOKEN: options.mcpEmailToken,
          MCP_MAIL_API_BASE: config.adApiUrl,
          MCP_MAIL_API_KEY: config.adApiKey,
          ...debugEnv('email-mcp-debug.log'),
        },
      };
      mcpToolNames.push(
        'mcp__email__email_list_folders',
        'mcp__email__email_search',
        'mcp__email__email_get_message',
        'mcp__email__email_get_attachments',
      );
    }
    if (options.mcpKmOnBehalf) {
      mcpServers.km = {
        command: process.execPath,
        args: mcpSpawnArgs('kmMcp'),
        env: {
          NODE_PATH: nodePath,
          KM_API_BASE: config.kmApiBase,
          KM_API_KEY: config.kmApiKey,
          KM_ON_BEHALF: options.mcpKmOnBehalf,
          ...debugEnv('km-mcp-debug.log'),
        },
      };
      mcpToolNames.push(
        'mcp__km__km_search',
        'mcp__km__km_get_document',
        'mcp__km__km_get_attachment',
      );
    }
    fs.writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers }), 'utf-8');
    // --strict-mcp-config: use ONLY our config, ignore any global MCP servers.
    args.push('--mcp-config', mcpConfigPath, '--strict-mcp-config');
    // Reliability (verified): disable ONLY Task when MCP tools are attached — NOT
    // ToolSearch. This CLI puts MCP tools in a DEFERRED pool the model loads via
    // ToolSearch ("I'll load the tools" → ToolSearch → call), so ToolSearch is
    // REQUIRED; disabling it leaves the model unable to reach the tools. Task IS
    // disabled because the worker otherwise delegates the lookup to a fresh sub-agent
    // that has no mcp-config → it reports "no tools". Removing Task forces the agent
    // to load+call the data-source tools itself.
    if (!disallowedTools.includes('Task')) disallowedTools = [...disallowedTools, 'Task'];
  }

  // Tool restrictions (security layer 2)
  const finalAllowedTools = [...allowedTools, ...mcpToolNames];
  if (finalAllowedTools.length > 0) {
    args.push('--allowedTools', finalAllowedTools.join(','));
  }
  args.push('--disallowedTools', disallowedTools.join(','));

  // Permission mode: this is a fully-automated backend — there is no human to
  // approve permission prompts. "dontAsk" auto-DENIES anything not covered by the
  // allow list instead of surfacing an interactive "ask" (which, in headless mode,
  // the model otherwise hallucinates into a fake "press Allow" dialog and leaks
  // internal structure to the end user). Allowed tools still run; the deny list
  // (--disallowedTools) is still enforced. Combined with EXECUTION_RULES in the
  // system prompt, this keeps all permission handling strictly internal.
  args.push('--permission-mode', 'dontAsk');

  // Turn cap: an explicit maxTurns wins (e.g. bounded WebSearch for team
  // members); otherwise routers are limited to a single analyze-and-delegate turn.
  if (typeof options.maxTurns === 'number' && options.maxTurns > 0) {
    args.push('--max-turns', String(options.maxTurns));
  } else if (options.role === 'router') {
    args.push('--max-turns', '1');
  }

  // Resolve the actual Claude CLI script path to avoid shell:true issues on Windows
  // npm global installs create .cmd wrappers that can break under concurrently/tsx
  const resolvedCmd = resolveClaudeCliPath(config.claudeCliPath);

  const logRole = options.role || 'worker';
  const logSkill = options.skillId || 'unknown';

  // Mutable reference so abort() always targets the active process
  let currentProc: ChildProcess | null = null;
  // Session-plumbing recovery is allowed once per spawnClaude call (see close
  // handler): a GC-ed --resume target or a colliding --session-id gets one clean
  // restart with a fresh session before we ever consider failing / API fallback.
  let sessionRecoveryAttempted = false;
  // Set by abort(): if a spawn is still queued at the auth gate when the caller
  // aborts, we must NOT spawn it afterwards (it would run orphaned/unmonitored).
  let aborted = false;

  /**
   * Inner spawn function — called once normally, and optionally again with a fresh
   * session (session-plumbing recovery) or API-key auth (quota fallback).
   *
   * Acquires an AUTH-PHASE slot first (claudeAuthGate): only a limited number of
   * CLIs may be in their startup/token-refresh window at once, which kills the
   * OAuth refresh race (#1/#2). The slot is released the instant the CLI emits its
   * first output (auth done, token persisted) or after AUTH_WARMUP_TIMEOUT_MS.
   */
  async function doSpawn(useApiKey: boolean, spawnReason: string = 'primary') {
    const authRelease = await acquireAuthSlot();
    // The caller may have aborted while we waited in the auth queue — bail before
    // spawning so we never leave an orphaned, unmonitored CLI running.
    if (aborted) { try { authRelease(); } catch { /* ignore */ } return; }
    let authReleased = false;
    const releaseAuth = () => {
      if (authReleased) return;
      authReleased = true;
      clearTimeout(authTimer);
      try { authRelease(); } catch { /* ignore */ }
    };
    const authTimer = setTimeout(releaseAuth, AUTH_WARMUP_TIMEOUT_MS);

    // Clean environment to prevent nested Claude session detection
    // Remove Claude-related AND Anthropic API key vars (control auth explicitly)
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.toUpperCase().startsWith('CLAUDE') || key === 'ANTHROPIC_API_KEY') {
        delete cleanEnv[key];
      }
    }
    // CRITICAL for MCP reliability: MCP_CONNECTION_NONBLOCKING (inherited from the
    // parent Claude Code env) makes the CLI START THE AGENT BEFORE the MCP server
    // finishes connecting — a race where email-mcp's tools aren't registered yet, so
    // the agent burns turns on ToolSearch, finds nothing, and gives up ("no mailbox
    // tools" / "only recent 20"). Removing it forces the CLI to WAIT for the MCP
    // handshake, so the email tools are always registered before the agent runs.
    delete cleanEnv['MCP_CONNECTION_NONBLOCKING'];

    // API key fallback mode: inject ANTHROPIC_API_KEY for CLI to use
    if (useApiKey && config.anthropicApiKey) {
      cleanEnv['ANTHROPIC_API_KEY'] = config.anthropicApiKey;
    }

    const modeLabel = useApiKey ? '(API Key fallback)' : '(account)';
    console.log(`[Claude CLI] Spawning ${logRole}/${logSkill} ${modeLabel} for conversation ${options.conversationId} (cwd: ${sandboxPath})`);
    // Verbose tool/arg dump (which may contain prompt fragments) only in
    // development; production logs stay terse to avoid data exposure if shipped.
    if (config.nodeEnv !== 'production') {
      console.log(`[Claude CLI]   allowedTools: ${finalAllowedTools.join(',')}`);
      console.log(`[Claude CLI]   args: ${args.join(' ')}`);
    }

    let proc: ChildProcess;
    try {
      proc = spawn(resolvedCmd.bin, [...resolvedCmd.prefix, ...args], {
        cwd: sandboxPath,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cleanEnv,
      });
    } catch (error) {
      releaseAuth();
      console.error('[Claude CLI] Spawn failed:', error);
      emitter.emit('event', {
        type: 'error',
        data: `Failed to spawn Claude CLI: ${error}`,
      } satisfies SSEEvent);
      emitter.emit('event', {
        type: 'done',
        data: { exitCode: 1 },
      } satisfies SSEEvent);
      return;
    }

    currentProc = proc;

    // Write user message to stdin. With images, use a stream-json user message
    // carrying the prompt text plus the image attachments as base64 blocks.
    if (hasImages) {
      const payload = JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: message },
            ...options.images!.map(im => ({ type: 'image', source: { type: 'base64', media_type: im.media_type, data: im.data } })),
          ],
        },
      }) + '\n';
      proc.stdin!.write(payload);
    } else {
      proc.stdin!.write(message);
    }
    proc.stdin!.end();

    // Accumulated token counts (per-attempt)
    let inputTokens = 0;
    let outputTokens = 0;
    let model = '';
    let stdoutBuffer = '';
    // Bounded tail of raw stdout (last 4KB). Some CLI versions report a usage-limit
    // hit via a stream-json result on STDOUT (not stderr); we scan this in the close
    // handler so the API-key overflow fires on 5-hour-limit errors wherever they land.
    let stdoutTail = '';
    // Output ceiling: a stuck agent (model in a loop / tool thrashing) can stream
    // output for its whole timeout (pptx timeout is 15 min), and the accumulation
    // downstream grows memory the whole time. Abort as runaway once total stdout
    // exceeds a ceiling far above any legit generation. Tune with AI_MAX_OUTPUT_BYTES.
    let stdoutBytes = 0;
    let killedForOutput = false;
    const MAX_OUTPUT_BYTES = Math.max(1_000_000, parseInt(process.env.AI_MAX_OUTPUT_BYTES || '', 10) || 8 * 1024 * 1024);

    // Shared token accumulator state (persists across processStreamEvent calls)
    const tokenState: TokenAccumulator = {
      getInputTokens: () => inputTokens,
      getOutputTokens: () => outputTokens,
      addInputTokens: (n: number) => { inputTokens += n; },
      addOutputTokens: (n: number) => { outputTokens += n; },
      setModel: (m: string) => { model = m; },
      hasStreamedText: false,
    };

    // Parse stream-json output line by line
    proc.stdout!.on('data', (data: Buffer) => {
      // First output = auth succeeded and the (possibly refreshed) token is now
      // persisted. Release the auth gate so the next queued spawn reuses the warm
      // token instead of racing its own refresh.
      releaseAuth();
      if (killedForOutput) return;
      const chunk = data.toString();
      stdoutTail += chunk;
      if (stdoutTail.length > 4096) stdoutTail = stdoutTail.slice(-4096);
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        killedForOutput = true;
        console.error(`[Claude CLI] ${logRole}/${logSkill} output exceeded ${MAX_OUTPUT_BYTES} bytes — aborting as runaway (likely stuck in a loop)`);
        emitter.emit('event', { type: 'error', data: 'AI 產生異常（輸出過長，可能陷入迴圈），已自動中止。' } satisfies SSEEvent);
        try {
          if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { shell: true });
          else proc.kill('SIGKILL');
        } catch { /* ignore */ }
        return;
      }
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split('\n');
      stdoutBuffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          processStreamEvent(parsed, emitter, tokenState);
        } catch {
          // Skip malformed JSON lines
        }
      }
    });

    // Capture stderr for debugging — but BOUNDED. With --verbose a long-running or
    // concurrent CLI can emit huge amounts of stderr; the old unbounded `+=` grew
    // this string for the whole process lifetime, and every line was logged. Under
    // many concurrent heavy agents that accumulation (buffer + log volume) was a
    // real memory leak. Keep only the last 16KB (enough for error detection/display)
    // and stop per-line logging once we've logged ~16KB for this process.
    const MAX_STDERR = 16 * 1024;
    let stderrBuffer = '';
    let stderrLogged = 0;
    proc.stderr!.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderrBuffer += chunk;
      if (stderrBuffer.length > MAX_STDERR) stderrBuffer = stderrBuffer.slice(-MAX_STDERR);
      if (stderrLogged < MAX_STDERR) {
        console.error(`[Claude CLI stderr] ${chunk.trim()}`);
        stderrLogged += chunk.length;
      }
    });

    // Process close — fires AFTER all stdio streams are drained (exit fires earlier,
    // potentially before stdout data is fully read, causing data loss race condition)
    proc.on('close', (code) => {
      releaseAuth(); // safety: never leave the auth gate held after the process ends
      // Process any remaining buffered stdout data
      if (stdoutBuffer.trim()) {
        try {
          const parsed = JSON.parse(stdoutBuffer);
          processStreamEvent(parsed, emitter, tokenState);
        } catch { /* partial line, ignore */ }
      }
      console.log(`[Claude CLI] ${logRole}/${logSkill} ${modeLabel} exited with code ${code}`);
      if (stderrBuffer) {
        console.error(`[Claude CLI] ${logRole}/${logSkill} stderr:\n${stderrBuffer.substring(0, 1000)}`);
      }

      // Ledger: record THIS spawn attempt — account vs api_key (ground truth from
      // useApiKey), which model, why it was spawned, and whether it produced output.
      // Logged for every attempt, so an account failure that retries on the API key
      // leaves two honest rows. Fire-and-forget; never affects the call.
      logAiCall({
        userId: options.userId,
        conversationId: options.conversationId,
        role: options.role || 'worker',
        skillId: options.skillId,
        model: model || null,
        authMode: useApiKey ? 'api_key' : 'account',
        reason: spawnReason,
        inputTokens,
        outputTokens,
        exitCode: code,
        success: inputTokens > 0,
      });

      // --- Session-plumbing recovery (before any fallback) ---
      // Two transient session errors show up under concurrency, and neither is a
      // real failure — they should restart cleanly rather than fail or bill the API:
      //   #3 "No conversation found with session ID" — a --resume target session was
      //      garbage-collected / never flushed by the CLI.
      //   #4 "Session ID already in use" — a --session-id collided with a still-live
      //      session from a racing/retrying spawn.
      // Recover ONCE: drop --resume, start a brand-new --session-id, and tell the
      // caller the new id so it can repoint its stored session.
      if (!killedForOutput && code !== 0 && !inputTokens && !sessionRecoveryAttempted) {
        const s = stderrBuffer.toLowerCase();
        // Strings verified against the real CLI (v2.1.201): #3 emits exactly
        // "No conversation found with session ID: <id>". #4's "already in use" could
        // not be reproduced locally, so the match is kept broad to catch the
        // production wording ("Session ID already in use") and any close variant —
        // a false positive only costs one harmless fresh-session restart.
        const resumeGone = /no conversation found with session id/.test(s);
        const idInUse = /already in use/.test(s);
        if (resumeGone || idInUse) {
          sessionRecoveryAttempted = true;
          const freshId = randomUUID();
          const rIdx = args.indexOf('--resume');
          if (rIdx !== -1) args.splice(rIdx, 2); // drop "--resume <id>"
          const sidIdx = args.indexOf('--session-id');
          if (sidIdx !== -1) args[sidIdx + 1] = freshId;
          else args.push('--session-id', freshId);
          console.log(`[Claude CLI] ${logRole}/${logSkill} session error (${resumeGone ? 'resume target GC-ed' : 'id already in use'}) — restarting with fresh session ${freshId}`);
          // Let the orchestrator persist the new id so future turns resume the right one.
          emitter.emit('event', { type: 'session_id', data: freshId } satisfies SSEEvent);
          void doSpawn(useApiKey, `session-recovery:${resumeGone ? 'resume-gone' : 'id-in-use'}`);
          return;
        }
      }

      // --- API Key Fallback ---
      // The account OAuth token can expire or hit a refresh race during concurrent
      // multi-agent spawns, killing the process with exit!=0 and little/no output.
      // Whenever an account-auth attempt fails completely (non-zero exit, produced
      // zero tokens) and an API key is configured, transparently retry once with the
      // API key — it has no token-expiry/refresh failure mode. This covers quota
      // limits, auth/token blips, and silent (empty-stderr) crashes alike.
      // Suppress error/usage/done for this failed attempt; the retry will emit them.
      // API-key fallback policy (see config.apiKeyFallbackQuotaOnly). By default we
      // overflow to the paid API ONLY when the account genuinely hit its rate/usage
      // limit (5-hour window or monthly cap). We deliberately do NOT mask auth
      // failures (logged-out account) or silent no-output blips with paid Opus calls:
      // that broad fallback is exactly what silently ran up the bill AND hid a
      // logged-out production account for weeks. Those now fail visibly so they get
      // fixed at the source. Set API_KEY_FALLBACK_QUOTA_ONLY=false for the old behavior.
      if (!killedForOutput && !useApiKey && code !== 0 && !inputTokens && config.anthropicApiKey) {
        const quotaHit = isQuotaLimitError(stderrBuffer) || isQuotaLimitError(stdoutTail);
        const shouldFallback = quotaHit || !config.apiKeyFallbackQuotaOnly;
        if (shouldFallback) {
          const reason = quotaHit ? 'account rate/usage limit hit' : 'account failure (broad fallback enabled)';
          console.log(`[Claude CLI] ${logRole}/${logSkill} ${reason}, overflowing to API key...`);
          // The failed attempt may have already registered its --session-id with the
          // CLI (session file written before it died), so reusing it on retry throws
          // "Session ID <id> is already in use" — which is exactly what happens when
          // several agents spawn at once (e.g. running multiple schedules). For a
          // NEW-session spawn, swap in a fresh id; a --resume must keep its id.
          const sidIdx = args.indexOf('--session-id');
          if (sidIdx !== -1 && args[sidIdx + 1]) args[sidIdx + 1] = randomUUID();
          void doSpawn(true, reason);
          return;
        }
        // Not a quota case — do NOT bill the paid API. Log loudly so a logged-out /
        // broken account is visible in the logs instead of silently masked.
        const why = isAuthError(stderrBuffer)
          ? 'account auth/token failure (login likely broken — NOT masking with paid API)'
          : 'no-output failure (NOT masking with paid API; likely OAuth blip or account issue)';
        console.warn(`[Claude CLI] ${logRole}/${logSkill} ${why}`);
      }

      if (!killedForOutput && code !== 0 && !inputTokens) {
        console.error(`[Claude CLI] ${logRole}/${logSkill} FAILED: code=${code}, inputTokens=0, stderr=${stderrBuffer.substring(0, 500)}`);
        const fallback = 'AI 處理程序發生非預期錯誤，請稍後再試。';
        emitter.emit('event', {
          type: 'error',
          data: humanizeClaudeError(stderrBuffer) || fallback,
        } satisfies SSEEvent);
      }

      // Emit final usage
      emitter.emit('event', {
        type: 'usage',
        data: { inputTokens, outputTokens, model },
      } satisfies SSEEvent);

      // Emit done
      emitter.emit('event', {
        type: 'done',
        data: { exitCode: code, stderr: stderrBuffer || undefined },
      } satisfies SSEEvent);
    });

    proc.on('error', (error) => {
      releaseAuth(); // safety: release the auth gate if the process errors out
      console.error('[Claude CLI] Process error:', error);
      emitter.emit('event', {
        type: 'error',
        data: humanizeClaudeError(error.message) || `AI 處理程序發生錯誤，請稍後再試。`,
      } satisfies SSEEvent);
      emitter.emit('event', {
        type: 'done',
        data: { exitCode: 1 },
      } satisfies SSEEvent);
    });
  }

  // Start first attempt with account auth (or forced API key if explicitly set)
  void doSpawn(options.useApiKey || false, options.useApiKey ? 'forced-api-key' : 'primary');

  return {
    emitter,
    abort: () => {
      aborted = true;
      try {
        if (currentProc) {
          if (process.platform === 'win32') {
            spawn('taskkill', ['/pid', String(currentProc.pid), '/f', '/t'], { shell: true });
          } else {
            currentProc.kill('SIGTERM');
          }
        }
      } catch { /* ignore */ }
    },
    sessionId: options.sessionId,
  };
}

interface TokenAccumulator {
  getInputTokens: () => number;
  getOutputTokens: () => number;
  addInputTokens: (n: number) => void;
  addOutputTokens: (n: number) => void;
  setModel: (m: string) => void;
  hasStreamedText: boolean; // True if text was streamed via content_block_delta (avoid duplication)
}

/**
 * Process a single stream-json event from Claude CLI.
 */
function processStreamEvent(
  parsed: Record<string, unknown>,
  emitter: EventEmitter,
  tokens: TokenAccumulator,
): void {
  const type = parsed.type as string;

  // Content block start — detect tool_use early for real-time tracking
  if (type === 'content_block_start') {
    const block = parsed.content_block as Record<string, unknown> | undefined;
    if (block?.type === 'tool_use') {
      emitter.emit('event', {
        type: 'tool_activity',
        data: {
          tool: block.name as string,
          id: block.id as string,
          status: 'running',
        },
      } satisfies SSEEvent);
    }
  }

  // Text content streaming (content_block_delta — real-time streaming chunks)
  if (type === 'content_block_delta') {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && delta.text) {
      const rawDelta = delta.text as string;
      const translated = humanizeClaudeError(rawDelta);
      const safeText = sanitizeOutput(translated || rawDelta);
      tokens.hasStreamedText = true; // Mark that we received streaming text
      emitter.emit('event', {
        type: translated ? 'error' : 'text',
        data: safeText,
      } satisfies SSEEvent);
    }
    if (delta?.type === 'thinking_delta' && delta.thinking) {
      emitter.emit('event', {
        type: 'thinking',
        data: delta.thinking,
      } satisfies SSEEvent);
    }
  }

  // Assistant message — mark previous tools completed, extract text + new tool use
  // NOTE: Only emit text from assistant if we didn't already stream it via content_block_delta,
  // to avoid duplicating responseText in callers that accumulate text events.
  if (type === 'assistant') {
    // Signal: all previously running tools have completed (Claude got their results)
    emitter.emit('event', {
      type: 'tool_activity',
      data: { tool: '_mark_completed', status: 'completed' },
    } satisfies SSEEvent);

    const message = parsed.message as Record<string, unknown> | undefined;
    // The real CLI carries the model on the assistant message (not always on the
    // final 'result'), so capture it here to avoid null models in the ledger.
    if (message?.model) tokens.setModel(message.model as string);
    const content = message?.content as Array<Record<string, unknown>> | undefined;
    if (content) {
      for (const block of content) {
        if (block.type === 'text' && block.text && !tokens.hasStreamedText) {
          // Only emit if text wasn't already streamed via content_block_delta
          const rawText = block.text as string;
          const translated = humanizeClaudeError(rawText);
          const safeText = sanitizeOutput(translated || rawText);
          emitter.emit('event', {
            type: translated ? 'error' : 'text',
            data: safeText,
          } satisfies SSEEvent);
        }
        if (block.type === 'tool_use') {
          emitter.emit('event', {
            type: 'tool_activity',
            data: {
              tool: block.name as string,
              id: block.id as string,
              status: 'running',
              input: block.input ? JSON.stringify(block.input).substring(0, 800) : undefined,
            },
          } satisfies SSEEvent);
        }
      }
    }
  }

  // Tool result (multiple formats)
  if (type === 'result' && parsed.subtype === 'tool_result') {
    const toolUseId = parsed.tool_use_id as string | undefined;
    emitter.emit('event', {
      type: 'tool_activity',
      data: {
        tool: 'tool_result',
        id: toolUseId,
        status: 'completed',
      },
    } satisfies SSEEvent);
  }

  // System init — capture session_id and the model in effect for this run
  if (type === 'system' && parsed.subtype === 'init') {
    const sid = parsed.session_id as string | undefined;
    if (sid) {
      emitter.emit('event', {
        type: 'session_id',
        data: sid,
      } satisfies SSEEvent);
    }
    if (parsed.model) tokens.setModel(parsed.model as string);
  }

  // Result message — only extract usage/model/session_id, NOT text
  // Text is already emitted from the 'assistant' event above.
  // The 'result' event's parsed.result contains the same text (duplicate).
  if (type === 'result') {
    const usage = parsed.usage as Record<string, number> | undefined;
    if (usage) {
      tokens.addInputTokens(usage.input_tokens || 0);
      tokens.addOutputTokens(usage.output_tokens || 0);
    }

    const modelStr = parsed.model as string | undefined;
    if (modelStr) tokens.setModel(modelStr);

    // Capture session_id from result
    const sid = parsed.session_id as string | undefined;
    if (sid) {
      emitter.emit('event', {
        type: 'session_id',
        data: sid,
      } satisfies SSEEvent);
    }
  }

  // Message start with usage info
  if (type === 'message_start') {
    const message = parsed.message as Record<string, unknown> | undefined;
    const usage = message?.usage as Record<string, number> | undefined;
    if (usage) {
      tokens.addInputTokens(usage.input_tokens || 0);
    }
    const modelStr = message?.model as string | undefined;
    if (modelStr) tokens.setModel(modelStr);
  }

  // Message delta with output token count
  if (type === 'message_delta') {
    const usage = parsed.usage as Record<string, number> | undefined;
    if (usage) {
      tokens.addOutputTokens(usage.output_tokens || 0);
    }
  }
}
