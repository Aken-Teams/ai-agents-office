/**
 * What the assistant actually did to somebody's open document.
 *
 * ── Why conversations were not enough ──
 * Until now the only trace of an add-in turn was the transcript: 「幫我把 Q3 的
 * 數字更新」 and 「已更新完成」. Everything between those two lines — which sheet,
 * which range, which slides were deleted, what code `excel_run_script` ran — was
 * emitted to the live SSE stream for the progress caption and then dropped.
 *
 * That gap matters more here than it does on the web side, and the reason is
 * structural rather than a matter of degree. ai-agents produces a FILE: if you
 * want to know what it did, you open the file, and the artefact is the record.
 * The add-in edits the document in place — there is no artefact, the change IS
 * the document, and the state before it is gone. So the log is the only record
 * that can exist.
 *
 * ── The confirmation gate is half retrospective ──
 * A gate whose outcome is never written down only works while somebody is
 * watching it. Under 自動允許 nobody clicks at all, and if the calls are not
 * recorded either, the assistant has changed a real file with no trace of what
 * or whether anyone agreed. `decision` is therefore three-valued and not a
 * boolean: 「自動允許」 and 「人看了才按」 are different facts about what happened,
 * and an audit that cannot tell them apart is not an audit.
 *
 * ── What is deliberately NOT stored ──
 * Not the arguments. A write's arguments contain the cell values being written,
 * so storing them would copy salary figures and customer prices into an audit
 * table that is read by people who have no business seeing them — the log would
 * become the leak it exists to detect. What goes in is the one-line description
 * the tool spec already writes for the confirmation card, plus a coordinate.
 */
import { randomUUID } from 'crypto';

export type ActionDecision =
  /** No confirmation was required — a read, or a write that cannot lose anything. */
  | 'none'
  /** 自動允許 was on: it ran without a human looking at it. */
  | 'auto'
  /** A person read the card and approved it. */
  | 'allowed'
  /** A person read the card and refused. */
  | 'rejected';

export interface AddinAction {
  userId?: string;
  conversationId?: string;
  /** 'excel' | 'word' | 'ppt' — taken from the tool name, so it cannot disagree. */
  host: string;
  /** 哪個模型做的。地端和雲端的判斷品質不一樣，事後追查需要這一欄。 */
  model?: string | null;
  tool: string;
  /** Where it landed: 「損益表!C4:F40」, 「投影片 5–7」, a filename. */
  target?: string;
  destructive: boolean;
  decision: ActionDecision;
  ok: boolean;
  /** The same sentence the confirmation card showed. Never the arguments. */
  summary?: string;
}

