/**
 * The MCP servers this deployment can mount, and on which surfaces.
 *
 * One list, asked by everyone who needs the answer. Before this existed the
 * admin "AI 中心" hard-coded a single Email card behind a `deployMode ===
 * 'pro-panjit'` check in the browser, so every new MCP meant editing the page —
 * and the Excel add-in's MCP, which shipped months later, simply never appeared.
 *
 * Availability is a DEPLOYMENT question (does this box hold the key / is the
 * feature wired up), never a per-user permission question. Whether a given user
 * may reach the data behind an MCP is decided at spawn time by the credential
 * the run carries — the mail JWT, the KM 員編, the Excel run token — and none of
 * that is visible here on purpose.
 */
import { config } from '../config.js';
import { kmEnabledFor } from './kmApi.js';
import { EXCEL_TOOL_NAMES } from './excelToolSpec.js';

/** Where an MCP can be switched on. */
export type McpSurface = 'web' | 'excel';

/**
 * Tool names as the CLI sees them (`mcp__<server>__<tool>`). They live here
 * rather than inline in claudeCli so the count on the admin page is the real
 * count, not a number somebody has to remember to update.
 */
export const EMAIL_MCP_TOOL_NAMES = [
  'mcp__email__email_list_folders',
  'mcp__email__email_search',
  'mcp__email__email_get_message',
  'mcp__email__email_get_attachments',
];

export const KM_MCP_TOOL_NAMES = [
  'mcp__km__km_search',
  'mcp__km__km_get_document',
  'mcp__km__km_get_attachment',
];

export interface McpSourceInfo {
  id: 'email-mcp' | 'km-mcp' | 'excel-mcp';
  /** Read-only data an agent can pull in, vs. tools that act on the user's app. */
  kind: 'data-source' | 'live-workbook';
  /** Empty when the deployment cannot offer it at all. */
  surfaces: McpSurface[];
  toolCount: number;
  /** 'user-selected' = off until the human picks it; 'always-on' = inherent to the surface. */
  activation: 'user-selected' | 'always-on';
}

/**
 * What this deployment offers right now. Sources it cannot serve are omitted
 * entirely rather than listed as disabled — an admin page full of greyed-out
 * things nobody can turn on is noise, not information.
 */
export function listMcpSources(): McpSourceInfo[] {
  const sources: McpSourceInfo[] = [];

  // Email: needs the Panjit gateway, so pro-panjit with a key. Offered on both
  // the web chat and the Excel pane; both mount the same server per run.
  if (config.deployMode === 'pro-panjit' && config.adApiKey) {
    sources.push({
      id: 'email-mcp',
      kind: 'data-source',
      surfaces: ['web', 'excel'],
      toolCount: EMAIL_MCP_TOOL_NAMES.length,
      activation: 'user-selected',
    });
  }

  // KM: per-surface by decision, not by capability — the customer chose to keep
  // it out of the web app while the Excel pane uses it. See kmApi.kmEnabledFor.
  const kmSurfaces = (['web', 'excel'] as const).filter(s => kmEnabledFor(s));
  if (kmSurfaces.length) {
    sources.push({
      id: 'km-mcp',
      kind: 'data-source',
      surfaces: [...kmSurfaces],
      toolCount: KM_MCP_TOOL_NAMES.length,
      activation: 'user-selected',
    });
  }

  // Excel: not a data source at all — these tools drive the workbook the user
  // has open, through the add-in. Always on there, because it IS the add-in;
  // there is nothing to consent to beyond having opened the pane.
  sources.push({
    id: 'excel-mcp',
    kind: 'live-workbook',
    surfaces: ['excel'],
    toolCount: EXCEL_TOOL_NAMES.length,
    activation: 'always-on',
  });

  return sources;
}
