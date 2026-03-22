import { spawn, execSync, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';
import { getSandboxPath } from './sandbox.js';
import type { SSEEvent } from '../types.js';

/**
 * Resolve the Claude CLI to a direct node invocation.
 * On Windows, npm global installs create .cmd wrappers that break under
 * concurrently/tsx process groups. We find the actual .js entry point
 * and invoke it with node directly (no shell needed).
 */
function resolveClaudeCliPath(cliPath: string): { bin: string; prefix: string[] } {
  // If user specified an absolute path to a .js file, use node directly
  if (cliPath.endsWith('.js')) {
    return { bin: process.execPath, prefix: [cliPath] };
  }

  // Try to find the actual CLI script from the npm global prefix
  try {
    const npmPrefix = execSync('npm prefix -g', { encoding: 'utf-8' }).trim();
    const cliScript = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
    if (fs.existsSync(cliScript)) {
      return { bin: process.execPath, prefix: [cliScript] };
    }
  } catch { /* fall through */ }

  // Fallback: try common Windows npm global paths
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const candidates = [
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(home, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return { bin: process.execPath, prefix: [candidate] };
    }
  }

  // Last resort: use shell (may not work under concurrently)
  console.warn('[Claude CLI] Could not resolve CLI script, falling back to shell invocation');
  return { bin: cliPath, prefix: [] };
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

// Router agents: minimal tools — no file access, no code execution
// Router only analyzes user requests and outputs [TASK] blocks
const ROUTER_ALLOWED_TOOLS = [
  'WebSearch',
  'WebFetch',
];

const ROUTER_DISALLOWED_TOOLS = [
  ...DISALLOWED_TOOLS,
  'Write',
  'Read',
  'Bash',
  'Glob',
  'Grep',
  'Task',
  'Edit',
];

/**
 * Spawn a Claude CLI process with sandbox restrictions.
 *
 * System prompt is written to CLAUDE.md in the sandbox directory,
 * which Claude CLI reads automatically. This avoids Windows command line
 * length limits and special character escaping issues.
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
  // Router agents get read-only tools; workers get full tool access
  const allowedTools = options.customAllowedTools
    || (options.role === 'router' ? ROUTER_ALLOWED_TOOLS : ALLOWED_TOOLS);
  const disallowedTools = options.customDisallowedTools
    || (options.role === 'router' ? ROUTER_DISALLOWED_TOOLS : DISALLOWED_TOOLS);

  // Tool restrictions (security layer 2)
  args.push('--allowedTools', allowedTools.join(','));
  args.push('--disallowedTools', disallowedTools.join(','));

  // Clean environment to prevent nested Claude session detection
  // Remove ALL Claude-related env vars (inherited from VSCode extension, etc.)
  const cleanEnv = { ...process.env };
  for (const key of Object.keys(cleanEnv)) {
    if (key.toUpperCase().startsWith('CLAUDE')) {
      delete cleanEnv[key];
    }
  }

  // Resolve the actual Claude CLI script path to avoid shell:true issues on Windows
  // npm global installs create .cmd wrappers that can break under concurrently/tsx
  const resolvedCmd = resolveClaudeCliPath(config.claudeCliPath);

  const logRole = options.role || 'worker';
  const logSkill = options.skillId || 'unknown';
  console.log(`[Claude CLI] Spawning ${logRole}/${logSkill} for conversation ${options.conversationId} (cwd: ${sandboxPath})`);
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
    return { emitter, abort: () => {}, sessionId: options.sessionId };
  }

  // Write user message to stdin
  proc.stdin!.write(message);
  proc.stdin!.end();

  // Accumulated token counts
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
    console.log(`[Claude CLI] ${logRole}/${logSkill} exited with code ${code}`);
    if (stderrBuffer) {
      console.error(`[Claude CLI] ${logRole}/${logSkill} stderr:\n${stderrBuffer.substring(0, 1000)}`);
    }

    if (code !== 0 && !inputTokens) {
      console.error(`[Claude CLI] ${logRole}/${logSkill} FAILED: code=${code}, inputTokens=0, stderr=${stderrBuffer.substring(0, 500)}`);
      emitter.emit('event', {
        type: 'error',
        data: `Claude CLI exited with code ${code}. ${stderrBuffer || 'No error details.'}`,
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
      data: `Claude CLI process error: ${error.message}`,
    } satisfies SSEEvent);
    emitter.emit('event', {
      type: 'done',
      data: { exitCode: 1 },
    } satisfies SSEEvent);
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
      emitter.emit('event', {
        type: 'text',
        data: delta.text,
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
          emitter.emit('event', {
            type: 'text',
            data: block.text as string,
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
