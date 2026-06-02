import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getSandboxPath } from './sandbox.js';
import type { ClaudeCliOptions } from './claudeCli.js';
import type { SSEEvent } from '../types.js';

/**
 * Codex CLI (OpenAI) engine — a drop-in alternative to spawnClaude.
 *
 * It takes the SAME options shape and emits the SAME SSE event protocol
 * ('text' | 'tool_activity' | 'usage' | 'session_id' | 'error' | 'done'),
 * so the orchestrator can swap engines with a single config flag.
 *
 * Mapping from the Claude engine:
 *   - System prompt → written as AGENTS.md in the sandbox dir (Codex reads it
 *     automatically, the way the Claude engine uses CLAUDE.md).
 *   - Per-tool allow/deny lists have no Codex equivalent; instead the role maps
 *     to a Codex sandbox policy (router → read-only, worker → workspace-write).
 *   - Session continuity uses Codex thread ids: the first run reports its
 *     thread id via a `session_id` event (which the orchestrator persists), and
 *     resumes run `codex exec resume <thread_id>`.
 *
 * Requires the host to be authenticated (`codex login`, or CODEX_HOME with
 * stored credentials). Without auth, Codex emits `turn.failed` (401) which is
 * surfaced as an error event.
 */

type CodexCliOptions = ClaudeCliOptions;

interface CodexResult {
  emitter: EventEmitter;
  abort: () => void;
  sessionId: string | undefined;
}

// Codex item types that represent tool/command activity (vs. plain messages).
const TOOL_ITEM_TYPES = new Set([
  'command_execution', 'file_change', 'mcp_tool_call', 'web_search', 'patch_apply',
]);

export function spawnCodex(
  message: string,
  systemPrompt: string,
  options: CodexCliOptions,
): CodexResult {
  const emitter = new EventEmitter();
  const baseSandboxPath = getSandboxPath(options.userId, options.conversationId);
  const sandboxPath = options.sandboxSubdir
    ? path.join(baseSandboxPath, options.sandboxSubdir)
    : baseSandboxPath;

  fs.mkdirSync(sandboxPath, { recursive: true });

  // Codex reads AGENTS.md from the working directory as project instructions.
  fs.writeFileSync(path.join(sandboxPath, 'AGENTS.md'), systemPrompt, 'utf-8');

  // Router only analyzes/delegates → read-only; workers generate files.
  const sandboxMode = options.role === 'router'
    ? 'read-only'
    : (config.codexCli.sandbox || 'workspace-write');

  const resuming = Boolean(options.isResume && options.sessionId);

  const args: string[] = ['exec'];
  if (resuming) {
    // `resume` accepts neither -s nor -C; set the sandbox via a config override
    // and rely on the spawn cwd (below) for the working root.
    args.push('resume', '-c', `sandbox_mode="${sandboxMode}"`);
  } else {
    args.push('-s', sandboxMode, '-C', sandboxPath);
  }
  args.push('--json', '--skip-git-repo-check');
  if (config.codexCli.model) args.push('-m', config.codexCli.model);
  if (resuming) args.push(options.sessionId!);  // positional SESSION_ID
  args.push('-');                                // PROMPT from stdin

  const cleanEnv = { ...process.env };
  if (config.codexCli.home) cleanEnv.CODEX_HOME = config.codexCli.home;

  const logRole = options.role || 'worker';
  const logSkill = options.skillId || 'unknown';
  console.log(`[Codex CLI] Spawning ${logRole}/${logSkill} for conversation ${options.conversationId} (cwd: ${sandboxPath}, sandbox: ${sandboxMode}, resume: ${resuming})`);
  console.log(`[Codex CLI]   args: ${args.join(' ')}`);

  let proc: ChildProcess;
  try {
    proc = spawn(config.codexCli.path, args, {
      cwd: sandboxPath,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv,
    });
  } catch (error) {
    console.error('[Codex CLI] Spawn failed:', error);
    emitter.emit('event', { type: 'error', data: `Failed to spawn Codex CLI: ${error}` } satisfies SSEEvent);
    emitter.emit('event', { type: 'done', data: { exitCode: 1 } } satisfies SSEEvent);
    return { emitter, abort: () => {}, sessionId: options.sessionId };
  }

  proc.stdin!.write(message);
  proc.stdin!.end();

  let inputTokens = 0;
  let outputTokens = 0;
  let model = config.codexCli.model || 'codex';
  let stdoutBuffer = '';

  proc.stdout!.on('data', (data: Buffer) => {
    stdoutBuffer += data.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        processCodexEvent(parsed, emitter, {
          addInputTokens: (n) => { inputTokens += n; },
          addOutputTokens: (n) => { outputTokens += n; },
        });
      } catch {
        // Codex interleaves non-JSON log lines on stdout/stderr — skip them.
      }
    }
  });

  let stderrBuffer = '';
  proc.stderr!.on('data', (data: Buffer) => {
    const chunk = data.toString();
    stderrBuffer += chunk;
    console.error(`[Codex CLI stderr] ${chunk.trim()}`);
  });

  proc.on('exit', (code) => {
    console.log(`[Codex CLI] ${logRole}/${logSkill} exited with code ${code}`);
    if (code !== 0 && !outputTokens) {
      emitter.emit('event', {
        type: 'error',
        data: `Codex CLI exited with code ${code}. ${stderrBuffer.substring(0, 500) || 'No error details.'}`,
      } satisfies SSEEvent);
    }
    emitter.emit('event', { type: 'usage', data: { inputTokens, outputTokens, model } } satisfies SSEEvent);
    emitter.emit('event', { type: 'done', data: { exitCode: code, stderr: stderrBuffer || undefined } } satisfies SSEEvent);
  });

  proc.on('error', (error) => {
    console.error('[Codex CLI] Process error:', error);
    emitter.emit('event', { type: 'error', data: `Codex CLI process error: ${error.message}` } satisfies SSEEvent);
    emitter.emit('event', { type: 'done', data: { exitCode: 1 } } satisfies SSEEvent);
  });

  return {
    emitter,
    abort: () => {
      try {
        if (process.platform === 'win32') {
          spawn('taskkill', ['/pid', String(proc.pid), '/f', '/t'], { shell: true });
        } else {
          proc.kill('SIGTERM');
        }
      } catch { /* ignore */ }
    },
    sessionId: options.sessionId,
  };
}

