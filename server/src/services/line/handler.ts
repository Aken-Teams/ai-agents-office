/**
 * Core LINE message handler — bridges a LINE text event to the existing
 * Orchestrator without going through the SSE/HTTP machinery.
 *
 * Pattern:
 *   1. signature verified upstream (in route)
 *   2. user resolved + quota / input-guard / rate-limit checked
 *   3. Orchestrator runs with a custom sseWriter that aggregates `text` events
 *      into a buffer; other events are logged but not surfaced
 *   4. Buffer split into LINE messages and pushed back
 *   5. Memory extraction is fire-and-forget, mirrors generate.ts:389
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { dbRun, dbAll, dbGet } from '../../db.js';
import { Orchestrator } from '../orchestrator.js';
import { analyzeInput, logSecurityEvent } from '../inputGuard.js';
import { checkUserUsageLimit } from '../usageLimit.js';
import { recordTokenUsage } from '../tokenTracker.js';
import { extractMemoryAndSummary } from '../memoryExtractor.js';
import { getSandboxPath } from '../sandbox.js';
import { getExistingFilePaths, registerNewFiles } from '../fileManager.js';
import { config } from '../../config.js';
import { getLineUser, touchLineUser, type LineUserRow } from './userMapping.js';
import { getOrCreateLineConversation } from './conversationRouter.js';
import { checkLineRateLimit } from './rateLimit.js';
import { parseCommand, handleHelp, handleLink, handleQuota, handleListFiles, handleWebLink, handleUnlinkedGreeting, handleTeams, handleSetTeam, handleSolo, handleNewTeam, handleSchedule, handleDelTeam, handleDelSchedule, handleDelTeamPrompt, handleDelTeamConfirm, handleSchedNew, handleSchedTeam, handleSchedSet } from './commands.js';
import { runTeam } from '../teamRun.js';
import { pushMessage, startLoadingIndicator, fetchMessageContent } from './client.js';
import { scanUploadedFile, isAllowedExtension } from '../uploadScanner.js';
import { splitForLine, extractChartBlocks } from './formatter.js';
import { buildGeneratedFilesFlex, type FileForFlex } from './flex.js';
import type { LineMessage } from './client.js';
import { createOrReuseFileShare } from './fileShare.js';
import { renderChartToPng } from './chartRenderer.js';
import type { SSEEvent } from '../../types.js';

export interface IncomingTextEvent {
  type: 'message';
  messageType: 'text';
  text: string;
  lineUserId: string;
  replyToken?: string;
}

export interface IncomingNonTextEvent {
  type: 'message';
  messageType: 'image' | 'file' | 'audio' | 'video';
  messageId?: string;
  filename?: string;
  lineUserId: string;
  replyToken?: string;
}

export interface IncomingPostbackEvent {
  type: 'postback';
  data: string;
  lineUserId: string;
  replyToken?: string;
}

export type IncomingEvent = IncomingTextEvent | IncomingNonTextEvent | IncomingPostbackEvent;

/**
 * Main entry point. Errors here are caught + logged + pushed as a friendly
 * "處理失敗" reply; never throws back to the webhook caller.
 */
