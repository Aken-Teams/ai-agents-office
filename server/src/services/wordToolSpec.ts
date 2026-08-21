/**
 * word tool spec — the SINGLE source of truth for the document tools.
 *
 * Imported by BOTH sides of the bridge:
 *   - wordMcp.ts (a separate subprocess) → advertises these to the Claude CLI
 *   - routes/word.ts (in the Express process) → decides which calls need a human
 *     confirmation and how to describe them in the confirm prompt
 *
 * Deliberately dependency-free (no config/db/express imports) so the MCP
 * subprocess stays instant to boot — the CLI has a short MCP handshake window and
 * a slow server means the tools never register.
 *
 * ── How this differs from excelToolSpec ──
 * Two things, and they shape every tool below.
 *
 *  1. **The address is a paragraph number.** Word has no A1. Every read comes
 *     back numbered and every write is aimed at those numbers, which is also
 *     what makes [[段落 42]] a citation the reader can click back to.
 *
 *  2. **Writes are revisions, not replacements.** The add-in turns Word's own
 *     change tracking on for the duration of a write, so a rewrite arrives as
 *     something the person accepts or rejects line by line. That is a real
 *     safety property Excel does not have, and it is why the tool descriptions
 *     below tell the model to rewrite boldly rather than to hedge: nothing it
 *     writes lands unreviewed.
 *
 * Tools stay COARSE for the same reason as Excel's: every call is a full round
 * trip (CLI → mcp subprocess → HTTP loopback → SSE → Office.js → back), so each
 * one does as much as possible per call.
 */

export interface WordToolSpec {
  name: string;
  /** Written FOR the model — says when to reach for it, not just what it does. */
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * true = the call changes the user's document. The add-in MUST get an explicit
   * human click before executing it. The CLI runs with --permission-mode dontAsk
   * (no human in that loop), so this flag is the ONLY thing standing between an
   * injected instruction and someone's real document.
   *
   * The line is the same one the Excel add-in draws: ask about what DESTROYS,
   * let appearance through. Formatting and insertion are covered by tracked
   * changes and by the pane's own undo; replacing and deleting are not, because
   * by the time you notice you have lost the wording you had.
   */
  destructive?: boolean;
}

const PARAGRAPH_RANGE = {
  from: { type: 'number', description: '起始段落編號（1 起算，含）。省略代表整份文件。' },
  to: { type: 'number', description: '結束段落編號（含）。省略代表只有 from 那一段。' },
};

const TRACK_FLAG = {
  track: {
    type: 'boolean',
    description:
      '是否以追蹤修訂寫入，預設 true。除非使用者明確說「直接改就好、不要修訂」，'
      + '否則不要設成 false——追蹤修訂是使用者逐條檢查你的改動的唯一方式。',
  },
};

