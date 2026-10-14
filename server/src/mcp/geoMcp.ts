/**
 * geo-mcp — a stdio MCP server that gives map-producing agents real
 * coordinates instead of remembered ones.
 *
 * ── Why this is an MCP and not a prompt rule ──
 * The research skill already told the model「你必須用 WebSearch 查正確座標」.
 * It didn't work, because WebSearch hands back prose and the model still has
 * to produce the numbers itself — which is the step that goes wrong. A tool
 * removes that step: the coordinates arrive as data the model copies, and a
 * place that can't be found comes back as NOT FOUND rather than as a plausible
 * number.
 *
 * ── Why it is unlike every other MCP here ──
 * email-mcp, km-mcp and the three add-in MCPs all carry a per-user credential
 * and exist to reach data belonging to the run owner. This one reaches a public
 * gazetteer: no token, no identity, nothing user-scoped. So it is not offered
 * as a data source the user picks — it is mounted automatically for the skills
 * that declare `mcp: [geo]`, because a skill that draws maps always wants it
 * and no skill that doesn't draw maps should pay for the extra tools in its
 * context.
 *
 * Run:  node --import tsx server/src/mcp/geoMcp.ts
 */
import fs from 'fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { geocodePlaces, reverseGeocode, activeProvider, MAX_BATCH } from '../services/geocoding.js';

const DEBUG_LOG = process.env.MCP_DEBUG_LOG || '';
function dlog(msg: string): void {
  if (!DEBUG_LOG) return;
  try { fs.appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}][geo] ${msg}\n`); } catch { /* ignore */ }
}

const TOOLS = [
  {
    name: 'geo_geocode',
    description:
      '把「地名／地址」查成真實經緯度。產生任何地圖（```map 區塊、Leaflet／MapLibre 網頁、文件裡的座標）前，所有地點都必須先經過這個工具。'
      + '\n【絕對規則】不准憑記憶寫座標。沒查過的地點就是不知道，不要猜，也不要用「大約」「概略位置」來掩飾憑空生成的數字。'
      + '\n【怎麼讀回傳值】每筆結果有三種狀態：'
      + '\n  • found=true, verified=true → 這就是你要的地點，直接用 lat/lng，不需要加任何免責說明。'
      + '\n  • found=true, verified=false → 查到的是「附近另一個地方」，不是你要的那個（note 會說它實際是什麼）。'
      + '請改用更精確的名稱重查一次；若仍然不行，要嘛不要標這個點，要嘛在標籤上誠實寫出「未能定位，此為鄰近的○○」。絕不可以當成正確座標使用。'
      + '\n  • found=false → 查無此地。就說查不到，不要補一個數字上去。'
      + '\n【查詢技巧】用官方全名最準（「高雄市岡山區公所」優於「岡山區公所」）；一次把所有地點放進 places 陣列批次查，比一個一個查快很多。'
      + `\n一次最多 ${MAX_BATCH} 個地點。`,
    inputSchema: {
      type: 'object',
      properties: {
        places: {
          type: 'array',
          items: { type: 'string' },
          description: '要查的地名或地址，一次放進來批次查詢。例：["高雄市岡山區公所","阿公店水庫","空軍軍官學校"]',
        },
        country: {
          type: 'string',
          description: '限定國家的兩碼代號（選填，但強烈建議）。台灣用 "tw"，日本 "jp"，美國 "us"。可大幅減少同名地點選錯國家。',
        },
      },
      required: ['places'],
      additionalProperties: false,
    },
  },
  {
    name: 'geo_reverse',
    description:
      '把經緯度查成地址／地名（反向地理編碼）。用於驗證一組已有的座標到底落在哪裡 —— '
      + '若回傳的地址跟你預期的地點對不起來，代表那組座標是錯的，請改用 geo_geocode 重查。',
    inputSchema: {
      type: 'object',
      properties: {
        lat: { type: 'number', description: '緯度 (-90 ~ 90)' },
        lng: { type: 'number', description: '經度 (-180 ~ 180)' },
      },
      required: ['lat', 'lng'],
      additionalProperties: false,
    },
  },
];

function textResult(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

async function callTool(name: string, args: Record<string, any>) {
  if (name === 'geo_geocode') {
    const raw = Array.isArray(args.places) ? args.places : (args.places ? [args.places] : []);
    const places = raw.map((p: unknown) => String(p || '').trim()).filter(Boolean);
    if (!places.length) return textResult({ error: 'places 為必填，且至少要有一個地名。' });

    const country = args.country ? String(args.country).trim().slice(0, 2) : undefined;
    dlog(`geocode ${places.length} place(s) country=${country || '-'}`);
    const results = await geocodePlaces(places, country);

    // The counts are here so the model sees the shape of its own result set at
    // a glance, rather than having to audit every row before it starts drawing.
    const unresolved = results.filter(r => !r.found || !r.verified).map(r => r.query);
    return textResult({
      provider: activeProvider(),
      results,
      ...(unresolved.length
        ? { warning: `這些地點沒有取得可信座標：${unresolved.join('、')}。請重查或據實說明，不要自己填數字。`, unresolved }
        : {}),
      ...(places.length > MAX_BATCH ? { truncated: `只處理了前 ${MAX_BATCH} 個地點。` } : {}),
    });
  }

  if (name === 'geo_reverse') {
    const lat = Number(args.lat);
    const lng = Number(args.lng);
    dlog(`reverse ${lat},${lng}`);
    return textResult(await reverseGeocode(lat, lng));
  }

  return textResult({ error: `unknown tool: ${name}` });
}

async function main(): Promise<void> {
  dlog(`--- geo-mcp start: provider=${activeProvider()} ---`);
  const server = new Server({ name: 'geo', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => { dlog('tools/list requested'); return { tools: TOOLS }; });
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      return await callTool(req.params.name, (req.params.arguments || {}) as Record<string, any>);
    } catch (e) {
      dlog(`  -> ${req.params.name} THREW: ${(e as Error).message}`);
      return { content: [{ type: 'text', text: JSON.stringify({ error: (e as Error).message }) }], isError: true };
    }
  });
  await server.connect(new StdioServerTransport());
  dlog('connected to stdio transport');
}

main().catch((e) => {
  console.error('[geo-mcp] fatal:', e);
  process.exit(1);
});
