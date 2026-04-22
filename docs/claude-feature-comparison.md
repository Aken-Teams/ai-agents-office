# Claude.com 功能對照與未來方向

> 對照 Claude.com 的功能，盤點 AI Agents Office 目前的完成度以及可學習的方向。
> 建立日期：2026-03-26

---

## 一、已實現的 Claude 功能

| Claude.com 功能 | AI Agents Office 對應實作 | 完成度 |
|---|---|---|
| **AI Agents** | Router + 12 Worker 多代理系統（orchestrator.ts） | ✅ 完整 |
| **Skills** | 12 個技能：pptx-gen, docx-gen, xlsx-gen, pdf-gen, slides-gen, webapp-gen, research, data-analyst, rag-analyst, planner, reviewer, router | ✅ 完整 |
| **Artifacts（內容產出）** | 內嵌圖表（Recharts）、Mermaid 流程圖、Markmap 心智圖、Leaflet 地圖 + 文件預覽（PDF/Office/HTML） | ✅ 完整 |
| **Projects（專案空間）** | 對話持久 session（agent_sessions）+ 文件上傳 + 使用者記憶提取（memoryExtractor） | ✅ 完整 |
| **Extended Thinking（深度思考）** | Router Agent 分析可視化 + 多代理任務追蹤 UI（task_dispatched → completed） | ✅ 完整 |
| **Web Search（即時搜尋）** | Research Agent 具備 WebSearch / WebFetch 工具 | ✅ 完整 |
| **Research（深度研究）** | 專門的 research 技能 + 跨文件 RAG 分析（rag-analyst） | ✅ 完整 |
| **Sharing（分享）** | 公開分享連結（conversation_shares），無需登入即可瀏覽 | ✅ 完整 |
| **i18n（多語系）** | 繁體中文 / 簡體中文 / 英文，完整 UI 翻譯 | ✅ 完整 |
| **Theme（主題）** | 深色 / 淺色主題切換，localStorage 持久化 | ✅ 完整 |
| **Admin Dashboard** | 使用者管理、代幣帳本、安全審計、系統公告、全域設定 | ✅ 完整 |
| **Personalization（個人化）** | AI 問候語（greeting SSE）+ 使用者記憶提取 + locale/theme 偏好 | ✅ 完整 |
| **Security（安全）** | 5 層沙箱防禦：輸入防護、路徑驗證、CLI 工具限制、工作區隔離、級聯刪除 | ✅ 完整 |
| **Token Tracking（用量追蹤）** | 每對話 / 每使用者的 token 用量統計 + 管理員全域帳本 | ✅ 完整 |
| **File Versioning（版本控制）** | 自動快照 + 版本歷史列表 + 任意版本下載 | ✅ 完整 |

---

## 二、Claude 有但尚未實現的功能

### 1. 聊天室視覺化擴充（雙層架構）

**Claude 做法：** 在對話中渲染豐富的互動式視覺化，包含：
- 熱力圖、桑基圖、儀表板、3D 圖表
- 知識圖譜、關係網絡圖
- 帶滑桿/按鈕的即時互動分析
- 手繪風格白板教學、物理模擬動畫
- 音頻波形 / 頻譜分析

**目前現狀：**
- `chart` code block → Recharts（僅 7 種：bar, line, area, pie, radar, scatter, donut）
- `mermaid` → 流程圖、甘特圖等
- `mindmap` → Markmap 互動心智圖
- `map` → Leaflet 地圖

**核心差距：** Recharts 圖表類型太少，無法滿足進階分析場景（熱力圖、3D、知識圖譜、音頻分析等）。

**重要定位釐清：**
> 這**不是**讓 AI 幫使用者「做網站」（那是 slides-gen / webapp-gen 的工作）。
> 這是**擴充我們 APP 的內建視覺化工具**，讓 AI 分析結果能用更豐富的圖表呈現在聊天室中。
> 就像 Recharts 是我們的圖表元件，新的套件也是我們的圖表元件，只是種類更多。

---

#### 雙層架構設計