interface CodexTokenSink {
  addInputTokens: (n: number) => void;
  addOutputTokens: (n: number) => void;
}

/**
 * Translate one Codex `exec --json` thread event into the shared SSE protocol.
 * Codex event shapes (codex-cli 0.x):
 *   {type:'thread.started', thread_id}
 *   {type:'item.started'|'item.updated'|'item.completed', item:{type, text, ...}}
 *   {type:'turn.completed', usage:{input_tokens, output_tokens, cached_input_tokens}}
 *   {type:'turn.failed', error:{message}}  /  {type:'error', message}
 */
function processCodexEvent(
  parsed: Record<string, unknown>,
  emitter: EventEmitter,
  tokens: CodexTokenSink,
): void {
  const type = parsed.type as string | undefined;

  if (type === 'thread.started') {
    const tid = parsed.thread_id as string | undefined;
    if (tid) emitter.emit('event', { type: 'session_id', data: tid } satisfies SSEEvent);
    return;
  }

  if (type === 'item.started' || type === 'item.updated' || type === 'item.completed') {
    const item = parsed.item as Record<string, unknown> | undefined;
    const itemType = item?.type as string | undefined;
    if (!item || !itemType) return;

    // Assistant text — emit once, on completion, to avoid duplicating partials.
    if (itemType === 'agent_message') {
      if (type === 'item.completed' && typeof item.text === 'string' && item.text) {
        emitter.emit('event', { type: 'text', data: item.text } satisfies SSEEvent);
      }
      return;
    }

    // Model reasoning → thinking stream (best effort; not all builds emit text).
    if (itemType === 'reasoning') {
      if (type === 'item.completed' && typeof item.text === 'string' && item.text) {
        emitter.emit('event', { type: 'thinking', data: item.text } satisfies SSEEvent);
      }
      return;
    }

    // Tool/command activity → tool_activity running/completed.
    if (TOOL_ITEM_TYPES.has(itemType)) {
      const status = type === 'item.completed' ? 'completed' : 'running';
      emitter.emit('event', {
        type: 'tool_activity',
        data: {
          tool: labelForCodexItem(itemType, item),
          id: typeof item.id === 'string' ? item.id : undefined,
          status,
        },
      } satisfies SSEEvent);
      return;
    }

    // Codex surfaces failures as an error item too.
    if (itemType === 'error' && type === 'item.completed') {
      const msg = typeof item.message === 'string' ? item.message : 'Codex item error';
      emitter.emit('event', { type: 'error', data: msg } satisfies SSEEvent);
    }
    return;
  }

  if (type === 'turn.completed') {
    const usage = parsed.usage as Record<string, number> | undefined;
    if (usage) {
      tokens.addInputTokens(usage.input_tokens || 0);
      tokens.addOutputTokens(usage.output_tokens || 0);
    }
    return;
  }

  if (type === 'turn.failed') {
    const err = parsed.error as Record<string, unknown> | undefined;
    const msg = (err && typeof err.message === 'string') ? err.message : 'Codex turn failed';
    emitter.emit('event', { type: 'error', data: msg } satisfies SSEEvent);
    return;
  }

  if (type === 'error') {
    const msg = typeof parsed.message === 'string' ? parsed.message : 'Codex error';
    emitter.emit('event', { type: 'error', data: msg } satisfies SSEEvent);
  }
}

/** Friendly label for a Codex tool/command item, for the UI activity feed. */
function labelForCodexItem(itemType: string, item: Record<string, unknown>): string {
  switch (itemType) {
    case 'command_execution': {
      const cmd = typeof item.command === 'string' ? item.command : '';
      return cmd ? `Bash(${cmd.slice(0, 60)})` : 'Bash';
    }
    case 'file_change':
    case 'patch_apply':
      return 'Write';
    case 'web_search':
      return 'WebSearch';
    case 'mcp_tool_call': {
      const tool = typeof item.tool === 'string' ? item.tool : (typeof item.name === 'string' ? item.name : '');
      return tool || 'mcp_tool';
    }
    default:
      return itemType;
  }
}
