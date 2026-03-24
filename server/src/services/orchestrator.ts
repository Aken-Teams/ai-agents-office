import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { dbGet, dbRun } from '../db.js';
import { spawnClaude } from './claudeCli.js';
import { parsePipelineBlocks, truncateResultForRouter } from './taskParser.js';
import { getSkill, buildSystemPrompt, getRouterSkill, buildRouterPrompt } from '../skills/loader.js';
import { getUserUploadsForPrompt, getConversationFilesForPrompt } from './uploadContext.js';
import { getSandboxPath } from './sandbox.js';
import { config } from '../config.js';
import type { SSEEvent, ParsedTask, ParsedPipeline, TaskExecution } from '../types.js';

const MAX_ORCHESTRATION_DEPTH = 3;
const ORCHESTRATION_TIMEOUT_MS = 900_000; // 15 minutes total orchestration limit

// Per-skill timeout (ms) — text-only agents are fast, generators need more time
const SKILL_TIMEOUT: Record<string, number> = {
  router:    90_000,    // 1.5 min — analyze and delegate (no tools, just text)
  research:  300_000,   // 5 min — web search
  planner:   300_000,   // 5 min — text planning (complex outlines need time)
  reviewer:  120_000,   // 2 min — text review
  'pptx-gen': 600_000,  // 10 min — write code + run node to generate PPT
  'docx-gen': 480_000,  // 8 min — write code + run node to generate Word
  'xlsx-gen': 300_000,  // 5 min — write code + run node to generate Excel
  'pdf-gen':  300_000,  // 5 min — write code + run node to generate PDF
  'slides-gen': 480_000,  // 8 min — generate HTML slides
  'data-analyst': 480_000, // 8 min — data analysis (files can be large)
  'rag-analyst': 480_000, // 8 min — cross-file analysis (multiple files)
};
const DEFAULT_TASK_TIMEOUT_MS = 300_000; // 5 min fallback for unknown skills

export interface OrchestratorResult {
  assistantText: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  model: string;
  tasks: TaskExecution[];
}

type SSEWriter = (event: SSEEvent) => void;

/**
 * Orchestrator: coordinates Router Agent + Worker Agents.
 *
 * Flow:
 * 1. Send user message to Router Agent
 * 2. Parse [TASK]/[PIPELINE] blocks from Router's response
 * 3. Execute tasks (serial or parallel)
 * 4. Feed results back to Router
 * 5. Repeat until no more tasks (max depth limit)
 */
export class Orchestrator {
  private userId: string;
  private conversationId: string;
  private sseWriter: SSEWriter;
  private aborted = false;
  private activeAbortFns: Array<() => void> = [];
  private tasks: TaskExecution[] = [];
  private uploadIds: string[];
  private userLocale: string;

  constructor(userId: string, conversationId: string, sseWriter: SSEWriter, uploadIds: string[] = [], userLocale: string = 'zh-TW') {
    this.userId = userId;
    this.conversationId = conversationId;
    this.sseWriter = sseWriter;
    this.userLocale = userLocale;
    this.uploadIds = uploadIds;
  }

