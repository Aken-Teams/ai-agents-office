import path from 'path';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { rebuildFile, patchFileField } from '../services/fileRebuilder.js';
import { regenerateBlock } from '../services/blockRegenerator.js';
import { agentEditDeck } from '../services/agentRebuilder.js';
import { captureBlocksForFile } from '../services/fileManager.js';
import { generateNarration } from '../services/docNarration.js';
import { moderateAiRequest } from '../services/contentSafety.js';
import { logSecurityEvent } from '../services/inputGuard.js';
import type { DocumentBlocksRecord, DocumentBlock, GeneratedFile } from '../types.js';

const router = Router();
router.use(authMiddleware);

// ---------------------------------------------------------------------------
// POST /api/blocks/:fileId/narration — produce per-page broadcast script lines
// for the document narrator (speaker button). pro-out deployments only.
// Frontend reads each line aloud (browser TTS) while following along page-by-page.
// ---------------------------------------------------------------------------
const NARRATION_TYPES = new Set(['pptx', 'pdf', 'docx']);
router.post('/:fileId/narration', async (req: Request, res: Response) => {
  if (config.deployMode !== 'pro-out') {
    res.status(403).json({ error: '此功能未開放' }); return;
  }
  const userId = req.user!.userId;
  const { fileId } = req.params;

  const file = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?', fileId, userId
  );
  if (!file) { res.status(404).json({ error: '找不到檔案' }); return; }
  if (!NARRATION_TYPES.has(file.file_type)) {
    res.status(400).json({ error: `不支援播報此類型：${file.file_type}` }); return;
  }

  // Load (or capture) the per-page block structure — same source the editor shows.
  let record = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?', fileId, userId
  );
  if (!record && file.conversation_id) {
    const sandboxPath = path.join(config.workspaceRoot, userId, file.conversation_id);
    try {
      await captureBlocksForFile(file, userId, file.conversation_id, sandboxPath);
      record = await dbGet<DocumentBlocksRecord>(
        'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?', fileId, userId
      );
    } catch { /* fall through to no-content */ }
  }
  if (!record) { res.status(404).json({ error: '沒有可播報的內容' }); return; }

  let blocks: DocumentBlock[] = [];
  try { blocks = JSON.parse(record.blocks); } catch { /* leave empty */ }
  blocks = blocks.filter(Boolean).sort((a, b) => a.order - b.order).slice(0, 40); // cap long docs
  if (!blocks.length) { res.status(404).json({ error: '沒有可播報的內容' }); return; }

  const narrations = await generateNarration(blocks, record.doc_type || file.file_type, userId);
  if (!narrations) { res.status(502).json({ error: '播報稿產生失敗，請稍後再試' }); return; }

  const segments = blocks.map((b, i) => ({
    blockId: b.id,
    label: (b.data as Record<string, unknown>)?.title as string
        || (b.data as Record<string, unknown>)?.heading as string
        || `第 ${i + 1} 頁`,
    text: narrations[i],
  }));
  res.json({ segments });
});

