# AI Agents Office — 產品需求文件（工程師版）

> 版本：1.0｜日期：2026-03-25｜狀態：開發中

---

## 1. 產品概述

AI Agents Office 是一套 **本機部署的 AI 文件生成服務**。使用者透過對話介面描述需求，系統透過多 Agent 協調機制，自動產出 PowerPoint、Word、Excel、PDF、Web 簡報等商業文件。

### 1.1 核心價值主張

- 企業文件不離開本機，零資料外洩風險
- 對話式操作取代手動排版，大幅降低文件製作時間
- 多 Agent 協調自動拆解複雜需求，一次對話完成多份文件
- 檔案版本自動追蹤，支援迭代修改

### 1.2 目標用戶

| 用戶類型 | 使用情境 |
|----------|----------|
| 企業內部員工 | 快速產出週報、提案簡報、數據報表 |
| 專案經理 | 產生專案計畫書、進度報告 |
| 業務人員 | 客戶提案簡報、報價單 |
| 管理層 | 資料分析報告、決策摘要 |

---

## 2. 系統架構

### 2.1 技術棧

| 層級 | 技術 | 版本 |
|------|------|------|
| 前端 | Next.js (App Router) + React + Tailwind CSS | 15.3 / 19 / v4 |
| 後端 | Express + TypeScript | 5.x |
| 資料庫 | MySQL (mysql2/promise) | 8.x |
| 認證 | JWT + bcrypt + Google OAuth 2.0 | — |
| AI 引擎 | Claude CLI (本機 spawn process) | — |
| 即時通訊 | SSE (Server-Sent Events) | — |
| 文件產生 | pptxgenjs / docx / exceljs / pdfkit / Reveal.js | — |

### 2.2 架構圖

```
┌────────────────────────────────────────────────────┐
│                    Client (Next.js)                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐           │
│  │ Chat UI  │ │ 檔案管理  │ │ Admin    │           │
│  │ SSE 串流  │ │ 版本控制  │ │ 後台管理  │           │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘           │
└───────┼────────────┼────────────┼──────────────────┘
        │ SSE 直連    │ REST       │ REST
┌───────┼────────────┼────────────┼──────────────────┐
│       ▼            ▼            ▼   Server (Express)│
│  ┌─────────┐  ┌─────────┐  ┌─────────┐            │
│  │Generate │  │ Files   │  │ Admin   │            │
│  │ Route   │  │ Route   │  │ Route   │            │
│  └────┬────┘  └─────────┘  └─────────┘            │
│       │                                            │
│  ┌────▼──────────────────────────────┐             │
│  │         Orchestrator              │             │
│  │  ┌────────┐    ┌───────────────┐  │             │
│  │  │ Router │───▶│ Task Parser   │  │             │
│  │  │ Agent  │    │ [TASK]/[PIPE] │  │             │
│  │  └────────┘    └───────┬───────┘  │             │
│  │                        │          │             │
│  │  ┌─────────┬──────┬────┴───┐      │             │
│  │  ▼         ▼      ▼        ▼      │             │
│  │ Worker   Worker  Worker  Worker   │             │
│  │ pptx-gen research planner ...     │             │
│  └───────────────────────────────────┘             │
│       │                                            │
│  ┌────▼────┐  ┌──────────┐  ┌──────────┐          │
│  │Claude   │  │ Sandbox  │  │ Input    │          │
│  │CLI      │  │ Service  │  │ Guard    │          │
│  │(spawn)  │  │          │  │ (5-layer)│          │
│  └─────────┘  └──────────┘  └──────────┘          │
└────────────────────────────────────────────────────┘
        │
   ┌────▼────┐
   │ MySQL   │
   │ DB      │
   └─────────┘
```

### 2.3 目錄結構

