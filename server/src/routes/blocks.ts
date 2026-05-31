import path from 'path';
import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbAll, dbRun } from '../db.js';
import { authMiddleware } from '../middleware/auth.js';
import { config } from '../config.js';
import { rebuildFile } from '../services/fileRebuilder.js';
import { regenerateBlock } from '../services/blockRegenerator.js';
import { captureBlocksForFile } from '../services/fileManager.js';
import type { DocumentBlocksRecord, DocumentBlock, GeneratedFile } from '../types.js';

const router = Router();
router.use(authMiddleware);

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

  res.json({
    id: record.id,
    fileId: record.file_id,
    docType: record.doc_type,
    meta: record.doc_meta ? JSON.parse(record.doc_meta) : {},
    blocks: JSON.parse(record.blocks) as DocumentBlock[],
    version: record.version,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
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
// POST /api/blocks/:fileId/rebuild — Rebuild file from current blocks
// ---------------------------------------------------------------------------
router.post('/:fileId/rebuild', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const fileId = req.params.fileId as string;

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
});

// ---------------------------------------------------------------------------
// POST /api/blocks/:fileId/regenerate/:blockId — AI partial regeneration
// ---------------------------------------------------------------------------
router.post('/:fileId/regenerate/:blockId', async (req: Request, res: Response) => {
  const userId = req.user!.userId;
  const fileId = req.params.fileId as string;
  const blockId = req.params.blockId as string;
  const { instruction } = req.body as { instruction: string };

  if (!instruction) {
    res.status(400).json({ error: 'instruction is required' });
    return;
  }

  try {
    const result = await regenerateBlock(fileId, blockId, userId, instruction);
    if (!result) {
      res.status(500).json({ error: 'Failed to regenerate block' });
      return;
    }

    res.json({
      success: true,
      block: result.updatedBlock,
      file: result.newFile,
    });
  } catch (err: any) {
    console.error('[Blocks] Regenerate error:', err);
    res.status(500).json({ error: err.message || 'Regeneration failed' });
  }
});

export default router;