```
┌──────────────────────────────────────────────────────────┐
│                    聊天室視覺化系統                         │
├──────────────────────────┬───────────────────────────────┤
│      第一層：ECharts      │     第二層：特殊視覺化          │
│    （JSON 驅動元件）       │   （sandboxed iframe 元件）    │
├──────────────────────────┼───────────────────────────────┤
│ AI 輸出 ECharts option   │ AI 輸出自包含 HTML            │
│ JSON → ChatEChart 渲染   │ → ChatVisual iframe 渲染      │
├──────────────────────────┼───────────────────────────────┤
│ 覆蓋 80% 場景            │ 覆蓋 20% 特殊場景             │
│ 標準商業圖表、統計圖表     │ 3D、知識圖譜、音頻、物理模擬   │
├──────────────────────────┼───────────────────────────────┤
│ code block: ```echart    │ code block: ```visual         │
│ 輕量、快速、主題同步       │ 靈活、任意套件、sandboxed      │
└──────────────────────────┴───────────────────────────────┘
```

---

#### 第一層：ECharts 擴充（取代/補充 Recharts）

**原理：** 與現有 `chart` code block 相同模式。AI 輸出 JSON，我們的 React 元件渲染。

**新增 code block：** `echart`

```
AI 輸出 ```echart { ECharts option JSON } ``` → ChatEChart 元件渲染
```

**新增圖表類型（Recharts 做不到的）：**

| 圖表類型 | 用途 | 範例場景 |
|---|---|---|
| **heatmap 熱力圖** | 矩陣資料、相關性分析 | 產品銷售 × 月份、技能矩陣 |
| **sankey 桑基圖** | 流量、資金流向 | 預算分配、使用者轉換漏斗 |
| **treemap 矩形樹圖** | 階層佔比 | 營收結構、磁碟用量 |
| **sunburst 旭日圖** | 多層階層 | 組織架構、分類統計 |
| **gauge 儀表板** | 單一指標展示 | KPI 完成率、系統健康度 |
| **funnel 漏斗圖** | 轉換分析 | 銷售漏斗、註冊流程 |
| **boxplot 箱型圖** | 統計分佈 | 薪資分佈、品質檢驗 |
| **candlestick K線圖** | 金融數據 | 股價走勢、匯率變化 |
| **parallel 平行座標** | 多維度比較 | 產品規格對比 |
| **themeRiver 河流圖** | 時間序列主題分佈 | 話題趨勢、技術趨勢 |
| **graph 關係圖** | 簡單網絡關係 | 人物關係、模組依賴 |
| **geo 地理圖** | 地理資料著色 | 各省銷售、全球分佈 |
| **radar（加強版）** | 多維評估 | 比 Recharts radar 更豐富 |

**ECharts 內建互動功能（不需寫 JS）：**
- `dataZoom` — 滑桿縮放時間軸
- `brush` — 框選資料區域
- `tooltip` — hover 詳情
- `legend` — 點擊切換系列
- `connect` — 多圖表聯動

**影響範圍：**

| 檔案 | 變更 |
|---|---|
| `client/src/components/charts/ChatEChart.tsx` | **新增** — ECharts 渲染元件（npm: echarts） |
| `client/src/app/chat/[id]/page.tsx` | 新增 `language-echart` 偵測 |
| `client/src/app/share/[token]/page.tsx` | 同步支援 |
| Agent SKILL.md（research, data-analyst, rag-analyst） | 新增 echart 產出指引 |

**與現有 Recharts 的關係：**
- **不取代**，兩者共存
- `chart` code block → 維持 Recharts（向後相容，已產出的對話不受影響）
- `echart` code block → 新增 ECharts（更豐富的圖表類型 + 內建互動）
- AI 根據場景自動選擇：簡單 bar/line/pie 用 `chart`，進階圖表用 `echart`

---

#### 第二層：特殊視覺化（iframe 渲染）

**適用場景：** ECharts 做不到的特殊視覺化類型。

**原理：** AI 輸出自包含的 HTML（引用 CDN 套件），我們的元件在 sandboxed iframe 中渲染。
這**仍然是 APP 的內建視覺化工具**，只是渲染機制用 iframe（就像 Mermaid 的渲染機制是 SVG）。