```
server/src/
├── index.ts                     # 進入點
├── config.ts                    # 環境設定
├── db.ts                        # MySQL 連線 + schema
├── types.ts                     # TypeScript 型別
├── middleware/
│   ├── auth.ts                  # JWT 驗證
│   ├── adminAuth.ts             # 管理員權限
│   └── rateLimit.ts             # 速率限制 (30/min)
├── routes/
│   ├── generate.ts              # SSE 主端點 (核心)
│   ├── auth.ts                  # 認證
│   ├── conversations.ts         # 對話 CRUD
│   ├── files.ts                 # 檔案下載/預覽
│   ├── uploads.ts               # 上傳管理
│   ├── usage.ts                 # Token 用量
│   ├── admin.ts                 # 管理後台
│   └── share.ts                 # 分享連結
├── services/
│   ├── orchestrator.ts          # 多 Agent 協調引擎 (核心)
│   ├── claudeCli.ts             # Claude CLI 程序管理
│   ├── taskParser.ts            # [TASK]/[PIPELINE] 解析
│   ├── sandbox.ts               # 沙箱路徑驗證
│   ├── inputGuard.ts            # 輸入安全檢測 (7 偵測器)
│   ├── fileManager.ts           # 檔案版本管理
│   ├── tokenTracker.ts          # Token 計量
│   ├── usageLimit.ts            # 使用額度控制
│   ├── uploadContext.ts         # 上傳檔案注入提示詞
│   ├── uploadScanner.ts         # 檔案掃描
│   └── watermark.ts             # 浮水印
├── generators/
│   ├── generate-pptx.ts         # PowerPoint 產生腳本
│   ├── generate-docx.ts         # Word 產生腳本
│   ├── generate-xlsx.ts         # Excel 產生腳本
│   ├── generate-pdf.ts          # PDF 產生腳本
│   └── generate-slides.ts       # Web 簡報產生腳本
└── skills/
    ├── router/SKILL.md          # Router Agent 定義
    ├── research/SKILL.md        # 研究 Agent
    ├── planner/SKILL.md         # 規劃 Agent
    ├── reviewer/SKILL.md        # 審查 Agent
    ├── data-analyst/SKILL.md    # 資料分析 Agent
    ├── pptx-gen/SKILL.md        # PPT 產生 Agent
    ├── docx-gen/SKILL.md        # Word 產生 Agent
    ├── xlsx-gen/SKILL.md        # Excel 產生 Agent
    ├── pdf-gen/SKILL.md         # PDF 產生 Agent
    └── slides-gen/SKILL.md      # Web 簡報 Agent

client/src/
├── app/
│   ├── layout.tsx               # 根 Layout
│   ├── page.tsx                 # 首頁路由
│   ├── login/page.tsx           # 登入
│   ├── register/page.tsx        # 註冊
│   ├── dashboard/page.tsx       # 儀表板
│   ├── conversations/page.tsx   # 對話列表
│   ├── chat/[id]/page.tsx       # 聊天主頁 (800+ 行核心)
│   ├── files/page.tsx           # 檔案管理
│   ├── usage/page.tsx           # 用量統計
│   ├── skills/page.tsx          # 技能瀏覽
│   ├── share/[token]/page.tsx   # 公開分享
│   ├── admin/                   # 管理後台 (6 頁)
│   └── components/
│       ├── AuthProvider.tsx      # 認證 Context
│       ├── Navbar.tsx            # 側邊欄導航
│       └── charts/              # 圖表元件 (Recharts/Mermaid/Markmap/Leaflet)
└── i18n/                        # 國際化 (zh-TW / zh-CN / en)
```

---

## 3. 核心功能規格

### 3.1 多 Agent 協調系統

**運作流程：**

1. 使用者發送訊息
2. Router Agent 分析需求，輸出 `[TASK:skillId]` 或 `[PIPELINE]` 區塊
3. Task Parser 解析指令，派遣 Worker Agents
4. Workers 平行或串行執行任務
5. 結果截斷至 1,500 字元回饋 Router
6. Router 決定是否需要下一輪（最多 3 輪）

**技術約束：**

| 參數 | 值 |
|------|-----|
| 最大協調深度 | 3 輪 |
| 協調總超時 | 15 分鐘 |
| Router 超時 | 1.5 分鐘 |
| Worker 超時 | 2～10 分鐘（依類型） |
| 結果截斷 | 1,500 字元（圖表類 4,000） |
| Router 工具權限 | 零（純推理） |
| Worker 工具權限 | Bash, Write, Read, WebSearch, WebFetch |

**Pipeline 語法：**

```
[PIPELINE]
[TASK:research]蒐集 AI 產業報告[/TASK]
[TASK:planner]根據研究結果規劃簡報大綱[/TASK]
[TASK:pptx-gen]依大綱產生簡報[/TASK]
[/PIPELINE]

[PIPELINE parallel]
[TASK:docx-gen]產生文字版報告[/TASK]
[TASK:xlsx-gen]產生數據表格[/TASK]
[/PIPELINE]
```

### 3.2 Claude CLI 程序管理

**核心實作：** `server/src/services/claudeCli.ts`

- Windows 環境下解析 .cmd wrapper，直接以 node 執行 cli.js
- 每個 Agent 獨立 spawn process，`stdio: ['pipe', 'pipe', 'pipe']`
- stdout 逐行解析 JSON (stream-json 格式)
- Session 持久化：Router 跨輪次保持，Worker 單次任務
- CLI 參數：`-p --output-format stream-json --verbose --session-id/--resume --allowedTools --disallowedTools`

