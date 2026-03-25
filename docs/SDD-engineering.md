# AI Agents Office — 系統設計文件（工程師版）

> 版本：1.0｜日期：2026-03-25｜狀態：開發中

---

## 1. 文件目的

本文件描述 AI Agents Office 的系統設計，涵蓋元件拆分、資料流、介面定義、資料庫設計、部署架構與安全機制。供開發團隊作為實作與維護的參考依據。

---

## 2. 系統總覽

### 2.1 部署拓撲

```
                        ┌─────────────┐
                        │   Browser   │
                        └──────┬──────┘
                               │
              ┌────────────────┼────────────────┐
              │ SSE 直連        │ REST (proxy)    │
              │                │                │
         ┌────▼────┐     ┌────▼─────┐          │
         │ Express │     │ Next.js  │          │
         │ :3000   │     │ :12053   │          │
         └────┬────┘     └──────────┘          │
              │                                │
    ┌─────────┼──────────────┐                 │
    │         │              │                 │
┌───▼───┐ ┌──▼───┐  ┌──────▼──────┐          │
│ MySQL │ │ File │  │ Claude CLI  │          │
│       │ │System│  │ (spawn ×N)  │          │
└───────┘ └──────┘  └─────────────┘
```

- **Next.js** 負責 SSR 頁面與靜態資源，API 請求透過 `next.config.ts` rewrite 轉發至 Express
- **SSE 串流例外**：前端直連 Express `/api/generate` 端點，繞過 Next.js 避免 response buffering
- **Claude CLI**：每個 Agent 任務 spawn 一個獨立 process，透過 stdin/stdout 通訊

### 2.2 程序生命週期

```
Server 啟動
  │
  ├─ 初始化 MySQL 連線池 (10 connections)
  ├─ 執行 initDB() — 建表 + seed admin
  ├─ 載入 Skills (從 skills/*/SKILL.md)
  ├─ 掛載 middleware (cors, json, auth, rateLimit)
  ├─ 掛載 routes
  └─ listen(:3000)

請求處理
  │
  ├─ [所有請求] CORS → JSON parse → Rate limit
  ├─ [受保護路由] JWT auth middleware
  ├─ [管理路由] admin auth middleware
  └─ [生成路由] Input Guard → Usage check → Orchestrator/Direct

Server 關閉
  │
  ├─ 關閉 MySQL 連線池
  └─ 清理孤立 Claude CLI 程序 (process.kill)
```

---

## 3. 元件設計

### 3.1 元件關係圖

```
routes/generate.ts
    │
    ├──▶ services/inputGuard.ts        (輸入檢測)
    ├──▶ services/usageLimit.ts        (額度檢查)
    ├──▶ services/sandbox.ts           (沙箱建立)
    ├──▶ services/uploadContext.ts     (上傳檔案注入)
    │
    ├── [Orchestrated]
    │   └──▶ services/orchestrator.ts
    │        ├──▶ services/claudeCli.ts    (Router spawn)
    │        ├──▶ services/taskParser.ts   (解析 [TASK]/[PIPELINE])
    │        ├──▶ services/claudeCli.ts    (Worker spawn ×N)
    │        └──▶ services/tokenTracker.ts (記錄用量)
    │
    ├── [Direct]
    │   ├──▶ services/claudeCli.ts     (單一 Agent spawn)
    │   └──▶ services/tokenTracker.ts
    │
    └──▶ services/fileManager.ts       (檔案掃描 + 版本註冊)
```

### 3.2 Orchestrator — 多 Agent 協調引擎

**檔案：** `server/src/services/orchestrator.ts`

**類別設計：**

```typescript
class Orchestrator {
  // 建構
  constructor(
    userId: string,
    conversationId: string,
    locale: string,
    sseWriter: (event: SSEEvent) => void
  )

  // 主進入點
  async run(userMessage: string, uploadContext?: string): Promise<OrchestratorResult>

  // 內部方法
  private async runRouterRound(messages: RouterMessage[]): Promise<RouterOutput>
  private async executeTasks(tasks: ParsedTask[]): Promise<TaskResult[]>
  private async executePipeline(pipeline: ParsedPipeline): Promise<TaskResult[]>
  private async spawnWorker(task: ParsedTask, pipeContext?: string): Promise<TaskResult>
  private buildRouterFeedback(results: TaskResult[]): string
}
```

**狀態機：**

```
IDLE → ROUTER_RUNNING → TASKS_DISPATCHED → WORKERS_RUNNING
  ↑                                              │
  │         ┌──────────────────────────────────── │
  │         │                                     ▼
  │    ROUTER_FEEDBACK ◄──── RESULTS_COLLECTED
  │         │
  │         ▼
  └─── COMPLETED / MAX_DEPTH_REACHED / TIMEOUT
```