let ensured = false;
async function ensureTable(dbRun: (sql: string, ...p: unknown[]) => Promise<unknown>): Promise<void> {
  if (ensured) return;
  await dbRun(`
    CREATE TABLE IF NOT EXISTS addin_actions (
      id              CHAR(36) PRIMARY KEY,
      created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      user_id         VARCHAR(36),
      conversation_id VARCHAR(36),
      host            VARCHAR(12) NOT NULL,
      /**
       * 哪一個模型做的。
       *
       * 「現在用哪一個模型有進稽核紀錄嗎？」——原本沒有。而這正是這張表最需要
       * 回答的問題之一：客戶為了省錢會改用地端模型，地端模型的判斷品質跟雲端不
       * 一樣，所以「這份文件是誰做的」在事後追查時跟「做了什麼」一樣重要。一份
       * 內容可疑的報價單，第一個要問的就是它是哪個模型寫的。
       */
      model           VARCHAR(100),
      tool            VARCHAR(64) NOT NULL,
      target          VARCHAR(255),
      destructive     TINYINT(1) NOT NULL DEFAULT 0,
      decision        VARCHAR(12) NOT NULL,
      ok              TINYINT(1) NOT NULL DEFAULT 0,
      summary         VARCHAR(500),
      INDEX idx_addin_created (created_at),
      INDEX idx_addin_user (user_id),
      INDEX idx_addin_conv (conversation_id),
      -- 「哪些動作是沒有人看過就執行的」 is the question this table exists to
      -- answer quickly, so it gets its own index rather than a table scan.
      INDEX idx_addin_decision (decision),
      -- 「這個模型做過哪些事」要能一次撈出來，不然換模型之後沒辦法回頭比對。
      INDEX idx_addin_model (model)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  /**
   * 既有的資料表要補上欄位。
   *
   * CREATE TABLE IF NOT EXISTS 對已經存在的表什麼都不做，所以升級的環境不會長出
   * model 欄位——然後每一次寫入都會因為欄位不存在而失敗，而這支是 fire-and-forget
   * 的，失敗完全不會叫。重複執行是安全的：欄位已經在就讓它報錯然後忽略。
   */
  try {
    await dbRun('ALTER TABLE addin_actions ADD COLUMN model VARCHAR(100) NULL AFTER host');
  } catch { /* 已經有了 */ }
  try {
    await dbRun('ALTER TABLE addin_actions ADD INDEX idx_addin_model (model)');
  } catch { /* 已經有了 */ }
  ensured = true;
}

const cut = (s: unknown, n: number): string | null => {
  const v = String(s ?? '').trim();
  return v ? v.slice(0, n) : null;
};

/**
 * Record one tool call. Fire-and-forget, and never throws.
 *
 * Logging must not be able to break the thing it is logging: a failed insert
 * costs a row, a thrown insert costs the user's edit. The same rule aiCallLog
 * follows, for the same reason.
 */
export function logAddinAction(rec: AddinAction): void {
  void (async () => {
    try {
      const { dbRun } = await import('../db.js');
      await ensureTable(dbRun);
      await dbRun(
        `INSERT INTO addin_actions
          (id, user_id, conversation_id, host, model, tool, target, destructive, decision, ok, summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        randomUUID(),
        rec.userId || null,
        rec.conversationId || null,
        rec.host,
        cut(rec.model, 100),
        cut(rec.tool, 64),
        cut(rec.target, 255),
        rec.destructive ? 1 : 0,
        rec.decision,
        rec.ok ? 1 : 0,
        cut(rec.summary, 500),
      );
    } catch { /* an audit row is never worth failing a user's edit for */ }
  })();
}

/**
 * Where a call landed, from its arguments.
 *
 * Coordinates only — a sheet name, a range, a slide number. Enough to go and
 * look at what was touched, and nothing that carries the content itself.
 */
export function targetOf(tool: string, args: Record<string, unknown>): string {
  const a = args || {};
  const str = (k: string) => (a[k] === undefined || a[k] === null ? '' : String(a[k]));
  const sheet = str('sheet') || str('worksheet') || str('name');
  const range = str('range') || str('address');
  if (sheet && range) return `${sheet}!${range}`;
  if (range) return range;

  if (a.slide !== undefined) {
    const to = a.to !== undefined && String(a.to) !== String(a.slide) ? `–${str('to')}` : '';
    return `投影片 ${str('slide')}${to}`;
  }
  if (Array.isArray(a.shapes) && a.shapes.length) return `物件 ${a.shapes.join('、')}`;
  if (a.shape !== undefined) return `物件 ${str('shape')}`;
  if (a.all === true) return '整頁';
  if (sheet) return sheet;
  // A script has no coordinates — its size is the only honest summary, and the
  // code itself belongs in the transcript, not in an audit table.
  if (typeof a.code === 'string') return `${a.code.length} 字的程式碼`;
  return '';
}

/** 'excel_write_range' → 'excel'. Derived, so host and tool can never disagree. */
export function hostOf(tool: string): string {
  const head = String(tool || '').split('_')[0];
  return ['excel', 'word', 'ppt'].includes(head) ? head : 'other';
}
