import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbRun } from '../db.js';
import { spawnClaude } from './claudeCli.js';
import { patchBlockInPlace } from './fileRebuilder.js';
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
    'You are a document block editor. Modify a single block based on user instructions.',
    '',
    `Document type: ${blockRecord.doc_type}`,
    `Document title: ${meta.title || 'Untitled'}`,
    `Block type: ${targetBlock.type}`,
    '',
    'AVAILABLE STYLE FIELDS (for visual/style changes, apply ALL relevant ones for a cohesive theme):',
    '- backgroundColor: slide background hex color (e.g. "#FFC0CB" for pink)',
    '- textColor: main text color (ensure high contrast with backgroundColor)',
    '- accentColor: accent elements like bars, highlights, dividers',
    '- accentColor2: secondary accent for panel backgrounds',
    '- titleColor: heading/title text color',
    '- subtitleColor: subtitle text color',
    '',
    'STYLE TIPS:',
    '- For style/theme requests (e.g. "粉色風格", "dark mode"), change MULTIPLE color fields as a cohesive palette',
    '- Always ensure text readability (sufficient contrast between text and background)',
    '- You may add style fields that don\'t exist yet in the current data',
    '',
    'SLIDE SHAPES CONTEXT:',
    '- The instruction may start with [投影片元素: ...] listing the visual shapes on the slide (e.g., "Title 1(text), Chart 1(chart), Chart 2(chart)").',
    '- These shapes represent what the user SEES on the rendered slide. They map to data fields as follows:',
    '  - text shapes → title, subtitle, bullets, content fields',
    '  - chart shapes → chart objects in data (e.g., lineChart, doughnut, barChart), or KPIs rendered as charts by the template',
    '  - table shapes → rows/headers fields',
    '  - picture shapes → imageSrc field',
    '- IMPORTANT: For "stats" type blocks, the PPTX template renders KPIs as visual charts. So "Chart 1" may correspond to the kpis array, not a separate chart field.',
    '',
    'TARGETED ELEMENT EDITING:',
    '- If the instruction contains [目標元素: xxx], focus changes on ONLY that specific element.',
    '- The target can be a data field key (e.g., "chart", "lineChart", "kpis") or a shape name (e.g., "Chart 1", "Title 1").',
    '- For shape names, use the shapes context above to identify which data field drives that visual element.',
    '- Keep all other fields unchanged when a target element is specified.',
    '',
    'RULES:',
    '1. Return ONLY a valid JSON object (the updated block data).',
    '2. Do NOT wrap in markdown code fences or any other text.',
    '3. Preserve content fields (title, bullets, etc.) unless user explicitly asks to change them.',
    '4. For style/theme requests, apply changes holistically across all relevant style fields.',
    '5. When a target element is specified, ONLY modify that element.',
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

          // Extract JSON from response (handle potential markdown fences)
          let jsonStr = responseText.trim();
          const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
          if (fenceMatch) jsonStr = fenceMatch[1].trim();

          const updatedData = JSON.parse(jsonStr);
          const dataChanged = JSON.stringify(oldData) !== JSON.stringify(updatedData);
          console.log(`[BlockRegenerator] Data changed: ${dataChanged}, oldKeys: [${Object.keys(oldData).join(',')}], newKeys: [${Object.keys(updatedData).join(',')}]`);
          if (!dataChanged) {
            console.log(`[BlockRegenerator] WARNING: AI returned identical data. Instruction was: "${instruction}"`);
          }

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
          // If AI returned identical data, the file may be out of sync from a previous
          // failed patch. Force-sync by passing empty oldData so all patchable fields
          // are treated as "changed" and applied to the file.
          const patchOld = dataChanged ? oldData : {};
          const patched = await patchBlockInPlace(
            fileId, userId, targetBlock.order, patchOld, updatedData, blockRecord.doc_type,
          );

          let newFile: GeneratedFile | null = null;
          if (!patched) {
            // Cannot patch in-place (unsupported doc type or fields).
            // Do NOT fallback to rebuildFile() here — it destroys all other slides/pages.
            // Block data is already saved in DB; user can manually trigger full rebuild if needed.
            console.log(`[BlockRegenerator] In-place patch not supported for this change. Block data updated in DB only.`);
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