**協調迴圈虛擬碼：**

```
depth = 0
routerMessages = [systemPrompt, userMessage]

while depth < MAX_DEPTH (3):
    routerOutput = spawnRouter(routerMessages)
    { tasks, pipelines } = parseTaskBlocks(routerOutput)

    if no tasks and no pipelines:
        break  // Router 判斷不需要更多任務

    results = []
    for each pipeline:
        if pipeline.parallel:
            results += await Promise.all(pipeline.tasks.map(spawnWorker))
        else:
            pipeContext = ""
            for each task in pipeline.tasks:
                result = await spawnWorker(task, pipeContext)
                pipeContext = result.output  // 串行傳遞
                results.push(result)

    for each bareTask:
        results.push(await spawnWorker(bareTask))

    feedback = buildRouterFeedback(results)  // 截斷至 1500 字元
    routerMessages.push(feedback)
    depth++
```

**超時策略：**

```typescript
const SKILL_TIMEOUT: Record<string, number> = {
  'router':       90_000,    // 1.5 min
  'research':     300_000,   // 5 min
  'planner':      300_000,   // 5 min
  'reviewer':     120_000,   // 2 min
  'data-analyst': 300_000,   // 5 min
  'rag-analyst':  300_000,   // 5 min
  'pptx-gen':     600_000,   // 10 min
  'docx-gen':     600_000,   // 10 min
  'xlsx-gen':     600_000,   // 10 min
  'pdf-gen':      600_000,   // 10 min
  'slides-gen':   600_000,   // 10 min
}
const ORCHESTRATION_TIMEOUT_MS = 900_000  // 15 min 總上限
```

Worker 超時處理：如果 process 已產出部分文字，取用已產出內容作為結果（partial output fallback），避免整個任務白費。

### 3.3 Claude CLI 程序管理

**檔案：** `server/src/services/claudeCli.ts`

**CLI 路徑解析（Windows 特殊處理）：**

```typescript
// 問題：npm 全域安裝在 Windows 產生 .cmd wrapper
// concurrently 下 spawn .cmd 會失敗
// 解法：解析 .cmd 內容找到實際 cli.js 路徑，用 node 直接執行

function resolveClaude(): { command: string, args: string[] } {
  // 1. 嘗試 npm prefix -g → 找 node_modules/@anthropic-ai/claude-code/cli.js
  // 2. 嘗試 %APPDATA%/npm/node_modules/...
  // 3. Fallback: 直接用 'claude' (shell: true)
  return { command: 'node', args: ['/path/to/cli.js'] }
}
```

**Spawn 參數組裝：**

```typescript
function buildCliArgs(options: SpawnOptions): string[] {
  const args = [
    '-p',                           // Print mode (非互動)
    '--output-format', 'stream-json', // 結構化串流
    '--verbose',
  ]

  if (options.resumeSessionId) {
    args.push('--resume', options.resumeSessionId)
  } else {
    args.push('--session-id', options.sessionId)
  }

  if (options.maxTurns) {
    args.push('--max-turns', String(options.maxTurns))
  }

  if (options.allowedTools?.length) {
    args.push('--allowedTools', ...options.allowedTools)
  }

  if (options.disallowedTools?.length) {
    args.push('--disallowedTools', ...options.disallowedTools)
  }

  return args
}
```

**工具權限矩陣：**

| 角色 | allowedTools | disallowedTools |
|------|-------------|-----------------|
| Router | `[]`（零工具） | — |
| Worker (預設) | `Bash, Write, Read, WebSearch, WebFetch` | `Edit, Bash(rm:*), Bash(del:*), Bash(sudo:*), Bash(curl:*), Bash(wget:*), Bash(powershell:*), Bash(cmd:*), Bash(chmod:*), Bash(chown:*), Bash(mklink:*), Bash(net:*)` |
| Worker (自訂) | 由 SKILL.md frontmatter 覆寫 | 由 SKILL.md frontmatter 覆寫 |

**stdout 事件解析：**

```typescript
// Claude CLI stream-json 格式：每行一個 JSON object
process.stdout.on('data', (chunk) => {
  buffer += chunk.toString()
  const lines = buffer.split('\n')
  buffer = lines.pop() // 保留不完整行

  for (const line of lines) {
    if (!line.trim()) continue
    const event = JSON.parse(line)

    switch (event.type) {
      case 'assistant':      // 文字輸出（含 content blocks）
      case 'content_block_delta':  // 串流增量
      case 'content_block_start':  // 區塊開始（text/tool_use/thinking）
      case 'message_start':        // 訊息開始
      case 'message_delta':        // 訊息結束 + usage
      case 'result':              // 最終結果 + session_id
    }
  }
})
```

