import { v4 as uuidv4 } from 'uuid';
import { dbGet, dbRun } from '../db.js';
import { spawnClaude } from './claudeCli.js';
import { patchBlockInPlace, rebuildFile } from './fileRebuilder.js';
import { agentEditDeck } from './agentRebuilder.js';
import type { DocumentBlocksRecord, DocumentBlock, GeneratedFile } from '../types.js';

export type RegenEvent =
  | { type: 'started' }
  | { type: 'ai_text'; data: string }
  | { type: 'answer'; data: string }
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
  answerOnly = false,
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

  // Build surrounding blocks summary for context
  const pageIndex = blocks.findIndex(b => b.id === blockId);
  const isDocx = blockRecord.doc_type === 'docx' || blockRecord.doc_type === 'pdf';
  const isXlsx = blockRecord.doc_type === 'xlsx';
  const blockLabel = isDocx ? 'SECTION' : isXlsx ? 'SHEET' : 'SLIDE';
  const surroundingSummary = blocks
    .map((b, i) => {
      const t = (b.data as any).title || (b.data as any).heading || '';
      const marker = i === pageIndex ? ` ← THIS ${blockLabel}` : '';
      return `  #${i + 1} [${b.type}] ${t}${marker}`;
    })
    .join('\n');

  // ── Answer-only (Q&A) mode ──────────────────────────────────────────────
  // The user asked a QUESTION about this block (not an edit). Answer it in
  // plain language and DO NOT touch the file, DB, or block data. This keeps
  // questions safe — routing them through full file generation could otherwise
  // regenerate and shrink the whole document.
  if (answerOnly) {
    const docKind = isDocx ? '文件' : isXlsx ? '試算表' : '簡報';
    const qaSystem =
      `你是「${docKind}」編輯助理。使用者正在檢視其中一個${blockLabel === 'SLIDE' ? '頁面' : '區塊'}並向你提問。\n` +
      `請用繁體中文、簡潔友善地回答:目前這個區塊有什麼內容,以及可以怎麼調整。\n` +
      `你只是在「回答問題」——請勿輸出 JSON,也不要宣稱已經修改任何內容(你並沒有修改)。\n` +
      `若使用者其實是想修改,請告訴他可以直接說出想改成什麼,你就會幫他改。`;
    const qaUser = [
      `${docKind}大綱:`,
      surroundingSummary,
      '',
      `使用者正在看的區塊資料:`,
      '```json',
      JSON.stringify(targetBlock.data, null, 2),
      '```',
      '',
      `使用者的提問: ${instruction}`,
    ].join('\n');

    send({ type: 'started' });
    return new Promise((resolve) => {
      let answerText = '';
      let qaResolved = false;
      const qa = spawnClaude(qaUser, qaSystem, {
        userId,
        conversationId: blockRecord.conversation_id,
        role: 'router',
        sandboxSubdir: '_agents/_block-editor',
        model: 'claude-sonnet-4-6',
      });
      qa.emitter.on('event', (event: any) => {
        if (qaResolved) return;
        if (event.type === 'text') {
          answerText += event.data;
          send({ type: 'ai_text', data: event.data });
        } else if (event.type === 'error') {
          qaResolved = true;
          send({ type: 'error', data: String(event.data) });
          resolve(null);
        } else if (event.type === 'done') {
          qaResolved = true;
          send({ type: 'answer', data: answerText });
          resolve(null); // No block/file change — nothing to return.
        }
      });
    });
  }

  // Build a focused prompt — different for DOCX vs XLSX vs PPTX
  const systemPrompt = isDocx
    ? buildDocxRegenPrompt(meta, targetBlock, pageIndex, blocks.length)
    : isXlsx
      ? buildXlsxRegenPrompt(meta, targetBlock, pageIndex, blocks.length)
      : buildPptxRegenPrompt(blockRecord.doc_type, meta, targetBlock, pageIndex, blocks.length);

  // Parse metadata prefixes out of instruction so they don't confuse the AI
  let cleanInstruction = instruction;
  let shapesContext = '';
  let targetElement = '';

  const shapesMatch = cleanInstruction.match(/^\[投影片元素:\s*([^\]]+)\]\s*/);
  if (shapesMatch) {
    shapesContext = shapesMatch[1].trim();
    cleanInstruction = cleanInstruction.slice(shapesMatch[0].length);
  }
  // Support both slide and section context prefixes
  const targetMatch = cleanInstruction.match(/^\[(?:目標元素|第\d+段\s*·\s*[^\]]*?):\s*([^\]]*)\]\s*/);
  if (targetMatch) {
    targetElement = targetMatch[1].trim();
    cleanInstruction = cleanInstruction.slice(targetMatch[0].length);
  }
  // Also handle [第N段 · label] format from DocElementPanel
  const sectionCtxMatch = cleanInstruction.match(/^\[第(\d+)段(?:\s*·\s*([^\]]*))?\]\s*/);
  if (sectionCtxMatch && !targetElement) {
    targetElement = sectionCtxMatch[2]?.trim() || '';
    cleanInstruction = cleanInstruction.slice(sectionCtxMatch[0].length);
  }
  // Handle [工作表: SheetName] [選取: A1:C5] format from SheetElementPanel
  const sheetCtxMatch = cleanInstruction.match(/^\[工作表:\s*([^\]]+)\]\s*/);
  if (sheetCtxMatch) {
    shapesContext = sheetCtxMatch[1].trim();
    cleanInstruction = cleanInstruction.slice(sheetCtxMatch[0].length);
  }
  const cellRefMatch = cleanInstruction.match(/^\[選取:\s*([^\]]+)\]\s*/);
  if (cellRefMatch) {
    targetElement = cellRefMatch[1].trim();
    cleanInstruction = cleanInstruction.slice(cellRefMatch[0].length);
  }

  // ── PPTX: full-agent edit (same flow as the left-side chat) ──────────────
  // Resume the conversation's pptx-gen session, have it edit its own original
  // build script and re-run → the WHOLE deck is regenerated changing ONLY this
  // page/element, so style/layout/chart sizing stay consistent with the rest.
  // (DOCX/XLSX keep the fast JSON-patch path below.)
  if (!isDocx && !isXlsx) {
    const slideNo = pageIndex + 1;
    const slideTitle = (targetBlock.data as any).title
      || (targetBlock.data as any).heading
      || (targetBlock.data as any).quote
      || `第 ${slideNo} 頁`;
    const elementClause = targetElement ? `，特別是其中的「${targetElement}」這個部分` : '';
    const scopedInstruction = [
      `請修改這份簡報的「第 ${slideNo} 頁」(標題:「${slideTitle}」)${elementClause}:`,
      cleanInstruction,
    ].join('\n');

    send({ type: 'started' });
    const result = await agentEditDeck(fileId, userId, scopedInstruction, (ev) => {
      // Map deck-edit events onto the block-editor's RegenEvent stream.
      // Swallow started/file_ready/blocks_updated/done — we emit our own below.
      if (ev.type === 'agent_text') send({ type: 'agent_text', data: ev.data });
      else if (ev.type === 'agent_tool') send({ type: 'agent_tool', data: ev.data });
      else if (ev.type === 'error') send({ type: 'error', data: ev.data });
    });

    if (!result) {
      // agentEditDeck already emitted an error; reset block status.
      targetBlock.status = 'idle';
      await dbRun(
        'UPDATE document_blocks SET blocks = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        JSON.stringify(blocks), blockRecord.id,
      ).catch(() => {});
      return null;
    }

    const updatedBlocks = result.blocks;
    const updatedTarget = updatedBlocks.find(b => b.id === blockId)
      || updatedBlocks[pageIndex]
      || targetBlock;
    send({ type: 'block_updated', data: { block: updatedTarget, blocks: updatedBlocks } });
    send({ type: 'done', data: { block: updatedTarget, blocks: updatedBlocks } });
    return { updatedBlock: updatedTarget, newFile: result.file };
  }

  const dataLabel = isDocx ? 'Current section data' : isXlsx ? 'Current sheet data' : 'Current slide data';
  const returnLabel = isDocx ? 'Return the updated section JSON only.' : isXlsx ? 'Return the updated sheet JSON only.' : 'Return the updated slide JSON only.';

  const userMessageParts = [
    `Document outline:`,
    surroundingSummary,
    '',
    `${dataLabel}:`,
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
  userMessageParts.push('', `User instruction: ${cleanInstruction}`, '', returnLabel);

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
      // Opus follows edit instructions (chart kind/colors/legend, exact JSON
      // shape) more reliably than Sonnet for these single-block edits.
      model: 'claude-opus-4-8',
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

          // ── DOCX / XLSX only (PPTX returned early via agentEditDeck) ──
          // Patch file in-place (fast: just XML manipulation, no generator script).
          send({ type: 'patching' });
          // If AI returned identical data, force-sync by passing empty oldData so
          // all patchable fields are treated as "changed" and applied to the file.
          const patchOld = dataChanged ? oldData : {};
          const patched = await patchBlockInPlace(
            fileId, userId, targetBlock.order, patchOld, updatedData, blockRecord.doc_type,
          );

          let newFile: GeneratedFile | null = null;
          if (!patched) {
            console.log(`[BlockRegenerator] In-place patch not supported for ${blockRecord.doc_type}, triggering rebuild...`);
            send({ type: 'rebuilding' });
            try {
              // Shared generator rebuild (sufficient quality for text documents)
              newFile = await rebuildFile(fileId, userId);
              if (newFile) {
                console.log(`[BlockRegenerator] Full rebuild successful for ${blockRecord.doc_type}`);
              } else {
                console.warn(`[BlockRegenerator] Full rebuild returned null — block data updated in DB only.`);
              }
            } catch (rebuildErr) {
              console.error(`[BlockRegenerator] Rebuild failed:`, rebuildErr);
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

/** Build system prompt for XLSX block regeneration */
function buildXlsxRegenPrompt(
  meta: any, targetBlock: DocumentBlock, pageIndex: number, totalBlocks: number,
): string {
  return [
    'You are a professional spreadsheet editor. You edit a single sheet\'s JSON data for an Excel workbook to fulfill the user\'s request.',
    '',
    `Workbook: "${meta.title || 'Untitled'}"`,
    `Sheet: "${(targetBlock.data as any).name || `Sheet ${pageIndex + 1}`}"`,
    `Sheet position: #${pageIndex + 1} of ${totalBlocks}`,
    '',
    'CRITICAL: Your entire response must be a single valid JSON object. No text, no markdown, no explanation.',
    '',
    '## SHEET STRUCTURE',
    'A sheet contains these fields:',
    '- name: Sheet tab name (string)',
    '- headers: Column headers (string[])',
    '- rows: Data rows — array of arrays, each inner array is one row matching headers order',
    '- summary: Brief description of the sheet content (string, optional)',
    '',
    '## DATA QUALITY RULES',
    '- Keep data types consistent within columns (all numbers, all strings, all dates).',
    '- When adding formulas or calculations, represent them as computed values (not Excel formula syntax).',
    '- Maintain column count consistency: every row must have the same number of cells as headers.',
    '- For numerical corrections: recalculate totals, averages, percentages as needed.',
    '- Preserve existing data unless explicitly asked to change it.',
    '- Use realistic, professional data.',
    '- Dates should use ISO format (YYYY-MM-DD) or locale-appropriate format.',
    '',
    '## TARGETED EDITING',
    'When a cell reference is specified (e.g., B3 or A1:C10):',
    '- ONLY modify cells within that range.',
    '- Keep all other cells and headers unchanged.',
    'When no target is specified, you may modify the entire sheet structure.',
  ].join('\n');
}

/** Build system prompt for DOCX block regeneration */
function buildDocxRegenPrompt(
  meta: any, targetBlock: DocumentBlock, pageIndex: number, totalBlocks: number,
): string {
  return [
    'You are a professional document editor. You edit a single section\'s JSON data for a Word document to fulfill the user\'s request.',
    '',
    `Document: "${meta.title || 'Untitled'}"`,
    `Section type: ${targetBlock.type}`,
    `Section position: #${pageIndex + 1} of ${totalBlocks}`,
    '',
    'CRITICAL: Your entire response must be a single valid JSON object. No text, no markdown, no explanation.',
    '',
    '## SECTION STRUCTURE',
    'A DOCX section may contain these fields (edit the ones that already exist in the data):',
    '- title / heading: Section heading text (string)',
    '- level: Heading level 1-3 (number)',
    '- content: Main body text (string)',
    '- paragraphs: Array of paragraph texts (string[])',
    '- bullets / items: Array of bullet / list items (string[]) — "list" sections use `items`',
    '- headers: TABLE column headers (string[]) — for "table" sections',
    '- rows: TABLE data — array of arrays, each inner array is ONE row matching the `headers` order',
    '- subtitle: Document subtitle (string)',
    '',
    '## CONTENT QUALITY RULES',
    '- Paragraphs: well-structured, professional, clear prose.',
    '- Bullets/items: concise (under 60 chars each), max 8 per section.',
    '- Headings: descriptive and hierarchical.',
    '- TABLE sections: to change the wording, edit the strings inside `headers`/`rows`. Every row MUST have the same number of cells as `headers`. Do NOT turn a table into paragraphs/bullets unless explicitly asked.',
    '- LIST sections: edit the strings inside `items` (keep it an array).',
    '- Visual styling (colours, fonts, borders) is applied by the document template — it is NOT in this JSON, so ignore "美編/配色" style requests and just improve the wording/structure.',
    '- Maintain the document\'s overall tone, style, and language.',
    '- Preserve heading level hierarchy (don\'t change level 1 to level 3, etc.).',
    '',
    '## TARGETED EDITING',
    'When a target element is specified (e.g., heading, content, bullets, table), ONLY modify that element.',
    'Keep all other fields unchanged. Always return the SAME field shape you received (a table stays a table with headers/rows).',
  ].join('\n');
}

/** Build system prompt for PPTX block regeneration */
function buildPptxRegenPrompt(
  docType: string, meta: any, targetBlock: DocumentBlock, pageIndex: number, totalBlocks: number,
): string {
  return [
    'You are a professional presentation designer. You edit a single slide\'s JSON data to fulfill the user\'s request with high visual quality.',
    '',
    `Document: ${docType} — "${meta.title || 'Untitled'}"`,
    `Block type: ${targetBlock.type}`,
    `Slide position: #${pageIndex + 1} of ${totalBlocks}`,
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
    '## CHART EDITING (IMPORTANT)',
    'A chart\'s type lives in its `kind` field (or `type` if that\'s what the data uses). Common values: "bar", "line", "pie", "donut", "area".',
    'Chinese term → kind mapping: 直條圖/長條圖/柱狀圖→"bar"; 折線圖→"line"; 圓餅圖→"pie"; 環形圖/甜甜圈→"donut"; 區域圖/面積圖→"area".',
    'When the user asks to CHANGE a chart\'s type:',
    '- Set the chart\'s `kind` (and `type` if present) to the requested value. If the data has BOTH `kind` and `type`, set BOTH to the same value so the renderer can\'t fall back to the old type.',
    '- KEEP the same data — reuse the existing labels[]/values[] (or data points). Do NOT blank them out, do NOT invent new numbers.',
    '- REMOVE fields that only apply to the old type (e.g. donut/pie `innerRadius`, `hole`, `doughnut`) so they don\'t conflict with the new type.',
    '- If the slide has multiple charts (a `charts` array), only change the chart the user is pointing at (usually index 0 / "Chart 0"); leave the others untouched.',
    '- Keep the title and every other slide field (kpis, bullets, footer, layout) exactly as-is — change ONLY the chart.',
    'When the user asks to change a chart\'s COLOR:',
    '- Set a `colors` array of 6-digit hex strings (no "#") on that chart, e.g. "colors": ["2B6CB0"].',
    '- For a single colour, give one hex. For 彩虹/多色/繽紛 (rainbow / multi-colour), give one distinct hex PER category (same count as labels), e.g. ["E8478A","F59E0B","FBBF24","34D399","3B82F6"].',
    '- Keep `kind`, `labels`, and `values` unchanged when only the colour is changing.',
    'When the user asks to add/remove a chart legend (圖例/圖示): set `showLegend` to true or false on that chart. (Pie/doughnut charts show a legend by default.)',
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
}
