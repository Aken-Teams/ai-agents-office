import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import JSZip from 'jszip';
import { dbGet, dbRun } from '../db.js';
import { spawnClaude } from './claudeCli.js';
import { getSkill, buildSystemPrompt } from '../skills/loader.js';
import { getSandboxPath } from './sandbox.js';
import { config } from '../config.js';
import type { DocumentBlocksRecord, DocumentBlock, GeneratedFile } from '../types.js';

export type AgentRebuildEvent =
  | { type: 'started' }
  | { type: 'agent_text'; data: string }
  | { type: 'agent_tool'; data: string }
  | { type: 'file_ready'; data: { file: GeneratedFile } }
  | { type: 'blocks_updated'; data: { blocks: DocumentBlock[] } }
  | { type: 'done'; data: { file: GeneratedFile; blocks: DocumentBlock[] } }
  | { type: 'error'; data: string };

/**
 * Rebuild a generated file using the pptx-gen worker agent (same quality as left-side chat).
 *
 * Flow:
 * 1. Read current block data from DB → write slides.json to agent directory
 * 2. Spawn pptx-gen worker with full SKILL.md system prompt
 * 3. Worker writes a custom pptxgenjs script + runs it → high-quality PPT
 * 4. Worker also writes updated slides.json for the editor
 * 5. We collect the output file, update DB, and re-capture blocks
 */
