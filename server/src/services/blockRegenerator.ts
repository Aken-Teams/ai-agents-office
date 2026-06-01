import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbRun } from '../db.js';
import { spawnClaude } from './claudeCli.js';
import { patchBlockInPlace } from './fileRebuilder.js';
import { agentRebuild } from './agentRebuilder.js';
import type { DocumentBlocksRecord, DocumentBlock, GeneratedFile } from '../types.js';

export type RegenEvent =
  | { type: 'started' }
  | { type: 'ai_text'; data: string }
  | { type: 'block_updated'; data: { block: DocumentBlock; blocks: DocumentBlock[] } }
  | { type: 'patching' }
  | { type: 'rebuilding' }
  | { type: 'agent_text'; data: string }
  | { type: 'agent_tool'; data: string }
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

  // Build surrounding slides summary for context
  const pageIndex = blocks.findIndex(b => b.id === blockId);
  const surroundingSummary = blocks
    .map((b, i) => {
      const t = (b.data as any).title || '';
      const marker = i === pageIndex ? ' ← THIS SLIDE' : '';
      return `  #${i + 1} [${b.type}] ${t}${marker}`;
    })
    .join('\n');

  // Build a focused prompt for single-block regeneration
  const systemPrompt = [
    'You are a professional presentation designer. You edit a single slide\'s JSON data to fulfill the user\'s request with high visual quality.',
    '',
    `Document: ${blockRecord.doc_type} — "${meta.title || 'Untitled'}"`,
    `Block type: ${targetBlock.type}`,
    `Slide position: #${pageIndex + 1} of ${blocks.length}`,
    '',
    'CRITICAL: Your entire response must be a single valid JSON object. No text, no markdown, no explanation.',
    '',
    '## STYLE & THEME SYSTEM',
    'Available style fields (add them even if not present in current data):',
    '- backgroundColor: slide background (hex, e.g. "#FFC0CB")',
    '- textColor: main body/bullet text color',
    '- titleColor: heading text color',
    '- subtitleColor: subtitle/secondary text color',
    '- accentColor: accent elements — stat card borders, chart bars, divider lines, icon bg',
    '- accentColor2: secondary accent — panel/card backgrounds, light tint areas',
    '',
    'THEME CHANGE RULES (when user asks for a style/theme/color scheme):',
    '- ALWAYS set ALL 6 style fields as a cohesive palette — never just 1-2 fields.',
    '- Also update chart colors if charts exist (barChart.colors, lineChart.color, doughnut.colors, etc.).',
    '- Ensure high contrast: dark text on light bg, light text on dark bg.',
    '',
    'Reference palettes:',
    '- 粉色/Pink: bg=#FFF0F5, text=#4A2030, title=#8B2252, subtitle=#C06080, accent=#E8578A, accent2=#FFE0EC',
    '- 藍色/Blue: bg=#F0F4FF, text=#1A2744, title=#1B3A6B, subtitle=#6889B0, accent=#2B6CB0, accent2=#E0EAFF',
    '- 綠色/Green: bg=#F0FFF4, text=#1A3A2A, title=#1B5E3B, subtitle=#68A07B, accent=#38A169, accent2=#DCFFE8',
    '- 暗色/Dark: bg=#1A1A2E, text=#E0E0E0, title=#FFFFFF, subtitle=#A0A0C0, accent=#00D4FF, accent2=#2A2A4E',
    '- 暖色/Warm: bg=#FFF8F0, text=#3D2B1F, title=#8B4513, subtitle=#B07850, accent=#E8782A, accent2=#FFE8D6',
    '- 極簡/Minimal: bg=#FFFFFF, text=#333333, title=#111111, subtitle=#888888, accent=#666666, accent2=#F5F5F5',
    '',
    '## CONTENT QUALITY RULES',
    '- Bullets: concise (under 50 chars each), max 5 per slide.',
    '- KPIs/stats: keep values short with units. Max 4 per slide.',
    '- For content rewrites: be specific, data-driven, professional.',
    '- Chart data: use realistic proportions. Include labels, values, and colors.',
    '',
    '## SLIDE TYPE PATTERNS',
    '- title/title_slide: title + subtitle + description. Creative, visually impactful.',
    '- stats/kpi/dashboard: title + kpis array [{value, label}]. Data-driven cards.',
    '- content: title + bullets []. Concise points, not paragraphs.',
    '- two_column: title + left{} + right{}. For comparisons.',
    '- chart/chart_stats: title + chart objects. Professional data visualization.',
    '- table: title + headers[] + rows[][]. Clean tabular data.',
    '- quote: quote + attribution. Impactful closing.',
    '',
    '## TARGETED EDITING',
    'When a target element is specified, ONLY modify that element. Keep all other fields unchanged.',
    'When NO target is specified and user asks for style/theme change, update ALL visual fields holistically.',
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
    `Document outline:`,
    surroundingSummary,
    '',
    'Current slide data:',
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
  userMessageParts.push('', `User instruction: ${cleanInstruction}`, '', 'Return the updated slide JSON only.');

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
            // Non-patchable fields changed (e.g. colors, chart, kpis) → agent rebuild
            // Uses the full pptx-gen worker for same quality as left-side chat
            console.log(`[BlockRegenerator] In-place patch not supported, triggering agent rebuild...`);
            send({ type: 'rebuilding' });
            try {
              const result = await agentRebuild(fileId, userId, (ev) => {
                // Forward agent events to the regen SSE stream
                if (ev.type === 'agent_text') send({ type: 'agent_text', data: ev.data });
                else if (ev.type === 'agent_tool') send({ type: 'agent_tool', data: ev.data });
              });
              if (result) {
                newFile = result.file;
                // Agent may have re-captured blocks — update local reference
                const updatedBlocks = result.blocks;
                const updatedTarget = updatedBlocks.find(b => b.id === blockId) || targetBlock;
                updatedTarget.status = 'idle';
                await dbRun(
                  'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                  JSON.stringify(updatedBlocks), blockRecord.id,
                );
                send({ type: 'done', data: { block: updatedTarget, blocks: updatedBlocks } });
                resolved = true;
                resolve({ updatedBlock: updatedTarget, newFile });
                return;
              } else {
                console.warn(`[BlockRegenerator] Agent rebuild returned null — block data updated in DB only.`);
              }
            } catch (rebuildErr) {
              console.error(`[BlockRegenerator] Agent rebuild failed:`, rebuildErr);
            }
          }

          // Mark as idle (reached when patch succeeded OR rebuild failed)
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
