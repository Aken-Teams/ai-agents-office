import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { dbGet, dbAll, dbRun } from '../db.js';
import { spawnClaude } from './claudeCli.js';
import { parsePipelineBlocks, truncateResultForRouter } from './taskParser.js';
import { getSkill, buildSystemPrompt, buildMemoryContext, buildCrossAssistantContext, getRouterSkill, buildRouterPrompt } from '../skills/loader.js';
import { EMAIL_RETRIEVER_SYSTEM_PROMPT, buildRetrieverSystemPrompt } from './emailContext.js';
import { getUserUploadsForPrompt, getConversationFilesForPrompt } from './uploadContext.js';
import { getSandboxPath } from './sandbox.js';
import { parseInfographicDirective, renderInfographic } from './infographicService.js';
import { config } from '../config.js';
import type { SSEEvent, ParsedTask, ParsedPipeline, TaskExecution } from '../types.js';

const MAX_ORCHESTRATION_DEPTH = 3;

// Skills that PRODUCE structured data — their full output must reach consumers intact.
const DATA_PRODUCER_SKILLS = new Set(['data-analyst', 'rag-analyst']);
// Skills that CONSUME data to generate documents — must read the full data file.
const DOC_CONSUMER_SKILLS = new Set(['pptx-gen', 'docx-gen', 'xlsx-gen', 'pdf-gen', 'slides-gen', 'infographic-gen']);
const ORCHESTRATION_TIMEOUT_MS = 900_000; // 15 minutes total orchestration limit

// Per-skill timeout (ms) — text-only agents are fast, generators need more time
const SKILL_TIMEOUT: Record<string, number> = {
  router:    90_000,    // 1.5 min — analyze and delegate (no tools, just text)
  research:  480_000,   // 8 min — web search + charts/visualizations
  planner:   300_000,   // 5 min — text planning (complex outlines need time)
  reviewer:  120_000,   // 2 min — text review
  'pptx-gen': 600_000,  // 10 min — write code + run node to generate PPT
  'docx-gen': 480_000,  // 8 min — write code + run node to generate Word
  'xlsx-gen': 300_000,  // 5 min — write code + run node to generate Excel
  'pdf-gen':  480_000,  // 8 min — match docx; the generator itself is <1s, the
                        // budget is for the agent's research + content writing
                        // (5 min was the shortest of all generators → frequent timeouts)
  'slides-gen': 480_000,  // 8 min — generate HTML slides
  'webapp-gen': 480_000,  // 8 min — generate HTML dashboard page
  'data-analyst': 600_000, // 10 min — data analysis + charts/visualizations
  'rag-analyst': 600_000, // 10 min — cross-file analysis + charts/visualizations
};
const DEFAULT_TASK_TIMEOUT_MS = 300_000; // 5 min fallback for unknown skills

// Injected into the Router's message when the user attached the "我的信件" data
// source (mcpEmailToken set). Email is just ONE MORE DATA SOURCE plugged into the
// existing flow: the rag-analyst holds the mailbox tools and retrieves; the result
// flows to doc-gen through the normal previous_step.md bridge. Nothing else changes.
const EMAIL_DATASOURCE_ROUTER_NOTE = `

[System — 資料源：使用者的 Outlook 信箱（已授權，只讀他自己的）]
使用者這次掛載了「我的信件」資料源。**負責檢索信箱的是 rag-analyst**——它具備信箱工具（搜整個資料夾含舊信、讀附件檔內容、看內嵌圖與附件圖）。
派工原則（沿用你原本的 [TASK]/[PIPELINE] 機制，不需改變）：
- 若使用者只是要「找某封信 / 看某封信或其附件」→ 派一個 [TASK:rag-analyst]，任務寫清楚要找的信（主旨關鍵字）與要看什麼（內文／附件／圖）。
- 若使用者要「用信件內容產出文件」（Word/PPT/Excel/PDF）→ 用 [PIPELINE]：先 [TASK:rag-analyst] 檢索並整理出需要的信件資料，再接 [TASK:對應的 doc-gen]。rag-analyst 的完整輸出會自動透過檔案交給下一步。
- **信件檢索一律交給 rag-analyst**，不要派給 research（那是網路搜尋）、也不要自己臆測信件內容。`;