**工具黑名單（Worker）：**
```
Edit, Bash(rm:*), Bash(del:*), Bash(sudo:*),
Bash(curl:*), Bash(wget:*), Bash(powershell:*),
Bash(cmd:*), Bash(chmod:*), Bash(chown:*),
Bash(mklink:*), Bash(net:*)
```

### 3.3 執行模式判斷

```typescript
if (指定 skillId || conversation 已綁定 skill || mode === 'direct') {
  → Direct 模式（單一 Agent 直接執行）
} else if (Router skill 存在) {
  → Orchestrated 模式（多 Agent 協調）
}
```

### 3.4 SSE 串流事件

| 事件類型 | 用途 |
|----------|------|
| `text` | 助手文字串流 |
| `thinking` | 思考過程（Extended Thinking） |
| `tool_activity` | 工具調用即時狀態 |
| `task_dispatched` / `task_completed` / `task_failed` | 任務生命週期 |
| `pipeline_started` / `pipeline_completed` | Pipeline 生命週期 |
| `router_plan` | Router 任務計畫 |
| `agent_status` / `agent_stream` | Agent 即時狀態 |
| `file_generated` | 檔案產生通知 |
| `usage` | Token 計數 |
| `done` | 完成訊號 |

前端 SSE 直連 Express（繞過 Next.js proxy 避免緩衝），10 秒 keepalive。

### 3.5 檔案版本管理

1. 生成前快照現有檔案
2. Agent 寫入新檔案至沙箱
3. 掃描比對：同名同路徑但大小不同 → 舊版標記為 `.v{n}`
4. 新版以 `version + 1` 註冊
5. 前端可選擇下載歷史版本

---

## 4. 安全架構

### 4.1 五層防禦模型

| 層 | 機制 | 實作位置 |
|----|------|----------|
| L1 | Input Guard — 7 偵測器，分數制 (≥60 封鎖, ≥30 警告) | `services/inputGuard.ts` |
| L2 | 沙箱路徑驗證 — ID 白名單 + resolved path 檢查 | `services/sandbox.ts` |
| L3 | CLI 工具限制 — 白名單/黑名單機制 | `services/claudeCli.ts` |
| L4 | 系統提示詞注入 — 9 條沙箱規則寫入 CLAUDE.md | `skills/loader.ts` |
| L5 | 檔案系統隔離 — `workspace/{userId}/{conversationId}/` | 全系統 |

**Input Guard 偵測器：**

1. 危險標籤偵測（`<system>`, `[SYSTEM]`, `<prompt>` 等）
2. 自然語言注入（"忽略之前的指示"、"override system" 等，中英文）
3. Unicode 混淆（零寬字元、RTL/LTR 覆寫、tag 字元）
4. 編碼載荷（Base64 解碼指示、長 Base64 字串）
5. 路徑穿越（`../`、系統路徑）
6. 公式注入（Excel 公式攻擊）
7. 升權模式（多輪繞過嘗試）

### 4.2 沙箱規則（注入至 Agent 系統提示詞）

1. 僅能寫入 cwd 及子目錄
2. 禁止 cd 指令
3. 禁止 `../` 路徑
4. 禁止 cwd 外的絕對路徑
5. 禁止讀取 cwd 外的檔案（generator 腳本除外）
6. 所有生成檔案必須使用相對路徑
7. 禁止網路存取（curl, wget）
8. 禁止刪除檔案
9. 拒絕寫入其他位置的請求

---

## 5. 資料庫設計

### 5.1 ER 概要

```
users (1) ──── (N) conversations (1) ──── (N) messages
  │                    │
  │                    ├──── (N) generated_files
  │                    ├──── (N) task_executions
  │                    ├──── (N) agent_sessions
  │                    └──── (N) user_uploads
  │
  ├──── (N) token_usage
  └──── (N) security_events
```

### 5.2 關鍵欄位

**users**: id, email, password_hash, display_name, role (user/admin), status (active/pending/suspended), locale, theme, oauth_provider, oauth_id

**conversations**: id, user_id, title, skill_id, session_id, mode (null/direct/orchestrated), status

**generated_files**: id, user_id, conversation_id, filename, file_path, file_type, file_size, **version**

**task_executions**: id, conversation_id, pipeline_id, skill_id, description, status, result_summary, input_tokens, output_tokens, started_at, completed_at

**agent_sessions**: id, conversation_id, skill_id, session_uuid, initialized

---

## 6. API 端點清單

### 6.1 認證

| Method | Path | 說明 |
|--------|------|------|
| POST | `/api/auth/register` | 註冊 |
| POST | `/api/auth/login` | 登入 |
| POST | `/api/auth/google` | Google OAuth |
| GET | `/api/auth/me` | 取得使用者資料 |
| PATCH | `/api/auth/preferences` | 更新偏好 |