**Session 管理：**

```
新對話 + 新 Agent:
  → 產生 UUID → --session-id {uuid}
  → 記錄到 agent_sessions 表 (initialized = false)
  → 收到 result event → 更新 initialized = true

已有 Session:
  → 查詢 agent_sessions 表
  → initialized = true → --resume {uuid}
  → initialized = false → --session-id {uuid} (重試)

Resume 失敗 (Direct 模式):
  → 產生新 UUID → --session-id {newUuid}
  → 將歷史訊息加入 prompt 前綴
  → 重新 spawn（全新 session 但保留對話脈絡）
```

### 3.4 Task Parser

**檔案：** `server/src/services/taskParser.ts`

**解析規則：**

```
輸入文字:
  "先做研究再做簡報
   [PIPELINE]
   [TASK:research]蒐集市場數據[/TASK]
   [TASK:pptx-gen]產出簡報[/TASK]
   [/PIPELINE]
   另外也順便做一份 Excel
   [TASK:xlsx-gen]數據表格[/TASK]"

解析結果:
  cleanText: "先做研究再做簡報\n另外也順便做一份 Excel"
  pipelines: [{
    tasks: [
      { skillId: 'research', description: '蒐集市場數據' },
      { skillId: 'pptx-gen', description: '產出簡報' }
    ],
    parallel: false  // 預設串行
  }]
  bareTasks: [
    { skillId: 'xlsx-gen', description: '數據表格' }
  ]
```

**結果截斷（回饋 Router）：**

```typescript
function truncateResultForRouter(result: string, maxChars = 1500): string {
  // 特殊處理：含圖表區塊 (```chart, mermaid, mindmap, map) 放大至 4000
  if (hasDiagramBlock(result)) maxChars = 4000

  if (result.length <= maxChars) return result

  const headRatio = 0.70   // 前 70%
  const tailRatio = 0.25   // 後 25%（留 5% 給省略標記）
  const head = result.slice(0, Math.floor(maxChars * headRatio))
  const tail = result.slice(-Math.floor(maxChars * tailRatio))

  return `${head}\n\n... (truncated) ...\n\n${tail}`
}
```

### 3.5 Skill 載入器

**檔案：** `server/src/skills/loader.ts`

**SKILL.md 結構：**

```yaml
---
name: PowerPoint Generator
description: 產生 PowerPoint 簡報
fileType: pptx
role: worker
order: 10
allowedTools:
  - Bash
  - Write
  - Read
disallowedTools:
  - Edit
  - Bash(rm:*)
---

你是一個 PowerPoint 簡報生成專家...
（以下為系統提示詞內容）
```

**載入流程：**

```
server 啟動
  → loadSkills()
    → glob('skills/*/SKILL.md')
    → 逐一解析 YAML frontmatter + content
    → 掃描 references/ 子目錄的 .md 附件
    → 附件內容串接至系統提示詞尾部
    → 快取至記憶體 Map<skillId, SkillDefinition>
```

**系統提示詞組裝：**

```
[Worker Agent 最終 prompt]
  = 語言指示 (依 locale)
  + SKILL.md 內容
  + 沙箱安全規則 (9 條)
  + Generator 腳本文件 (如果是 file-gen 類型)
  + NODE_PATH 提示 (讓 require() 找到 pptxgenjs 等)
  + References 附件內容

[Router Agent 最終 prompt]
  = 語言指示
  + SKILL.md 內容
  + 可用 Worker Skills 清單（名稱 + 描述 + fileType）
```

### 3.6 Input Guard — 輸入安全檢測

**檔案：** `server/src/services/inputGuard.ts`

**架構：**

```typescript
interface DetectorResult {
  score: number       // 0-100
  flags: string[]     // 觸發的偵測器名稱
}

interface GuardResult {
  safe: boolean       // score < WARN_THRESHOLD(30)
  score: number       // 總分 (capped at 100)
  flags: string[]     // 所有觸發的偵測器
  sanitized: string   // 清理後的輸入
  blocked: boolean    // score >= BLOCK_THRESHOLD(60)
}
```

**偵測器管線（串行累加）：**

```
輸入文字
  → [1] detectDangerousTags()      → +20~30 per match
  → [2] detectNaturalLanguageInjection() → +25~40
  → [3] detectUnicodeObfuscation() → +15~30
  → [4] detectEncodedPayloads()    → +20~35
  → [5] detectPathTraversal()      → +25~40
  → [6] detectFormulaInjection()   → +15~25
  → [7] detectEscalationPatterns() → +20~35
  → 累加 score (cap 100)
  → score >= 60 → blocked: true, 記錄 security_event (high)
  → score >= 30 → safe: false, 記錄 security_event (medium)
  → score < 30  → safe: true