export async function processIncomingEvent(event: IncomingEvent): Promise<void> {
  const { lineUserId } = event;
  try {
    if (!checkLineRateLimit(lineUserId)) {
      await pushMessage(lineUserId, [{
        type: 'text',
        text: `⏳ 訊息頻率過快，每分鐘上限 ${config.line.maxMsgPerMin} 則，請稍候。`,
      }]);
      return;
    }

    // Postback events (rich-menu taps) get their own dispatch path.
    if (event.type === 'postback') {
      const lineUser = await getLineUser(lineUserId);
      if (!lineUser) {
        await handleUnlinkedGreeting(lineUserId);
        return;
      }
      await dispatchPostback(lineUser, event.data);
      return;
    }

    if (event.messageType !== 'text') {
      // File / image events route through the indexing pipeline.
      const lineUser = await getLineUser(lineUserId);
      if (!lineUser) {
        await handleUnlinkedGreeting(lineUserId);
        return;
      }
      await handleIncomingFile(lineUser, event);
      return;
    }

    const cmd = parseCommand(event.text);
    const lineUser = await getLineUser(lineUserId);

    // `/link` is the only command unlinked users can run.
    if (cmd.kind === 'link') {
      await handleLink(lineUserId, cmd.args);
      return;
    }
    if (!lineUser) {
      await handleUnlinkedGreeting(lineUserId);
      return;
    }

    // Linked users — quota first, then dispatch.
    if (cmd.kind === 'help')  { await handleHelp(lineUserId); return; }
    if (cmd.kind === 'quota') { await handleQuota(lineUser); return; }
    if (cmd.kind === 'teams') { await handleTeams(lineUser); return; }
    if (cmd.kind === 'solo')  { await handleSolo(lineUser); return; }
    if (cmd.kind === 'newteam') { await handleNewTeam(lineUser, cmd.args); return; }
    if (cmd.kind === 'files') { await handleListFiles(lineUser); return; }
    if (cmd.kind === 'schedule') { await handleSchedule(lineUser, cmd.args); return; }
    if (cmd.kind === 'delteam') { await handleDelTeam(lineUser); return; }

    await runConversation(lineUser, event.text);
  } catch (err) {
    console.error('[LINE handler] uncaught error:', err instanceof Error ? err.stack : err);
    try {
      await pushMessage(lineUserId, [{
        type: 'text',
        text: '⚠️ 處理時發生問題，請稍後重試。如反覆出現，請聯繫管理員。',
      }]);
    } catch {
      // Best-effort — if push also fails, swallow.
    }
  }
}

/**
 * Routes rich-menu / quick-reply postback actions. Data format is
 * `key=value&key=value` (URL-encoded), set when building the menu layout.
 */
async function dispatchPostback(lineUser: LineUserRow, data: string): Promise<void> {
  const params = new URLSearchParams(data);
  const action = params.get('action') ?? '';

  switch (action) {
    case 'list_files':
      await handleListFiles(lineUser);
      return;
    case 'quota':
      await handleQuota(lineUser);
      return;
    case 'help':
      await handleHelp(lineUser.line_user_id);
      return;
    case 'web_link':
      await handleWebLink(lineUser);
      return;
    case 'teams':
      await handleTeams(lineUser);
      return;
    case 'set_team': {
      const teamId = params.get('team') ?? '';
      // The picker may be stale; re-read the user so the confirmation reflects state.
      const fresh = await getLineUser(lineUser.line_user_id);
      await handleSetTeam(fresh ?? lineUser, teamId);
      return;
    }
    case 'solo':
      await handleSolo(lineUser);
      return;
    case 'schedule':
      await handleSchedule(lineUser, '');
      return;
    case 'sched_new':
      await handleSchedNew(lineUser);
      return;
    case 'sched_team':
      await handleSchedTeam(lineUser, params.get('team') ?? '');
      return;
    case 'sched_set':
      await handleSchedSet(lineUser, params.get('team') ?? '', params.get('t') ?? '');
      return;
    case 'del_team':
      await handleDelTeamPrompt(lineUser, params.get('team') ?? '');
      return;
    case 'del_team_confirm': {
      const fresh = await getLineUser(lineUser.line_user_id);
      await handleDelTeamConfirm(fresh ?? lineUser, params.get('team') ?? '');
      return;
    }
    case 'del_schedule':
      await handleDelSchedule(lineUser, params.get('sid') ?? '');
      return;
    default:
      await pushMessage(lineUser.line_user_id, [{
        type: 'text',
        text: '此功能尚未支援，請改用文字指令或 /help 查看選單。',
      }]);
  }
}

/**
 * Image / file events — download via the Content API, security-scan, save to
 * the user's _uploads dir, and register a `user_uploads` row bound to the
 * current LINE conversation. No vector indexing: the existing uploadContext +
 * rag-analyst path lets Claude read the file directly on the next message.
 *
 * Audio / video are out of scope: we just inform the user.
 */
