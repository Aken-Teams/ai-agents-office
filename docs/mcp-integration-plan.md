# MCP Integration & Multi-Provider Roadmap

## 背景

目前系統的 AI 能力完全依賴 Claude CLI，視覺化限於 chart (Recharts)、echart (ECharts)、mermaid、mindmap、map (Leaflet)。存在以下瓶頸：

1. **資訊圖表**：Claude 從零生成複雜 HTML 耗時長、品質不穩定，已暫時從分析技能移除 `visual`
2. **地圖精確度**：AI 猜測座標（幻覺），無 geocoding API 導致位置偏差
3. **金融數據**：依賴 WebSearch 爬取，無法取得即時結構化數據
4. **圖片生成**：簡報 / 文件無法嵌入 AI 生成的配圖

透過 MCP (Model Context Protocol) 整合外部 API，可讓 Claude Agent 在生成過程中呼叫真實數據源。

---

## 系統架構

```
用戶 → Next.js UI → Express API → Claude CLI (--mcp-config mcp.json)
                                       │
                                       ▼
                                 ┌─────────────────┐
                                 │   MCP Servers    │
                                 ├─────────────────┤
                                 │ gemini-api       │ → Google Gemini API
                                 │ google-maps      │ → Maps Platform (Geocoding / Directions / Places)
                                 │ image-gen        │ → DALL-E 3 / Flux
                                 │ finance-data     │ → Yahoo Finance / Alpha Vantage
                                 │ brave-search     │ → Brave Search API
                                 │ database         │ → PostgreSQL / MySQL connector
                                 └─────────────────┘
```

### Claude CLI MCP 配置

```jsonc
// mcp.json — 傳給 Claude CLI 的 --mcp-config
{
  "mcpServers": {
    "google-maps": {
      "command": "node",
      "args": ["mcp-servers/google-maps/index.js"],
      "env": { "GOOGLE_MAPS_API_KEY": "..." }
    },
    "gemini": {
      "command": "node",
      "args": ["mcp-servers/gemini/index.js"],
      "env": { "GEMINI_API_KEY": "..." }
    }
  }
}
```

每個 MCP Server 是獨立 process，Claude CLI 自動管理其生命週期。

---

## 優先級規劃

### Tier 1 — 高優先（直接解決現有痛點）

#### 1. Gemini API — 資訊圖表生成

| 項目 | 內容 |
|------|------|
| **目的** | 用 Gemini 生成複雜 HTML 資訊圖表，Claude 負責分析和編排 |
| **流程** | Claude 分析用戶需求 → 呼叫 `gemini.generate_infographic({prompt, data})` → Gemini 回傳 HTML → 輸出為 ` ```visual ` block → ChatVisual.tsx iframe 顯示 |
| **為何用 Gemini** | Gemini 2.5 Pro 擅長生成結構化 HTML/CSS，且成本低（input $1.25/M, output $10/M） |
| **可用 tools** | `generate_infographic(prompt, data, style)` — 回傳完整 HTML 文件 |
| **前端** | ChatVisual.tsx 已存在，sandbox="allow-scripts"，無需修改 |

**Token 計費**：
- Claude tokens：分析需求 + 組織 prompt（記入 `provider='claude'`）
- Gemini tokens：HTML 生成（記入 `provider='gemini'`）
- 用戶端顯示合併費用或分項明細

#### 2. Google Maps Platform — 地圖精確度

| 項目 | 內容 |
|------|------|
| **目的** | 解決 AI 地圖座標幻覺問題 |
| **現狀** | AI 從訓練資料猜測 lat/lng → 偏差 50~500+ 公尺，路線虛構 |
| **解法** | MCP 提供 geocoding / directions / places 工具，AI 查詢真實座標後再寫入 map JSON |
| **可用 tools** | `geocode(address)` → 精確 lat/lng |
|                | `directions(origin, destination, mode)` → 真實路線 polyline |
|                | `nearby_search(location, keyword, radius)` → 真實 POI 列表 |
|                | `place_details(place_id)` → 評分、營業時間、照片 |
| **前端** | ChatMap.tsx 已支援 markers + route polyline，可能需增加 POI 卡片 |
| **成本** | Geocoding $5/1k req, Directions $5/1k req, Places $17/1k req |

**Before vs After**：
```
Before: AI 猜「阮綜合醫院停車場」→ [22.625, 120.301]（可能偏差 200m）
After:  AI 呼叫 geocode("阮綜合醫院停車場") → [22.6254, 120.3018]（精確）
        AI 呼叫 directions(origin, dest, "walking") → 真實步行路線