  async run(message: string): Promise<OrchestratorResult> {
    const routerSkill = getRouterSkill();
    if (!routerSkill) {
      throw new Error('Router skill not found');
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let model = '';
    let allAssistantText = '';

    // Get or create Router's session for this conversation
    const { sessionId: routerSessionId, initialized: routerInitialized } = await this.getOrCreateAgentSession('router');

    const routerSystemPrompt = buildRouterPrompt(routerSkill, this.userLocale);

    // If user attached files, prepend file info to message so Router knows to delegate to data-analyst/rag-analyst
    let messageWithFileContext = message;
    if (this.uploadIds.length > 0) {
      const baseSandbox = getSandboxPath(this.userId, this.conversationId);
      const fileContext = await getUserUploadsForPrompt(this.userId, baseSandbox, { uploadIds: this.uploadIds });
      if (fileContext) {
        messageWithFileContext = message + '\n\n[System: The user has attached files for this request.]\n' + fileContext;
      }
    }

    // Recursive orchestration loop
    let currentMessage = messageWithFileContext;
    let depth = 0;
    let routerResumed = routerInitialized; // Track if we should resume within this run
    const orchestrationStart = Date.now();

    while (depth < MAX_ORCHESTRATION_DEPTH && !this.aborted) {
      // Total orchestration time guard
      if (Date.now() - orchestrationStart > ORCHESTRATION_TIMEOUT_MS) {
        const warning = '\n\n(Reached maximum orchestration time limit. Providing final summary.)';
        allAssistantText += warning;
        this.sseWriter({ type: 'text', data: warning });
        break;
      }
      depth++;

      // Step 1: Send to Router Agent (with retry on transient failure)
      this.sseWriter({ type: 'agent_status', data: { agent: 'router', status: 'thinking' } });

      let routerResult: { text: string; inputTokens: number; outputTokens: number; model: string };
      try {
        routerResult = await this.spawnAgent(
          currentMessage,
          routerSystemPrompt,
          {
            sessionId: routerSessionId,
            isResume: routerResumed,
            role: 'router' as const,
            skillId: 'router',
          }
        );
      } catch (routerErr) {
        // Retry once with a fresh session on transient failure (exit code 1)
        console.warn(`[Orchestrator] Router failed, retrying with fresh session:`, routerErr);
        const freshSession = await this.getOrCreateAgentSession('router');
        try {
          routerResult = await this.spawnAgent(
            currentMessage,
            routerSystemPrompt,
            {
              sessionId: freshSession.sessionId,
              isResume: false,
              role: 'router' as const,
              skillId: 'router',
            }
          );
        } catch (retryErr) {
          // Both attempts failed — bail out
          const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          allAssistantText += `\n\nRouter agent failed: ${errMsg}`;
          this.sseWriter({ type: 'text', data: `\n\nRouter agent failed: ${errMsg}` });
          break;
        }
      }
      routerResumed = true; // After first call in this run, always resume

      if (this.aborted) break;

      totalInputTokens += routerResult.inputTokens;
      totalOutputTokens += routerResult.outputTokens;
      if (routerResult.model) model = routerResult.model;

      // Step 2: Parse Router's response
      const { cleanText, pipelines, bareTasks } = parsePipelineBlocks(routerResult.text);

      // Send Router's clean text (non-task content) to client
      if (cleanText) {
        allAssistantText += cleanText + '\n';
        this.sseWriter({ type: 'text', data: cleanText });
      }

      // If Router sent a plan explanation, forward it
      if (pipelines.length > 0 || bareTasks.length > 0) {
        this.sseWriter({
          type: 'router_plan',
          data: {
            pipelines: pipelines.map(p => ({
              parallel: p.parallel,
              tasks: p.tasks.map(t => ({ skillId: t.skillId, description: t.description.substring(0, 100) })),
            })),
            bareTasks: bareTasks.map(t => ({ skillId: t.skillId, description: t.description.substring(0, 100) })),
          },
        });
      }

      // No tasks = Router is done (just chatting or summarizing)
      if (pipelines.length === 0 && bareTasks.length === 0) {
        break;
      }

      // Step 3: Execute tasks
      const taskResults: string[] = [];

      // Execute pipelines
      for (const pipeline of pipelines) {
        if (this.aborted) break;

        const pipelineId = uuidv4();
        this.sseWriter({
          type: 'pipeline_started',
          data: { pipelineId, parallel: pipeline.parallel, taskCount: pipeline.tasks.length },
        });

        let results: string[];
        if (pipeline.parallel) {
          results = await this.executePipelineParallel(pipeline, pipelineId);
        } else {
          results = await this.executePipelineSerial(pipeline, pipelineId);
        }

        taskResults.push(...results);

        this.sseWriter({
          type: 'pipeline_completed',
          data: { pipelineId },
        });
      }

      // Execute bare tasks (outside pipelines) — run in parallel
      if (bareTasks.length > 0 && !this.aborted) {
        const bareResults = await Promise.all(
          bareTasks.map(task => this.executeTask(task))
        );
        taskResults.push(...bareResults);
      }

      // Step 4: Feed results back to Router
      if (taskResults.length > 0 && !this.aborted) {
        const hasFailures = taskResults.some(r => r.startsWith('Error') || r.startsWith('Skipped'));
        const resultsSummary = taskResults
          .map((r, i) => `### Task ${i + 1} Result:\n${truncateResultForRouter(r)}`)
          .join('\n\n');

        let instruction = 'Please summarize the results for the user. If more tasks are needed, dispatch them. Otherwise, provide a final response.\n\nIMPORTANT: If the results contain fenced code blocks (```chart, ```mermaid, ```mindmap, ```map), you MUST include them VERBATIM in your response — do NOT describe them in text, do NOT omit them, do NOT paraphrase them. These code blocks render as interactive visualizations for the user.';
        if (hasFailures) {
          instruction = 'Some tasks failed or were skipped. Summarize what succeeded and what failed for the user. Do NOT retry failed tasks — just report the status clearly. Provide a final response.';
        }

        currentMessage = `Here are the results from the tasks you dispatched:\n\n${resultsSummary}\n\n${instruction}`;
      } else {
        break;
      }
    }

    // Depth limit warning
    if (depth >= MAX_ORCHESTRATION_DEPTH && !this.aborted) {
      const warning = '\n\n(Reached maximum orchestration depth. Providing final summary.)';
      allAssistantText += warning;
      this.sseWriter({ type: 'text', data: warning });
    }

    return {
      assistantText: allAssistantText.trim(),
      totalInputTokens,
      totalOutputTokens,
      model,
      tasks: this.tasks,
    };
  }

  /**
   * Execute a pipeline's tasks in serial (each receives previous output).
   */
  private async executePipelineSerial(pipeline: ParsedPipeline, pipelineId: string): Promise<string[]> {
    const results: string[] = [];
    let previousOutput = '';
    let previousFailed = false;

    for (const task of pipeline.tasks) {
      if (this.aborted) break;

      // If previous step failed, skip dependent tasks
      if (previousFailed) {
        const skipMsg = `Skipped: previous pipeline step failed`;
        results.push(skipMsg);
        this.sseWriter({
          type: 'task_failed',
          data: { taskId: 'skipped', skillId: task.skillId, error: skipMsg },
        });
        continue;
      }

      // Prepend previous task's output as context
      const enrichedTask = { ...task };
      if (previousOutput) {
        enrichedTask.description = `${task.description}\n\n## Context from previous step:\n${truncateResultForRouter(previousOutput)}`;
      }

      const result = await this.executeTask(enrichedTask, pipelineId);
      results.push(result);
      previousOutput = result;

      // Check if this task failed (result starts with "Error")
      if (result.startsWith('Error')) {
        previousFailed = true;
      }
    }

    return results;
  }

  /**
   * Execute a pipeline's tasks in parallel.
   */
  private async executePipelineParallel(pipeline: ParsedPipeline, pipelineId: string): Promise<string[]> {
    return Promise.all(
      pipeline.tasks.map(task => this.executeTask(task, pipelineId))
    );
  }

  /**
   * Execute a single task by spawning a skill agent.
   */
  private async executeTask(task: ParsedTask, pipelineId?: string): Promise<string> {
    const taskId = uuidv4();
    const execution: TaskExecution = {
      taskId,
      skillId: task.skillId,
      description: task.description.substring(0, 200),
      status: 'dispatched',
    };
    this.tasks.push(execution);

    // Save to DB
    await dbRun(
      `INSERT INTO task_executions (id, conversation_id, pipeline_id, skill_id, description, status, started_at)
       VALUES (?, ?, ?, ?, ?, 'dispatched', NOW())`,
      taskId, this.conversationId, pipelineId || null, task.skillId, task.description.substring(0, 500)
    );

    const taskStartTime = Date.now();

    this.sseWriter({
      type: 'task_dispatched',
      data: { taskId, skillId: task.skillId, description: task.description.substring(0, 100) },
    });

    const skill = getSkill(task.skillId);
    if (!skill) {
      const error = `Unknown skill: ${task.skillId}`;
      execution.status = 'failed';
      execution.result = error;
      await this.updateTaskInDb(taskId, 'failed', error);
      this.sseWriter({ type: 'task_failed', data: { taskId, skillId: task.skillId, error } });
      return `Error: ${error}`;
    }

    // Build system prompt for this skill (with user upload context)
    // Use the actual agent CWD (including _agents/{skillId} subdirectory) for relative path calculation
    const baseSandboxPath = getSandboxPath(this.userId, this.conversationId);
    const agentCwd = path.join(baseSandboxPath, '_agents', task.skillId);
    const uploadContext = task.skillId === 'rag-analyst'
      ? await getConversationFilesForPrompt(this.userId, agentCwd, this.conversationId)
      : await getUserUploadsForPrompt(this.userId, agentCwd, {
          uploadIds: this.uploadIds.length > 0 ? this.uploadIds : undefined,
          conversationId: this.conversationId,
        });
    const systemPrompt = buildSystemPrompt(skill, config.generatorsDir, this.userLocale) + uploadContext;

    // Get or create session for this skill agent
    const { sessionId: agentSessionId, initialized: agentInitialized } = await this.getOrCreateAgentSession(task.skillId);

    execution.status = 'running';
    await this.updateTaskInDb(taskId, 'running');

    try {
      // Stream agent activity to client under agent_stream
      const result = await this.spawnAgent(
        task.description,
        systemPrompt,
        {
          sessionId: agentSessionId,
          isResume: agentInitialized, // Resume if session was already used
          role: 'worker',
          skillId: task.skillId,
        },
        taskId,  // Pass taskId for agent_stream events
      );

      execution.status = 'completed';
      execution.result = result.text;
      execution.tokenUsage = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };

      await this.updateTaskInDb(taskId, 'completed', result.text.substring(0, 2000), result.inputTokens, result.outputTokens);

      const elapsedMs = Date.now() - taskStartTime;
      this.sseWriter({
        type: 'task_completed',
        data: { taskId, skillId: task.skillId, resultPreview: result.text.substring(0, 200), elapsedMs },
      });

      return result.text;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      execution.status = 'failed';
      execution.result = error;
      await this.updateTaskInDb(taskId, 'failed', error);
      this.sseWriter({ type: 'task_failed', data: { taskId, skillId: task.skillId, error } });
      return `Error executing ${task.skillId}: ${error}`;
    }
  }