```

**Sanitization：**

```typescript
function sanitize(input: string): string {
  return input
    .replace(/<\/?system[^>]*>/gi, '')     // 移除 <system> 標籤
    .replace(/<\/?prompt[^>]*>/gi, '')     // 移除 <prompt> 標籤
    .replace(/[\u200B-\u200F\u2028-\u202F\uFEFF]/g, '')  // 移除零寬字元
    .replace(/[\u{E0000}-\u{E007F}]/gu, '')  // 移除 tag 字元
}
```

### 3.7 Sandbox Service

**檔案：** `server/src/services/sandbox.ts`

**路徑結構：**

```
workspace/
└── {userId}/
    ├── _uploads/                    # 使用者上傳檔案
    └── {conversationId}/
        ├── CLAUDE.md                # 沙箱規則（由系統寫入）
        ├── *.pptx, *.docx, ...      # 生成的檔案
        ├── *.v1.pptx, *.v2.docx     # 版本備份
        └── _agents/
            ├── router/
            │   └── CLAUDE.md        # Router 系統提示詞
            ├── research/
            │   └── CLAUDE.md        # Research Agent 提示詞
            └── pptx-gen/
                └── CLAUDE.md        # PPTX Agent 提示詞
```

**驗證邏輯：**

```typescript
function validateId(id: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(id)
}

function validateFilePath(userId: string, filePath: string): boolean {
  const resolved = path.resolve(filePath)
  const userRoot = path.resolve(WORKSPACE_ROOT, userId)
  return resolved.startsWith(userRoot)
}

function getSandboxPath(userId: string, conversationId: string): string {
  validateId(userId)
  validateId(conversationId)
  const sandboxPath = path.join(WORKSPACE_ROOT, userId, conversationId)
  fs.mkdirSync(sandboxPath, { recursive: true })
  return sandboxPath
}
```

### 3.8 File Manager

**檔案：** `server/src/services/fileManager.ts`

**版本管理流程：**

```
[生成前]
  snapshotExistingFiles(sandboxPath)
    → 掃描現有檔案
    → 複製為 filename.v{n}.ext 備份

[生成後]
  scanSandboxFiles(sandboxPath)
    → 遞迴掃描目錄
    → 過濾條件：
        ✓ 白名單副檔名 (.pptx, .docx, .xlsx, .pdf, .html, .csv, .txt, ...)
        ✗ 排除 CLAUDE.md
        ✗ 排除 _agents/ 目錄
        ✗ 排除 .v{n}. 版本備份檔
        ✗ 排除 node_modules/
        ✗ 排除 .js/.ts 中間腳本

  registerNewFiles(userId, conversationId, newFiles)
    → 比對 pre-snapshot
    → 新路徑 → INSERT generated_files (version = 1)
    → 已存在但大小不同 → UPDATE 舊記錄 file_path 加 .v{n} → INSERT 新記錄 (version + 1)
    → 已存在且大小相同 → skip
```

### 3.9 Token Tracker & Usage Limit

**檔案：** `server/src/services/tokenTracker.ts`, `usageLimit.ts`

**計費模型：**

```typescript
// 實際成本
const COST_PER_M_INPUT = 3     // $3 per 1M input tokens
const COST_PER_M_OUTPUT = 15   // $15 per 1M output tokens
const actualCost = (input / 1e6) * COST_PER_M_INPUT
                 + (output / 1e6) * COST_PER_M_OUTPUT

// 顯示成本（含 10x 加成）
const MARKUP = 10
const displayCost = actualCost * MARKUP

// 預設上限
const DEFAULT_LIMIT_USD = 50  // 顯示價 $50
```

**額度檢查（每次生成前）：**

```typescript
async function checkUsageLimit(userId: string): Promise<{
  allowed: boolean
  currentCost: number
  limit: number
}> {
  const usage = await getUserTotalUsage(userId)
  const limit = await getSystemSetting('user_usage_limit_usd') || DEFAULT_LIMIT_USD
  const currentCost = calculateDisplayCost(usage.totalInput, usage.totalOutput)
  return {
    allowed: currentCost < limit,
    currentCost,
    limit,
  }
}
```

### 3.10 Upload Context Builder

**檔案：** `server/src/services/uploadContext.ts`

**提示詞注入格式：**

```markdown
## User Uploaded Files
Total: 3 files, 2.4 MB