export const WORD_TOOLS: WordToolSpec[] = [
  {
    name: 'word_get_overview',
    description:
      '取得目前開啟文件的結構：段落數、字數、章節大綱（每個標題的段落編號與文字）、'
      + '追蹤修訂目前的狀態，以及開頭幾段的預覽。'
      + '【每段對話一開始一定要先呼叫這個】，它很便宜，而且是你唯一能知道這份文件長什麼樣、'
      + '哪一章在第幾段的方式。不要用 word_read_range 從第 1 段開始猜。',
    inputSchema: {
      type: 'object',
      properties: {
        preview_chars: { type: 'number', description: '開頭預覽的字數，預設 1500，最多 4000。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_get_selection',
    description:
      '取得使用者目前在 Word 裡選取的文字，以及它對應的段落編號。'
      + '當使用者說「這一段」「這句」「選起來的部分」這類指涉當下畫面的說法時使用。'
      + '回傳的段落編號可以直接拿去給 word_write_range 或 word_format_range。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'word_read_range',
    description:
      '讀取內文。可以用段落編號範圍（from/to），也可以用 heading 指定一整個章節——'
      + '「幫我看第三章」用 heading 比自己算段落編號可靠得多，它會自動讀到下一個同級標題為止。'
      + '回傳的每一行開頭都是段落編號，標題會標上 [H1]/[H2]。',
    inputSchema: {
      type: 'object',
      properties: {
        ...PARAGRAPH_RANGE,
        heading: { type: 'string', description: '章節標題（可只給一部分文字）。給了這個就忽略 from/to。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_search',
    description:
      '找出含有某段文字的段落，回傳段落編號與內容摘要。用來定位——'
      + '要改一個詞卻不知道它在哪幾段時，先搜尋拿到編號，再用 word_write_range 改。'
      + '要一次換掉全部請直接用 word_replace_all。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的文字。' },
        match_case: { type: 'boolean', description: '是否區分大小寫，預設 false。' },
        regex: { type: 'boolean', description: 'query 是否為規則運算式，預設 false。' },
        max_results: { type: 'number', description: '最多回傳幾筆，預設 50。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_run_script',
    description:
      '在使用者的 Word 裡直接執行一段 JavaScript（Office.js），只把 return 的結果帶回來。'
      + '\n\n【什麼時候一定要用這個】要「掃過全文」的時候。'
      + '例如「把所有全形括號換成半形」「找出每一個沒有加單位的數字」「統計每個章節的字數」——'
      + '這些用 word_read_range 讀回來自己算，會把整份文件塞進你的上下文，然後再一段一段寫回去。'
      + '用 script 是一次來回，回傳三行結論。'
      + '\n\n可以用的名稱只有：context（= ctx）、document、body、Word、log、store。'
      + '沒有 require / import / fetch。'
      + '\n\nstore 是跨呼叫保留的暫存區：掃描的結果放 store.rows，下一支 script 直接拿，'
      + '不會經過你的上下文。'
      + '\n\n要修改文件時必須帶 mode="write"，使用者會看到確認視窗；'
      + '沒帶的話任何修改都會被擋下來並要你重試。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'JavaScript 程式碼。用 return 回傳結果。' },
        mode: {
          type: 'string',
          enum: ['read', 'write'],
          description: '會修改文件就填 write，只讀就填 read。',
        },
        explain: {
          type: 'string',
          description: '一句話說明這段程式要做什麼，會顯示在使用者的確認視窗上。用使用者的語言寫。',
        },
        ...TRACK_FLAG,
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_write_range',
    description:
      '改寫指定段落：把 from~to 這幾段換成你給的新內容。這是「潤飾」「改寫」「換個語氣」的主力工具。'
      + '\n\n預設以追蹤修訂寫入，所以使用者會看到紅色的修訂標記並逐條決定——'
      + '因此請直接給出你認為最好的版本，不要因為怕改壞而只做最小幅度的修改。'
      + '\n\n第一段的樣式會保留（改寫標題後它仍然是標題）。'
      + '要新增內容而不是取代，用 word_insert_text。',
    inputSchema: {
      type: 'object',
      properties: {
        ...PARAGRAPH_RANGE,
        text: { type: 'string', description: '新內容。用 \\n 分段。' },
        paragraphs: { type: 'array', items: { type: 'string' }, description: '新內容，一個元素一段。給了這個就忽略 text。' },
        ...TRACK_FLAG,
      },
      required: ['from'],
      additionalProperties: false,
    },
    destructive: true,
  },
  {
    name: 'word_insert_text',
    description:
      '插入新的段落，不動既有內容。at 可以是 end（文件最後）、start（文件開頭）、'
      + 'after / before（指定 paragraph 的前後）。'
      + '\n\n寫報告、加一段結論、在某章底下補一小節都用這個。'
      + 'style 可以直接指定樣式（Heading1、Heading2、Normal…），省得再呼叫一次格式工具。',
    inputSchema: {
      type: 'object',
      properties: {
        at: { type: 'string', enum: ['end', 'start', 'after', 'before'], description: '插入位置，預設 end。' },
        paragraph: { type: 'number', description: 'at 是 after/before 時的基準段落編號。' },
        text: { type: 'string', description: '要插入的內容。用 \\n 分段。' },
        paragraphs: { type: 'array', items: { type: 'string' }, description: '要插入的內容，一個元素一段。' },
        style: { type: 'string', description: '套用在插入內容上的樣式，例如 Heading1、Heading2、Normal、Quote。' },
        ...TRACK_FLAG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_delete_range',
    description:
      '刪除指定段落。只有在使用者明確要求刪除時才用——要改寫請用 word_write_range，'
      + '它會保留樣式而且讀起來是一次修訂而不是「刪掉再重打」。',
    inputSchema: {
      type: 'object',
      properties: { ...PARAGRAPH_RANGE, ...TRACK_FLAG },
      required: ['from'],
      additionalProperties: false,
    },
    destructive: true,
  },
  {
    name: 'word_format_range',
    description:
      '設定段落的樣式與格式：內建樣式（Heading1…）、對齊、縮排、行距、段落間距，'
      + '以及字型、大小、顏色、粗體斜體底線、螢光標示。'
      + '\n\n【統一標題階層就是用這個】把每個章節標題設成正確的 Heading 層級，'
      + 'word_insert_toc 產生的目錄才會正確——目錄只收錄套了標題樣式的段落。'
      + '\n\n用內建樣式，不要用「16pt 粗體」去模仿標題：模仿出來的東西進不了目錄、'
      + '也不會跟著使用者公司的樣式範本走。',
    inputSchema: {
      type: 'object',
      properties: {
        ...PARAGRAPH_RANGE,
        style: { type: 'string', description: '內建樣式名稱，例如 Heading1、Heading2、Normal、Quote、ListParagraph。' },
        alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: '對齊方式。' },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        underline: { type: 'boolean' },
        font: { type: 'string', description: '字型名稱，例如「微軟正黑體」。' },
        size: { type: 'number', description: '字級（點）。' },
        color: { type: 'string', description: '文字顏色，#RRGGBB。' },
        highlight: { type: 'string', description: '螢光標示顏色，例如 Yellow。標風險條款很好用。' },
        left_indent: { type: 'number', description: '左邊縮排（點）。' },
        first_line_indent: { type: 'number', description: '首行縮排（點）。中文公文常用 24（兩個字）。' },
        line_spacing: { type: 'number', description: '行距（點）。' },
        space_before: { type: 'number', description: '段前距（點）。' },
        space_after: { type: 'number', description: '段後距（點）。' },
      },
      required: ['from'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_manage_list',
    description: '把連續幾段設成項目符號或編號清單，或取消清單格式。',
    inputSchema: {
      type: 'object',
      properties: {
        ...PARAGRAPH_RANGE,
        type: { type: 'string', enum: ['bullet', 'number', 'none'], description: '清單種類，預設 bullet。' },
      },
      required: ['from'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_table',
    description:
      '插入表格。values 是二維陣列，第一列通常是表頭。'
      + '要把一段敘述整理成對照表、把條款差異列成比較表都用這個。',
    inputSchema: {
      type: 'object',
      properties: {
        values: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: '表格內容，二維陣列。',
        },
        at: { type: 'string', enum: ['after', 'before'], description: '相對於 paragraph 的位置，預設 after。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        header: { type: 'boolean', description: '第一列是否為表頭，預設 true。' },
        style: { type: 'string', description: '表格樣式，預設 GridTable4_Accent1。' },
        ...TRACK_FLAG,
      },
      required: ['values'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_toc',
    description:
      '插入目錄。Word 的目錄是「欄位」而不是文字，所以插入後要由使用者按一次「更新目錄」'
      + '才會列出項目——這是 Word 本來的行為，回傳訊息會提醒使用者，你不用再解釋一次，'
      + '更不要因為看不到項目就以為失敗而重試。'
      + '\n\n目錄只收錄套了 Heading 樣式的段落，所以先用 word_format_range 把標題階層整理好。',
    inputSchema: {
      type: 'object',
      properties: {
        at: { type: 'string', enum: ['after', 'before'], description: '相對於 paragraph 的位置。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件開頭。' },
        ...TRACK_FLAG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_replace_all',
    description:
      '全文尋找並取代。用於統一用詞、改掉錯字、換掉公司名稱這類「每一處都要改」的情況。'
      + '會回報改了幾處。要只改某幾段請改用 word_write_range。',
    inputSchema: {
      type: 'object',
      properties: {
        find: { type: 'string', description: '要找的文字。' },
        replace: { type: 'string', description: '要換成的文字。' },
        match_case: { type: 'boolean', description: '是否區分大小寫。' },
        whole_word: { type: 'boolean', description: '是否只比對整個字詞。' },
        ...TRACK_FLAG,
      },
      required: ['find', 'replace'],
      additionalProperties: false,
    },
    destructive: true,
  },
  {
    name: 'word_tracked_changes',
    description:
      '處理追蹤修訂：status（目前模式）、set_mode、list（列出未處理的修訂）、'
      + 'accept_all、reject_all。'
      + '\n\n注意：你自己的改寫預設就會以修訂寫入，不需要先呼叫這個把模式打開。'
      + '這個工具是給「把之前的修訂全部接受」「看看還有幾條沒處理」這類需求用的。'
      + 'accept_all 會讓那些修訂再也退不回來，所以會要求使用者確認。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['status', 'set_mode', 'list', 'accept_all', 'reject_all'] },
        mode: { type: 'string', enum: ['off', 'mine', 'all'], description: 'op=set_mode 時的目標模式。' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_comment',
    description:
      '在某一段加註解，或列出文件裡現有的註解。'
      + '\n\n【比對條款、標風險時優先用這個】註解說了話但沒有改動原文，'
      + '正是「我覺得這條有問題」該有的形狀。直接改掉合約條文則不是。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'list'], description: '預設 add。' },
        paragraph: { type: 'number', description: '要加註解的段落編號。' },
        text: { type: 'string', description: '註解內容。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_ask_user',
    description:
      '需要使用者在幾個具體做法之間選一個時，用這個工具問，不要用文字列出「1. … 2. …」再問「你要哪個」。'
      + '側邊欄會把選項變成按鈕，使用者點一下就好。'
      + '例如改寫語氣有好幾種方向、或者不確定該改全文還是只改選取的段落時。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要問的問題，用使用者的語言。' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: '選項，2~5 個。每個都要是具體做法，不要是「好」「不要」。',
        },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
];

export const WORD_TOOL_NAMES = WORD_TOOLS.map(t => t.name);

export const WORD_MCP_TOOL_NAMES = WORD_TOOL_NAMES.map(n => `mcp__word__${n}`);

/**
 * Does this script change the document?
 *
 * Used as a second opinion on the model's own `mode` declaration. It matches
 * Office.js's mutation surface specifically rather than "any assignment",
 * because scripts assign to their own accumulators constantly (`acc.total = 0`)
 * and treating that as a write would put a confirmation dialog in front of
 * every read.
 *
 * This is a heuristic and can be fooled by computed access (`p["te"+"xt"] = x`).
 * It is NOT the security boundary. The boundary is the Proxy guard in the add-in
 * (src/taskpane/hosts/guard.js), which watches what the script DOES; this exists
 * so that a mislabelled call fails safe on the way in.
 */
const SCRIPT_MUTATION_PATTERNS: RegExp[] = [
  // Assignment into a property only Office.js has. Generic names are deliberately
  // absent: analysis scripts build plain objects with keys like `text` all day.
  /\.\s*(styleBuiltIn|alignment|leftIndent|firstLineIndent|lineSpacing|spaceBefore|spaceAfter|changeTrackingMode|headerRowCount|listItem)\s*=(?!=)/,
  // Anything under .font — covers bold, color, size, highlightColor in one.
  /\.font\b[^=\n]*=(?!=)/,
  // The insert* family is Word's entire write surface, and nothing reads with it.
  /\.\s*insert[A-Z]\w*\s*\(/,
  /\.\s*(delete|clear|remove|attachToList|detachFromList|startNewList|setLevelBullet|setLevelNumbering|acceptAll|rejectAll|accept|reject|track|untrack|select)\s*\(/,
  // `.style = 'Heading 1'` — `style` alone is too generic for the first pattern,
  // but on something reached through a paragraph/range chain it is a write.
  /\.(paragraphs?|body|range|tables?)\b[^\n]*\.\s*style\s*=(?!=)/,
];

export function scriptMutatesDocument(code: string): boolean {
  return SCRIPT_MUTATION_PATTERNS.some(re => re.test(code));
}

export function isDestructiveTool(name: string, args: Record<string, unknown> = {}): boolean {
  if (WORD_TOOLS.some(t => t.name === name && t.destructive)) return true;
  const op = String(args.op || '');
  if (name === 'word_tracked_changes') return op === 'accept_all' || op === 'reject_all';
  if (name === 'word_run_script') {
    // Declaration AND verification. The model declares `mode`, but the code is
    // scanned independently: a call that says `read` while inserting text still
    // gets a confirmation. Neither signal is trusted alone, because this flag is
    // the only thing between an instruction hidden in a downloaded document and
    // someone's real work (the CLI runs --permission-mode dontAsk).
    return String(args.mode || '') === 'write' || scriptMutatesDocument(String(args.code || ''));
  }
  return false;
}

/**
 * Calls that destroy something the undo button cannot bring back.
 *
 * Narrower than isDestructiveTool, which asks "does this change the document" —
 * nearly everything on this bridge does. This asks the question the confirmation
 * card actually needs: if this goes wrong, is it recoverable?
 *
 * Word answers that question more generously than Excel does. A rewrite arrives
 * as a tracked revision the person can reject, and the pane holds the document's
 * OOXML from before the call either way. What survives as high risk is the pair
 * of things neither mechanism covers: deleting paragraphs outright with tracking
 * off, and accepting every outstanding revision — after which "reject" is no
 * longer available to anyone.
 */
const SCRIPT_DESTROYS_TEXT = /\.\s*(delete|clear)\s*\(/;

export function toolRisk(name: string, args: Record<string, unknown> = {}): 'high' | 'normal' {
  if (name === 'word_tracked_changes') return String(args.op || '') === 'accept_all' ? 'high' : 'normal';
  if (name === 'word_delete_range') return args.track === false ? 'high' : 'normal';
  if (name === 'word_run_script') {
    return args.track === false && SCRIPT_DESTROYS_TEXT.test(String(args.code || '')) ? 'high' : 'normal';
  }
  return 'normal';
}

const range = (args: Record<string, unknown>): string => {
  const from = args.from ?? args.paragraph;
  const to = args.to;
  if (from === undefined) return '整份文件';
  return to !== undefined && to !== from ? `段落 ${from}-${to}` : `段落 ${from}`;
};

const TRACK_OP_LABEL: Record<string, string> = {
  status: '查看追蹤修訂狀態',
  set_mode: '變更追蹤修訂模式',
  list: '列出未處理的修訂',
  accept_all: '接受全部修訂',
  reject_all: '拒絕全部修訂',
};

export function describeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === 'word_get_overview') return '讀取文件結構';
  if (name === 'word_get_selection') return '讀取目前選取的段落';
  if (name === 'word_read_range') return args.heading ? `讀取「${args.heading}」` : `讀取${range(args)}`;
  if (name === 'word_search') return `搜尋「${args.query}」`;
  if (name === 'word_write_range') {
    const lines = Array.isArray(args.paragraphs)
      ? (args.paragraphs as unknown[]).length
      : String(args.text || '').split('\n').length;
    return `改寫${range(args)}，換成 ${lines} 段`;
  }
  if (name === 'word_insert_text') {
    const at = String(args.at || 'end');
    const where = at === 'end' ? '文件最後' : at === 'start' ? '文件開頭'
      : `段落 ${args.paragraph} ${at === 'before' ? '之前' : '之後'}`;
    return `在${where}插入內容`;
  }
  if (name === 'word_delete_range') return `刪除${range(args)}`;
  if (name === 'word_format_range') return `設定${range(args)}的格式`;
  if (name === 'word_manage_list') return `把${range(args)}設成清單`;
  if (name === 'word_insert_table') {
    const rows = Array.isArray(args.values) ? (args.values as unknown[]).length : 0;
    return `插入 ${rows} 列的表格`;
  }
  if (name === 'word_insert_toc') return '插入目錄';
  if (name === 'word_replace_all') return `把全文的「${args.find}」換成「${args.replace}」`;
  if (name === 'word_tracked_changes') return TRACK_OP_LABEL[String(args.op || '')] || String(args.op || '');
  if (name === 'word_comment') {
    return String(args.op || 'add') === 'list' ? '讀取文件裡的註解' : `在段落 ${args.paragraph} 加註解`;
  }
  if (name === 'word_ask_user') return String(args.question || '請你決定一件事');
  if (name === 'word_run_script') {
    // The model's own one-line explanation, and nothing else. HOW it will be done
    // is real information but it is not the decision, so it goes on its own line
    // via describeToolMeta.
    const explain = String(args.explain || '').trim();
    if (explain) return explain;
    return String(args.mode || '') === 'write' ? '執行程式並修改文件' : '執行程式讀取內容';
  }
  return name;
}

/**
 * The technical footnote for a call: HOW, as opposed to WHAT. Small print under
 * the action in the confirmation card, empty when there is nothing to add.
 *
 * Whether a write goes in as a revision belongs here for every write, not just
 * scripts: it is the difference between "you can reject this" and "this is now
 * your document", and the person should see which one they are agreeing to
 * before they click, not afterwards in the result line.
 */
export function describeToolMeta(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (name === 'word_run_script') {
    const lines = String(args.code || '').split('\n').length;
    parts.push(String(args.mode || '') === 'write' ? '執行程式並修改文件' : '執行程式讀取內容');
    parts.push(`${lines} 行`);
  }
  if (WORD_TOOLS.some(t => t.name === name && t.destructive) || name === 'word_insert_text') {
    parts.push(args.track === false ? '直接寫入，不標記為修訂' : '以追蹤修訂寫入，可逐條接受或拒絕');
  }
  return parts.join(' · ');
}