// ---------------------------------------------------------------------------
// GET /api/blocks/:fileId — Get block structure for a file
// ---------------------------------------------------------------------------
router.get('/:fileId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { fileId } = req.params;

  let record = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId
  );

  // If no blocks exist, try to capture them from the sandbox (for files created before block capture was added)
  if (!record) {
    const fileRecord = await dbGet<GeneratedFile>(
      'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
      fileId, userId
    );
    if (fileRecord && fileRecord.conversation_id) {
      const sandboxPath = path.join(config.workspaceRoot, userId, fileRecord.conversation_id);
      try {
        const blocks = await captureBlocksForFile(fileRecord, userId, fileRecord.conversation_id, sandboxPath);
        if (blocks) {
          record = await dbGet<DocumentBlocksRecord>(
            'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
            fileId, userId
          );
        }
      } catch (err) {
        console.error('[Blocks] Lazy capture failed:', err);
      }
    }
  }

  if (!record) {
    res.status(404).json({ error: 'No blocks found for this file' });
    return;
  }

  // Fix xlsx blocks with missing rows: re-extract from the actual .xlsx file
  if (record.doc_type === 'xlsx') {
    const blocks: DocumentBlock[] = JSON.parse(record.blocks);
    const needsFix = blocks.length > 0 && blocks.some(b => {
      const headers = (b.data as any).headers as any[] | undefined;
      const rows = (b.data as any).rows as any[][] | undefined;
      // No rows at all
      if (!rows || (Array.isArray(rows) && rows.length === 0)) return true;
      if (!Array.isArray(rows)) return false;
      // Object values (formula cells stored as { formula, result })
      if (rows.some((row: any[]) => Array.isArray(row) && row.some(cell => cell !== null && typeof cell === 'object')
      )) return true;
      // Columns that are ALL null while other columns have data (= uncomputed formulas)
      if (headers && headers.length > 0 && rows.length > 1) {
        for (let c = 0; c < headers.length; c++) {
          const allNull = rows.every(row => Array.isArray(row) && (row[c] == null || row[c] === ''));
          const otherColsHaveData = rows.some(row => Array.isArray(row) && row.some((cell, ci) => ci !== c && cell != null && cell !== ''));
          if (allNull && otherColsHaveData) return true;
        }
      }
      return false;
    });
    if (needsFix) {
      const fileRecord = await dbGet<GeneratedFile>(
        'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
        fileId, userId
      );
      if (fileRecord) {
        const filePath = path.join(config.workspaceRoot, fileRecord.file_path);
        try {
          const { extractBlocksFromXlsx } = await import('../services/fileManager.js');
          const extracted = await extractBlocksFromXlsx(filePath);
          if (extracted && extracted.length > 0) {
            // Merge: keep existing block ids but use extracted data
            const fixedBlocks = blocks.map((b, i) => {
              const source = extracted[i];
              if (source) {
                return { ...b, data: { ...b.data, ...source.data } };
              }
              return b;
            });
            await dbRun(
              'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
              JSON.stringify(fixedBlocks), record.id
            );
            console.log(`[Blocks] Fixed ${fixedBlocks.length} xlsx blocks (missing/broken data) for file ${fileId}`);
            record = await dbGet<DocumentBlocksRecord>(
              'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
              fileId, userId
            );
          }
        } catch (err) {
          console.error('[Blocks] Failed to fix xlsx blocks:', err);
        }
      }
    }
  }

  res.json({
    id: record!.id,
    fileId: record!.file_id,
    docType: record!.doc_type,
    meta: record!.doc_meta ? JSON.parse(record!.doc_meta) : {},
    blocks: JSON.parse(record!.blocks) as DocumentBlock[],
    version: record!.version,
    createdAt: record!.created_at,
    updatedAt: record!.updated_at,
  });
});

// ---------------------------------------------------------------------------
// GET /api/blocks/conversation/:conversationId — Get all blocks in a conversation
// ---------------------------------------------------------------------------
router.get('/conversation/:conversationId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { conversationId } = req.params;

  const records = await dbAll<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE conversation_id = ? AND user_id = ? ORDER BY created_at DESC',
    conversationId, userId
  );

  res.json(records.map(r => ({
    id: r.id,
    fileId: r.file_id,
    docType: r.doc_type,
    meta: r.doc_meta ? JSON.parse(r.doc_meta) : {},
    blocks: JSON.parse(r.blocks) as DocumentBlock[],
    version: r.version,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })));
});

// ---------------------------------------------------------------------------
// PUT /api/blocks/:fileId — Update entire blocks array (reorder / batch edit)
// ---------------------------------------------------------------------------
router.put('/:fileId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { fileId } = req.params;
  const { blocks, meta } = req.body as { blocks?: DocumentBlock[]; meta?: Record<string, unknown> };

  const record = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId
  );
  if (!record) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Update blocks and/or meta
  const updatedBlocks = blocks || JSON.parse(record.blocks);
  const updatedMeta = meta !== undefined ? JSON.stringify(meta) : record.doc_meta;

  await dbRun(
    'UPDATE document_blocks SET blocks = ?, doc_meta = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    JSON.stringify(updatedBlocks), updatedMeta, record.id
  );

  res.json({ success: true, blocks: updatedBlocks });
});