  /**
   * Spawn a Claude CLI agent and collect its full output.
   * Returns a promise that resolves when the agent finishes.
   */
  private spawnAgent(
    message: string,
    systemPrompt: string,
    opts: {
      sessionId: string;
      isResume: boolean;
      role: 'router' | 'worker';
      skillId: string;
    },
    taskId?: string,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }> {
    return new Promise((resolve, reject) => {
      const { emitter, abort } = spawnClaude(message, systemPrompt, {
        userId: this.userId,
        conversationId: this.conversationId,
        sessionId: opts.sessionId,
        isResume: opts.isResume,
        role: opts.role,
        skillId: opts.skillId,
        // Each agent gets its own subdirectory to avoid CLAUDE.md conflicts
        sandboxSubdir: `_agents/${opts.skillId}`,
      });

      this.activeAbortFns.push(abort);

      let text = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let model = '';

      // Per-skill timeout: text agents get short limits, generators get long ones
      const timeoutMs = SKILL_TIMEOUT[opts.skillId] ?? DEFAULT_TASK_TIMEOUT_MS;
      let settled = false; // Guard against race between timeout and done event

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        console.warn(`[Orchestrator] Agent ${opts.skillId} timed out after ${timeoutMs / 1000}s`);
        abort();
        // Remove abort fn
        this.activeAbortFns = this.activeAbortFns.filter(fn => fn !== abort);

        if (text.trim()) {
          // Agent produced partial output — use it (file may already be generated)
          console.log(`[Orchestrator] Agent ${opts.skillId} timed out but has partial output (${text.length} chars), using it`);
          resolve({ text: text + '\n\n(Note: agent timed out, output may be incomplete)', inputTokens, outputTokens, model });
        } else {
          reject(new Error(`Agent ${opts.skillId} timed out after ${timeoutMs / 1000} seconds with no output`));
        }
      }, timeoutMs);

      emitter.on('event', (event: SSEEvent) => {
        if (this.aborted || settled) return;

        // Forward worker agent's streaming events to client (prefixed with taskId)
        if (taskId) {
          if (event.type === 'text') {
            this.sseWriter({
              type: 'agent_stream',
              data: { taskId, skillId: opts.skillId, type: 'text', content: event.data },
            });
          }
          if (event.type === 'tool_activity') {
            this.sseWriter({
              type: 'agent_stream',
              data: { taskId, skillId: opts.skillId, type: 'tool_activity', content: event.data },
            });
          }
        } else {
          // Router agent: forward text/tool events directly
          if (event.type === 'tool_activity') {
            this.sseWriter(event);
          }
        }

        if (event.type === 'text') {
          text += event.data as string;
        }

        if (event.type === 'usage') {
          const usage = event.data as { inputTokens: number; outputTokens: number; model: string };
          inputTokens = usage.inputTokens;
          outputTokens = usage.outputTokens;
          model = usage.model;
        }

        if (event.type === 'session_id') {
          const sid = event.data as string;
          if (sid) {
            // Update agent session in DB (fire and forget)
            dbRun(
              `UPDATE agent_sessions SET session_uuid = ?, initialized = 1 WHERE conversation_id = ? AND skill_id = ?`,
              sid, this.conversationId, opts.skillId
            ).catch(e => console.error('Failed to update agent session:', e));
          }
        }

        if (event.type === 'error') {
          // Don't reject — let it finish and we'll see if there's text
          console.error(`[Orchestrator] Agent ${opts.skillId} error:`, event.data);
        }

        if (event.type === 'done') {
          clearTimeout(timeout);
          if (settled) return; // Already resolved by timeout
          settled = true;
          // Remove abort fn
          this.activeAbortFns = this.activeAbortFns.filter(fn => fn !== abort);

          const exitCode = (event.data as { exitCode?: number; stderr?: string })?.exitCode;
          const stderr = (event.data as { stderr?: string })?.stderr;
          if (!text && exitCode !== 0) {
            const detail = stderr ? ` (stderr: ${stderr.substring(0, 300)})` : '';
            console.error(`[Orchestrator] Agent ${opts.skillId} FAILED: exitCode=${exitCode}, text="${text}", stderr=${stderr?.substring(0, 300)}`);
            reject(new Error(`Agent ${opts.skillId} failed with no output (exit code ${exitCode})${detail}`));
          } else {
            resolve({ text, inputTokens, outputTokens, model });
          }
        }
      });
    });
  }

  /**
   * Get or create a persistent session ID for an agent in this conversation.
   * Returns sessionId and whether it was already initialized (used for resume logic).
   */
  private async getOrCreateAgentSession(skillId: string): Promise<{ sessionId: string; initialized: boolean }> {
    const existing = await dbGet<{ session_uuid: string; initialized: number }>(
      'SELECT session_uuid, initialized FROM agent_sessions WHERE conversation_id = ? AND skill_id = ?',
      this.conversationId, skillId
    );

    if (existing) return { sessionId: existing.session_uuid, initialized: existing.initialized === 1 };

    const sessionUuid = uuidv4();
    await dbRun(
      'INSERT INTO agent_sessions (id, conversation_id, skill_id, session_uuid) VALUES (?, ?, ?, ?)',
      uuidv4(), this.conversationId, skillId, sessionUuid
    );

    return { sessionId: sessionUuid, initialized: false };
  }

  /**
   * Update task execution status in DB.
   */
  private async updateTaskInDb(
    taskId: string,
    status: string,
    resultSummary?: string,
    inputTokens?: number,
    outputTokens?: number,
  ): Promise<void> {
    if (status === 'completed' || status === 'failed') {
      await dbRun(
        `UPDATE task_executions
         SET status = ?, result_summary = ?, input_tokens = ?, output_tokens = ?, completed_at = NOW()
         WHERE id = ?`,
        status, resultSummary || null, inputTokens || 0, outputTokens || 0, taskId
      );
    } else {
      await dbRun('UPDATE task_executions SET status = ? WHERE id = ?', status, taskId);
    }
  }

  /**
   * Abort all active agent processes.
   */
  abort(): void {
    this.aborted = true;
    for (const fn of this.activeAbortFns) {
      try { fn(); } catch { /* ignore */ }
    }
    this.activeAbortFns = [];
  }
}
