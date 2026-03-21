# AI Agents Office

AI 驅動的文件生成服務。使用者透過網頁介面描述需求，系統調度本地 Claude CLI 代理自動生成 PowerPoint、Word、Excel、PDF 文件。

![Dashboard](designs/dashboard-page.png)

## 功能特色

- **多代理協作** - Router Agent 分析需求，自動調度專業 Worker Agent 協同完成任務
- **4 種文件類型** - 支援 PPTX、DOCX、XLSX、PDF 生成，各有專屬技能代理
- **即時串流** - 基於 SSE 的即時進度推送，可視化代理活動狀態
- **沙箱隔離** - 5 層安全防禦模型，每位使用者檔案獨立隔離
- **管理後台** - 使用者管理、Token 用量分析、操作稽核日誌
- **多輪對話** - 持久化代理 Session，支援跨回合對話記憶

## 畫面截圖

| 登入 | 聊天 | 檔案管理 |
|------|------|----------|
| ![Login](designs/login-page.png) | ![Chat](designs/chat-page.png) | ![Files](designs/files-page.png) |

## 技術棧

| 層級 | 技術 |
|------|------|
| 後端 | Express 5 + TypeScript |
| 前端 | Next.js 15 (App Router) + Tailwind CSS |
| 資料庫 | SQLite (better-sqlite3) |
| 認證 | bcrypt + JWT |
| AI 引擎 | Claude CLI（本地行程生成） |
| 串流 | Server-Sent Events (SSE) |
| 文件生成 | pptxgenjs, docx, exceljs, pdfkit |

## 系統架構

```
                    ┌──────────────┐
                    │   Next.js    │ :3001
                    │     前端     │
                    └──────┬───────┘
                           │ SSE / REST
                    ┌──────┴───────┐
                    │   Express    │ :3000
                    │     後端     │
                    └──────┬───────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────┴─────┐ ┌───┴───┐ ┌─────┴─────┐
        │  Claude    │ │SQLite │ │ Workspace  │
        │  CLI 代理  │ │ 資料庫 │ │  (沙箱)    │
        └─────┬─────┘ └───────┘ └────────────┘
              │
    ┌─────────┼─────────┐
    │         │         │
  Router   Workers   Generators
  路由代理  工作代理    文件生成器
          (research,  (pptx, docx,
          planner,    xlsx, pdf)
          reviewer)
```

### 多代理工作流程

1. 使用者發送訊息（例如「研究 AI 趨勢並製作簡報」）
2. **Router Agent** 分析請求，輸出 `[TASK]` / `[PIPELINE]` 任務區塊
3. **Worker Agents** 依序或並行執行任務
4. 結果回饋給 Router 進行迭代優化（最多 3 輪）
5. 生成的檔案自動註冊，可供下載

```
使用者訊息 → Router Agent → [TASK:research] → Research Agent
                          → [TASK:pptx-gen] → PPTX Agent → output.pptx
```

### 執行模式

| 模式 | 觸發條件 | 行為 |
|------|----------|------|
| **協作模式** | 未指定技能 | Router 調度多個 Worker 協同工作 |
| **直接模式** | 在 UI 選擇特定技能 | 單一代理獨立處理 |

## 專案結構

```
ai-agents-office/
├── server/                     # Express API 後端
│   ├── src/
│   │   ├── routes/             # API 端點（auth, generate, files, admin...）
│   │   ├── services/           # 核心邏輯（orchestrator, claudeCli, sandbox...）
│   │   ├── middleware/         # 認證、速率限制
│   │   ├── skills/             # 代理技能定義
│   │   │   ├── router/         #   請求分析與任務調度
│   │   │   ├── pptx-gen/       #   PowerPoint 生成
│   │   │   ├── docx-gen/       #   Word 文件生成
│   │   │   ├── xlsx-gen/       #   Excel 試算表生成
│   │   │   ├── pdf-gen/        #   PDF 生成
│   │   │   ├── research/       #   網路研究與彙整
│   │   │   ├── planner/        #   規劃與大綱
│   │   │   └── reviewer/       #   審閱與品質把關
│   │   ├── generators/         # 文件生成腳本（pptxgenjs, docx 等）
│   │   ├── config.ts           # 應用程式設定
│   │   └── db.ts               # SQLite 結構與初始化
│   └── package.json
├── client/                     # Next.js 前端
│   ├── src/app/
│   │   ├── dashboard/          # 主控台
│   │   ├── chat/[id]/          # 聊天介面（含代理活動視覺化）
│   │   ├── files/              # 檔案總管
│   │   ├── skills/             # 技能中心
│   │   ├── usage/              # Token 用量分析
│   │   ├── admin/              # 管理後台
│   │   └── components/         # 共用元件（AuthProvider, Navbar...）
│   └── package.json
├── workspace/                  # 沙箱輸出目錄（依使用者/對話隔離）
├── designs/                    # UI 設計參考
├── .env.example                # 環境變數範本
├── pnpm-workspace.yaml         # Monorepo 設定
└── CLAUDE.md                   # 專案指引
```

## 快速開始

### 前置需求

- **Node.js** 18+
- **pnpm**（套件管理器）
- **Claude CLI** 全域安裝：
  ```bash
  npm install -g @anthropic-ai/claude-code
  ```

### 安裝

```bash
# 複製專案
git clone https://github.com/anthropics/ai-agents-office.git
cd ai-agents-office

# 安裝依賴
pnpm install

# 複製環境設定
cp .env.example .env
# 編輯 .env，將 JWT_SECRET 設為安全的隨機字串

# 初始化資料庫
pnpm run init-db
```

### 啟動

```bash
# 同時啟動前後端
pnpm run dev

# 或分別啟動
pnpm run dev:server   # Express API：http://localhost:3000
pnpm run dev:client   # Next.js UI：http://localhost:3001
```