### Data Files
- sales_q1.csv (156 KB) — relative path: `../../_uploads/abc123_sales_q1.csv`
- report_draft.xlsx (1.2 MB) — relative path: `../../_uploads/def456_report_draft.xlsx`

### Image Files
- logo.png (890 KB) — relative path: `../../_uploads/ghi789_logo.png`
```

圖片檔案提供相對路徑讓 Agent 可以在 generator 腳本中引用。資料檔案提供路徑讓 Agent 可以用 Read 工具讀取分析。

---

## 4. 資料流

### 4.1 Orchestrated 模式完整資料流

```
Client                Express              Orchestrator          Claude CLI
  │                     │                       │                    │
  │ POST /generate      │                       │                    │
  │ {message, uploads}  │                       │                    │
  │────────────────────▶│                       │                    │
  │                     │ inputGuard.analyze()  │                    │
  │                     │ usageLimit.check()    │                    │
  │                     │ sandbox.prepare()     │                    │
  │                     │                       │                    │
  │                     │ new Orchestrator()    │                    │
  │                     │──────────────────────▶│                    │
  │                     │                       │                    │
  │◀─ SSE: connected ──│                       │ spawn Router       │
  │                     │                       │───────────────────▶│
  │                     │                       │                    │ (推理)
  │◀─ SSE: agent_status │◀──── text events ────│◀── stdout JSON ───│
  │◀─ SSE: text ────────│                       │                    │
  │                     │                       │                    │
  │                     │                       │ parse [TASK] blocks│
  │◀─ SSE: router_plan ─│◀─────────────────────│                    │
  │                     │                       │                    │
  │                     │                       │ spawn Worker #1    │
  │◀─ SSE: task_dispatched                     │───────────────────▶│
  │                     │                       │                    │ (執行)
  │◀─ SSE: tool_activity│◀── agent_stream ─────│◀── stdout JSON ───│
  │◀─ SSE: agent_stream │                       │                    │
  │                     │                       │                    │
  │◀─ SSE: file_generated◀── file detected ────│                    │
  │◀─ SSE: task_completed◀── worker done ──────│                    │
  │                     │                       │                    │
  │                     │                       │ truncate results   │
  │                     │                       │ feed back to Router│
  │                     │                       │───────────────────▶│ (Router round 2)
  │                     │                       │                    │
  │                     │                       │ (no more tasks)    │
  │                     │                       │                    │
  │◀─ SSE: usage ───────│◀─────────────────────│ record tokens      │
  │◀─ SSE: done ────────│◀─────────────────────│ save messages      │
  │                     │                       │                    │
```

### 4.2 Direct 模式資料流

```
Client                Express              Claude CLI
  │                     │                    │
  │ POST /generate      │                    │
  │ {message, skillId}  │                    │
  │────────────────────▶│                    │
  │                     │ guards + checks    │
  │                     │                    │
  │                     │ resolve session    │
  │                     │ (new or resume)    │
  │                     │                    │
  │◀─ SSE: connected ──│ spawn Claude CLI   │
  │                     │───────────────────▶│
  │                     │                    │ (執行)
  │◀─ SSE: text ────────│◀── stdout JSON ───│
  │◀─ SSE: tool_activity│◀── tool events ───│
  │◀─ SSE: thinking ────│◀── thinking ──────│
  │                     │                    │
  │                     │ (process exit)     │
  │                     │◀──────────────────│
  │                     │                    │
  │                     │ scanSandboxFiles() │
  │◀─ SSE: file_generated                   │
  │◀─ SSE: usage ───────│ record tokens      │
  │◀─ SSE: done ────────│ save messages      │
  │                     │                    │

Session Resume 失敗時:
  │                     │ resume → error     │
  │                     │                    │
  │                     │ 產生新 session UUID │
  │                     │ 歷史訊息 → prompt   │
  │                     │ 重新 spawn ────────▶│
  │                     │                    │
```

### 4.3 檔案上傳資料流

```
Client                Express              File System
  │                     │                    │
  │ POST /uploads       │                    │
  │ (multipart/form)    │                    │
  │────────────────────▶│                    │
  │                     │ multer parse       │
  │                     │ validate size/type │
  │                     │                    │
  │                     │ save to            │
  │                     │ workspace/{uid}/   │
  │                     │ _uploads/{hash}_   │
  │                     │ {filename}  ──────▶│
  │                     │                    │
  │                     │ uploadScanner      │
  │                     │ .scan(filePath)    │
  │                     │ → clean/suspicious │
  │                     │   /rejected        │
  │                     │                    │
  │                     │ INSERT user_uploads│
  │◀── 200 { upload } ─│                    │
  │                     │                    │

