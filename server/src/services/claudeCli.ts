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

interface ClaudeCliOptions {
  userId: string;
  conversationId: string;
  sessionId?: string;
  skillId?: string;
}

interface ClaudeResult {
  emitter: EventEmitter;
  abort: () => void;
  sessionId: string | undefined;
}

// Tools Claude is allowed to use in sandbox
const ALLOWED_TOOLS = [
  'Bash(node:*)',
  'Write',
  'Read',
];

// Tools explicitly blocked for security
const DISALLOWED_TOOLS = [
  'Edit',
  'WebFetch',
  'WebSearch',
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
  const sandboxPath = getSandboxPath(options.userId, options.conversationId);

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
  if (options.sessionId) {
    args.push('--session-id', options.sessionId);
  }

  // Tool restrictions (security layer 2)
  args.push('--allowedTools', ALLOWED_TOOLS.join(','));
  args.push('--disallowedTools', DISALLOWED_TOOLS.join(','));

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

  console.log(`[Claude CLI] Spawning for conversation ${options.conversationId} (cwd: ${sandboxPath})`);

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
    console.log(`[Claude CLI] Process exited with code ${code}`);

    if (code !== 0 && !inputTokens) {
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

  // Text content streaming
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

  // Assistant message with tool use
  if (type === 'assistant') {
    const message = parsed.message as Record<string, unknown> | undefined;
    const content = message?.content as Array<Record<string, unknown>> | undefined;
    if (content) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          emitter.emit('event', {
            type: 'tool_activity',
            data: { tool: block.name, id: block.id },
          } satisfies SSEEvent);
        }
        if (block.type === 'text' && block.text) {
          emitter.emit('event', {
            type: 'text',
            data: block.text,
          } satisfies SSEEvent);
        }
      }
    }
  }

  // Result message (contains generated text after tool calls)
  if (type === 'result') {
    const result = parsed.result as string | undefined;
    if (result) {
      emitter.emit('event', {
        type: 'text',
        data: result,
      } satisfies SSEEvent);
    }

    const usage = parsed.usage as Record<string, number> | undefined;
    if (usage) {
      tokens.addInputTokens(usage.input_tokens || 0);
      tokens.addOutputTokens(usage.output_tokens || 0);
    }

    const modelStr = parsed.model as string | undefined;
    if (modelStr) tokens.setModel(modelStr);
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