export async function agentRebuild(
  fileId: string,
  userId: string,
  emit?: (event: AgentRebuildEvent) => void,
): Promise<{ file: GeneratedFile; blocks: DocumentBlock[] } | null> {
  const send = emit || (() => {});

  // ── 1. Load records ──
  const blockRecord = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!blockRecord) {
    send({ type: 'error', data: 'Block record not found' });
    return null;
  }

  const fileRecord = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!fileRecord) {
    send({ type: 'error', data: 'File record not found' });
    return null;
  }

  const blocks: DocumentBlock[] = JSON.parse(blockRecord.blocks);
  const meta = blockRecord.doc_meta ? JSON.parse(blockRecord.doc_meta) : {};
  const docType = blockRecord.doc_type;

  // Only pptx is supported for agent rebuild
  if (docType !== 'pptx') {
    send({ type: 'error', data: `Agent rebuild not supported for doc_type: ${docType}` });
    return null;
  }

  // ── 2. Prepare agent directory ──
  const sandboxPath = getSandboxPath(userId, blockRecord.conversation_id);
  const agentDir = path.join(sandboxPath, '_agents', 'pptx-gen');
  fs.mkdirSync(agentDir, { recursive: true });

  // Reconstruct slides.json from block data
  const slidesJson = {
    ...meta,
    slides: blocks.sort((a, b) => a.order - b.order).map(b => ({
      type: b.type,
      ...b.data,
    })),
  };
  const slidesJsonPath = path.join(agentDir, 'slides.json');
  fs.writeFileSync(slidesJsonPath, JSON.stringify(slidesJson, null, 2), 'utf-8');

  console.log(`[AgentRebuilder] Prepared slides.json: ${blocks.length} slides, style=${meta.style || 'default'}`);

  // ── 3. Load pptx-gen skill ──
  const skill = getSkill('pptx-gen');
  if (!skill) {
    send({ type: 'error', data: 'pptx-gen skill not found' });
    return null;
  }
  const systemPrompt = buildSystemPrompt(skill, config.generatorsDir);

  // ── 4. Construct message ──
  const slidesSummary = blocks
    .sort((a, b) => a.order - b.order)
    .map((b, i) => {
      const title = (b.data as any).title || (b.data as any).quote || '';
      return `  #${i + 1} [${b.type}] ${title}`;
    })
    .join('\n');

  const message = [
    '你需要根據目前的投影片資料重新產生一份高品質的 PowerPoint 簡報。',
    '我已經把投影片資料放在 slides.json，請先讀取它。',
    '',
    '## 簡報概要',
    `標題: ${meta.title || 'Untitled'}`,
    `風格: ${meta.style || 'corporate'}`,
    `頁數: ${blocks.length}`,
    '',
    '投影片結構:',
    slidesSummary,
    '',
    '## 要求',
    '1. 讀取 slides.json 的完整資料',
    '2. 使用 pptxgenjs 撰寫一個自訂腳本來產生整份簡報',
    '3. **嚴格保持所有投影片的文字內容不變**（標題、副標題、要點、統計數據、引言等）',
    '4. 封面頁要有創意設計（使用色塊、幾何元素）',
    '5. 內容頁保持專業一致的風格',
    '6. 如果投影片資料有指定顏色樣式欄位（backgroundColor、accentColor 等），務必使用這些顏色',
    '7. 產生 output.pptx 和更新的 slides.json',
    '',
    '請開始作業。',
  ].join('\n');

  send({ type: 'started' });

  // ── 5. Spawn pptx-gen worker ──
  return new Promise((resolve) => {
    let resolved = false;
    let agentText = '';

    const { emitter, abort } = spawnClaude(message, systemPrompt, {
      userId,
      conversationId: blockRecord.conversation_id,
      role: 'worker',
      skillId: 'pptx-gen',
      sandboxSubdir: '_agents/pptx-gen',
    });

    // Timeout: 5 minutes for rebuild
    const timeout = setTimeout(() => {
      if (resolved) return;
      console.warn('[AgentRebuilder] Agent timed out after 5 minutes');
      abort();
      resolved = true;
      send({ type: 'error', data: 'Agent rebuild timed out' });
      resolve(null);
    }, 300_000);

    emitter.on('event', async (event: any) => {
      if (resolved) return;

      if (event.type === 'text') {
        agentText += event.data;
        send({ type: 'agent_text', data: event.data });
      } else if (event.type === 'tool_activity') {
        send({ type: 'agent_tool', data: event.data });
      } else if (event.type === 'error') {
        console.error('[AgentRebuilder] Agent error:', event.data);
        clearTimeout(timeout);
        resolved = true;
        send({ type: 'error', data: String(event.data) });
        resolve(null);
      } else if (event.type === 'done') {
        clearTimeout(timeout);

        try {
          // ── 6. Find generated PPTX ──
          const pptxFiles = fs.readdirSync(agentDir)
            .filter(f => f.endsWith('.pptx') && !f.includes('.v'))
            .sort((a, b) => {
              // Prefer output.pptx, then newest file
              if (a === 'output.pptx') return -1;
              if (b === 'output.pptx') return 1;
              const sa = fs.statSync(path.join(agentDir, a));
              const sb = fs.statSync(path.join(agentDir, b));
              return sb.mtimeMs - sa.mtimeMs;
            });

          if (pptxFiles.length === 0) {
            throw new Error('Agent did not generate a PPTX file');
          }

          const generatedPptx = path.join(agentDir, pptxFiles[0]);
          const originalFilePath = path.join(config.workspaceRoot, fileRecord.file_path);

          // Copy to original file location
          fs.mkdirSync(path.dirname(originalFilePath), { recursive: true });
          fs.copyFileSync(generatedPptx, originalFilePath);
          console.log(`[AgentRebuilder] Copied ${pptxFiles[0]} → ${fileRecord.file_path}`);

          // Update file size in DB
          const newSize = fs.statSync(originalFilePath).size;
          await dbRun(
            'UPDATE generated_files SET file_size = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?',
            newSize, fileId,
          );

          // Invalidate preview cache
          invalidateCache(originalFilePath, fileRecord, sandboxPath);

          // ── 7. Re-capture blocks from new slides.json ──
          let newBlocks = blocks; // Fallback: keep existing blocks
          const newSlidesJson = path.join(agentDir, 'slides.json');
          if (fs.existsSync(newSlidesJson)) {
            try {
              const raw = JSON.parse(fs.readFileSync(newSlidesJson, 'utf-8'));
              const slidesArr = raw.slides || raw.sections || raw.sheets || [];
              if (Array.isArray(slidesArr) && slidesArr.length > 0) {
                newBlocks = slidesArr.map((slide: any, i: number) => ({
                  id: blocks[i]?.id || uuidv4(), // Preserve existing IDs where possible
                  type: slide.type || 'content',
                  order: i,
                  data: slide,
                  status: 'idle',
                }));

                // Update meta if changed
                const newMeta = { ...raw };
                delete newMeta.slides;
                delete newMeta.sections;
                delete newMeta.sheets;

                await dbRun(
                  'UPDATE document_blocks SET blocks = ?, doc_meta = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                  JSON.stringify(newBlocks), JSON.stringify(newMeta), blockRecord.id,
                );
                console.log(`[AgentRebuilder] Re-captured ${newBlocks.length} blocks from agent's slides.json`);
              }
            } catch (err) {
              console.warn('[AgentRebuilder] Failed to parse agent slides.json, keeping existing blocks:', err);
            }
          }

          // Fetch updated file record
          const updatedFile = await dbGet<GeneratedFile>(
            'SELECT * FROM generated_files WHERE id = ?', fileId,
          );
          if (!updatedFile) throw new Error('File record vanished');

          send({ type: 'file_ready', data: { file: updatedFile } });
          send({ type: 'blocks_updated', data: { blocks: newBlocks } });
          send({ type: 'done', data: { file: updatedFile, blocks: newBlocks } });
          resolved = true;
          resolve({ file: updatedFile, blocks: newBlocks });

        } catch (err: any) {
          console.error('[AgentRebuilder] Post-agent processing failed:', err);
          send({ type: 'error', data: err.message || 'Post-processing failed' });
          resolved = true;
          resolve(null);
        }
      }
    });
  });
}