**新增 code block：** `visual`

```
AI 輸出 ```visual <html>...</html> ``` → ChatVisual 元件 → sandboxed iframe (srcdoc)
```

**覆蓋的特殊視覺化：**

| 套件 | CDN 大小 | 用途 | 範例場景 |
|---|---|---|---|
| **Plotly.js** | ~3MB（可 partial） | 3D 圖、頻譜圖、等高線圖、箱型圖、瀑布圖 | 科學數據分析、頻率分析 |
| **D3.js** | ~250KB | 力導向圖、拖曳式散佈圖、自定義動畫 | 即時回歸分析（拖曳點更新公式） |
| **Cytoscape.js** | ~300KB | 知識圖譜、關係網絡、圖論視覺化 | 論文論點分析、人物關係圖 |
| **Rough.js** | ~100KB | 手繪風格圖表、白板教學風 | 教學場景、概念說明 |
| **p5.js** | ~800KB | 物理模擬、光學動畫、互動藝術 | 光折射示範、物理公式視覺化 |
| **Wavesurfer.js** | ~150KB | 音頻波形、頻譜分析 | 語音分析、音樂分析 |
| **Vis.js** | ~500KB | 時間軸、網絡圖 | 歷史事件時間軸、專案里程碑 |

**互動控制項（原生 HTML，不需額外套件）：**
- 滑桿 `<input type="range">` — 調整參數即時重算
- 按鈕/切換 `<button>` — 切換顯示模式（$/%、不同情境）
- 下拉選單 `<select>` — 選擇不同資料集
- 拖曳 — D3 drag behavior，拖曳資料點即時更新

**安全考量：**
- iframe `sandbox="allow-scripts"` — 允許 JS 執行，禁止存取父頁面 DOM
- 不設 `allow-same-origin` — 防止 iframe 讀取主頁 cookie/localStorage
- 套件僅透過 CDN 載入 — 不接觸後端 API

**影響範圍：**

| 檔案 | 變更 |
|---|---|
| `client/src/components/charts/ChatVisual.tsx` | **新增** — iframe 渲染元件 |
| `client/src/app/chat/[id]/page.tsx` | 新增 `language-visual` 偵測 |
| `client/src/app/share/[token]/page.tsx` | 同步支援 |
| Agent SKILL.md（research, data-analyst, rag-analyst） | 新增 visual 產出指引 |

---

#### 適用場景總覽

| 場景 | 使用哪一層 | 具體套件/功能 | Claude 範例對照 |
|---|---|---|---|
| 熱力圖/相關性矩陣 | 第一層 ECharts | heatmap | Chart Your Data 熱力圖 |
| 桑基圖/資金流向 | 第一層 ECharts | sankey | — |
| 漏斗圖/轉換分析 | 第一層 ECharts | funnel | — |
| 儀表板/KPI | 第一層 ECharts | gauge | — |
| K線圖/金融數據 | 第一層 ECharts | candlestick | — |
| 矩形樹圖/階層佔比 | 第一層 ECharts | treemap | — |
| 地理著色圖 | 第一層 ECharts | geo | — |
| 預算情境（滑桿互動） | 第二層 iframe | ECharts CDN + slider | Budget Futures 三欄比較 |
| 銷售預測（雙滑桿模擬） | 第二層 iframe | Chart.js CDN + slider | Donor Retention vs Acquisition |
| 拖曳散佈圖 + 回歸線 | 第二層 iframe | D3.js (drag behavior) | Apply a Formula 互動散佈圖 |
| 知識圖譜/論點關係 | 第二層 iframe | Cytoscape.js | Lit Review 論點地圖 |
| 3D 資料視覺化 | 第二層 iframe | Plotly.js 3D | 科學資料展示 |
| 頻譜圖/音頻分析 | 第二層 iframe | Wavesurfer.js | 頻譜圖 |
| 手繪風白板教學 | 第二層 iframe | Rough.js | Whiteboard Lesson |
| 物理/光學模擬 | 第二層 iframe | p5.js | Visualize the Mechanism（稜鏡） |
| 歷史事件時間軸 | 第二層 iframe | Vis.js timeline | — |