async function handleIncomingFile(
  lineUser: LineUserRow,
  event: IncomingNonTextEvent,
): Promise<void> {
  const { lineUserId } = event;

  if (event.messageType === 'audio' || event.messageType === 'video') {
    await pushMessage(lineUserId, [{
      type: 'text',
      text: '目前僅支援文字、圖片 (jpg/png) 與檔案訊息。音訊 / 影片暫不支援。',
    }]);
    return;
  }

  if (!event.messageId) {
    await pushMessage(lineUserId, [{ type: 'text', text: '⚠️ 缺少訊息 ID，無法下載檔案。' }]);
    return;
  }

  // Acknowledge fast — LINE users get anxious staring at a silent chat.
  await pushMessage(lineUserId, [{
    type: 'text',
    text: '📥 收到檔案，處理中…',
  }]);

  let buffer: Buffer;
  let contentType: string | null;
  try {
    const fetched = await fetchMessageContent(event.messageId);
    buffer = fetched.buffer;
    contentType = fetched.contentType;
  } catch (err) {
    console.error('[LINE handler] content fetch failed:', err);
    await pushMessage(lineUserId, [{ type: 'text', text: '⚠️ 下載檔案失敗，請稍後重試。' }]);
    return;
  }

  // Resolve filename — file events carry it, image events do not.
  const originalName = event.filename
    ?? `line_image_${Date.now()}.${contentType?.includes('jpeg') ? 'jpg' : contentType?.includes('png') ? 'png' : 'bin'}`;

  if (!isAllowedExtension(originalName)) {
    await pushMessage(lineUserId, [{
      type: 'text',
      text: `⚠️ 不支援的檔案類型：${path.extname(originalName) || '(未知)'}。\n目前支援：txt / md / pdf / docx / xlsx / csv / json 等常見格式。`,
    }]);
    return;
  }

  // Save under the user's _uploads dir using a unique name.
  const userId = lineUser.internal_user_id;
  const uploadDir = path.join(config.workspaceRoot, userId, '_uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const storedFilename = `${uuidv4()}${path.extname(originalName)}`;
  const fullPath = path.join(uploadDir, storedFilename);
  fs.writeFileSync(fullPath, buffer);

  // Security scan — reuse the exact same gate the web uploader runs.
  const scan = scanUploadedFile(fullPath, originalName, contentType ?? undefined, userId);
  if (scan.status === 'rejected') {
    try { fs.unlinkSync(fullPath); } catch { /* ignore */ }
    await pushMessage(lineUserId, [{
      type: 'text',
      text: `⚠️ 檔案安全檢查未通過：${scan.detail}`,
    }]);
    return;
  }

  // Attach the upload to the user's current LINE conversation. Instead of
  // vector indexing, we reuse the existing upload-context mechanism
  // (uploadContext.ts + rag-analyst skill): on the next message the
  // orchestrator gets these uploadIds and Claude reads the files directly.
  const conversation = await getOrCreateLineConversation(lineUser);
  const uploadId = uuidv4();
  const relPath = path.relative(config.workspaceRoot, fullPath);
  await dbRun(
    `INSERT INTO user_uploads
       (id, user_id, conversation_id, filename, original_name, file_type, mime_type, file_size, scan_status, scan_detail, storage_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uploadId,
    userId,
    conversation.id,
    storedFilename,
    originalName,
    path.extname(originalName).slice(1).toLowerCase() || 'bin',
    contentType ?? null,
    buffer.length,
    scan.status,
    scan.detail ?? null,
    relPath,
  );

  await pushMessage(lineUserId, [{
    type: 'text',
    text: `✅ 已收到「${originalName}」，可以直接提問，我會讀取這個檔案來回答。`,
  }]);
}

async function runConversation(lineUser: LineUserRow, message: string): Promise<void> {
  const userId = lineUser.internal_user_id;
  const lineUserId = lineUser.line_user_id;

  // Input safety — reuse exactly the same guard as web flow.
  const guard = analyzeInput(message);
  if (guard.blocked) {
    logSecurityEvent(userId, 'prompt_injection', 'high', `LINE input blocked (score=${guard.score}, flags=${guard.flags.join(',')})`, message);
    await pushMessage(lineUserId, [{
      type: 'text',
      text: '⚠️ 訊息內容被安全檢查阻擋，請改用其他敘述方式。',
    }]);
    return;
  }

  // Quota — reuse exactly the same accounting as web.
  const usage = await checkUserUsageLimit(userId);
  if (usage.exceeded) {
    await pushMessage(lineUserId, [{
      type: 'text',
      text: `⚠️ 本月用量已達上限 USD $${usage.limit.toFixed(2)}，請聯繫管理員調整或等下個月重置。`,
    }]);
    return;
  }

  // Team mode: if the user has switched to a team (and it still exists), route
  // the message through that team's collaboration instead of the single
  // assistant. Otherwise fall through to the rolling-assistant orchestrator.
  if (lineUser.active_team_id) {
    const team = await dbGet<{ id: string; title: string }>(
      'SELECT id, title FROM agent_teams WHERE id = ? AND user_id = ?',
      lineUser.active_team_id, userId,
    );
    if (team) {
      await runTeamForLine(lineUser, team, message);
      return;
    }
    // Team was deleted — drop back to solo silently and continue as assistant.
    await dbRun('UPDATE line_users SET active_team_id = NULL WHERE line_user_id = ?', lineUserId);
  }

  const conversation = await getOrCreateLineConversation(lineUser);

  // Persist the user message exactly as generate.ts does.
  await dbRun(
    'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
    uuidv4(), conversation.id, 'user', message,
  );

  // Start the "typing…" indicator best-effort — ignored if it fails.
  startLoadingIndicator(lineUserId, 30).catch(() => {});

  // Custom SSE sink: keep only the deltas we care about for LINE.
  let assistantText = '';
  const sseSink = (event: SSEEvent) => {
    if (event.type === 'text' && typeof event.data === 'string') {
      assistantText += event.data;
    }
    // file_generated events will be surfaced as share URLs in Phase D.
  };

  // Snapshot files already known for this conversation BEFORE the orchestrator
  // runs. Anything that appears in the sandbox after run() is a freshly
  // generated file that needs registering + a share token.
  const filesBefore = await getExistingFilePaths(conversation.id);

  // Uploaded files (no vector RAG): hand the conversation's uploads to the
  // orchestrator via uploadIds. getUserUploadsForPrompt / the rag-analyst
  // skill then let Claude read the files directly. Mirrors the web flow.
  const uploadRows = await dbAll<{ id: string }>(
    "SELECT id FROM user_uploads WHERE user_id = ? AND conversation_id = ? AND scan_status IN ('clean', 'suspicious') ORDER BY created_at DESC",
    userId, conversation.id,
  );
  const uploadIds = uploadRows.map(r => r.id);

  const orchestrator = new Orchestrator(
    userId,
    conversation.id,
    sseSink,
    uploadIds,     // uploaded files for this conversation — Claude reads them directly
    'zh-TW',
    'assistant',   // category — LINE bots get cross-assistant context
    '',            // referenceContext — vector RAG not used in this build
  );

  const result = await orchestrator.run(message);

  if (result.assistantText) {
    await dbRun(
      'INSERT INTO messages (id, conversation_id, role, content) VALUES (?, ?, ?, ?)',
      uuidv4(), conversation.id, 'assistant', result.assistantText,
    );
  }

  if (result.totalInputTokens > 0 || result.totalOutputTokens > 0) {
    await recordTokenUsage({
      userId,
      conversationId: conversation.id,
      inputTokens: result.totalInputTokens,
      outputTokens: result.totalOutputTokens,
      model: result.model,
    });
  }

  await touchLineUser(lineUserId, conversation.id);

  // Discover + register any new files the orchestrator wrote into the sandbox.
  // Mirrors generate.ts:370-378 except we mint a public share token per file
  // and surface them as a Flex card carousel instead of a plain-text URL list.
  let generatedFlex: LineMessage | null = null;
  try {
    const sandboxPath = getSandboxPath(userId, conversation.id);
    const newFiles = await registerNewFiles(userId, conversation.id, sandboxPath, filesBefore);
    if (newFiles.length > 0) {
      const shares = await Promise.all(
        newFiles.map(async (f): Promise<FileForFlex | null> => {
          try {
            const { url } = await createOrReuseFileShare({ fileId: f.id, userId });
            return {
              filename: f.filename,
              fileType: f.file_type,
              url,
              createdAt: f.created_at,
              sizeBytes: f.file_size ?? null,
            };
          } catch (err) {
            console.error('[LINE handler] file_share mint failed:', err);
            return null;
          }
        }),
      );
      const ok = shares.filter((s): s is FileForFlex => s !== null);
      if (ok.length > 0) generatedFlex = buildGeneratedFilesFlex(ok);
    }
  } catch (err) {
    console.error('[LINE handler] file discovery failed:', err);
  }

  // Compose the LINE reply: prefer Orchestrator's collected assistantText
  // (already final), fall back to whatever the sseWriter buffered (defensive
  // — should be equal but harmless).
  const baseText = (result.assistantText && result.assistantText.trim()) || assistantText.trim();
  const finalText = baseText || '（暫無回覆，請再試一次）';

  // Extract chart fence blocks so the JSON doesn't leak as text. Each chart
  // gets rendered to a PNG, saved into the sandbox, and pushed as a LINE
  // image message after the prose.
  const chartImages = await renderChartsForLine(userId, conversation.id, finalText);

  // LINE caps one push at 5 messages — text chunks share that budget with
  // the file-card Flex and any chart images.
  const totalNonText = (generatedFlex ? 1 : 0) + chartImages.length;
  const textBudget = Math.max(1, 5 - totalNonText);
  const textMessages = splitForLine(finalText).slice(0, textBudget);
  const messages: LineMessage[] = [...textMessages, ...chartImages.slice(0, 5 - textMessages.length)];
  if (generatedFlex && messages.length < 5) messages.push(generatedFlex);
  await pushMessage(lineUserId, messages.slice(0, 5));

  // Memory extraction — fire-and-forget, mirrors generate.ts:389.
  extractMemoryAndSummary(userId, conversation.id, 'zh-TW', 'assistant').catch(e =>
    console.error('[LINE handler] memory extraction failed:', e),
  );
}

/**
 * Team mode — run the user's active team's collaboration on the message and
 * push the synthesis back to LINE. Reuses the same headless `runTeam` engine
 * the scheduler uses (token usage is recorded inside runTeam). The run is also
 * recorded as a `team_runs` row, so it shows up in the team's web history; we
 * mint a public share token and append a "view full report" link (charts and
 * rich formatting live there, since LINE only gets plain text here).
 */
async function runTeamForLine(
  lineUser: LineUserRow,
  team: { id: string; title: string },
  message: string,
): Promise<void> {
  const userId = lineUser.internal_user_id;
  const lineUserId = lineUser.line_user_id;

  await pushMessage(lineUserId, [{
    type: 'text',
    text: `🧑‍🤝‍🧑 團隊「${team.title}」協作分析中，需要約 1～3 分鐘，完成後會把統整結論傳給你…`,
  }]);
  startLoadingIndicator(lineUserId, 60).catch(() => {});

  let result;
  try {
    result = await runTeam({ userId, teamId: team.id, question: message, writer: () => {} });
  } catch (err) {
    console.error('[LINE handler] team run failed:', err instanceof Error ? err.stack : err);
    await pushMessage(lineUserId, [{
      type: 'text',
      text: '⚠️ 團隊協作時發生問題，請稍後重試，或用 /solo 改回單一助手。',
    }]);
    return;
  }

  const finalText = (result.result && result.result.trim()) || '（團隊未產生結論，請再試一次）';

  // Render any chart fences in the synthesis to PNG images (no conversation —
  // stored per-user). Same treatment the single-assistant path gives charts.
  const chartImages = await renderChartsForLine(userId, null, finalText);

  // Mint a public share token for the run so the user can open the full,
  // chart-rich report on the web. Mirrors the scheduler's share-link approach.
  let shareUrl = '';
  try {
    const token = crypto.randomBytes(8).toString('hex');
    await dbRun('UPDATE team_runs SET share_token = ? WHERE id = ? AND share_token IS NULL', token, result.runId);
    const row = await dbGet<{ share_token: string | null }>('SELECT share_token FROM team_runs WHERE id = ?', result.runId);
    if (row?.share_token) shareUrl = `${config.line.publicApiBase}/share/team/${row.share_token}`;
  } catch (err) {
    console.error('[LINE handler] team share mint failed:', err);
  }

  // LINE budget is 5 messages, shared between text chunks, chart images, and
  // the web-report link. Prioritise text, then charts, then the link.
  const linkCount = shareUrl ? 1 : 0;
  const textBudget = Math.max(1, 5 - chartImages.length - linkCount);
  const textMessages = splitForLine(finalText).slice(0, textBudget);
  const messages: LineMessage[] = [...textMessages, ...chartImages.slice(0, 5 - textMessages.length - linkCount)];
  if (shareUrl && messages.length < 5) {
    messages.push({
      type: 'text',
      text: `🔗 在網頁看完整報告（含圖表）：\n${shareUrl}`,
    });
  }
  await pushMessage(lineUserId, messages.slice(0, 5));
}

/**
 * Find chart code fences in the assistant's reply, render each to a PNG,
 * persist it as a `generated_files` row + mint a public share URL, and
 * return them as LINE image messages. LINE caps at 4 image messages alongside
 * other content (5 total per push), so we hard-cap here at 4.
 *
 * Failures fall through silently — the textWithoutCharts already had the
 * raw JSON stripped by `splitForLine`, so users never see broken fences.
 */
async function renderChartsForLine(
  userId: string,
  conversationId: string | null,
  rawText: string,
): Promise<LineMessage[]> {
  const { charts } = extractChartBlocks(rawText);
  const renderable = charts.filter(c => (c.kind === 'chart' || c.kind === 'echart') && c.spec).slice(0, 4);
  if (renderable.length === 0) return [];

  // Team runs have no conversation — store their charts in a per-user dir and
  // leave generated_files.conversation_id NULL (the column is nullable).
  const chartsDir = conversationId
    ? path.join(getSandboxPath(userId, conversationId), '__charts')
    : path.join(config.workspaceRoot, userId, '__team_charts');
  fs.mkdirSync(chartsDir, { recursive: true });

  const messages: LineMessage[] = [];
  for (let i = 0; i < renderable.length; i++) {
    const block = renderable[i];
    try {
      const rendered = await renderChartToPng(block.spec);
      if (!rendered) continue;

      const stamp = String(Date.now() + i);
      const filename = `chart-${stamp}.png`;
      const absPath = path.join(chartsDir, filename);
      fs.writeFileSync(absPath, rendered.png);

      // file_path is stored relative to workspaceRoot so getFileDownloadPath
      // resolves it via the same validateFilePath check used for every other
      // sandboxed artifact.
      const relPath = path.relative(config.workspaceRoot, absPath);
      const fileId = uuidv4();
      await dbRun(
        `INSERT INTO generated_files
         (id, user_id, conversation_id, filename, file_path, file_type, file_size, version)
         VALUES (?, ?, ?, ?, ?, 'png', ?, 1)`,
        fileId, userId, conversationId, filename, relPath, rendered.png.length,
      );

      const { url } = await createOrReuseFileShare({ fileId, userId });
      messages.push({
        type: 'image',
        originalContentUrl: url,
        previewImageUrl: url,
      });
    } catch (err) {
      console.error('[LINE handler] chart render failed:', err);
    }
  }
  return messages;
}