// Injected when the user attached the "KM 知識庫" data source (mcpKmOnBehalf set).
// KM is just ONE MORE DATA SOURCE: rag-analyst holds the KM tools and retrieves;
// the result flows to doc-gen through the normal previous_step.md bridge.
const KM_DATASOURCE_ROUTER_NOTE = `

[System — 資料源：KM 知識庫（已授權，只讀使用者本人有權限的文件）]
使用者這次掛載了「KM 知識庫」資料源。**負責檢索 KM 的是 rag-analyst**——它具備 KM 工具（搜文件、讀文件詳情、讀附件檔內容與圖）。
派工原則（沿用你原本的 [TASK]/[PIPELINE] 機制）：
- 若使用者只是要「找某份文件 / 看某份文件或其附件」→ 派一個 [TASK:rag-analyst]，寫清楚要找什麼（短關鍵字）與要看什麼。
- 若使用者要「用 KM 文件內容產出文件」（Word/PPT/Excel/PDF）→ 用 [PIPELINE]：先 [TASK:rag-analyst] 檢索整理，再接對應的 doc-gen。
- **KM 檢索一律交給 rag-analyst**，不要派給 research、也不要自己臆測文件內容。
彙整最終回覆時的**來源標註**：「資料來源／KM 依據」**只列實際查到的 KM 文件**（\`文件標題（#document_id）\`），不要把「文件內文裡提到的網址」當成資料來源；若要提內文網址，明確標成「（文件內文提到的連結）」，以免使用者誤以為那是 KM 文件連結。`;

export interface OrchestratorResult {
  assistantText: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  model: string;
  tasks: TaskExecution[];
  /** Raw Gemini cost (USD) from any infographic-gen agents in this run */
  geminiCostUsd: number;
  /** File types the infographic agent rendered (png/html) — for the file whitelist */
  infographicTypes: string[];
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
  private conversationCategory: string;
  private sseWriter: SSEWriter;
  private aborted = false;
  private activeAbortFns: Array<() => void> = [];
  private tasks: TaskExecution[] = [];
  // Most recent data-producing agent's FULL output, handed to doc-gen agents as a
  // file so cross-round data tasks aren't starved by context truncation (B-2).
  private lastDataOutput: string | null = null;
  private geminiCostUsd = 0;
  private infographicTypes = new Set<string>();
  private uploadIds: string[];
  private userLocale: string;
  private referenceContext: string;
  private customRolePrompt: string;
  // Per-run data-source MCP: the user's Outlook mail JWT, attached to WORKER
  // agents so a doc generator can pull the user's own mail. Set only when the
  // user selected the "email" data source. Identity is the token — no cross-user.
  private mcpEmailToken?: string;
  // Per-run KM data source: the user's 員編 (X-On-Behalf-Of). Attached to the
  // rag-analyst retriever so it can pull KM documents the user is permitted to read.
  private mcpKmOnBehalf?: string;