生成時使用:
  │ POST /generate      │                    │
  │ {uploadIds: [...]}  │                    │
  │────────────────────▶│                    │
  │                     │ uploadContext      │
  │                     │ .build(uploadIds)  │
  │                     │ → markdown snippet │
  │                     │ → 注入 Agent prompt│
  │                     │                    │
```

---

## 5. 資料庫詳細設計

### 5.1 完整 Schema

```sql
CREATE TABLE users (
  id           VARCHAR(36) PRIMARY KEY,
  email        VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  display_name VARCHAR(100),
  role         ENUM('user', 'admin') DEFAULT 'user',
  status       ENUM('active', 'pending', 'suspended') DEFAULT 'active',
  locale       VARCHAR(10) DEFAULT 'zh-TW',
  theme        VARCHAR(10) DEFAULT 'dark',
  oauth_provider VARCHAR(20),
  oauth_id     VARCHAR(255),
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE conversations (
  id           VARCHAR(36) PRIMARY KEY,
  user_id      VARCHAR(36) NOT NULL,
  title        VARCHAR(200),
  skill_id     VARCHAR(50),
  session_id   VARCHAR(36),
  mode         VARCHAR(20),    -- NULL | 'direct' | 'orchestrated'
  status       VARCHAR(20) DEFAULT 'active',
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE messages (
  id              VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  role            ENUM('user', 'assistant', 'system') NOT NULL,
  content         MEDIUMTEXT,
  metadata        JSON,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE generated_files (
  id              VARCHAR(36) PRIMARY KEY,
  user_id         VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36),
  filename        VARCHAR(255) NOT NULL,
  file_path       VARCHAR(500) NOT NULL,
  file_type       VARCHAR(20),
  file_size       BIGINT DEFAULT 0,
  version         INT DEFAULT 1,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL
);

CREATE TABLE token_usage (
  id              VARCHAR(36) PRIMARY KEY,
  user_id         VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36),
  input_tokens    INT DEFAULT 0,
  output_tokens   INT DEFAULT 0,
  model           VARCHAR(50),
  duration_ms     INT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE task_executions (
  id              VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  pipeline_id     VARCHAR(36),
  skill_id        VARCHAR(50) NOT NULL,
  description     TEXT,
  status          VARCHAR(20) DEFAULT 'pending',  -- pending|running|completed|failed|timeout
  result_summary  TEXT,
  input_tokens    INT DEFAULT 0,
  output_tokens   INT DEFAULT 0,
  started_at      DATETIME,
  completed_at    DATETIME,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);

CREATE TABLE agent_sessions (
  id              VARCHAR(36) PRIMARY KEY,
  conversation_id VARCHAR(36) NOT NULL,
  skill_id        VARCHAR(50) NOT NULL,
  session_uuid    VARCHAR(36) NOT NULL,
  initialized     BOOLEAN DEFAULT FALSE,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  UNIQUE(conversation_id, skill_id)
);

CREATE TABLE security_events (
  id         VARCHAR(36) PRIMARY KEY,
  user_id    VARCHAR(36),
  event_type VARCHAR(50) NOT NULL,
  severity   ENUM('low', 'medium', 'high', 'critical') DEFAULT 'medium',
  detail     TEXT,
  raw_input  TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_uploads (
  id              VARCHAR(36) PRIMARY KEY,
  user_id         VARCHAR(36) NOT NULL,
  conversation_id VARCHAR(36),
  filename        VARCHAR(255) NOT NULL,
  original_name   VARCHAR(255),
  file_type       VARCHAR(20),
  mime_type       VARCHAR(100),
  file_size       BIGINT DEFAULT 0,
  scan_status     ENUM('pending', 'clean', 'suspicious', 'rejected') DEFAULT 'pending',
  scan_detail     TEXT,
  storage_path    VARCHAR(500),
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE system_settings (
  key_name  VARCHAR(100) PRIMARY KEY,
  value     TEXT
);
```

### 5.2 索引策略

```sql
-- 高頻查詢索引
CREATE INDEX idx_conversations_user ON conversations(user_id, created_at DESC);
CREATE INDEX idx_messages_conversation ON messages(conversation_id, created_at);
CREATE INDEX idx_files_user ON generated_files(user_id, created_at DESC);
CREATE INDEX idx_files_conversation ON generated_files(conversation_id);
CREATE INDEX idx_usage_user ON token_usage(user_id, created_at);
CREATE INDEX idx_tasks_conversation ON task_executions(conversation_id);
CREATE INDEX idx_security_user ON security_events(user_id, created_at DESC);
CREATE INDEX idx_uploads_user ON user_uploads(user_id, created_at DESC);
```

---

## 6. 前端架構

### 6.1 頁面路由

| Route | 元件 | 認證 | 說明 |
|-------|------|------|------|
| `/` | `page.tsx` | — | 依登入狀態重導 |
| `/login` | `login/page.tsx` | 公開 | 登入 + Google OAuth |
| `/register` | `register/page.tsx` | 公開 | 註冊（含 honeypot） |
| `/dashboard` | `dashboard/page.tsx` | 必要 | 主控台 |
| `/conversations` | `conversations/page.tsx` | 必要 | 對話列表 |
| `/chat/[id]` | `chat/[id]/page.tsx` | 必要 | 聊天主頁（核心） |
| `/files` | `files/page.tsx` | 必要 | 檔案管理 |
| `/usage` | `usage/page.tsx` | 必要 | 用量統計 |
| `/skills` | `skills/page.tsx` | 必要 | 技能瀏覽 |
| `/share/[token]` | `share/[token]/page.tsx` | 公開 | 分享預覽 |
| `/admin/*` | `admin/*/page.tsx` | Admin | 管理後台 (6 頁) |

### 6.2 Context 架構

```
<html>
  <AuthProvider>             ← JWT token + user state
    <I18nProvider>           ← locale + theme + t()
      <RootLayout>
        <Navbar />           ← 側邊欄，讀取 auth + i18n context
        {children}           ← 頁面內容
      </RootLayout>
    </I18nProvider>
  </AuthProvider>
</html>

Admin 路由額外包裝:
  <AdminAuthProvider>        ← role === 'admin' 檢查
    <AdminSidebar />
    {children}
  </AdminAuthProvider>
```

### 6.3 聊天頁面狀態管理

```typescript
// chat/[id]/page.tsx 核心狀態
const [messages, setMessages] = useState<Message[]>([])
const [streamText, setStreamText] = useState('')         // 串流中文字
const [thinkingText, setThinkingText] = useState('')     // 思考過程
const [tools, setTools] = useState<ToolActivity[]>([])   // 工具活動
const [files, setFiles] = useState<GeneratedFile[]>([])  // 所有檔案
const [latestFiles, setLatestFiles] = useState<GeneratedFile[]>([]) // 最新批次
const [agentTasks, setAgentTasks] = useState<AgentTask[]>([])  // Agent 任務
const [isStreaming, setIsStreaming] = useState(false)     // 串流中
const [lastUsage, setLastUsage] = useState<Usage | null>(null)  // Token 用量
const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]) // 上傳附件
```

### 6.4 SSE 連線實作

```typescript
// 直連 Express（繞過 Next.js proxy）
const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000'

const response = await fetch(`${API_BASE}/api/generate/${conversationId}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
  },
  body: JSON.stringify({ message, skillId, uploadIds }),
})

const reader = response.body!.getReader()
const decoder = new TextDecoder()
let buffer = ''

while (true) {
  const { done, value } = await reader.read()
  if (done) break

  buffer += decoder.decode(value, { stream: true })
  const lines = buffer.split('\n')
  buffer = lines.pop()!

  for (const line of lines) {
    if (!line.startsWith('data: ')) continue
    const event: SSEEvent = JSON.parse(line.slice(6))

    switch (event.type) {
      case 'text':           setStreamText(prev => prev + event.data); break
      case 'thinking':       setThinkingText(prev => prev + event.data); break
      case 'tool_activity':  setTools(prev => [...prev, event.data]); break
      case 'file_generated': setFiles(prev => [...prev, event.data]); break
      case 'task_dispatched': setAgentTasks(prev => [...prev, event.data]); break
      case 'task_completed':  updateTaskStatus(event.data, 'completed'); break
      case 'usage':          setLastUsage(event.data); break
      case 'done':           finalizeMessage(); break
    }
  }
}
```

### 6.5 圖表元件架構

```
ReactMarkdown
  └─ components={{ code: CodeBlock }}
      │
      ├─ language === 'chart'
      │   └─ <ChatChart data={JSON.parse(children)} />
      │       └─ Recharts (Bar, Line, Area, Pie, Radar, Scatter)
      │
      ├─ language === 'mermaid'
      │   ├─ isMindmap(children) ?
      │   │   └─ <ChatMindmap markdown={convertToMarkdown(children)} />
      │   │       └─ Markmap (interactive tree)
      │   └─ <ChatMermaid chart={children} />
      │       └─ Mermaid.js (flowchart, sequence, state, class, ...)
      │
      ├─ language === 'mindmap'
      │   └─ <ChatMindmap markdown={children} />
      │
      ├─ language === 'map'
      │   └─ <ChatMap config={JSON.parse(children)} />
      │       └─ React-Leaflet (GeoJSON, markers)
      │
      └─ default
          └─ <pre><code>{children}</code></pre>
```

### 6.6 工具活動解析

```typescript
// 90+ 種模式的解析範例
function parseToolInput(toolName: string, input: string): string {
  switch (toolName) {
    case 'Bash':
      // 識別 generator 腳本
      if (input.includes('generate-pptx'))  return '🔧 生成 PowerPoint'
      if (input.includes('generate-docx'))  return '🔧 生成 Word'
      if (input.includes('npm install'))    return '📦 安裝套件'
      // ... 更多模式
      return `$ ${extractCommand(input)}`

    case 'Write':
      return `📝 寫入 ${extractFilename(input)}`

    case 'Read':
      return `📖 讀取 ${extractFilename(input)}`

    case 'WebSearch':
      return `🔍 搜尋: ${extractQuery(input)}`

    case 'WebFetch':
      return `🌐 取得: ${extractUrl(input)}`

    // ... 更多工具
  }
}
```

---

## 7. 錯誤處理

### 7.1 錯誤分類

| 類別 | 處理方式 | SSE 事件 |
|------|----------|----------|
| 輸入被封鎖 (score ≥ 60) | 回傳 403 + 記錄 security_event | — (HTTP error) |
| 額度超限 | 回傳 403 | — (HTTP error) |
| 儲存空間不足 | 回傳 413 | — (HTTP error) |
| Router spawn 失敗 | 重試一次（新 session）| `error` |
| Worker spawn 失敗 | 記錄 task_failed | `task_failed` |
| Worker 超時 | 取用 partial output 或標記 timeout | `task_failed` |
| Session resume 失敗 | 新 session + 歷史訊息注入 | 透明重試 |
| Claude CLI crash | 收集 stderr，回報錯誤 | `error` |

### 7.2 重試策略

```
Router 失敗:
  → 第 1 次失敗 → 產生新 session → 重試 1 次
  → 第 2 次失敗 → emit error event → 終止

Worker 失敗:
  → 不重試（由 Router 在下一輪決定是否重新派遣）

Direct 模式 Session Resume 失敗:
  → 產生新 session UUID
  → 將完整對話歷史注入 prompt 前綴
  → 以新 session 重新 spawn
  → 對使用者透明（不會看到錯誤）
```

---

## 8. 效能考量

### 8.1 連線池

- MySQL: 10 connections (mysql2/promise pool)
- 避免 per-request 建連

### 8.2 快取

- Skills: 記憶體快取（啟動時載入一次）
- Dev mode: `invalidateSkillCache()` 可強制重載
- I18n: 前端 lazy-load + 記憶體快取（zh-TW 內建，zh-CN/en 按需載入）

### 8.3 串流

- SSE keepalive: 每 10 秒發送 `: keepalive\n\n`
- `X-Accel-Buffering: no` 防止 nginx/proxy 緩衝
- 前端直連 Express 繞過 Next.js SSR proxy

### 8.4 並行

- Pipeline parallel: Worker 任務以 `Promise.all` 並行執行
- 無相依性的 bare tasks 也並行執行
- 每個 Agent 獨立 process，OS 層級並行

---

## 9. 可觀測性

### 9.1 日誌

- `task_executions` 表記錄每個 Agent 任務的完整生命週期
- `token_usage` 表記錄每次生成的 Token 消耗
- `security_events` 表記錄所有安全相關事件
- `admin_audit_log` 表記錄管理員操作

### 9.2 前端透明度

- 工具活動即時串流（使用者可看到 AI 在做什麼）
- Agent 任務面板（多 Agent 模式下的任務追蹤）
- Token 用量即時更新

### 9.3 管理後台

- Token 速率圖表（7 天 / 30 天）
- 使用者活動日誌
- 安全事件監控
- 系統健康狀態

---

## 10. 已知技術債

1. **聊天頁面過大**：`chat/[id]/page.tsx` 超過 800 行，應拆分為 MessageList、ToolPanel、FilePanel 等子元件
2. **費率寫死**：Token 計費基於 Claude 3.5 Sonnet 費率硬編碼，應改為可設定
3. **無 HA**：單一 MySQL 實例，無讀寫分離或 failover
4. **無容器化**：目前為裸機部署，應加入 Docker Compose
5. **Claude CLI 依賴**：強耦合本機 Claude CLI，無法純 API 模式運行
6. **Navbar 過大**：`Navbar.tsx` 約 87KB，含過多邏輯應拆分
7. **無自動化測試**：目前無 unit test / integration test 覆蓋