// ---------------------------------------------------------------------------
// PUT /api/blocks/:fileId/block/:blockId — Update a single block
// ---------------------------------------------------------------------------
router.put('/:fileId/block/:blockId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { fileId, blockId } = req.params;
  const { data, type } = req.body as { data?: Record<string, unknown>; type?: string };

  const record = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId
  );
  if (!record) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const blocks: DocumentBlock[] = JSON.parse(record.blocks);
  const block = blocks.find(b => b.id === blockId);
  if (!block) {
    res.status(404).json({ error: 'Block not found' });
    return;
  }

  if (data) block.data = data;
  if (type) block.type = type;

  await dbRun(
    'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    JSON.stringify(blocks), record.id
  );

  res.json({ success: true, block });
});

// ---------------------------------------------------------------------------
// DELETE /api/blocks/:fileId/block/:blockId — Delete a block
// ---------------------------------------------------------------------------
router.delete('/:fileId/block/:blockId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { fileId, blockId } = req.params;

  const record = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId
  );
  if (!record) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  let blocks: DocumentBlock[] = JSON.parse(record.blocks);
  blocks = blocks.filter(b => b.id !== blockId);

  // Re-index order
  blocks.forEach((b, i) => { b.order = i; });

  await dbRun(
    'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    JSON.stringify(blocks), record.id
  );

  res.json({ success: true, blocks });
});

// ---------------------------------------------------------------------------
// POST /api/blocks/:fileId/block — Add a new block
// ---------------------------------------------------------------------------
router.post('/:fileId/block', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const { fileId } = req.params;
  const { type, data, insertAfter } = req.body as {
    type: string;
    data: Record<string, unknown>;
    insertAfter?: string; // blockId to insert after, or omit for end
  };

  if (!type || !data) {
    res.status(400).json({ error: 'type and data are required' });
    return;
  }

  const record = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId
  );
  if (!record) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const blocks: DocumentBlock[] = JSON.parse(record.blocks);
  const newBlock: DocumentBlock = {
    id: uuidv4(),
    type,
    order: blocks.length,
    data,
  };

  if (insertAfter) {
    const idx = blocks.findIndex(b => b.id === insertAfter);
    if (idx >= 0) {
      blocks.splice(idx + 1, 0, newBlock);
    } else {
      blocks.push(newBlock);
    }
  } else {
    blocks.push(newBlock);
  }

  // Re-index order
  blocks.forEach((b, i) => { b.order = i; });

  await dbRun(
    'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    JSON.stringify(blocks), record.id
  );

  res.json({ success: true, block: newBlock, blocks });
});

