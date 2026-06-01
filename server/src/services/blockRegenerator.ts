import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbRun } from '../db.js';
import { spawnClaude } from './claudeCli.js';
import { patchBlockInPlace, rebuildFile } from './fileRebuilder.js';
import type { DocumentBlocksRecord, DocumentBlock, GeneratedFile } from '../types.js';

export type RegenEvent =
  | { type: 'started' }
  | { type: 'ai_text'; data: string }
  | { type: 'block_updated'; data: { block: DocumentBlock; blocks: DocumentBlock[] } }
  | { type: 'patching' }
  | { type: 'done'; data: { block: DocumentBlock; blocks: DocumentBlock[] } }
  | { type: 'error'; data: string };

/**
 * Regenerate a single block using AI, then patch the file in-place.
 * Accepts an optional `emit` callback for SSE streaming.
 *
 * Flow:
 * 1. Load block record from DB
 * 2. Extract the target block
 * 3. Spawn a focused Claude agent to regenerate just that block's JSON
 * 4. Parse AI response → emit block_updated → update block data in DB
 * 5. Patch changed fields in-place (fast!) — fallback to full rebuild if unsupported
 */
export async function regenerateBlock(
  fileId: string,
  blockId: string,
  userId: string,
  instruction: string,
  emit?: (event: RegenEvent) => void,
): Promise<{ updatedBlock: DocumentBlock; newFile: GeneratedFile | null } | null> {
  const send = emit || (() => {});

  // Load block record
  const blockRecord = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId
  );
  if (!blockRecord) {
    send({ type: 'error', data: 'Block record not found' });
    return null;
  }

  const blocks: DocumentBlock[] = JSON.parse(blockRecord.blocks);
  const targetBlock = blocks.find(b => b.id === blockId);
  if (!targetBlock) {
    send({ type: 'error', data: 'Block not found' });
    return null;
  }

  const meta = blockRecord.doc_meta ? JSON.parse(blockRecord.doc_meta) : {};
  const oldData = { ...targetBlock.data }; // Snapshot before AI modifies it

  // Build a focused prompt for single-block regeneration
  const systemPrompt = [
    'You are a document block editor. Your job is to modify a single block of a document based on user instructions.',
    '',
    `Document type: ${blockRecord.doc_type}`,
    `Document title: ${meta.title || 'Untitled'}`,
    `Block type: ${targetBlock.type}`,
    '',
    'IMPORTANT RULES:',
    '1. Return ONLY a valid JSON object representing the updated block data.',
    '2. Do NOT wrap the output in markdown code fences or any other text.',
    '3. Preserve the same schema/structure as the input block.',
    '4. Only modify what the user asks for.',
    '5. Keep all existing fields unless explicitly asked to remove them.',
  ].join('\n');

  const userMessage = [
    'Current block data:',
    '```json',
    JSON.stringify(targetBlock.data, null, 2),
    '```',
    '',
    `User instruction: ${instruction}`,
    '',
    'Return the updated block JSON only.',
  ].join('\n');

  send({ type: 'started' });

  // Spawn a one-shot Claude agent
  return new Promise((resolve) => {
    let responseText = '';

    const result = spawnClaude(userMessage, systemPrompt, {
      userId,
      conversationId: blockRecord.conversation_id,
      role: 'router', // No tools needed, just text generation
      sandboxSubdir: '_agents/_block-editor',
      model: 'claude-haiku-4-5-20251001', // Fast model for single-block edits
    });

    result.emitter.on('text', (chunk: string) => {
      responseText += chunk;
      send({ type: 'ai_text', data: chunk });
    });

    result.emitter.on('error', (err: any) => {
      console.error('[BlockRegenerator] AI error:', err);
      send({ type: 'error', data: String(err) });
      resolve(null);
    });

    result.emitter.on('done', async () => {
      try {
        // Extract JSON from response (handle potential markdown fences)
        let jsonStr = responseText.trim();
        const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (fenceMatch) jsonStr = fenceMatch[1].trim();

        const updatedData = JSON.parse(jsonStr);

        // Update the block in the array
        targetBlock.data = updatedData;
        if (updatedData.type) targetBlock.type = updatedData.type;

        // Save updated blocks to DB
        await dbRun(
          'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          JSON.stringify(blocks), blockRecord.id
        );

        // Immediately emit block_updated so frontend can show new content
        send({ type: 'block_updated', data: { block: targetBlock, blocks } });

        // Patch file in-place (fast: just XML manipulation, no generator script)
        send({ type: 'patching' });
        const patched = await patchBlockInPlace(
          fileId, userId, targetBlock.order, oldData, updatedData, blockRecord.doc_type,
        );

        let newFile: GeneratedFile | null = null;
        if (!patched) {
          // Fallback to full rebuild for unsupported doc types
          console.log(`[BlockRegenerator] In-place patch not supported, falling back to full rebuild`);
          newFile = await rebuildFile(fileId, userId);
        }

        // Mark as idle
        targetBlock.status = 'idle';
        await dbRun(
          'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          JSON.stringify(blocks), blockRecord.id
        );

        send({ type: 'done', data: { block: targetBlock, blocks } });
        resolve({ updatedBlock: targetBlock, newFile });
      } catch (err) {
        console.error('[BlockRegenerator] Failed to parse AI response:', err);
        console.error('[BlockRegenerator] Raw response:', responseText);
        // Reset status on failure
        targetBlock.status = 'idle';
        await dbRun(
          'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          JSON.stringify(blocks), blockRecord.id
        ).catch(() => {});
        send({ type: 'error', data: 'Failed to parse AI response' });
        resolve(null);
      }
    });
  });
}
