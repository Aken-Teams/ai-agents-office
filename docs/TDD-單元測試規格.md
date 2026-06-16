# AI Agents Office — TDD 單元測試規格

> 版本 1.0 · 2026-06-12 · 對象:開發
> 系列文件:〈ATDD-驗收測試規格〉·〈BDD-行為測試規格〉· **本篇 TDD**

## 0. 關於 TDD(Test-Driven Development)

TDD 回答的是「**每個單元正確嗎?**」。以 **紅 → 綠 → 重構** 的循環驅動實作:先寫一條會失敗的測試(紅),寫最小程式碼讓它通過(綠),再在測試保護下重構。

- **語言**:程式碼(Vitest `describe` / `it`)。
- **層級**:單元(純函式、模組)。
- **原則**:純邏輯(鎖定計算、輸出淨化、路徑驗證、解析器)應可**不依賴 DB / 網路**直接測試。
- **回歸**:每個資安修補(如 M-11)都先補一條**回歸測試**釘住正確行為。

```jsonc
// server/package.json(新增)
"scripts": { "test": "vitest run", "test:watch": "vitest" }
```

---

## 1. F1 — 使用者認證與登入防護

對應 `routes/auth.ts` 之 `checkLoginLockout` / `recordLoginFailure` / `clearLoginFailures`。

```ts
// auth.lockout.test.ts
describe('login lockout (M-11)', () => {
  it('門檻內的失敗計數會持續累積,不被每次檢查清除', () => {
    // 回歸:修補前缺陷是計數每次被清成 1,永遠到不了門檻
  });
  it('連續 5 次失敗後 checkLoginLockout 回報 locked=true', () => {});
  it('鎖定中回傳剩餘時間 remainingMs > 0', () => {});
  it('時間窗(lockedUntil)過後再檢查 → 自動重置為未鎖定', () => {});
  it('每次失敗都重新標記滾動時窗(15 分鐘)', () => {});
  it('clearLoginFailures 後計數歸零(成功登入路徑)', () => {});
  it('清理排程移除已逾時項目(Map 不會無限增長)', () => {});
});

describe('credential & token', () => {
  it('bcrypt.compare 對正確密碼回 true、錯誤回 false', () => {});
  it('JWT 簽發包含 userId/email/role 且有效期為 7d', () => {});
  it('isValidEmail 接受合法信箱、拒絕超長或格式錯誤', () => {});
  it('generateVerificationCode 為 6 位、使用加密級亂數(crypto.randomInt)', () => {});
});
```

> **回歸重點**:第一條測試直接釘住 M-11 — 修補前「同一序列連續失敗皆回 401、永不鎖定」,修補後「5 次 401 → 423 →(逾量)429」。

---

## 2. F2 — AI 文件生成

```ts
describe('sanitizeOutput', () => {
  it('遮蔽 Unix 家目錄 /home/<user>/...', () => {});
  it('遮蔽 Windows 使用者路徑 C:\\Users\\...', () => {});
  it('遮蔽 _agents/<skill>/ 內部路徑', () => {});
  it('遮蔽 node_modules / .claude 等內部路徑', () => {});
  it('一般文字不受影響(無誤遮)', () => {});
});

describe('taskParser', () => {
  it('正確解析 [TASK] 區塊為待派工項目', () => {});
  it('正確解析 [PIPELINE] 多階段任務', () => {});
  it('格式錯誤的區塊不致拋例外(容錯)', () => {});
});

describe('claudeCli 串流與 token', () => {
  it('由 message_start / message_delta / result 正確累加 input/output tokens', () => {});
  it('content_block_delta 之 text_delta 經 sanitize 後對外送出', () => {});
  it('帳號額度用盡(quota error)且有 API 金鑰時 → 退回 API 金鑰重試', () => {});
});
```

---

## 3. F3 — 平台安全控制

```ts
describe('安全中介層 / 組態', () => {
  it('helmet 設定產生 nosniff / HSTS / referrer-policy 標頭', () => {});
  it('回應不含 x-powered-by', () => {});
  it('全域錯誤處理:production 隱藏 detail、development 顯示 detail', () => {});
  it('rateLimit:超過 config.rateLimitMaxRequests 回 429', () => {});
});

describe('validateConfig (fail-fast)', () => {
  it('production + 預設 JWT_SECRET → 拋錯拒絕啟動', () => {});
  it('production + 空 MYSQL_PASSWORD → 拋錯', () => {});
  it('production + 正確密鑰與密碼 → 通過', () => {});
  it('development + 預設密鑰 → 僅警示不中止', () => {});
});
```

> 對應資安報告 §2(動態驗證)與 C-01/M-09(fail-fast)、H-02/M-06(安全標頭)、M-07/M-08(錯誤處理)。

---

## 4. F4 — 沙盒與跨帳號資料隔離

對應 `services/sandbox.ts` 之路徑歸屬驗證(L-04 強化)。

```ts
describe('sandbox 路徑歸屬', () => {
  it('精確匹配使用者根目錄 → 允許', () => {});
  it('位於使用者根目錄之下(含路徑分隔)→ 允許', () => {});
  it('相似前綴(workspace/alice 對 workspace/alice-evil)→ 拒絕', () => {});
  it('含 .. 之穿越路徑 → 拒絕', () => {});
  it('getSandboxPath 對不同 user/conversation 產生不重疊路徑', () => {});
});
```

---

## 5. F5 — 內容安全護欄

對應 `services/contentSafety.ts`(本地規則 + 語意分類)。

```ts
describe('contentSafety', () => {
  it('本地確定性規則命中六類惡意意圖', () => {});
  it('語意分類(輔助服務)逾時 → fail-open(本地規則已先篩)', () => {});
  it('無金鑰時略過語意分類、回退本地規則', () => {});
  it('防禦性資安 / 教育用途 → allowed=true(不誤殺)', () => {});
  it('拒絕結果含類別代碼但對外訊息不洩漏規則', () => {});
});
```

---

## 6. 測試環境設定

- **純函式單元**(lockout、sanitizeOutput、taskParser、sandbox 路徑、validateConfig):直接 `import` 測試,不需 DB / 網路。
- **需 DB 的整合**:以**獨立測試資料庫**(Docker 拋棄式 MySQL)避免污染正式資料。
- **production 行為**:以 `NODE_ENV=production` 並注入合法 `JWT_SECRET` / DB 密碼啟動測試實例。
- **流程**:紅(失敗測試)→ 綠(最小實作)→ 重構;PR 需附對應單元測試,資安修補另附回歸測試。

*本文件為內部工程文件;對照〈ATDD〉、〈BDD〉與資安報告 §2 / §7。*
