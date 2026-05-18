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

  // Router: limit to 1 turn (no tool loops, just analyze and delegate)
  if (options.role === 'router') {
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
    console.log(`[Claude CLI]   allowedTools: ${allowedTools.join(',')}`);
    console.log(`[Claude CLI]   args: ${args.join(' ')}`);

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

    // Write user message to stdin
    proc.stdin!.write(message);
    proc.stdin!.end();

    // Accumulated token counts (per-attempt)
    let inputTokens = 0;
    let outputTokens = 0;
    let model = '';
    let stdoutBuffer = '';

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
          processStreamEvent(parsed, emitter, {
            getInputTokens: () => inputTokens,
            getOutputTokens: () => outputTokens,
            addInputTokens: (n: number) => { inputTokens += n; },
            addOutputTokens: (n: number) => { outputTokens += n; },
            setModel: (m: string) => { model = m; },
          });
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

    // Process exit
    proc.on('exit', (code) => {
      console.log(`[Claude CLI] ${logRole}/${logSkill} ${modeLabel} exited with code ${code}`);
      if (stderrBuffer) {
        console.error(`[Claude CLI] ${logRole}/${logSkill} stderr:\n${stderrBuffer.substring(0, 1000)}`);
      }

      // --- API Key Fallback ---
      // If account quota hit (no output produced) and API key is available, retry transparently.
      // Suppress error/usage/done for this failed attempt; the retry will emit them.
      if (!useApiKey && code !== 0 && !inputTokens
          && isQuotaLimitError(stderrBuffer) && config.anthropicApiKey) {
        console.log(`[Claude CLI] Account quota exhausted for ${logRole}/${logSkill}, retrying with API key...`);
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

  // Text content streaming (content_block_delta — may appear for long responses)
  if (type === 'content_block_delta') {
    const delta = parsed.delta as Record<string, unknown> | undefined;
    if (delta?.type === 'text_delta' && delta.text) {
      const rawDelta = delta.text as string;
      const translated = humanizeClaudeError(rawDelta);
      emitter.emit('event', {
        type: translated ? 'error' : 'text',
        data: translated || rawDelta,
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
        if (block.type === 'text' && block.text) {
          const rawText = block.text as string;
          const translated = humanizeClaudeError(rawText);
          emitter.emit('event', {
            type: translated ? 'error' : 'text',
            data: translated || rawText,
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
