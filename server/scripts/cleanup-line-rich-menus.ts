/**
 * Delete every rich menu on the LINE channel except the one currently pinned
 * as default (read from `system_settings.line_rich_menu_id`).
 *
 * Run with:
 *   pnpm --filter ai-agents-office-server tsx scripts/cleanup-line-rich-menus.ts
 *
 * Safe to run repeatedly — once orphans are gone subsequent runs report
 * "nothing to delete". Use --dry-run to preview without deleting.
 */

import { dbGet, initializeDatabase } from '../src/db.js';
import { listRichMenus, deleteRichMenu } from '../src/services/line/richMenu.js';
import { config } from '../src/config.js';

async function main(): Promise<void> {
  if (!config.line.channelAccessToken) {
    console.error('LINE_CHANNEL_ACCESS_TOKEN is not set in .env');
    process.exit(2);
  }

  const dryRun = process.argv.includes('--dry-run');

  await initializeDatabase();

  const row = await dbGet<{ value: string }>(
    "SELECT value FROM system_settings WHERE `key` = ?",
    'line_rich_menu_id',
  );
  const keeper = row?.value ?? null;
  console.log(`Keeper (current default): ${keeper ?? '(none recorded)'}`);

  const menus = await listRichMenus();
  console.log(`Found ${menus.length} rich menu(s) on LINE.`);
  if (menus.length === 0) {
    console.log('Nothing to clean up.');
    process.exit(0);
  }

  for (const menu of menus) {
    const tag = `${menu.richMenuId}  "${menu.name}"`;
    if (menu.richMenuId === keeper) {
      console.log(`  KEEP   ${tag}`);
      continue;
    }
    if (dryRun) {
      console.log(`  WOULD DELETE  ${tag}`);
      continue;
    }
    try {
      await deleteRichMenu(menu.richMenuId);
      console.log(`  DELETE ${tag}`);
    } catch (err) {
      console.error(`  FAIL   ${tag} — ${(err as Error).message}`);
    }
  }
  process.exit(0);
}

main().catch(err => {
  console.error('Cleanup failed:', err);
  process.exit(1);
});