```

#### 3. Finance API — 金融數據

| 項目 | 內容 |
|------|------|
| **目的** | 即時股票 / 匯率 / 財報數據，搭配 echart candlestick |
| **可用 tools** | `stock_quote(symbol)` → 即時報價 |
|                | `stock_history(symbol, period)` → OHLC 歷史數據 |
|                | `exchange_rate(from, to)` → 匯率 |
| **數據源** | Yahoo Finance (免費) 或 Alpha Vantage (免費 25 req/day) |
| **前端** | ChatEChart.tsx 已支援 candlestick 渲染 |

---

### Tier 2 — 中優先

| MCP Server | 用途 | 場景 |
|------------|------|------|
| **Image Generation** (DALL-E 3 / Flux) | AI 生成配圖 | 簡報、文件需要插圖時自動生成 |
| **Brave Search / Tavily** | 進階網路搜尋 | research skill 搜尋品質提升，比 WebSearch 更精準 |
| **Database Connector** | 直接查詢 SQL 資料庫 | 「分析我 DB 裡的銷售數據」→ SQL → echart |
| **Google Drive / OneDrive** | 讀取雲端文件 | 「分析我 Google Sheet 的資料」 |

### Tier 3 — 低優先（未來）

| MCP Server | 用途 |
|------------|------|
| GitHub | 程式碼倉庫分析 |
| DeepL | 高品質多語翻譯 |
| Puppeteer / Screenshot | 網頁截圖嵌入文件 |
| Calendar | 排程整合 |
| Email / Slack | 通知推送 |

---

## Token 追蹤架構

### 資料庫變更

```sql
-- token_usages 表新增欄位
ALTER TABLE token_usages ADD COLUMN provider TEXT DEFAULT 'claude';
ALTER TABLE token_usages ADD COLUMN external_cost REAL DEFAULT 0;
```

| 欄位 | 說明 |
|------|------|
| `provider` | `'claude'` \| `'gemini'` \| `'google-maps'` \| `'openai'` \| `'yahoo-finance'` ... |
| `external_cost` | 該次 API 呼叫的實際費用（USD） |

### 計費邏輯

```typescript
// 每次 MCP 工具呼叫後記錄
await dbRun(`
  INSERT INTO token_usages (id, user_id, conversation_id, provider, input_tokens, output_tokens, external_cost)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`, [uuid, userId, convId, 'gemini', inputTokens, outputTokens, cost]);
```

### 後台顯示

- Token 帳本增加 `provider` 欄位篩選
- 總覽頁顯示各 provider 費用佔比（pie chart）
- 用戶管理顯示個別用戶的 multi-provider 消耗

---

## 安全考量

| 風險 | 對策 |
|------|------|
| API Key 暴露 | Key 只存在 server `.env`，透過 MCP Server env 傳入，前端永遠不接觸 |
| MCP Server 權限過大 | 每個 skill 的 `--allowedTools` 控制可用哪些 MCP tools |
| 費用失控 | 設定每用戶 / 每日 MCP 呼叫次數上限 |
| Gemini 輸出注入 | ChatVisual.tsx 已有 `sandbox="allow-scripts"` 隔離，無 cookie / fetch 權限 |

---

## 實施順序建議

1. **Phase 1**：Google Maps MCP（解決地圖幻覺，最直接的用戶體驗改善）
2. **Phase 2**：Gemini API MCP（恢復 `visual` 能力，但由 Gemini 生成）
3. **Phase 3**：Finance API MCP（data-analyst 股票分析增強）
4. **Phase 4**：Token tracking 架構升級（multi-provider 計費）
5. **Phase 5**：Image Gen + Brave Search（簡報配圖 + 搜尋品質）