### 6.2 對話

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/conversations` | 列出對話 |
| POST | `/api/conversations` | 建立對話 |
| GET | `/api/conversations/:id` | 取得對話 + 訊息 |
| PATCH | `/api/conversations/:id` | 更新標題 |
| DELETE | `/api/conversations/:id` | 刪除對話 |

### 6.3 文件生成（核心）

| Method | Path | 說明 |
|--------|------|------|
| POST | `/api/generate/:conversationId` | **SSE 串流生成** |
| GET | `/api/generate/skills` | 列出可用技能 |

### 6.4 檔案管理

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/files` | 列出檔案 |
| GET | `/api/files/:id/download` | 下載檔案 |
| GET | `/api/files/:id/preview` | 預覽首頁 |
| POST | `/api/uploads` | 上傳檔案 |
| GET | `/api/uploads` | 列出上傳 |
| DELETE | `/api/uploads/:id` | 刪除上傳 |

### 6.5 管理

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/admin/overview/stats` | 系統統計 |
| GET/PATCH | `/api/admin/users` | 使用者管理 |
| GET/PATCH | `/api/admin/settings` | 系統設定 |

---

## 7. 設定參數

### 7.1 環境變數

```bash
PORT=3000                          # 後端埠號
JWT_SECRET=dev-secret-...          # JWT 密鑰
WORKSPACE_ROOT=./workspace         # 沙箱根目錄
MYSQL_HOST=127.0.0.1               # MySQL 主機
MYSQL_PORT=3306
MYSQL_DB=db_ai_agents
MYSQL_USER=root
MYSQL_PASSWORD=
CLAUDE_CLI_PATH=claude             # Claude CLI 路徑
GOOGLE_CLIENT_ID=                  # Google OAuth
STORAGE_QUOTA_GB=2                 # 每使用者儲存配額
CORS_ORIGINS=http://localhost:3001,http://localhost:3000
```

### 7.2 系統設定（system_settings 表）

| Key | 預設值 | 說明 |
|-----|--------|------|
| `user_usage_limit_usd` | $50 | 使用者費用上限（顯示價） |
| `storage_quota_gb` | 2 | 儲存配額 (GB) |
| `upload_quota_mb` | 500 | 上傳限制 (MB) |

### 7.3 費率

```
Claude 3.5 Sonnet: $3/M input tokens, $15/M output tokens
顯示費率 = 實際費率 × 10（含加成）
```

---

## 8. 部署需求

### 8.1 前置條件

- Node.js 18+
- MySQL 8.x
- Claude CLI 已安裝且已認證
- pnpm 套件管理器

### 8.2 啟動指令

```bash
pnpm install              # 安裝依賴
pnpm run init-db           # 初始化資料庫
pnpm run dev               # 啟動 server + client
pnpm run dev:server        # 僅啟動後端
pnpm run dev:client        # 僅啟動前端
```

### 8.3 預設管理員

- Email: `admin@zhaoi.ai`
- Password: `zhaoi1023`

---

## 9. 前端技術重點

### 9.1 聊天頁核心（chat/[id]/page.tsx, 800+ 行）

- SSE 直連 Express（繞過 Next.js proxy 緩衝）
- 90+ 種工具活動解析模式
- 內嵌圖表：Recharts (```chart), Mermaid (```mermaid), Markmap (```mindmap), Leaflet (```map)
- 多 Agent 任務追蹤面板（即時狀態、計時器）
- 檔案預覽：HTML iframe / PDF-Office 首頁
- 拖放上傳 + 掃描狀態

### 9.2 狀態管理

- React Context API（AuthProvider, I18nProvider, AdminAuthProvider）
- 無全域狀態庫（Redux/Zustand）
- 自定義 hooks: `useSidebarCollapsed`, `useTranslation`

### 9.3 國際化

- 繁中（zh-TW）內建、簡中/英文 lazy-load
- 翻譯字典 + 參數插值
- 主題（dark/light）同步至 localStorage + Server

---

## 10. 已知限制與後續規劃

### 10.1 已知限制

- Claude CLI 需本機安裝，無法純雲端部署
- 單一 MySQL 實例，無 HA/讀寫分離
- 檔案預覽僅支援首頁，無完整線上編輯
- Token 計費基於 Claude 3.5 Sonnet 費率寫死

### 10.2 可擴展方向

- 支援更多 AI 引擎（OpenAI, Gemini）
- 檔案範本系統（企業品牌範本）
- 協作功能（多人共同編輯同一對話）
- Webhook / API 整合（自動化工作流）
- 容器化部署（Docker Compose）
