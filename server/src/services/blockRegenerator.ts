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
    'You are a JSON block editor. You receive a JSON block and modify it per the user instruction.',
    '',
    `Document: ${blockRecord.doc_type} — "${meta.title || 'Untitled'}"`,
    `Block type: ${targetBlock.type}`,
    '',
    'CRITICAL: Your entire response must be a single valid JSON object. No text, no markdown, no explanation.',
    '',
    'Style fields you may use: backgroundColor, textColor, accentColor, accentColor2, titleColor, subtitleColor.',
    'For style/theme requests, change multiple color fields as a cohesive palette with good contrast.',
    '',
    'Shape-to-data mapping (when visual shapes are mentioned):',
    '- text shapes → title, subtitle, bullets, content',
    '- chart shapes → chart objects (lineChart, doughnut, barChart) or kpis array (for "stats" type blocks)',
    '- table shapes → rows/headers',
    '- picture shapes → imageSrc',
    '',
    'When a target element is specified, ONLY modify that element. Keep all other fields unchanged.',
    'Preserve all fields unless the user explicitly asks to change them.',
  ].join('\n');

  // Parse metadata prefixes out of instruction so they don't confuse the AI
  let cleanInstruction = instruction;
  let shapesContext = '';
  let targetElement = '';

  const shapesMatch = cleanInstruction.match(/^\[投影片元素:\s*([^\]]+)\]\s*/);
  if (shapesMatch) {
    shapesContext = shapesMatch[1].trim();
    cleanInstruction = cleanInstruction.slice(shapesMatch[0].length);
  }
  const targetMatch = cleanInstruction.match(/^\[目標元素:\s*([^\]]+)\]\s*/);
  if (targetMatch) {
    targetElement = targetMatch[1].trim();
    cleanInstruction = cleanInstruction.slice(targetMatch[0].length);
  }

  const userMessageParts = [
    'Current block data:',
    '```json',
    JSON.stringify(targetBlock.data, null, 2),
    '```',
  ];
  if (shapesContext) {
    userMessageParts.push('', `Visual shapes on this slide: ${shapesContext}`);
  }
  if (targetElement) {
    userMessageParts.push('', `Target element to modify: ${targetElement}`);
  }
  userMessageParts.push('', `User instruction: ${cleanInstruction}`, '', 'Return the updated block JSON only.');

  const userMessage = userMessageParts.join('\n');

  send({ type: 'started' });

  // Spawn a one-shot Claude agent
  return new Promise((resolve) => {
    let responseText = '';

    const result = spawnClaude(userMessage, systemPrompt, {
      userId,
      conversationId: blockRecord.conversation_id,
      role: 'router', // No tools needed, just text generation
      sandboxSubdir: '_agents/_block-editor',
      model: 'claude-sonnet-4-6', // Balanced: good quality + reasonable speed for single-block edits
    });

    let resolved = false;
    result.emitter.on('event', async (event: any) => {
      if (resolved) return; // Prevent processing after resolve
      if (event.type === 'text') {
        responseText += event.data;
        send({ type: 'ai_text', data: event.data });
      } else if (event.type === 'error') {
        console.error('[BlockRegenerator] AI error:', event.data);
        send({ type: 'error', data: String(event.data) });
        resolved = true;
        resolve(null);
      } else if (event.type === 'done') {
        try {
          console.log(`[BlockRegenerator] Raw responseText (${responseText.length} chars): ${responseText.substring(0, 500)}`);

          if (!responseText.trim()) {
            throw new Error('AI returned empty response');
          }

          // Extract JSON from response — try multiple strategies
          let jsonStr = responseText.trim();

          // Strategy 1: markdown code fences
          const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fenceMatch) jsonStr = fenceMatch[1].trim();

          let updatedData: Record<string, unknown>;
          try {
            updatedData = JSON.parse(jsonStr);
          } catch {
            // Strategy 2: find the outermost {...} in the response
            const braceStart = responseText.indexOf('{');
            const braceEnd = responseText.lastIndexOf('}');
            if (braceStart !== -1 && braceEnd > braceStart) {
              const extracted = responseText.slice(braceStart, braceEnd + 1);
              console.log(`[BlockRegenerator] Direct parse failed, trying brace extraction (${braceStart}..${braceEnd})`);
              updatedData = JSON.parse(extracted); // Will throw if still invalid
            } else {
              throw new Error('No JSON object found in AI response');
            }
          }
          const dataChanged = JSON.stringify(oldData) !== JSON.stringify(updatedData);
          console.log(`[BlockRegenerator] Data changed: ${dataChanged}, oldKeys: [${Object.keys(oldData).join(',')}], newKeys: [${Object.keys(updatedData).join(',')}]`);
          if (!dataChanged) {
            console.log(`[BlockRegenerator] WARNING: AI returned identical data. Instruction was: "${instruction}"`);
          }

          // Update the block in the array
          targetBlock.data = updatedData;
          if (updatedData.type) targetBlock.type = updatedData.type as string;

          // Save updated blocks to DB
          await dbRun(
            'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            JSON.stringify(blocks), blockRecord.id
          );

          // Immediately emit block_updated so frontend can show new content
          send({ type: 'block_updated', data: { block: targetBlock, blocks } });

          // Patch file in-place (fast: just XML manipulation, no generator script)
          send({ type: 'patching' });
          // If AI returned identical data, the file may be out of sync from a previous
          // failed patch. Force-sync by passing empty oldData so all patchable fields
          // are treated as "changed" and applied to the file.
          const patchOld = dataChanged ? oldData : {};
          const patched = await patchBlockInPlace(
            fileId, userId, targetBlock.order, patchOld, updatedData, blockRecord.doc_type,
          );

          let newFile: GeneratedFile | null = null;
          if (!patched) {
            // Non-patchable fields changed (e.g. chart, kpis, steps) → full rebuild from blocks
            console.log(`[BlockRegenerator] In-place patch not supported, triggering full rebuild...`);
            try {
              newFile = await rebuildFile(fileId, userId);
              if (newFile) {
                console.log(`[BlockRegenerator] Rebuild successful: ${newFile.filename}`);
              } else {
                console.warn(`[BlockRegenerator] Rebuild returned null — block data updated in DB only.`);
              }
            } catch (rebuildErr) {
              console.error(`[BlockRegenerator] Rebuild failed:`, rebuildErr);
            }
          }

          // Mark as idle
          targetBlock.status = 'idle';
          await dbRun(
            'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
            JSON.stringify(blocks), blockRecord.id
          );

          send({ type: 'done', data: { block: targetBlock, blocks } });
          resolved = true;
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
          resolved = true;
          resolve(null);
        }
      }
    });
  });
}