### 預設管理員帳號

執行 `init-db` 後會建立管理員帳號：
- **信箱**：`admin@zhaoi.ai`
- **密碼**：*（見 `server/src/db.ts` 中的 seed 資料）*

## 環境變數

| 變數 | 預設值 | 說明 |
|------|--------|------|
| `PORT` | `3000` | Express 伺服器連接埠 |
| `JWT_SECRET` | - | **必填**，JWT 簽章金鑰 |
| `NODE_ENV` | `development` | 環境模式 |
| `WORKSPACE_ROOT` | `./workspace` | 沙箱輸出根目錄 |
| `CLAUDE_CLI_PATH` | `claude` | Claude CLI 執行檔路徑 |
| `STORAGE_QUOTA_GB` | `2` | 每位使用者儲存空間上限（GB） |

## API 端點

### 認證

| 方法 | 端點 | 說明 |
|------|------|------|
| POST | `/api/auth/register` | 建立帳號 |
| POST | `/api/auth/login` | 登入，回傳 JWT |
| GET | `/api/auth/me` | 取得目前使用者資訊 |

### 對話

| 方法 | 端點 | 說明 |
|------|------|------|
| GET | `/api/conversations` | 列出對話 |
| POST | `/api/conversations` | 建立對話 |
| GET | `/api/conversations/:id` | 取得對話與訊息 |
| PATCH | `/api/conversations/:id` | 更新標題/狀態 |

### 生成

| 方法 | 端點 | 說明 |
|------|------|------|
| POST | `/api/generate/:id` | SSE 串流生成 |
| GET | `/api/generate/skills` | 列出可用技能 |

### 檔案

| 方法 | 端點 | 說明 |
|------|------|------|
| GET | `/api/files` | 列出檔案（可篩選） |
| GET | `/api/files/:id/download` | 下載檔案 |
| GET | `/api/files/:id/preview` | 預覽檔案 |
| DELETE | `/api/files/:id` | 刪除檔案 |

### 管理後台

| 方法 | 端點 | 說明 |
|------|------|------|
| GET | `/api/admin/overview/stats` | 系統統計 |
| GET | `/api/admin/overview/token-velocity` | 每日 Token 用量 |
| GET | `/api/admin/users` | 使用者管理 |
| PATCH | `/api/admin/users/:id/status` | 停用/啟用使用者 |
| GET | `/api/admin/security/audit-log` | 稽核日誌 |

## 安全模型

系統採用 **5 層縱深防禦**：

1. **身分認證** - JWT Token，7 天效期
2. **輸入驗證** - 訊息消毒、10K 字元限制、路徑穿越攔截
3. **沙箱隔離** - 所有檔案限制在 `workspace/{userId}/{conversationId}/` 內
4. **工具限制** - Claude CLI 代理依角色授予不同工具權限：
   - Router：僅 `WebSearch`、`WebFetch`（唯讀）
   - Worker：`Bash(node:*)`、`Write`、`Read`、`WebSearch`、`WebFetch`
   - 封鎖：`Edit`、`rm`、`del`、`sudo`、`curl`、`wget`、`powershell`
5. **檔案驗證** - 路徑正規化、工作區邊界檢查

額外防護：
- **速率限制**：每位使用者 30 次/分鐘
- **儲存配額**：每位使用者 2 GB（可設定）
- **管理稽核**：所有管理員操作皆記錄
- **bcrypt**：12 輪密碼雜湊

## 技能系統

每個技能由 `SKILL.md` 檔案定義，包含 YAML frontmatter 中繼資料與系統提示詞。

| 技能 | 角色 | 檔案輸出 | 說明 |
|------|------|----------|------|
| `router` | 路由器 | - | 分析請求、調度任務 |
| `pptx-gen` | 工作者 | `.pptx` | PowerPoint 簡報生成 |
| `docx-gen` | 工作者 | `.docx` | Word 文件生成 |
| `xlsx-gen` | 工作者 | `.xlsx` | Excel 試算表生成 |
| `pdf-gen` | 工作者 | `.pdf` | PDF 文件生成 |
| `research` | 工作者 | - | 網路研究與資料彙整 |
| `planner` | 工作者 | - | 規劃與大綱撰寫 |
| `reviewer` | 工作者 | - | 審閱與品質把關 |

### 代理逾時設定

| 代理 | 逾時 |
|------|------|
| Router | 2 分鐘 |
| Research | 3 分鐘 |
| Planner | 5 分鐘 |
| Reviewer | 2 分鐘 |
| PPTX Gen | 10 分鐘 |
| DOCX Gen | 8 分鐘 |
| XLSX Gen | 5 分鐘 |
| PDF Gen | 5 分鐘 |

## 資料庫

SQLite 資料庫，包含以下資料表：

- **`users`** - 使用者帳號，含角色（`user`/`admin`）與狀態（`active`/`suspended`）
- **`conversations`** - 對話工作階段，追蹤模式（`direct`/`orchestrated`）
- **`messages`** - 對話訊息（user/assistant/system）
- **`generated_files`** - 檔案註冊表（含中繼資料）
- **`token_usage`** - 每次呼叫的 Token 消耗紀錄
- **`task_executions`** - 多代理任務狀態追蹤
- **`agent_sessions`** - 持久化 Claude CLI Session（每代理/對話）
- **`admin_audit_log`** - 管理員操作稽核軌跡

## 指令

```bash
pnpm run dev          # 同時啟動前後端
pnpm run dev:server   # 僅啟動 Express 後端
pnpm run dev:client   # 僅啟動 Next.js 前端
pnpm run build        # 建置生產版本
pnpm run init-db      # 初始化資料庫（含 seed 資料）
```

## 授權

私有專案，保留所有權利。