---

#### 預估工作量

| 項目 | 天數 |
|---|---|
| **第一層 ChatEChart 元件** | 3-5 天 |
| 元件開發（ECharts React wrapper + 主題同步 + 全螢幕 + 下載） | 2-3 天 |
| SKILL.md prompt 工程（讓 AI 學會輸出 ECharts option JSON） | 1-2 天 |
| **第二層 ChatVisual 元件** | 3-5 天 |
| 元件開發（iframe srcdoc + sandbox + 主題通知 + 全螢幕 + 下載） | 2-3 天 |
| SKILL.md prompt 工程（讓 AI 學會在適當場景輸出 visual HTML） | 1-2 天 |
| **整合測試與微調** | 3-5 天 |
| 各種圖表類型測試、streaming 相容性、主題切換 | 2-3 天 |
| 分享頁面支援、舊對話相容性 | 1-2 天 |
| **總計** | **約 2-3 週** |

> 建議先做第一層（ECharts），因為覆蓋率高、風險低。
> 第二層可在第一層穩定後再加入。

---

### 2. Artifacts 即時編輯（Canvas 模式）

**Claude 做法：** Artifacts 不只是預覽，使用者可以直接在瀏覽器中編輯生成的內容（程式碼、文件、圖表），然後讓 AI 根據修改繼續迭代。

**目前現狀：** 生成 → 預覽 → 下載，單向流程。使用者無法在瀏覽器內直接修改生成的內容。

**建議做法：**
- 優先對 HTML 類產出（slides-gen、webapp-gen）實現瀏覽器內編輯
- 可在 iframe 旁加入「編輯模式」，讓使用者修改 HTML/CSS 後存回
- 進階：讓使用者選取 Artifact 中的片段，對 AI 說「修改這段」

**影響範圍：**
- `client/src/app/chat/[id]/page.tsx` — 新增 Artifact 編輯面板
- `server/src/routes/files.ts` — 新增 file update endpoint
- `server/src/services/fileManager.ts` — 支援就地更新

**預估工作量：** 中等（2-3 週）

---

### 3. 對話分支（Message Branching）

**Claude 做法：** 使用者可以編輯之前的訊息重新生成，產生不同的對話分支，並在分支間切換比較。

**目前現狀：** 線性對話，不滿意只能追加指令修改，無法回到某個節點重跑。

**建議做法：**
- 在每則使用者訊息旁加「編輯並重新生成」按鈕
- 資料庫新增 `parent_message_id` 欄位建立樹狀結構
- UI 加入分支切換器（左右箭頭 ← 1/3 →）

**影響範圍：**
- `server/src/db.ts` — messages 表新增 parent_message_id, branch_index
- `server/src/routes/conversations.ts` — 新增分支查詢邏輯
- `server/src/routes/generate.ts` — 支援從中間節點重新生成
- `client/src/app/chat/[id]/page.tsx` — 分支 UI 元件

**預估工作量：** 中高（3-4 週）

---

### 4. 自定義指令 / 品牌指南（Custom Instructions）

**Claude 做法：** Projects 可設定持久的自定義指令，所有該 Project 下的對話都會遵守。

**目前現狀：** SKILL.md 是系統級設定，使用者無法設定個人偏好。

**建議做法：**
- 新增「使用者偏好設定」頁面（或 Profile 內嵌）
- 支援設定：
  - 預設語言 / 文件風格
  - 品牌色 / 公司名稱 / Logo
  - PPT / Word / PDF 的預設主題
  - 自定義系統指令（free-form text）
- 這些偏好在生成時注入 system prompt

**影響範圍：**
- `server/src/db.ts` — 新增 user_preferences 表（或擴展 users 表）
- `server/src/skills/loader.ts` — buildSystemPrompt 注入使用者偏好
- `client/src/app/` — 新增偏好設定頁面

**預估工作量：** 低中（1-2 週）