// ---------------------------------------------------------------------------
// POST /api/blocks/:fileId/patch — In-place text patching (preserves formatting)
// ---------------------------------------------------------------------------
router.post('/:fileId/patch', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const fileId = req.params.fileId as string;
  const { blockId, key, value } = req.body as { blockId: string; key: string; value: unknown };

  if (!blockId || !key) {
    res.status(400).json({ error: 'blockId and key are required' });
    return;
  }

  try {
    const updatedFile = await patchFileField(fileId, userId, blockId, key, value);
    if (!updatedFile) {
      res.status(500).json({ error: 'Failed to patch file' });
      return;
    }
    res.json({ success: true, file: updatedFile });
  } catch (err: any) {
    console.error('[Blocks] Patch error:', err);
    res.status(500).json({ error: err.message || 'Patch failed' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/blocks/:fileId/rebuild — Rebuild file using pptx-gen worker agent (SSE)
// Uses the same multi-agent quality as left-side chat generation.
// Falls back to fast rebuild (shared generator) for non-SSE requests.
// ---------------------------------------------------------------------------
router.post('/:fileId/rebuild', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const fileId = req.params.fileId as string;
  // Optional whole-deck style request: re-render all slides in a new look while
  // keeping every slide's content. Empty → plain rebuild with the existing style.
  const instruction = typeof req.body?.instruction === 'string' ? req.body.instruction.trim().slice(0, 500) : '';

  // Content safety on the user's free-text style/edit instruction (this route
  // previously had no guard at all). Skip when empty (plain rebuild).
  if (instruction) {
    const v = await moderateAiRequest(instruction, '無法處理這個編輯需求', { userId });
    if (!v.allowed) {
      logSecurityEvent(userId, 'blocked_request', 'high', `block-rebuild blocked (category=${v.category})`, instruction);
      res.status(403).json({ error: v.reason }); return;
    }
  }

  // Only PPTX uses the heavy (and sometimes flaky) agent rebuild. DOCX/XLSX
  // re-render deterministically via the shared generator — fast and reliable.
  const blockRec = await dbGet<{ doc_type: string }>(
    'SELECT doc_type FROM document_blocks WHERE file_id = ? AND user_id = ?', fileId, userId,
  );
  const docType = blockRec?.doc_type || 'pptx';

  const acceptsSSE = req.headers.accept?.includes('text/event-stream');

  if (acceptsSSE) {
    // SSE mode: stream agent progress to client
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* closed */ }
    }, 10000);

    const emit = (event: any) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ }
    };

    // PPTX rebuild goes through the SAME full-agent flow as single-page edits and
    // the left-side chat: resume the session, edit the original build script,
    // re-run → whole deck regenerated with only the requested visual change.
    const pptxRebuildInstruction = instruction
      ? `請將整份簡報重新美化，並套用以下調整:${instruction}。保留所有頁面的文字內容、數據與結構完全不變,只調整視覺設計(版面、配色、元素)。`
      : '請重新美化整份簡報的視覺設計(讓版面更精緻、配色更協調、元素更專業),所有頁面的文字內容與數據完全保持不變。';

    const rebuildRun: Promise<unknown> = docType === 'pptx'
      ? agentEditDeck(fileId, userId, pptxRebuildInstruction, emit)
      : (async () => {
          // DOCX/XLSX/SLIDES: deterministic re-render via the shared generator (now
          // schema-aligned with the editor blocks, incl. tables/lists/content).
          emit({ type: 'started' });
          // "美編/換風格" = pick a style/theme preset. The frontend sends a style
          // key as instruction; generate-slides.ts / docx generator read meta.style.
          const STYLE_KEYS = ['formal', 'modern', 'academic', 'compact'];
          // generate-slides.ts themes (doc_type='slides').
          const SLIDES_STYLES = ['editorial', 'minimal', 'dark', 'gradient', 'neon', 'corporate', 'creative', 'elegant', 'tech'];
          const styleLabelMap: Record<string, string> = {
            專業: 'formal', 端莊: 'formal', 正式: 'formal', 現代: 'modern', 簡約: 'modern',
            學術: 'academic', 精簡: 'compact', 緊湊: 'compact',
          };
          let styleKey = '';
          const instr = instruction.trim().toLowerCase();
          if (docType === 'slides' && SLIDES_STYLES.includes(instr)) styleKey = instr;
          else if (STYLE_KEYS.includes(instr)) styleKey = instr;
          else for (const [zh, key] of Object.entries(styleLabelMap)) { if (instruction.includes(zh)) { styleKey = key; break; } }
          if (styleKey) {
            const rec = await dbGet<{ id: string; doc_meta: string | null }>(
              'SELECT id, doc_meta FROM document_blocks WHERE file_id = ? AND user_id = ?', fileId, userId,
            );
            if (rec) {
              const m = rec.doc_meta ? JSON.parse(rec.doc_meta) : {};
              m.style = styleKey;
              // Mark as a USER-explicit theme choice so generate-slides honors it
              // even under the editorial house-style lock (slides only; harmless for docx).
              if (docType === 'slides') m.styleOverride = true;
              await dbRun('UPDATE document_blocks SET doc_meta = ? WHERE id = ?', JSON.stringify(m), rec.id);
            }
          }
          const f = await rebuildFile(fileId, userId);
          if (f) { emit({ type: 'file_ready', data: { file: f } }); emit({ type: 'done', data: { file: f } }); }
          return f;
        })();
    rebuildRun
      .then(result => {
        if (!result) {
          emit({ type: 'error', data: 'Rebuild failed' });
        }
      })
      .catch(err => {
        console.error('[Blocks] Rebuild error:', err);
        emit({ type: 'error', data: String(err) });
      })
      .finally(() => {
        clearInterval(keepalive);
        try { res.end(); } catch {}
      });
  } else {
    // Non-SSE fallback: use fast shared-generator rebuild
    try {
      const newFile = await rebuildFile(fileId, userId);
      if (!newFile) {
        res.status(500).json({ error: 'Failed to rebuild file' });
        return;
      }
      res.json({ success: true, file: newFile });
    } catch (err: any) {
      console.error('[Blocks] Rebuild error:', err);
      res.status(500).json({ error: err.message || 'Rebuild failed' });
    }
  }
});