  constructor(userId: string, conversationId: string, sseWriter: SSEWriter, uploadIds: string[] = [], userLocale: string = 'zh-TW', conversationCategory: string = 'document', referenceContext: string = '', customRolePrompt: string = '', mcpEmailToken?: string, mcpKmOnBehalf?: string) {
    this.userId = userId;
    this.conversationId = conversationId;
    this.conversationCategory = conversationCategory;
    this.sseWriter = sseWriter;
    this.userLocale = userLocale;
    this.uploadIds = uploadIds;
    this.referenceContext = referenceContext;
    this.customRolePrompt = customRolePrompt;
    this.mcpEmailToken = mcpEmailToken;
    this.mcpKmOnBehalf = mcpKmOnBehalf;
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

    // Inject user memories into router prompt
    const userMemories = await dbAll<{ content: string }>(
      "SELECT content FROM user_memories WHERE user_id = ? AND memory_type = 'preference' ORDER BY created_at DESC LIMIT 10", this.userId
    );

    // For assistant conversations: inject cross-assistant context (same user only)
    let crossAssistantContext = '';
    if (this.conversationCategory === 'assistant') {
      const otherSummaries = await dbAll<{ title: string; summary: string; created_at: string }>(
        "SELECT title, summary, created_at FROM conversations WHERE user_id = ? AND category = 'assistant' AND id != ? AND summary IS NOT NULL ORDER BY created_at DESC LIMIT 3",
        this.userId, this.conversationId
      );
      crossAssistantContext = buildCrossAssistantContext(otherSummaries, this.conversationId);
    }

    const routerSystemPrompt = buildRouterPrompt(routerSkill, this.userLocale) + this.customRolePrompt + buildMemoryContext(userMemories) + crossAssistantContext;

    // Load conversation history so Router has full context of what was discussed/generated
    const historyMsgs = await dbAll<{ role: string; content: string }>(
      'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 40',
      this.conversationId
    );
    // Filter out the current user message if it was already saved, keep last 20
    const prevMsgs = historyMsgs
      .filter(m => !(m.role === 'user' && m.content.trim() === message.trim()))
      .slice(-20);
    let chatHistoryBlock = '';
    if (prevMsgs.length > 0) {
      const lines = prevMsgs.map(m => {
        const role = m.role === 'user' ? 'User' : 'Assistant';
        const content = m.content.length > 4000 ? m.content.substring(0, 4000) + '... (truncated — 大量資料請改用「上傳檔案」，貼在對話中的長內容可能被截斷)' : m.content;
        return `[${role}]: ${content}`;
      });
      chatHistoryBlock =
        '## Conversation History\n' +
        'Below is what has already been discussed and generated in this conversation. ' +
        'Use this context to understand previous work and user references.\n\n' +
        lines.join('\n\n') +
        '\n\n---\n\n';
    }

    // Build effective message — inject referenced data inline so Router uses it directly (no re-research)
    let messageWithFileContext = chatHistoryBlock ? chatHistoryBlock + '用戶最新指令：' + message : message;
    if (this.referenceContext) {
      // Prepend reference data with explicit instruction to use existing content
      messageWithFileContext =
        '[System: 用戶已引用以下 AI 助手的工作成果。請直接運用這些資料來完成需求，' +
        '不要重新對這些主題進行網路搜尋或重複研究。將引用資料作為主要來源，直接委派給適合的 Worker。]\n' +
        this.referenceContext + '\n\n---\n\n用戶需求：' + messageWithFileContext;
    }
    if (this.uploadIds.length > 0) {
      const baseSandbox = getSandboxPath(this.userId, this.conversationId);
      const fileContext = await getUserUploadsForPrompt(this.userId, baseSandbox, { uploadIds: this.uploadIds });
      if (fileContext) {
        messageWithFileContext = messageWithFileContext + '\n\n[System: The user has attached files for this request.]\n' + fileContext;
      }
    }
    // Email as a DATA SOURCE (does not change the orchestration flow):
    //  • Explicit data source selected (mcpEmailToken) → tell the Router to route
    //    mail retrieval to rag-analyst (which has the email tools). It searches old
    //    mail, reads attachments + inline images, and hands data to doc-gen via the
    //    existing previous_step.md bridge. No pre-fetch → the agent pulls exactly what
    //    is needed (flexible, never capped at "recent 20").
    //  • No data source → legacy keyword-triggered pre-fetch (back-compat, unchanged).
    if (this.mcpEmailToken) {
      messageWithFileContext += EMAIL_DATASOURCE_ROUTER_NOTE;
    } else {
      const { messageNeedsEmail, getEmailContextForPrompt } = await import('./emailContext.js');
      if (messageNeedsEmail(message)) {
        const emailCtx = await getEmailContextForPrompt(this.userId, message);
        if (emailCtx) messageWithFileContext += emailCtx;
      }
    }
    // KM as a DATA SOURCE (same pattern as email; both can be attached at once):
    // route KM retrieval to rag-analyst, which holds the KM tools.
    if (this.mcpKmOnBehalf) {
      messageWithFileContext += KM_DATASOURCE_ROUTER_NOTE;
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
        // Retry once with a brand-new session on transient failure (exit code 1, "session already in use")
        console.warn(`[Orchestrator] Router failed, retrying with fresh session:`, routerErr);
        const freshSession = await this.resetAgentSession('router');
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

        // Per-task truncation can cut off the "資料來源" list (it sits at the end
        // of research output). Pull every URL from the FULL results so the Router
        // can rebuild a complete sources section even after truncation.
        const urls = Array.from(new Set(
          taskResults.flatMap(r => (r.match(/https?:\/\/[^\s)\]>"'，。、；）】}]+/g) || []).map(u => u.replace(/[.,;:、，。）]+$/, ''))),
        ));
        const sourcesBlock = urls.length
          ? `\n\n【任務查到的資料來源網址（若你的回覆有引用這些資料，務必整合到回覆最後的「資料來源」段落，去重列出）】\n${urls.map(u => `- ${u}`).join('\n')}`
          : '';

        let instruction = 'Please summarize the results for the user. If more tasks are needed, dispatch them. Otherwise, provide a final response.\n\nIMPORTANT: If the results contain fenced code blocks (```chart, ```mermaid, ```mindmap, ```map), you MUST include them VERBATIM in your response — do NOT describe them in text, do NOT omit them, do NOT paraphrase them. These code blocks render as interactive visualizations for the user.\n\n資料來源：若上面結果是經由網路搜尋查證得到的（含資料來源網址），你的最終回覆**必須**在結尾加上「資料來源」段落，逐條列出實際引用的網址（去重）。不要捏造來源，也不要省略真實查到的來源。';
        if (hasFailures) {
          instruction = 'Some tasks failed or were skipped. Summarize what succeeded and what failed for the user. Do NOT retry failed tasks — just report the status clearly. Provide a final response.';
        }

        currentMessage = `Here are the results from the tasks you dispatched:\n\n${resultsSummary}${sourcesBlock}\n\n${instruction}`;
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
      geminiCostUsd: this.geminiCostUsd,
      infographicTypes: [...this.infographicTypes],
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

      // Hand the FULL previous output to the next agent via a file (so no data is
      // lost to truncation); only a short summary goes inline. Truncating an
      // analyst's dataset into the next agent's context made it fabricate the
      // missing rows — this prevents that. See attachPreviousStepData.
      const enrichedTask = { ...task };
      if (previousOutput) {
        enrichedTask.description = this.attachPreviousStepData(task.skillId, task.description, previousOutput);
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
   * Hand the FULL previous-step output to the next agent via a file in its
   * working directory (read in full, no truncation), with only a short summary
   * inline. Critical for data fidelity: truncating a dataset between agents
   * starves the downstream agent, which then fabricates the missing rows.
   */
  private attachPreviousStepData(skillId: string, description: string, previousOutput: string): string {
    try {
      const agentCwd = path.join(getSandboxPath(this.userId, this.conversationId), '_agents', skillId);
      fs.mkdirSync(agentCwd, { recursive: true });
      const fileName = 'previous_step.md';
      fs.writeFileSync(path.join(agentCwd, fileName), previousOutput, 'utf-8');
      const summary = truncateResultForRouter(previousOutput, 1200);
      return `${description}\n\n## 上一步的完整輸出（重要）\n上一個 agent 的**完整**結果已存於檔案 \`${fileName}\`（就在你的工作目錄）。\n**你必須先用 Read 工具讀取 \`${fileName}\` 取得完整資料**；所有客戶名／公司名／數字／資料一律以該檔為準，**不可超出該檔內容，也不可自行補充或編造**任何來源外的名稱或數值。若該檔的資料筆數少於版面所需，寧可少放（標「資料未提供」），也不可湊數。\n\n以下僅為節錄摘要（可能不完整，完整內容務必讀檔）：\n${summary}`;
    } catch (e) {
      // Never block the pipeline — fall back to the (truncated) inline context.
      console.warn('[Orchestrator] attachPreviousStepData failed, falling back to inline context:', e);
      return `${description}\n\n## Context from previous step:\n${truncateResultForRouter(previousOutput)}`;
    }
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

    let skill = getSkill(task.skillId);
    if (!skill && this.uploadIds.length > 0) {
      // Defensive: the Router sometimes hallucinates a skill name (e.g. 'claude-api')
      // for "analyze my uploaded image/file". Rather than fail silently — leaving the
      // upload unread — route to a real vision-capable analyst (they have the multimodal
      // Read tool and can SEE images/PDFs directly).
      const fallbackId = this.uploadIds.length > 1 ? 'rag-analyst' : 'data-analyst';
      const fb = getSkill(fallbackId);
      if (fb) {
        console.warn(`[Orchestrator] Unknown skill '${task.skillId}' with ${this.uploadIds.length} upload(s) — routing to ${fallbackId}`);
        skill = fb;
        task.skillId = fallbackId;
      }
    }
    if (!skill) {
      const error = `Unknown skill: ${task.skillId}`;
      execution.status = 'failed';
      execution.result = error;
      await this.updateTaskInDb(taskId, 'failed', error);
      this.sseWriter({ type: 'task_failed', data: { taskId, skillId: task.skillId, error } });
      return `Error: ${error}`;
    }

    // B-2: ensure doc-gen agents receive the latest analyst data IN FULL (via a
    // file), even when the analyst ran in a separate Router round (not a pipeline).
    if (DOC_CONSUMER_SKILLS.has(task.skillId) && this.lastDataOutput && !task.description.includes('previous_step.md')) {
      task.description = this.attachPreviousStepData(task.skillId, task.description, this.lastDataOutput);
    }

    // Inject email data when worker task mentions email keywords
    {
      const { messageNeedsEmail: needsEmail, getEmailContextForPrompt: getEmailCtx } = await import('./emailContext.js');
      if (needsEmail(task.description)) {
        const emailCtx = await getEmailCtx(this.userId, task.description);
        if (emailCtx) task.description += emailCtx;
      }
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
    // When rag-analyst is doing EMAIL retrieval (it holds the email-mcp tools), give
    // it a LEAN focused retriever prompt instead of its full 187-line file-analysis
    // SKILL.md — the big prompt distracts the model into thrashing on ToolSearch. Its
    // retrieved output still flows to doc-gen via the normal previous_step.md bridge.
    const useDataSourceRetriever = task.skillId === 'rag-analyst' && (!!this.mcpEmailToken || !!this.mcpKmOnBehalf);
    const systemPrompt = useDataSourceRetriever
      ? buildRetrieverSystemPrompt({ email: !!this.mcpEmailToken, km: !!this.mcpKmOnBehalf }) + uploadContext
      : buildSystemPrompt(skill, config.generatorsDir, this.userLocale) + uploadContext;

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

      // Remember the latest data-producing output so the next doc-gen agent gets
      // it in full (B-2). Only data producers — not doc-gen's own output.
      if (DATA_PRODUCER_SKILLS.has(task.skillId) && result.text) {
        this.lastDataOutput = result.text;
      }

      // Infographic agent: render its directive via Gemini into the BASE sandbox
      // (not the agent subdir) so the deliverable is picked up + surfaced.
      if (task.skillId === 'infographic-gen' && result.text) {
        const directive = parseInfographicDirective(result.text);
        if (directive) {
          try {
            const rendered = await renderInfographic(directive, baseSandboxPath);
            this.geminiCostUsd += rendered.usage.costUsd;
            this.infographicTypes.add(rendered.fileType);
          } catch (e) {
            this.sseWriter({ type: 'error', data: `資訊圖表生成失敗：${(e as Error).message}` });
          }
        }
      }

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
      // Look up skill-level tool restrictions
      const skillDef = opts.role !== 'router' ? getSkill(opts.skillId) : undefined;

      const { emitter, abort } = spawnClaude(message, systemPrompt, {
        userId: this.userId,
        conversationId: this.conversationId,
        sessionId: opts.sessionId,
        isResume: opts.isResume,
        role: opts.role,
        skillId: opts.skillId,
        customAllowedTools: skillDef?.allowedTools,
        customDisallowedTools: skillDef?.disallowedTools,
        // Router runs on a fast, cheap model (Haiku by default): first token in
        // ~1-2s instead of 10-30s on Opus, so it rarely hits the 90s timeout, and it
        // consumes far less of the subscription's rate-limit budget. Override via
        // ROUTER_MODEL (config.routerModel). Workers keep the account default model.
        ...(opts.role === 'router' && config.routerModel ? { model: config.routerModel } : {}),
        // Email data source (MCP): attach ONLY to the rag-analyst — our dedicated
        // data-retrieval agent. It fetches the emails/attachments/images the user
        // needs and hands the data to doc-gen via the existing previous_step.md
        // bridge. Keeping the tools on one focused agent (not every worker) is far
        // more reliable than bolting mail tools onto the generic research worker.
        ...(opts.skillId === 'rag-analyst' && this.mcpEmailToken ? { mcpEmailToken: this.mcpEmailToken } : {}),
        ...(opts.skillId === 'rag-analyst' && this.mcpKmOnBehalf ? { mcpKmOnBehalf: this.mcpKmOnBehalf } : {}),
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
   * Reset an agent's session — delete old record and create a fresh UUID.
   * Used when --resume fails with "session already in use".
   */
  private async resetAgentSession(skillId: string): Promise<{ sessionId: string; initialized: boolean }> {
    await dbRun(
      'DELETE FROM agent_sessions WHERE conversation_id = ? AND skill_id = ?',
      this.conversationId, skillId
    );

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