---

### 5. MCP 整合（Model Context Protocol）

**Claude 做法：** 透過 MCP 協議連接外部服務（Google Drive、Notion、Slack、GitHub 等），AI 可以直接讀寫外部資料。

**目前現狀：** 資料輸入僅靠手動上傳（uploads），輸出僅存在本地 workspace。

**建議做法：**
- Phase 1：生成後一鍵匯出到 Google Drive / OneDrive
- Phase 2：從 Google Drive / Notion 匯入資料作為上下文
- Phase 3：完整 MCP server 支援，允許使用者自行配置連接器

**影響範圍：**
- 新增 `server/src/services/connectors/` 目錄
- `server/src/routes/` — 新增 OAuth 授權 + 同步 endpoints
- `client/src/app/` — 連接器設定 UI

**預估工作量：** 高（4-6 週，依整合深度）

---

### 6. 結構化引用溯源（Citations）

**Claude 做法：** 回應中標記引用來源，使用者可點擊跳到原始文件對應位置。

**目前現狀：** Research Agent 的回應附有來源連結（markdown links），但非結構化可互動引用。

**建議做法：**
- 定義引用格式：`[^1]` 腳註或 `[[source:uploadId:page]]` 標記
- 前端渲染為可點擊的引用氣泡
- 點擊跳到上傳文件的對應段落 / 頁面
- 對 RAG Analyst 特別有用（跨文件分析需要溯源）

**影響範圍：**
- `server/src/skills/research/SKILL.md` — 引用格式指引
- `server/src/skills/rag-analyst/SKILL.md` — 引用格式指引
- `client/src/app/chat/[id]/page.tsx` — 引用渲染元件
- `client/src/app/files/page.tsx` — 支援跳轉到文件特定位置

**預估工作量：** 中等（2-3 週）

---

### 7. Prompt Library / 社群模板

**Claude 做法：** 提供精選 prompt 範例，使用者可以快速套用或作為起點。

**目前現狀：** Dashboard 有 8 個模板卡片（硬編碼），功能有限。

**建議做法：**
- 建立 prompt_templates 資料表
- 支援使用者自建模板（儲存常用 prompt + 技能組合）
- 支援「公開分享」模板，其他使用者可收藏
- 管理員可建立「精選模板」置頂推薦
- 模板可帶入預設參數（文件類型、風格、頁數等）

**影響範圍：**
- `server/src/db.ts` — 新增 prompt_templates 表
- `server/src/routes/` — 新增 templates CRUD endpoints
- `client/src/app/` — 新增模板中心頁面 + Dashboard 整合

**預估工作量：** 中等（2-3 週）

---

## 三、建議優先順序

### 第一階段：最高價值（1-2 個月）

| 順序 | 功能 | 理由 |
|---|---|---|
| **1** | **聊天室視覺化擴充（雙層架構）** | **差異化最大、視覺衝擊最強**。先做 ECharts 擴充（覆蓋 80%），再加 iframe 特殊視覺化 |
| 2 | 自定義指令 / 品牌指南 | 工作量最低，對重複使用者體驗提升最大 |
| 3 | Artifacts 即時編輯 | HTML slides/webapp 最適合先做 |

### 第二階段：差異化功能（2-3 個月）

| 順序 | 功能 | 理由 |
|---|---|---|
| 4 | 對話分支 | 解決「修改不滿意」的核心痛點 |
| 5 | 結構化引用溯源 | 提升研究 / 分析類產出的專業度 |
| 6 | Prompt Library | 社群效應，降低新使用者門檻 |

### 第三階段：生態擴展（3-6 個月）

| 順序 | 功能 | 理由 |
|---|---|---|
| 7 | MCP 整合 | 連接外部服務，擴展資料來源與輸出管道 |

---

## 四、參考連結

- [Claude Use Cases](https://claude.com/resources/use-cases)
- [Model Context Protocol (MCP)](https://modelcontextprotocol.io/)
- [Claude Artifacts 文件](https://docs.anthropic.com/en/docs/build-with-claude/artifacts)