/**
 * Rebuild a SINGLE slide using the pptx-gen worker agent, then splice the
 * generated slide into the original PPTX. All other slides stay untouched.
 *
 * Flow:
 * 1. Write slide data to agent dir as slide-rebuild.json
 * 2. Spawn pptx-gen worker: "generate only this 1 slide"
 * 3. Worker produces a 1-slide PPTX with full creative quality
 * 4. Extract slide XML from generated PPTX
 * 5. Splice into original PPTX at the correct position
 */
export async function agentRebuildSlide(
  fileId: string,
  userId: string,
  slideIndex: number,
  slideData: Record<string, unknown>,
  docMeta: Record<string, unknown>,
  allBlocks: DocumentBlock[],
  emit?: (event: AgentRebuildEvent) => void,
): Promise<GeneratedFile | null> {
  const send = emit || (() => {});

  const fileRecord = await dbGet<GeneratedFile>(
    'SELECT * FROM generated_files WHERE id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!fileRecord) { send({ type: 'error', data: 'File not found' }); return null; }

  const blockRecord = await dbGet<DocumentBlocksRecord>(
    'SELECT * FROM document_blocks WHERE file_id = ? AND user_id = ?',
    fileId, userId,
  );
  if (!blockRecord) { send({ type: 'error', data: 'Block record not found' }); return null; }

  const sandboxPath = getSandboxPath(userId, blockRecord.conversation_id);
  const agentDir = path.join(sandboxPath, '_agents', 'pptx-gen');
  fs.mkdirSync(agentDir, { recursive: true });

  // Write the single slide data for the agent to read
  const slideJson = { type: slideData.type, ...slideData };
  const slideJsonPath = path.join(agentDir, 'slide-rebuild.json');
  fs.writeFileSync(slideJsonPath, JSON.stringify(slideJson, null, 2), 'utf-8');

  // Load pptx-gen skill
  const skill = getSkill('pptx-gen');
  if (!skill) { send({ type: 'error', data: 'pptx-gen skill not found' }); return null; }
  const systemPrompt = buildSystemPrompt(skill, config.generatorsDir);

  // Build surrounding context so the worker knows the presentation theme
  const slidesSummary = allBlocks
    .sort((a, b) => a.order - b.order)
    .map((b, i) => {
      const title = (b.data as any).title || (b.data as any).quote || '';
      const marker = i === slideIndex ? ' ← 要修改的投影片' : '';
      return `  #${i + 1} [${b.type}] ${title}${marker}`;
    })
    .join('\n');

  const message = [
    `你需要重新產生簡報中的**第 ${slideIndex + 1} 頁**投影片（僅此一頁）。`,
    `我已經把該頁的資料放在 slide-rebuild.json，請先讀取它。`,
    '',
    '## 簡報背景',
    `標題: ${docMeta.title || 'Untitled'}`,
    `風格: ${docMeta.style || 'corporate'}`,
    `總頁數: ${allBlocks.length}`,
    '',
    '投影片結構:',
    slidesSummary,
    '',
    '## 要求',
    '1. 讀取 slide-rebuild.json 的資料',
    '2. 使用 pptxgenjs 撰寫一個腳本，**只產生這一頁**投影片',
    '3. **嚴格保持投影片的文字內容不變**（標題、副標題、要點、統計數據等）',
    '4. **圖表類型務必依照資料**：每個圖表的 `kind`（或 `type`）欄位是什麼，就畫成那種圖表——',
    '   `bar`=直條圖、`line`=折線圖、`pie`=圓餅圖、`donut`=環形圖、`area`=區域圖。',
    '   例如 `kind:"bar"` 一定要畫成直條圖，**絕對不可**因為它原本是環形圖就還是畫環形圖。沿用資料裡的 labels／values，不要改數字。',
    '   若有多個圖表（`charts` 陣列），每個都各自依其 `kind` 作畫。',
    '5. **版面完整、不可跑版**：所有元素都要在投影片邊界內，彼此**不可重疊**、要留足夠間距。',
    '   若該頁是 KPI 卡片＋圖表的組合，維持原本分區（如：卡片在上、圖表在下並排），不要讓圖表壓到卡片或文字。',
    `6. 如果是第 1 頁（封面頁），設計要有創意（色塊、幾何元素）`,
    `7. 如果是內容頁，保持專業風格，搭配 accent bar、footer 等元素`,
    '8. 如果資料有指定顏色欄位（backgroundColor、accentColor 等），**務必使用這些顏色作為整頁配色**',
    '9. 輸出檔名為 slide-output.pptx（僅 1 頁）',
    '10. 不需要產生 slides.json',
    '',
    '請開始作業。',
  ].join('\n');

  send({ type: 'started' });

  return new Promise((resolve) => {
    let resolved = false;

    const { emitter, abort } = spawnClaude(message, systemPrompt, {
      userId,
      conversationId: blockRecord.conversation_id,
      role: 'worker',
      skillId: 'pptx-gen',
      sandboxSubdir: '_agents/pptx-gen',
    });

    const timeout = setTimeout(() => {
      if (resolved) return;
      console.warn('[AgentRebuilder] Single-slide agent timed out');
      abort();
      resolved = true;
      send({ type: 'error', data: 'Agent timed out' });
      resolve(null);
    }, 300_000);

    emitter.on('event', async (event: any) => {
      if (resolved) return;

      if (event.type === 'text') {
        send({ type: 'agent_text', data: event.data });
      } else if (event.type === 'tool_activity') {
        send({ type: 'agent_tool', data: event.data });
      } else if (event.type === 'error') {
        clearTimeout(timeout);
        resolved = true;
        send({ type: 'error', data: String(event.data) });
        resolve(null);
      } else if (event.type === 'done') {
        clearTimeout(timeout);

        try {
          // Find the 1-slide PPTX the agent generated
          const pptxFiles = fs.readdirSync(agentDir)
            .filter(f => f.endsWith('.pptx') && !f.includes('.v'))
            .sort((a, b) => {
              if (a === 'slide-output.pptx') return -1;
              if (b === 'slide-output.pptx') return 1;
              const sa = fs.statSync(path.join(agentDir, a));
              const sb = fs.statSync(path.join(agentDir, b));
              return sb.mtimeMs - sa.mtimeMs;
            });

          if (pptxFiles.length === 0) throw new Error('Agent did not generate a PPTX file');

          const generatedPptx = path.join(agentDir, pptxFiles[0]);
          const originalFilePath = path.join(config.workspaceRoot, fileRecord.file_path);

          // ── Splice: extract slide from generated PPTX → insert into original ──
          const genData = fs.readFileSync(generatedPptx);
          const genZip = await JSZip.loadAsync(genData);

          // Find generated slide (could be slide1.xml or the first slide found)
          const genSlideFile = Object.keys(genZip.files)
            .filter(p => /^ppt\/slides\/slide\d+\.xml$/.test(p))
            .sort()[0];
          if (!genSlideFile) throw new Error('No slide XML in generated PPTX');

          const newSlideXml = await genZip.file(genSlideFile)!.async('text');

          // Load original PPTX
          const origData = fs.readFileSync(originalFilePath);
          const origZip = await JSZip.loadAsync(origData);

          // Find and sort original slide files
          const origSlideFiles: string[] = [];
          origZip.forEach((p) => {
            if (/^ppt\/slides\/slide\d+\.xml$/.test(p)) origSlideFiles.push(p);
          });
          origSlideFiles.sort((a, b) => {
            const na = parseInt(a.match(/slide(\d+)/)?.[1] || '0');
            const nb = parseInt(b.match(/slide(\d+)/)?.[1] || '0');
            return na - nb;
          });

          if (slideIndex >= origSlideFiles.length) {
            throw new Error(`Slide index ${slideIndex} out of range (${origSlideFiles.length} slides)`);
          }

          // Replace target slide XML
          const targetFile = origSlideFiles[slideIndex];
          origZip.file(targetFile, newSlideXml);
          console.log(`[AgentRebuilder] Spliced agent slide into ${targetFile}`);

          // Write updated PPTX
          const output = await origZip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
          fs.writeFileSync(originalFilePath, output);

          // Update file size
          const newSize = fs.statSync(originalFilePath).size;
          await dbRun(
            'UPDATE generated_files SET file_size = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?',
            newSize, fileId,
          );

          // Invalidate preview cache
          invalidateCache(originalFilePath, fileRecord, sandboxPath);

          // Cleanup temp file
          try { fs.unlinkSync(path.join(agentDir, 'slide-rebuild.json')); } catch {}

          const updatedFile = await dbGet<GeneratedFile>(
            'SELECT * FROM generated_files WHERE id = ?', fileId,
          );
          if (!updatedFile) throw new Error('File record vanished');

          console.log(`[AgentRebuilder] Single-slide rebuild done: slide ${slideIndex + 1} (${newSize} bytes)`);
          send({ type: 'done', data: { file: updatedFile, blocks: allBlocks } });
          resolved = true;
          resolve(updatedFile);

        } catch (err: any) {
          console.error('[AgentRebuilder] Single-slide post-processing failed:', err);
          send({ type: 'error', data: err.message || 'Post-processing failed' });
          resolved = true;
          resolve(null);
        }
      }
    });
  });
}

/** Invalidate preview cache in both the sandbox root and the file's directory */
function invalidateCache(
  filePath: string,
  fileRecord: GeneratedFile,
  sandboxPath: string,
) {
  const dir = path.dirname(filePath);
  const basename = path.basename(fileRecord.filename, path.extname(fileRecord.filename));

  for (const cacheDir of new Set([dir, sandboxPath])) {
    const cachedPdf = path.join(cacheDir, '.preview-cache', `${basename}.pdf`);
    if (fs.existsSync(cachedPdf)) {
      try {
        fs.unlinkSync(cachedPdf);
        console.log(`[AgentRebuilder] Cleared preview cache: ${cachedPdf}`);
      } catch {}
    }
  }
}
