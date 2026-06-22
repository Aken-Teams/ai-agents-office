import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getSandboxPath } from './sandbox.js';
import { resolveClaudeCliPath } from './resolveClaudeCli.js';
import type { SSEEvent } from '../types.js';

/**
 * Translate known Claude CLI error messages to user-friendly Chinese.
 * Returns translated string if matched, null otherwise.
 */
function humanizeClaudeError(text: string): string | null {
  const t = text.trim();

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
  if (/you[''\u2019]ve hit your limit/i.test(text)) return true;
  if (/rate.?limit|too many requests|429/i.test(text) && text.length < 500) return true;
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
  const disallowedTools = options.customDisallowedTools
    ? [...new Set([...baseDisallowed, ...options.customDisallowedTools])]
    : baseDisallowed;

  // Tool restrictions (security layer 2)
  if (allowedTools.length > 0) {
    args.push('--allowedTools', allowedTools.join(','));
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

  /**
   * Inner spawn function — called once normally, and optionally a second time
   * with API key authentication if the first attempt hits account quota limits.
   */
  function doSpawn(useApiKey: boolean) {
    // Clean environment to prevent nested Claude session detection
    // Remove Claude-related AND Anthropic API key vars (control auth explicitly)
    const cleanEnv = { ...process.env };
    for (const key of Object.keys(cleanEnv)) {
      if (key.toUpperCase().startsWith('CLAUDE') || key === 'ANTHROPIC_API_KEY') {
        delete cleanEnv[key];
      }
    }

    // API key fallback mode: inject ANTHROPIC_API_KEY for CLI to use
    if (useApiKey && config.anthropicApiKey) {
      cleanEnv['ANTHROPIC_API_KEY'] = config.anthropicApiKey;
    }

    const modeLabel = useApiKey ? '(API Key fallback)' : '(account)';
    console.log(`[Claude CLI] Spawning ${logRole}/${logSkill} ${modeLabel} for conversation ${options.conversationId} (cwd: ${sandboxPath})`);
    // Verbose tool/arg dump (which may contain prompt fragments) only in
    // development; production logs stay terse to avoid data exposure if shipped.
    if (config.nodeEnv !== 'production') {
      console.log(`[Claude CLI]   allowedTools: ${allowedTools.join(',')}`);
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
      const chunk = data.toString();
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

    // Capture stderr for debugging
    let stderrBuffer = '';
    proc.stderr!.on('data', (data: Buffer) => {
      const chunk = data.toString();
      stderrBuffer += chunk;
      console.error(`[Claude CLI stderr] ${chunk.trim()}`);
    });

    // Process close — fires AFTER all stdio streams are drained (exit fires earlier,
    // potentially before stdout data is fully read, causing data loss race condition)
    proc.on('close', (code) => {
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

      // --- API Key Fallback ---
      // The account OAuth token can expire or hit a refresh race during concurrent
      // multi-agent spawns, killing the process with exit!=0 and little/no output.
      // Whenever an account-auth attempt fails completely (non-zero exit, produced
      // zero tokens) and an API key is configured, transparently retry once with the
      // API key — it has no token-expiry/refresh failure mode. This covers quota
      // limits, auth/token blips, and silent (empty-stderr) crashes alike.
      // Suppress error/usage/done for this failed attempt; the retry will emit them.
      if (!useApiKey && code !== 0 && !inputTokens && config.anthropicApiKey) {
        const reason = isQuotaLimitError(stderrBuffer)
          ? 'account quota exhausted'
          : isAuthError(stderrBuffer)
            ? 'account auth/token failure'
            : 'no-output failure (likely OAuth token refresh blip)';
        console.log(`[Claude CLI] ${logRole}/${logSkill} ${reason}, retrying with API key...`);
        doSpawn(true);
        return;
      }

      if (code !== 0 && !inputTokens) {
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
  doSpawn(options.useApiKey || false);

  return {
    emitter,
    abort: () => {
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

  // System init — capture session_id
  if (type === 'system' && parsed.subtype === 'init') {
    const sid = parsed.session_id as string | undefined;
    if (sid) {
      emitter.emit('event', {
        type: 'session_id',
        data: sid,
      } satisfies SSEEvent);
    }
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
