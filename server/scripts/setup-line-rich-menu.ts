/**
 * One-shot script: generate the 文清 rich menu PNG, upload it, and set it as
 * the default for all LINE users.
 *
 * Run with:
 *   pnpm --filter ai-agents-office-server tsx scripts/setup-line-rich-menu.ts
 *
 * Reads LINE_CHANNEL_ACCESS_TOKEN from the project .env. Persists the
 * resulting richMenuId to `system_settings.line_rich_menu_id` so the handler
 * can reference it later (e.g. for switching between menus).
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { dbRun, initializeDatabase } from '../src/db.js';
import { DEFAULT_TILES, renderRichMenuPng, deployRichMenu } from '../src/services/line/richMenu.js';
import { config } from '../src/config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const OUTPUT_PNG = path.resolve(__dirname, '../dist-assets/line-rich-menu.png');

async function main(): Promise<void> {
  if (!config.line.channelAccessToken) {
    console.error('LINE_CHANNEL_ACCESS_TOKEN is not set in .env');
    process.exit(2);
  }

  await initializeDatabase();

  console.log(`Rendering rich menu PNG to ${OUTPUT_PNG}...`);
  const png = await renderRichMenuPng(DEFAULT_TILES, OUTPUT_PNG);
  console.log(`  → ${png.length.toLocaleString()} bytes`);

  console.log('Uploading to LINE and setting as default...');
  const richMenuId = await deployRichMenu(png, DEFAULT_TILES);
  console.log(`  → richMenuId = ${richMenuId}`);

  await dbRun(
    "REPLACE INTO system_settings (`key`, value) VALUES (?, ?)",
    'line_rich_menu_id',
    richMenuId,
  );
  console.log('Saved richMenuId to system_settings.line_rich_menu_id');
  process.exit(0);
}

main().catch(err => {
  console.error('Rich menu setup failed:', err);
  process.exit(1);
});
