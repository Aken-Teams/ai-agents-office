/**
 * BullMQ worker — extracts text from an uploaded file, indexes it into the
 * user's personal RAG store, and pushes a status message back to LINE.
 *
 * The LINE handler enqueues a job after downloading the file via the
 * Content API; this worker owns the heavy work (parse + embed + insert)
 * so the chat worker isn't blocked.
 */

import path from 'path';
import { config } from '../config.js';
import { extractText } from '../services/textExtract.js';
import { indexDocument } from '../services/personalRag.js';
import { pushMessage } from '../services/line/client.js';
import type { EmbedJob } from '../services/queue.js';

export async function runEmbedJob(job: EmbedJob): Promise<void> {
  const absolutePath = path.isAbsolute(job.storagePath)
    ? job.storagePath
    : path.join(config.workspaceRoot, job.storagePath);

  // LINE uploads push status back to chat; web uploads (no lineUserId) skip it.
  const notify = async (text: string) => {
    if (!job.lineUserId) return;
    try { await pushMessage(job.lineUserId, [{ type: 'text', text }]); }
    catch { /* ignore push failures */ }
  };

  try {
    const extracted = await extractText(absolutePath);

    if (!extracted.text.trim()) {
      await notify(`⚠️ 「${job.filename}」沒抽到可索引的文字${extracted.warning ? `\n（${extracted.warning}）` : ''}`);
      return;
    }

    const result = await indexDocument({
      userId: job.userId,
      filename: job.filename,
      fileType: extracted.fileType,
      text: extracted.text,
      sourceUploadId: job.sourceUploadId,
    });

    const lines = [`✅ 「${job.filename}」已加入您的知識庫`];
    lines.push(`   ${result.chunkCount} 段 · ${extracted.chars.toLocaleString()} 字`);
    if (extracted.warning) lines.push(`   備註：${extracted.warning}`);
    lines.push('');
    lines.push('您可以接著直接問我相關問題，我會優先參考這份文件作答。');

    await notify(lines.join('\n'));
  } catch (err) {
    console.error(`[EmbedWorker] failed for user=${job.userId} file=${job.filename}:`, err);
    await notify(`⚠️ 索引「${job.filename}」失敗：${(err as Error).message.slice(0, 200)}`);
    throw err; // let BullMQ mark the job failed
  }
}