// ---------------------------------------------------------------------------
// POST /api/blocks/:fileId/regenerate/:blockId — AI partial regeneration (SSE)
// Streams real-time events so the frontend can show AI activity.
// Falls back to fire-and-forget if client doesn't accept SSE.
// ---------------------------------------------------------------------------
const activeRegenerations = new Map<string, boolean>();

router.post('/:fileId/regenerate/:blockId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const fileId = req.params.fileId as string;
  const blockId = req.params.blockId as string;
  const { instruction, answerOnly } = req.body as { instruction: string; answerOnly?: boolean };

  if (!instruction) {
    res.status(400).json({ error: 'instruction is required' });
    return;
  }

  // Content safety — the block edit / Q&A instruction is user free-text reaching
  // an LLM with no prior guard. Refuse crime / system-internals probing / etc.
  const safety = await moderateAiRequest(instruction, answerOnly ? '無法回答這個問題' : '無法處理這個編輯需求', { userId });
  if (!safety.allowed) {
    logSecurityEvent(userId, 'blocked_request', 'high', `block-regen blocked (category=${safety.category})`, instruction);
    res.status(403).json({ error: safety.reason });
    return;
  }

  // Prevent duplicate concurrent regeneration of the same block
  const regenKey = `${fileId}:${blockId}`;
  if (activeRegenerations.get(regenKey)) {
    res.status(409).json({ error: 'Regeneration already in progress for this block' });
    return;
  }

  // Answer-only (Q&A) never mutates the block — skip the "regenerating" marker.
  // Mark block as regenerating in DB immediately
  if (!answerOnly) try {
    const blockRecord = await dbGet<DocumentBlocksRecord>(
      'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
      fileId, userId,
    );
    if (blockRecord) {
      const blocks: DocumentBlock[] = JSON.parse(blockRecord.blocks);
      const block = blocks.find(b => b.id === blockId);
      if (block) {
        block.status = 'regenerating';
        await dbRun(
          'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          JSON.stringify(blocks), blockRecord.id,
        );
      }
    }
  } catch {}

  activeRegenerations.set(regenKey, true);

  // SSE mode: stream real-time events to the client
  const acceptsSSE = req.headers.accept?.includes('text/event-stream');
  if (acceptsSSE) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const keepalive = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch { /* closed */ }
    }, 10000);

    const emit = (event: any) => {
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { /* closed */ }
    };

    regenerateBlock(fileId, blockId, userId, instruction, emit, answerOnly)
      .then(result => {
        if (answerOnly) {
          console.log(`[Blocks] Answer-only response complete for block ${blockId}`);
        } else if (result) {
          console.log(`[Blocks] Regeneration complete for block ${blockId}`);
        } else {
          console.error(`[Blocks] Regeneration returned null for block ${blockId}`);
        }
      })
      .catch(err => {
        console.error('[Blocks] SSE regeneration error:', err);
        emit({ type: 'error', data: String(err) });
      })
      .finally(() => {
        activeRegenerations.delete(regenKey);
        clearInterval(keepalive);
        try { res.end(); } catch {}
      });
    return;
  }

  // Non-SSE fallback: respond immediately, run in background
  res.json({ success: true, started: true });

  regenerateBlock(fileId, blockId, userId, instruction, undefined, answerOnly)
    .then(result => {
      if (result) {
        console.log(`[Blocks] Regeneration complete for block ${blockId}`);
      } else {
        console.error(`[Blocks] Regeneration returned null for block ${blockId}`);
      }
    })
    .catch(err => {
      console.error('[Blocks] Background regeneration error:', err);
      // Reset block status on unhandled failure
      dbGet<DocumentBlocksRecord>(
        'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
        fileId, userId,
      ).then(rec => {
        if (!rec) return;
        const blocks: DocumentBlock[] = JSON.parse(rec.blocks);
        const b = blocks.find(x => x.id === blockId);
        if (b && b.status === 'regenerating') {
          b.status = 'idle';
          dbRun('UPDATE document_blocks SET blocks = ? WHERE id = ?', JSON.stringify(blocks), rec.id);
        }
      }).catch(() => {});
    })
    .finally(() => {
      activeRegenerations.delete(regenKey);
    });
});

export default router;
