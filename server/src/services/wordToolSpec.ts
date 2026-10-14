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

/**
 * Tracking is the default only where there is a before-and-after to compare.
 *
 * Writing a document from scratch with change tracking on produces a report that
 * is entirely red and underlined with a column of revision balloons beside it —
 * every word is an "insertion", and the reader has to accept two hundred changes
 * they were never given a chance to disagree with before they can read it.
 */
const TRACK_REWRITE = {
  track: {
    type: 'boolean',
    description:
      '是否以追蹤修訂寫入，預設 true。這個工具動的是既有內容，使用者需要逐條比對，'
      + '所以除非他明確說「直接改就好、不要修訂」，否則不要設成 false。',
  },
};

const TRACK_NEW = {
  track: {
    type: 'boolean',
    description:
      '是否以追蹤修訂寫入，**預設 false**。這個工具加的是新內容，沒有「原本長怎樣」可以比對，'
      + '標成修訂只會讓整份文件變成紅色底線。只有在你是「補上使用者原本漏掉的東西、'
      + '而他可能想拒絕」的情況才設成 true。',
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
        ...TRACK_REWRITE,
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
        ...TRACK_REWRITE,
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
        ...TRACK_NEW,
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
      properties: { ...PARAGRAPH_RANGE, ...TRACK_REWRITE },
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
      '【要做的是履歷表、申請單、簽核單這類**表單**的話，用 `word_insert_form`，不要用這支】'
      + '這支是報表：有表頭、一列一筆資料。表單是左邊欄位名稱、右邊留白給人填，整張一個表格——'
      + '用這支做會變成一節一張黑色表頭的表、列高是填寫空間的兩倍、一列湊不滿就留下空格子。'
      + '\n\n插入表格。values 是二維陣列，第一列通常是表頭。'
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
        align: {
          type: 'array',
          items: { type: 'string', enum: ['left', 'center', 'right'] },
          description:
            '每一欄的對齊，順序同欄位。**有數字的欄一定要 right**——'
            + '金額、數量、單價靠左看起來就不像正式文件。'
            + '例如 ["left","left","right","center","right","right"]。',
        },
        widths: {
          type: 'array',
          items: { type: 'number' },
          description:
            '每一欄的寬度（點），順序同欄位。A4 內文總寬約 450 點。'
            + '品名規格要寬、數量單位要窄，不給的話 Word 會平均分配，看起來很鬆散。',
        },
        total_rows: {
          type: 'number',
          description:
            '最後幾列是合計列。會填深底白字粗體，讓讀者要找的那個數字最顯眼。'
            + '報價單的「小計／稅／總計」就填 3。',
        },
        total_fill: { type: 'string', description: '合計列底色，預設 #1F3864。' },
        total_color: { type: 'string', description: '合計列文字色，預設白色。' },
        banded: { type: 'boolean', description: '是否隔列上色。資料多的時候好讀，正式報價單通常關掉。' },
        first_column: { type: 'boolean', description: '第一欄是否強調。' },
        ...TRACK_NEW,
      },
      required: ['values'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_form',
    description:
      '做一張**表單**：履歷表、申請單、簽核單、檢查表、點檢表。'
      + '\n\n【跟 word_insert_table 的差別，這很重要】'
      + 'word_insert_table 做的是**報表**——有表頭、有資料列、一列一筆紀錄，像是各季營收。'
      + '這支做的是**表單**——左邊欄位名稱、右邊留白給人填，整張是**一個**表格。'
      + '\n傳統企業的履歷表、請購單、出差申請單都是後者，而且用報表的做法做會很難看：'
      + '每一節一張黑色表頭的表、列高是填寫空間的兩倍、一列湊不滿就留下沒有標題的空格子。'
      + '\n\n【怎麼給 fields】照表單從上到下的順序，一個陣列給完，不要分成好幾張表：'
      + '\n- `{ label: "中文姓名" }`——標籤加一格空白'
      + '\n- `{ label: "出生日期", value: "　　年　　月　　日" }`——預先寫好格式的，用全形空白排版'
      + '\n- `{ label: "戶籍地址", span: true }`——這一欄佔滿整列'
      + '\n- `{ label: "自傳", lines: 10 }`——留十行的填寫空間，自動佔滿整列'
      + '\n- `{ section: "基本資料" }`——整列的區段帶，取代「一個標題加一張表」'
      + '\n\n【版面】`columns` 是一列放幾組「標籤＋填寫」，預設 2，最多 3。'
      + '標籤欄的寬度會照最長的標籤算，填寫欄吃掉剩下的寬度。'
      + '`row_height` 是列高（點），預設 24——表單的列高要一致，而且要剛好夠寫字。'
      + '\n\n【留白就是留白】不要在填寫欄塞「（請填寫）」「N/A」之類的提示，'
      + '那是給人寫的地方。說明寫在 `note`，它會印在表單下方的小字。',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: '照表單順序排好的欄位。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '欄位名稱，例如「中文姓名」。' },
              value: { type: 'string', description: '預先填好的內容或格式，留空就是給人填。' },
              span: { type: 'boolean', description: '這一欄佔滿整列。地址、備註這種長欄位要開。' },
              lines: { type: 'number', description: '填寫空間要幾行。大於 1 會自動佔滿整列。' },
              section: { type: 'string', description: '區段帶，例如「基本資料」。給了這個就不要給 label。' },
            },
            additionalProperties: false,
          },
        },
        title: { type: 'string', description: '表單標題，會以置中標題印在表單上方。' },
        note: { type: 'string', description: '表單下方的小字說明，例如填寫規則或個資聲明。' },
        columns: { type: 'number', description: '一列幾組「標籤＋填寫」。預設 2，最多 3。' },
        row_height: { type: 'number', description: '列高（點），預設 24。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        ...TRACK_NEW,
      },
      required: ['fields'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_sidebar',
    description:
      '**側欄版面**：左邊（或右邊）一條深色欄放聯絡方式、技能、語言，右邊放正文。'
      + '設計感的履歷、個人簡介、單頁企劃都是這個版型。'
      + '\n\n【為什麼是這支而不是 word_insert_layout】那支是把幾個區塊並排，'
      + '這支是**整頁的版型**：色塊欄會填滿整個欄位、欄內有自己的標題樣式和分隔線、'
      + '技能程度會畫成長條。'
      + '\n\n【怎麼給】sidebar 和 main 各是一串區塊，照上到下的順序：'
      + '\n- `{ title: "王小明", subtitle: "資深製程工程師" }`——姓名與職稱'
      + '\n- `{ heading: "聯絡方式" }`——小標，底下會有一條分隔線'
      + '\n- `{ lines: ["0912-345-678", "name@example.com", "高雄市…"] }`——一行一條'
      + '\n- `{ bars: [{ label: "Python", value: 0.9 }] }`——技能長條，value 可以給 0–1 或 0–100'
      + '\n- `{ entries: [{ title: "製程工程師", meta: "強茂　2019–2024", detail: "負責…" }] }`'
      + '——工作經歷、學歷這種「標題＋時間＋說明」的三段式'
      + '\n\n【看得到的限制，先講清楚】'
      + '\n畫得出來的是**版面**：欄、色塊、分隔線、長條。'
      + '\n畫不出來的是**美術素材**：圓形大頭照、水彩花邊、書法標題、斜切漸層底圖。'
      + '那些要用現成的範本檔，再把文字填進去，不要硬用這支湊。'
      + '\n\n整頁是一個框線關掉的表格，所以**每個字都還是 Word 的字、可以直接編輯**，不是一張圖。',
    inputSchema: {
      type: 'object',
      properties: {
        sidebar: {
          type: 'array',
          description: '色塊欄的內容，由上到下。',
          items: { type: 'object', additionalProperties: true },
        },
        main: {
          type: 'array',
          description: '正文欄的內容，由上到下。',
          items: { type: 'object', additionalProperties: true },
        },
        side: { type: 'string', enum: ['left', 'right'], description: '色塊欄在哪一邊。預設 left。' },
        width: { type: 'number', description: '色塊欄寬度（點），預設 150，範圍 90–240。' },
        fill: { type: 'string', description: '色塊欄底色，預設 #1F3864 深藍。' },
        text_color: { type: 'string', description: '色塊欄上的字色，預設白色。' },
        accent: { type: 'string', description: '分隔線與技能長條的顏色，預設跟字色一樣。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        ...TRACK_NEW,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_calendar',
    description:
      '月曆：一整年排在一頁，或單獨一個月留空格給人寫。'
      + '\n\n【兩種是不同的東西】'
      + '\n- 不給 `month` → **年曆**，12 個月排成 3×4，是拿來看的。'
      + '它是一張圖：十二個格子要對齊，交給 Word 的表格引擎排，任何人動一次邊界就跑掉。'
      + '\n- 給 `month` → **單月月曆**，7 欄的真表格，每格下面留空行，可以直接在格子裡打字。'
      + '行事曆、值班表、工作排程用這個。'
      + '\n\n【國定假日要你給】這支**不內建任何假日**。'
      + '各國不一樣、每年都在動，而一份把上班日標成放假的月曆比完全不標更糟。'
      + '`holidays` 給 `["2026-01-01"]` 或 `[{ date: "2026-01-01", label: "元旦" }]`，'
      + '標紅；單月版還會把名稱印在日期底下。'
      + '\n使用者沒給假日就不要自己編——直接做出來，然後告訴他假日要另外給。'
      + '\n\n【預設】週從星期日起（台灣的習慣，要改用 `week_start: "monday"`）、'
      + '星期六和星期日都標紅（週休二日；單休的公司用 `saturday_off: false`）。'
      + '年份省略就是今年。',
    inputSchema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: '西元年。省略就是今年。' },
        month: { type: 'number', description: '1–12。給了就做單月可填寫版，不給就做整年。' },
        holidays: {
          type: 'array',
          description: '要標紅的日期。字串 "2026-01-01"，或 { date, label }。',
          items: {},
        },
        week_start: {
          type: 'string',
          enum: ['sunday', 'monday'],
          description: '一週從哪天開始。預設 sunday。',
        },
        saturday_off: { type: 'boolean', description: '星期六算不算假日，預設 true。' },
        lines: { type: 'number', description: '單月版每格留幾行可以寫字，預設 2，最多 8。' },
        accent: { type: 'string', description: '年份與月份標題的顏色，預設 #1F3864。' },
        width: { type: 'number', description: '年曆的寬度（點）。預設跟內文欄一樣寬。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        ...TRACK_NEW,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'word_read_table',
    description:
      '把文件裡**既有的**某一張表格整張讀出來，含列號、欄號和每一格現有的文字。'
      + '\n\n【什麼時候一定要先用這支】使用者拿一份現成的範本（報價單、工單、'
      + '請購單、合約附表）要你填——動手之前先讀一次。'
      + '概覽只會告訴你有幾張表、幾列幾欄、第一欄寫了什麼；'
      + '哪一格是空的、欄位名稱到底在左邊還是上面，要讀過才知道。'
      + '\n猜著填會把東西填到錯的格子，而那種錯在畫面上看起來跟填對一模一樣。',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'number', description: '第幾張表格，從 1 起算。預設 1。概覽裡有編號。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'word_fill_table',
    description:
      '把內容填進文件裡**既有的**表格。這是「拿現成範本來填」的那支工具。'
      + '\n\n【兩種指定方式】'
      + '\n- `fields: { "客戶名稱": "強茂" }`——找到寫著「客戶名稱」那一格，'
      + '填進它**右邊**那一格；右邊有東西就試它**下面**那一格。'
      + '這是填範本該用的方式，因為你讀文件讀到的是欄位名稱，不是座標。'
      + '\n- `cells: [{ row: 2, col: 2, text: "強茂" }]`——直接指定列和欄，從 1 起算。'
      + '欄位名稱比對不到、或是要覆寫已經有內容的格子時用。'
      + '\n\n【它不會蓋掉已經有內容的格子】`fields` 只寫空白的格子，'
      + '右邊和下面都有內容就跳過並回報。那是刻意的——'
      + '填表單和覆寫是兩件事，把人家已經填好的資料無聲洗掉是最糟的失敗方式。'
      + '真的要覆寫就改用 `cells`。'
      + '\n\n【動手前先 word_read_table】欄位名稱比對會忽略空白、冒號和星號，'
      + '但「客戶名稱」和「客戶名稱(必填)」還是不同的字串。讀一次就不用猜。',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'number', description: '第幾張表格，從 1 起算。預設 1。' },
        fields: {
          type: 'object',
          description: '欄位名稱 → 要填的內容。會找到那一格，填進它右邊（或下面）的空格。',
          additionalProperties: { type: 'string' },
        },
        cells: {
          type: 'array',
          description: '直接指定格子：[{ row, col, text }]，列和欄都從 1 起算。',
          items: {
            type: 'object',
            properties: {
              row: { type: 'number' },
              col: { type: 'number' },
              text: { type: 'string' },
            },
            required: ['row', 'col', 'text'],
            additionalProperties: false,
          },
        },
        ...TRACK_NEW,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'word_review_layout',
    description:
      '**整份文件寫完之後，最後跑這一支。**把版面上機械性的毛病掃一遍並修掉。'
      + '\n\n【為什麼需要這一關】你是一段一段、一張表一張表寫下來的，每一步都對，'
      + '但沒有人退一步看整份長什麼樣。結果就是中間多出一整頁空白、'
      + '長表格的表頭留在上一頁而資料跑到下一頁。'
      + '\n\n【它會修的】'
      + '\n- 連續的空段落（整頁空白幾乎都是這個來的，不是有人插了分頁）'
      + '\n- 結尾那一串多餘的空白'
      + '\n- 超過 8 列的表格，表頭改成跨頁重複'
      + '\n\n【它刻意不做的】**不會**把每個章節推到新的一頁。'
      + '那是編輯判斷——有些章節適合有些不適合，猜錯的代價是一份被硬切開的文件。'
      + '使用者要的話會自己說是哪幾個章節，那時候用 word_insert_break。'
      + '\n\n【它做不到、要照實告訴使用者的】「整列不要被切成兩頁」在增益集的 API 裡'
      + '沒有對應的設定。長表格只能讓表頭每頁重複，要完全不切開得在 Word 裡自己設。'
      + '工具的回覆會把這件事寫出來，**原封不動轉達給使用者**，不要說成已經處理好了。'
      + '\n\n先看不改就帶 `fix: false`。',
    inputSchema: {
      type: 'object',
      properties: {
        fix: {
          type: 'boolean',
          description: '預設 true，查到就修。給 false 只會回報查到什麼，不動文件。',
        },
        ...TRACK_NEW,
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_toc',
    description:
      '插入目錄。項目插入當下就看得到（它會帶著已經算好的結果進去），'
      + '只有**頁碼**要等使用者按一次「參考資料 → 更新目錄」才會出現，'
      + '因為 Office.js 讀不到分頁資訊。回傳訊息會講這件事，你不用再解釋一次。'
      + '\n\n它會自己加上「目錄」這個標題，**不要自己先插一個**，否則會出現兩個。'
      + '\n\n目錄只收錄套了 Heading 樣式的段落。沒有任何標題時它會直接失敗並告訴你——'
      + '先用 word_format_range 把各章節標題設成 Heading1／Heading2，再插目錄。',
    inputSchema: {
      type: 'object',
      properties: {
        at: { type: 'string', enum: ['after', 'before'], description: '相對於 paragraph 的位置。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件開頭。' },
        ...TRACK_NEW,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_header_footer',
    description:
      '設定頁首或頁尾，可以放文字、也可以放頁碼。'
      + '\n\n頁碼是 Word 的欄位：page_number="page" 只放數字，"x_of_y" 放「第 X 頁，共 Y 頁」。'
      + '插進去當下第一頁就看得到，其餘頁 Word 重新分頁時自己算——不要因為只看到「1」就以為壞了。'
      + '\n\n【超過三頁的文件一定要做這件事】沒有頁碼的報告列印出來散了就排不回去。',
    inputSchema: {
      type: 'object',
      properties: {
        where: { type: 'string', enum: ['header', 'footer'], description: '預設 footer。' },
        text: { type: 'string', description: '要放的文字，例如公司名稱或文件標題。' },
        page_number: { type: 'string', enum: ['page', 'x_of_y'], description: '要放頁碼就給這個。' },
        alignment: { type: 'string', enum: ['left', 'center', 'right'], description: '預設置中。' },
        clear: { type: 'boolean', description: 'true = 清空頁首／頁尾。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_layout',
    description:
      '把兩到四個區塊**並排**在同一行。'
      + '\n\n【這是做出「像範本」的關鍵】其他工具都只會往下寫，'
      + '所以「客戶資料 | 報價資訊」這種左右並排的版面做不出來，'
      + '只能擠成一張四欄表或八行堆疊——字都對，版面是錯的。'
      + '\n\n用途：報價單／合約的雙欄資訊、信頭（公司名靠左、地址靠右）、'
      + '兩案對照、文末的簽核欄。'
      + '\n\npanel=true 會加上淡底色和細框線，就是範本上那種方框的樣子；'
      + '不加就是純版面用的無框格線（做信頭用這個）。'
      + '\n\n每一欄可以放 fields（標籤／內容）或 text（純文字，可用 \\n 分行）。',
    inputSchema: {
      type: 'object',
      properties: {
        columns: {
          type: 'array',
          description: '2 到 4 欄。每欄可有 title、fields（物件）或 rows（陣列）或 text。',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '這一欄的小標，例如「客戶資料」。' },
              fields: { type: 'object', additionalProperties: { type: 'string' } },
              rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              text: { type: 'string', description: '純文字內容，可用 \\n 分行。' },
              align: { type: 'string', enum: ['left', 'center', 'right'], description: 'text 的對齊；信頭的地址那欄用 right。' },
            },
          },
        },
        widths: { type: 'array', items: { type: 'number' }, description: '每欄寬度（點）。A4 內文總寬約 450。' },
        panel: { type: 'boolean', description: '是否加底色和框線，預設 false。資訊方塊用 true，信頭用 false。' },
        panel_fill: { type: 'string', description: '底色，預設 #F2F6FA。' },
        size: { type: 'number', description: '基準字級，預設 10。' },
        tab: { type: 'number', description: '標籤欄寬（點），預設 72。' },
        font: { type: 'string' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'] },
        track: { type: 'boolean', description: '預設 false。' },
      },
      required: ['columns'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_block',
    description:
      '插入一個**有版式的區塊**，而不是一段文字。字級和顏色由區塊種類決定，你不用挑。'
      + '\n\n【為什麼需要這個】只用 word_insert_text 的話，一頁上只會有「標題、章節、內文」三級，'
      + '做出來就是大文字配小文字。真正的商務文件不是這樣：一張報價單上有公司名、英文名、地址、'
      + '文件名、欄位標籤、欄位內容、專案行——七種處理，沒有一種是標題也沒有一種是內文。'
      + '\n\n四種區塊：'
      + '\n· **fields**（預設）：標籤／內容清單，用定位點對齊。'
      + '「客戶名稱　強合科技」「報價日期　2026-07-24」這種。標籤深藍、內容灰。'
      + '\n· **kv**：同樣是成對資訊，但排成兩欄表格。超過六七列就用這個。'
      + '\n· **note**：附註區塊，字更小、縮排、左邊有一條色線。用在說明、但書、注意事項。'
      + '\n· **lead**：章節標題底下的一句前言，比內文大、比標題輕。'
      + '\n· **rule**：一條橫線。信頭底下那條線就是這個，用 color 和 size 控制。'
      + '\n\n插完不要再用 word_format_range 改它的字級——那正是版面亂掉的來源。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['fields', 'kv', 'note', 'lead', 'rule'], description: '預設 fields。' },
        title: { type: 'string', description: 'fields 和 kv 的小標題，例如「客戶資料」。' },
        fields: {
          type: 'object',
          description: 'fields／kv 的內容，鍵是標籤、值是內容。',
          additionalProperties: { type: 'string' },
        },
        rows: {
          type: 'array',
          description: '同 fields，但用陣列保留順序：[["客戶名稱","強合科技"],…]。',
          items: { type: 'array', items: { type: 'string' } },
        },
        text: { type: 'string', description: 'note 和 lead 的內容。note 可以用 \\n 分行。' },
        thickness: { type: 'number', description: 'rule 的線粗（點），預設 1.5。1.5 是細線，3 以上就變成粗黑條了。' },
        size: { type: 'number', description: '基準字級（點），預設 10。區塊內各層會依它調整。' },
        tab: { type: 'number', description: 'fields 的標籤欄寬（點），預設 96。標籤長就調大。' },
        table_style: { type: 'string', description: 'kv 的表格樣式。' },
        font: { type: 'string', description: '字型，預設微軟正黑體。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        track: { type: 'boolean', description: '預設 false。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_cover',
    description:
      '做一頁封面，並自動接上分頁符號讓正文從第二頁開始。'
      + '\n\n【要做封面就用這個，不要自己組】自己用 word_insert_text 打標題和副標題，'
      + '做出來會是幾行大字浮在一整頁空白裡——那看起來像沒做完，不像封面。'
      + '\n\n三種版面，選跟文件性質相符的：'
      + '\n· **report**（預設）：大標題 + 副標 + 一張「文件資訊」表。'
      + '寫 PRD、規格書、分析報告用這個。meta 放文件版本、建立日期、文件狀態、負責人這類欄位。'
      + '

**report 版面給了 eyebrow 或 promise 就會改走設計過的靠左節奏**：眉標（小字主色）→ 主標（大字）→ 副標（主色，下面一條色線）→ 一句話承諾（灰字）→ 文件資訊表。'
      + '規劃書、提案、對客戶的正式文件用這個，配 word_apply_theme 的 report 主題最整齊。'
      + '承諾那句要寫「為了誰、要達成什麼」，不是把標題換句話說——'
      + '它是封面上唯一一句完整的話，少了它封面只是一張標籤。'
      + '\n· **form**：標題、副標、列印時間，全部置中而且字都小。'
      + '彙整表、點檢表、申請書用這個。'
      + '\n· **letterhead**：公司抬頭 + 置中的文件名 + 客戶／案件資訊。'
      + '報價單、通知函、對外文件用這個，company 和 address 要給。'
      + '\n\n字級和顏色由版面決定，**不要再套 word_format_range 把封面放大**——'
      + '一頁上只有一個大字級、其餘都小，是這幾種版面共通的做法。',
    inputSchema: {
      type: 'object',
      properties: {
        layout: { type: 'string', enum: ['report', 'form', 'letterhead'], description: '預設 report。' },
        title: { type: 'string', description: '文件名稱。letterhead 版面下若在 6 個字以內會自動加寬字距。' },
        subtitle: { type: 'string', description: '副標題或英文名稱。report 的設計版面裡它會是主色並帶一條底線。' },
        eyebrow: { type: 'string', description: 'report 專用。標題上方的小字，寫「機構 · 定位」，例如「久億藥局 · 在地健康守護」。給了就改走設計過的靠左版面。' },
        promise: { type: 'string', description: 'report 專用。一句話說明這份文件為了誰、要達成什麼，放在副標下方。' },
        note: { type: 'string', description: 'form 版面的小字，例如「列印時間：民國 115 年 7 月 31 日」。' },
        company: { type: 'string', description: 'letterhead 版面的公司名稱。' },
        company_en: { type: 'string', description: 'letterhead 版面的公司英文名。' },
        address: { type: 'string', description: 'letterhead 版面的地址與聯絡方式，會靠右。' },
        meta: {
          type: 'object',
          description:
            'report 版面的文件資訊表，鍵是欄位名、值是內容。'
            + '例如 {"文件版本":"v1.0","建立日期":"2026-08-21","文件狀態":"草稿"}。',
          additionalProperties: { type: 'string' },
        },
        table_style: { type: 'string', description: '資訊表的樣式，預設 GridTable4_Accent1。' },
        font: { type: 'string', description: '字型，預設微軟正黑體。' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_break',
    description:
      '插入分頁符號或分節符號。'
      + '\n\n【做封面就是用這個】封面寫完之後插一個分頁，正文才會從新的一頁開始。'
      + '用連打好幾個空白段落把內容擠到下一頁是文件排版最常見也最脆弱的錯誤——'
      + '之後只要有人改一個字，整份就跑掉了。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['page', 'line', 'section', 'section_continuous'],
          description: '預設 page。要讓某一段開始有不同的頁首頁尾才用 section。',
        },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        ...TRACK_NEW,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_gantt',
    description:
      '畫一張甘特圖（時程表），插入成圖片。'
      + '\n【做時程一定要用這個，不要用 word_insert_diagram 的 mermaid gantt】'
      + 'mermaid 的甘特圖把任務名寫在長條上，只要排程有兩件事時間重疊，字就會疊在一起；'
      + '日期也是有幾天印幾天，最後整排擠成一團看不出是什麼。'
      + '這支是自己畫的：任務名在左邊欄位、日期標籤的數量依寬度決定，不會互相壓。'
      + '\n【資料怎麼給】`tasks`，每一項要有 name 和 start；'
      + 'end 和 days 擇一（days 是「做幾天」）。日期一律 YYYY-MM-DD。'
      + '\n`group` 會變成背景色帶，用來分階段——「MVP」「V1.1」「V1.2」這種。'
      + '同一個 group 的工作要排在一起，色帶是照連續段落畫的。'
      + '\n`today` 給今天的日期會畫一條線；不在時程範圍內會自動略過。'
      + '`progress` 給 0～1 會在長條上畫出完成比例。'
      + '\n【它是圖片】Word 沒有甘特圖物件，所以插進去的是圖片，在 Word 裡改不了。'
      + '要改內容就重新產生一張。',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          description: '工作清單，依時間順序排。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '工作名稱' },
              start: { type: 'string', description: '開始日，YYYY-MM-DD' },
              end: { type: 'string', description: '結束日，YYYY-MM-DD。與 days 擇一。' },
              days: { type: 'number', description: '工期幾天。與 end 擇一。' },
              group: { type: 'string', description: '階段名稱，例如 MVP (P0)' },
              progress: { type: 'number', description: '完成比例 0～1' },
            },
            required: ['name', 'start'],
          },
        },
        title: { type: 'string', description: '圖表標題' },
        today: { type: 'string', description: '今天的日期，YYYY-MM-DD。會畫一條線。' },
        caption: { type: 'string', description: '圖說，例如「圖 2　版本時程」' },
        width: { type: 'number', description: '寬度（點）。不給就是內文寬度 450 點。' },
        paragraph: { type: 'number', description: '插在第幾段旁邊，省略就接在文件最後。' },
        at: { type: 'string', enum: ['before', 'after'], description: '預設 after' },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_diagram',
    description:
      '用 mermaid 語法畫圖並插進文件：流程圖、循序圖、甘特圖、狀態圖、類別圖、圓餅圖、心智圖等。'
      + '\n\n【什麼時候該用】文件裡出現「流程」「架構」「步驟」「誰跟誰互動」「時程」的時候。'
      + '這些用文字描述讀者要自己在腦中畫一次，給圖就不用。'
      + '規格書的系統架構、SOP 的作業流程、專案的時程，都該有圖。'
      + '\n\n跟 word_insert_chart 的差別：那個畫**數字**（長條、折線、圓餅），'
      + '這個畫**關係**（誰接到誰、先做什麼後做什麼）。'
      + '\n\n語法範例：'
      + '\n`flowchart TD` / `A[收料] --> B{檢驗}` / `B -->|合格| C[入庫]` / `B -->|不合格| D[退回]`'
      + '\n`sequenceDiagram` / `使用者->>系統: 送出申請` / `系統-->>使用者: 回覆結果`'
      + '\n\n【限制，要老實說】插進去的是**圖片**，使用者不能在 Word 裡拖動節點；'
      + '要改內容就改語法重新產生一張。'
      + '\n\n配一個 caption，圖才有編號可以在內文引用。'
      + '\n【時程、沿革、里程碑都不要用這支】'
      + '\n- 有起訖日期的工作排程 → `word_insert_gantt`'
      + '\n- 一條軸上的事件（沿革、里程碑、發展史）→ `word_insert_chart` 的 `type: "timeline"`，資料走 `events`'
      + '\nmermaid 的 `gantt` 會把任務名疊在長條上、日期擠成一團；它的 `timeline` 則是把事件平均排開，而時間軸真正要講的就是「哪裡密、哪裡疏」——平均排開正好把它抹掉。原生的那兩支會量字寬、會閃避相鄰的標籤，排不下才斷行。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'mermaid 原始碼，不要包 ``` 圍欄。' },
        caption: { type: 'string', description: '圖說，例如「圖 2　收料檢驗流程」。' },
        width: { type: 'number', description: '寬度（點）。不給就縮到內文寬度 450 點。' },
        theme: { type: 'string', enum: ['default', 'neutral', 'dark', 'forest', 'base'], description: '預設 default。文件多半用 default 或 neutral。' },
        font: { type: 'string', description: '圖裡的字型。預設是微軟正黑體，中文才不會變成方框。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        track: { type: 'boolean', description: '預設 false。' },
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_chart',
    description:
      '把一組數字畫成圖表插進文件：column（直條）、bar（橫條）、line（折線）、pie（圓餅）。'
      + '\n\n【什麼時候該用】報告裡出現三個以上可以比較的數字時。'
      + '「北中南三區的銷售」「四季的變化」「各項佔比」——寫成一段文字讀者要自己在腦中畫圖，給圖就不用。'
      + '\n\n【限制，要老實跟使用者說】Word 的增益集 API 沒有原生圖表物件，所以這是一張**圖片**：'
      + '插進去之後不能在 Word 裡點開改數字，數字變了要重新產生一張。'
      + '需要會跟資料連動的圖表，那是 Excel 的工作。'
      + '\n\n配一個 caption，圖才有編號可以在內文引用。'
      + '\n【不是只有長條和圓餅】這支現在跟簡報用的是同一個繪圖器，'
      + '所以瀑布、漏斗、雷達、時間軸、地圖、散佈、堆疊、箱型都畫得出來。'
      + '\n選型別看你要講什麼：比大小用 column／bar；看趨勢用 line／area；'
      + '拆解一個總數怎麼來的用 waterfall；轉換率一層層掉用 funnel；'
      + '兩個對象在同幾個面向上的強弱用 radar；組成比例隨時間變化用 stacked100。'
      + '\n**報告裡的圖比投影片更該少用顏色**——它用的是文件的灰階配色，'
      + '一頁黑字裡最亮的東西不該是圖表。'
      + '\n【數學的圖用 plot】type: "plot"，資料走 `curves`：'
      + '`[{ name: "N log N", points: [[256, 2048], [1024, 10240]] }]`，'
      + '每條線至少兩個點，points 是 [x, y]。'
      + '\n**跟其他圖的差別是 X 軸是真的數值軸，不是分類軸。**'
      + '函數曲線、量測數據、複雜度比較、頻率響應都要用這個——'
      + 'N² 跟 N log N 畫在平均刻度上，那張圖唯一要講的「差距越拉越開」正好被藏起來。'
      + '\n跨好幾個數量級就開 `log_y`（或 `log_x`），不然會變成一條平線加一根尖刺。'
      + '記得給 `x_axis` 和 `y_axis`：數值軸不會自己說明自己。'
      + '`dashed: true` 畫虛線，`dots: true` 標出實際量到的點。'
      + '\n\n【配色】`palette` 一次換掉整組顏色：classic（預設）、cool、warm、mono、earth、mono_grey。'
      + '文件的表格和標題是刻意壓成黑白灰的，**但圖表不是**——'
      + '一張圖的顏色就是它的資料，第二個數列用灰色會讓人以為那個數列比較不重要。'
      + '只有確定要黑白列印或影印時才用 mono_grey。'
      + '\n\n【學術文件的圖】Word 常拿來寫論文、報告、驗證計畫，下面這幾種是那種文件在用的，'
      + '商業圖表硬湊湊不出來：'
      + '\n- **histogram 直方圖**：一個變數怎麼分布。`values` 要給**原始數值**（不是數好的次數），'
      + '組數自己算（Freedman–Diaconis），要疊常態曲線就開 `normal: true`。'
      + '圖上會自動標 n、平均、標準差。'
      + '\n- **heatmap 熱力圖**：相關矩陣、混淆矩陣、任何「這些對那些」的表。'
      + '`matrix` 二維陣列 + `rows`/`cols`。資料跨越零就自動用雙向配色（相關係數就是這種）。'
      + '\n- **violin 小提琴圖**：分布的**形狀**。兩組可以有一模一樣的箱型圖卻完全不同的形狀——'
      + '一個單峰、一個分兩群，而箱型圖會把這件事藏起來。`groups: [{ label, values: [原始數值] }]`，'
      + '內建的箱型要關掉就 `box: false`。'
      + '\n- **forest 森林圖**：好幾個效果量和它們的信賴區間排在一起（統合分析、分組比較）。'
      + '`rows: [{ label, value, lo, hi, weight }]`，合計放 `summary`。'
      + '比值型的效果量（OR、RR、HR）一定要開 `log_x`，不然 2 倍和 ½ 倍會畫成不一樣長。'
      + '\n- **survival 存活曲線**：隨時間遞減的比例，畫成階梯（事件之間什麼都沒發生，'
      + '直線會謊稱有穩定下降）。`curves: [{ name, points: [[時間, 比例]], censored: [時間] }]`。'
      + '\n- **venn 范氏圖**：兩三個集合重疊多少。`sets: ["AOI","X-Ray"]` + '
      + '`overlaps: { A: 142, B: 88, AB: 37 }`。'
      + '\n\n【誤差棒：有量測就要有】`error` 跟 `values` 等長（多個數列就給二維），'
      + '畫在 column／bar／line 上。再用 `error_label` 講清楚那是什麼——'
      + '「± 1 SD」和「95% CI」是兩件完全不同的事，沒寫的誤差棒等於沒畫。'
      + '\n【迴歸線】散佈圖加 `fit: "linear"` 會畫最小平方線並標出方程式和 R²，'
      + '`fit_band: true` 再加上平均反應的 95% 信賴帶。'
      + '一張沒有斜率和 R² 的散佈圖，讀者只能用眼睛猜有沒有趨勢。'
      + '\n【氣泡圖】散佈圖的點加 `size` 就會按**面積**放大，用來放第三個變數。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          // 最後六個是學術文件那組，只開在 Word——簡報用不到這些。
          enum: ['column', 'bar', 'line', 'area', 'pie', 'donut', 'waterfall', 'funnel',
            'radar', 'timeline', 'map', 'scatter', 'stacked', 'stacked100', 'box', 'plot',
            'histogram', 'heatmap', 'violin', 'forest', 'survival', 'venn'],
          description: '預設 column。甘特圖請改用 word_insert_gantt。',
        },
        title: { type: 'string', description: '圖表標題。' },
        categories: { type: 'array', items: { type: 'string' }, description: 'X 軸（或圓餅的分類）名稱。' },
        series: {
          type: 'array',
          description: '數列。每個 values 的長度要跟 categories 一樣。圓餅圖只能有一個。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              values: { type: 'array', items: { type: 'number' } },
            },
            required: ['values'],
          },
        },
        values: { type: 'array', items: { type: 'number' }, description: '只有一個數列時的簡寫。' },
        events: {
          type: 'array',
          description: 'timeline 專用。至少一筆。',
          items: {
            type: 'object',
            properties: {
              at: { type: 'string', description: '時間點。給數字（2024、2024.75）會照實際間隔擺。' },
              label: { type: 'string', description: '這個時間點發生什麼。' },
              note: { type: 'string', description: '補充一句，可省略。' },
              highlight: { type: 'boolean', description: '設 true 會用強調色放大，一條軸最多標一個。' },
            },
            required: ['at', 'label'],
            additionalProperties: false,
          },
        },
        points: {
          type: 'array',
          description: 'scatter 專用：`[{ x, y, label, group }]`。',
          items: { type: 'object', additionalProperties: true },
        },
        boxes: {
          type: 'array',
          description: 'box 專用，分布已經算好的時候用：'
            + '`[{ label, min, q1, median, q3, max, outliers }]`。有原始數值就直接給 values。',
          items: { type: 'object', additionalProperties: true },
        },
        map: {
          type: 'string',
          enum: ['world', 'china', 'taiwan'],
          description: 'map 專用：要哪一份地圖。預設 world。',
        },
        total: {
          type: 'array',
          items: { type: 'number' },
          description: 'waterfall 專用：哪幾根是合計而不是增減（索引，0 起算）。',
        },
        colors: { type: 'array', items: { type: 'string' }, description: '每個數列的顏色。不給就用文件的灰階配色。' },
        data_labels: { type: 'boolean', description: '長條上是否標數字。' },
        labels: { type: 'boolean', description: 'scatter 專用：設 false 不標點的名稱。超過 12 點本來就不標。' },
        area: { type: 'boolean', description: 'line 專用：線下方填色。' },
        center: { type: 'string', description: 'donut 中間的大字，例如「70%」。' },
        center_label: { type: 'string', description: 'donut 中間大字底下的說明。' },
        curves: {
          type: 'array',
          description: 'plot 專用：每條線 `{ name, points: [[x, y], ...], dashed, dots }`，'
            + '至少兩個點。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              points: { type: 'array', description: '[[x, y], ...]，也可以給 [{ x, y }]。' },
              dashed: { type: 'boolean', description: '畫虛線。' },
              dots: { type: 'boolean', description: '標出實際量到的點。' },
            },
            required: ['points'],
            additionalProperties: false,
          },
        },
        x_axis: { type: 'string', description: 'plot／scatter 的 X 軸名稱。數值軸不會自己說明自己。' },
        y_axis: { type: 'string', description: 'plot／scatter 的 Y 軸名稱。' },
        log_x: { type: 'boolean', description: 'X 軸改對數刻度。所有 x 都要大於 0。' },
        log_y: { type: 'boolean', description: 'Y 軸改對數刻度。跨好幾個數量級就要開。' },
        bins: { type: 'number', description: 'histogram：組數。不給就自動算。' },
        normal: { type: 'boolean', description: 'histogram：疊一條常態曲線上去。' },
        matrix: {
          type: 'array',
          description: 'heatmap 專用：二維陣列，每一列一樣長。',
          items: { type: 'array', items: { type: 'number' } },
        },
        rows: {
          type: 'array',
          description: 'heatmap 的列名（字串）；forest 的每一列（物件 '
            + '`{ label, value, lo, hi, weight }`）。',
          items: {},
        },
        cols: { type: 'array', items: { type: 'string' }, description: 'heatmap 的欄名。' },
        scale: {
          type: 'string',
          enum: ['sequential', 'diverging'],
          description: 'heatmap 的配色。跨越零就自動用 diverging，可以指定蓋過。',
        },
        show_values: { type: 'boolean', description: 'heatmap 格子裡標數字／forest 右欄標數值。' },
        groups: {
          type: 'array',
          description: 'violin 專用：[{ label: "對照組", values: [原始數值…] }]。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              values: { type: 'array', items: { type: 'number' } },
            },
            required: ['values'],
            additionalProperties: false,
          },
        },
        box: { type: 'boolean', description: 'violin：內建的箱型圖，預設開。' },
        baseline: { type: 'number', description: 'forest 的無效果線。預設比值型是 1、差值型是 0。' },
        summary: {
          type: 'object',
          description: 'forest 的合計，會畫成菱形。',
          properties: {
            label: { type: 'string' },
            value: { type: 'number' },
            lo: { type: 'number' },
            hi: { type: 'number' },
          },
          required: ['value'],
          additionalProperties: false,
        },
        sets: { type: 'array', items: { type: 'string' }, description: 'venn：兩到三個集合名稱。' },
        overlaps: {
          type: 'object',
          description: 'venn 各區的數量：A、B、C 是只屬於該集合的，AB、AC、BC、ABC 是重疊的。',
          additionalProperties: { type: 'number' },
        },
        error: {
          type: 'array',
          description: '誤差棒的大小（半長），跟 values 等長。多個數列就給二維陣列。',
        },
        error_label: {
          type: 'string',
          description: '誤差棒代表什麼，例如「± 1 SD」或「95% CI」。會標在圖上。',
        },
        fit: {
          type: 'string',
          enum: ['linear'],
          description: 'scatter：畫最小平方迴歸線，並標出方程式與 R²。',
        },
        fit_band: { type: 'boolean', description: 'scatter：迴歸線加 95% 信賴帶。' },
        palette: {
          type: 'string',
          enum: ['classic', 'cool', 'warm', 'mono', 'earth', 'mono_grey'],
          description:
            '整組配色，預設 classic。'
            + 'classic 一般商務報告／cool 冷色，技術文件與規格書／warm 暖色，行銷與對客戶的文件／'
            + 'mono 同一色相由深到淺，適合有順序的分類／earth 大地色，ESG 與永續／'
            + 'mono_grey 純灰階，只在確定會黑白列印或影印時用。'
            + '要精確指定每個數列的顏色就用 colors，它會蓋過 palette。',
        },
        caption: { type: 'string', description: '圖說，例如「圖 1　各季營收」。會套用內建的標號樣式。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        ...TRACK_NEW,
      },
      // timeline 用 events、plot 用 curves、map 用 values＋地區名，
      // 所以 categories 不能是硬性要求——以前是，於是那幾種圖在列舉裡存在、
      // 在說明裡有範例，卻連送出的機會都沒有。缺什麼由 word.js 擋，訊息比這裡清楚。
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_equation',
    description:
      '插入數學公式，用 LaTeX 寫。'
      + '\n\n【重要】插進去的是**真正的 Word 公式物件**，不是圖片也不是文字——'
      + '使用者可以點進去繼續編輯、可以搜尋、縮放不會糊。所以文件裡任何算式都用這個，'
      + '不要用純文字拼「x^2 + sqrt(y)」，那不是公式，那是公式的描述。'
      + '\n\n支援常用的 LaTeX：分數 \\frac、上下標 ^ _、根號 \\sqrt、'
      + '求和積分 \\sum \\int（含上下限）、希臘字母、矩陣 \\begin{pmatrix}、'
      + '括號 \\left( \\right)、函數 \\sin \\log \\lim、重音 \\bar \\hat \\vec、'
      + '文字 \\text{}。認不得的指令會原樣顯示，不會整個失敗。'
      + '\n\n【插完公式之後最重要的一件事】公式是一個「數學區域」，Word 會把它延續到下一段。'
      + '所以**不要用 word_insert_text 接在公式段落後面**——你的文字會變成公式的一部分：'
      + '字型變成 Cambria Math、被置中、而且不會自動換行，整段衝出頁面右邊。'
      + '\n\n這個工具會自動在公式後面接一個乾淨的空段落，回傳訊息會提醒你。'
      + '接下來的內容用 word_write_range 寫進那一段。'
      + '\n\n真正夾在句子中間的行內公式目前做不到，要在句中提到符號就直接寫那個字元。',
    inputSchema: {
      type: 'object',
      properties: {
        latex: { type: 'string', description: 'LaTeX 原始碼，不用加 $ 或 $$。' },
        align: { type: 'string', enum: ['left', 'center'], description: '公式段落的對齊，**預設 left**——跟著內文走。只有整份文件的算式都獨立置中時才用 center，混著用會讓版面看起來像沒校對過。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        ...TRACK_NEW,
      },
      required: ['latex'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_checkbox',
    description:
      '產生、讀取或勾選核取方塊。'
      + '\n\n【什麼時候該用】做查核表、SOP、點檢單、簽核清單的時候。'
      + '插進去的是 Word 真正的核取方塊控制項——使用者點一下就能勾，狀態會存進檔案，'
      + '不是打「☐」這個字元（那個點了不會有反應）。'
      + '\n\nop="insert" 一次給整串項目；op="list" 看目前哪些勾了、哪些沒勾；'
      + 'op="set" 改某一項的狀態。'
      + '\n\n「這份點檢單還有哪幾項沒做」用 op="list" 就答得出來。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['insert', 'list', 'set'], description: '預設 insert。' },
        items: { type: 'array', items: { type: 'string' }, description: 'op=insert 時的項目文字。' },
        index: { type: 'number', description: 'op=set 時要改第幾個（用 op="list" 看編號）。' },
        checked: { type: 'boolean', description: 'op=set 時要勾還是取消，預設勾。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        ...TRACK_NEW,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_link',
    description:
      '加超連結。可以把文件裡既有的文字變成連結（給 find），也可以插入一段新的連結文字。'
      + '\n\n報告寫了參考資料、規範編號、網頁出處，就把它們做成連結。'
      + '只接受 http/https/mailto——文件可能來自外部，不該把裡面隨便一個字串變成可點的目標。'
      + '\n\n注意：不要把 KM 或郵件系統的內部網址寫進文件，那些需要憑證才打得開。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'list'], description: '預設 add。' },
        url: { type: 'string', description: '目標網址。' },
        find: { type: 'string', description: '要變成連結的既有文字。給了就忽略 text。' },
        text: { type: 'string', description: '要插入的連結文字。省略就用網址本身。' },
        match_case: { type: 'boolean', description: 'find 是否區分大小寫。' },
        paragraph: { type: 'number', description: '基準段落編號。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        ...TRACK_NEW,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_page_design',
    description:
      '整份文件的外觀：浮水印、頁面框線、頁面底色。'
      + '\n\n浮水印最常用——「機密」「草稿」「僅供內部參閱」會出現在每一頁的文字後面。'
      + '\n\n【注意】框線和底色要重寫整份內文才做得到（Word 把它們放在增益集碰不到的地方），'
      + '所以那兩個會跳確認視窗。浮水印只動頁首，不受影響。'
      + '一次呼叫可以同時設定多項，不要分好幾次呼叫。',
    inputSchema: {
      type: 'object',
      properties: {
        watermark: { type: 'string', description: '浮水印文字，例如「機密」。' },
        watermark_color: { type: 'string', description: '浮水印顏色，#RRGGBB，預設淺灰。' },
        border: { type: 'string', enum: ['single', 'double', 'thick', 'dashed', 'dotted'], description: '頁面框線樣式。' },
        border_color: { type: 'string', description: '框線顏色，#RRGGBB。' },
        border_width: { type: 'number', description: '框線粗細（1/8 pt 為單位），預設 12＝1.5pt。' },
        page_color: { type: 'string', description: '頁面底色，#RRGGBB。列印預設不會印出來。' },
      },
      additionalProperties: false,
    },
    destructive: true,
  },
  {
    name: 'word_insert_textbox',
    description:
      '插入浮動的文字方塊，可以指定位置、大小、底色、字色。'
      + '\n\n【做設計感的封面就是用這個】滿版色塊配大標題、側邊的引言框、'
      + '角落的文件編號——這些是文字方塊，不是段落。'
      + '\n\n單位是**點（pt）**，從頁面左上角算起。A4 是 595 × 842 pt，Letter 是 612 × 792 pt。'
      + '所以滿版橫幅大概是 left=0, top=0, width=595, height=200。'
      + '\n\n它是浮動物件，使用者可以直接拖曳和改字。',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '方塊裡的文字。' },
        left: { type: 'number', description: '左邊距離（pt），預設 0。' },
        top: { type: 'number', description: '上方距離（pt），預設 0。' },
        width: { type: 'number', description: '寬（pt），預設 400。' },
        height: { type: 'number', description: '高（pt），預設 100。' },
        fill: { type: 'string', description: '底色，#RRGGBB 或顏色名稱。' },
        transparency: { type: 'number', description: '底色透明度，0（不透明）到 1（全透明）。' },
        font_color: { type: 'string', description: '文字顏色，#RRGGBB。' },
        font_size: { type: 'number', description: '字級（pt）。' },
        font: { type: 'string', description: '字型名稱。' },
        bold: { type: 'boolean' },
        name: { type: 'string', description: '物件名稱，方便之後辨識。' },
        paragraph: { type: 'number', description: '錨定的段落編號。省略就錨在文件開頭。' },
        ...TRACK_NEW,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'word_normalize_layout',
    description:
      '把整份文件的內文段落統一成同一套排版：對齊、縮排、行距、段後距。'
      + '\n\n【寫完一份文件的最後一定要做這件事】排版會漂。'
      + '接在置中段落後面插入的段落會繼承置中，公式段落本來就是置中的、'
      + '它後面的也會跟著，而你一題一題寫的時候看不到整份文件長什麼樣。'
      + '結果就是一頁裡有幾段莫名其妙置中——讀者不會覺得「這幾段對齊錯了」，'
      + '他會覺得這份文件沒有人校對過。'
      + '\n\n它不會動標題、圖說、目錄、清單和公式段落——那些的對齊是刻意的。'
      + '\n\n中文公文常見的設定：alignment="justify"、first_line_indent=24（兩個字）。',
    inputSchema: {
      type: 'object',
      properties: {
        alignment: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: '內文對齊，預設 left。' },
        first_line_indent: { type: 'number', description: '首行縮排（點）。中文公文常用 24。' },
        left_indent: { type: 'number', description: '左縮排（點），預設 0。' },
        line_spacing: { type: 'number', description: '行距（點）。' },
        space_after: { type: 'number', description: '段後距（點）。用它做留白，不要用空白段落。' },
        style_body: { type: 'string', description: '內文段落要套的樣式，通常不用給。' },
        repair_math: {
          type: 'boolean',
          description:
            '把被公式「吃進去」的段落救回來。文字如果落在數學區域裡，會是 Cambria Math、'
            + '置中、而且不會換行所以衝出頁面——那不是對齊問題，設對齊救不回來。'
            + '看到文件裡有段落超出右邊界或莫名置中就開這個。'
            + '它要把每段的原始格式拉過來檢查，比較慢，所以預設關閉。',
        },
        ...PARAGRAPH_RANGE,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_apply_theme',
    description:
      '把整份文件套成同一套字型、字級、顏色和間距。七種：'
      + 'formal（公文體，標楷體、置中標題、首行縮排兩字）、'
      + 'modern（商務簡潔，微軟正黑體、靠左、藍色章節標題）、'
      + 'academic（學術論文，新細明體、雙倍行距、兩端對齊）、'
      + 'compact（緊湊，字小、間距密，適合表格多的文件）、'
      + 'spec（規格書，Word 原生藍色標題階層，寫 PRD 和技術文件用）、'
      + 'business（商務表單，深藍標題配小字內文，報價單、彙整表、對外文件用）、'
      + 'report（報告書，單一色相的綠配色、表格用淡底細線而不是黑底灰紋，'
      + '規劃書、提案、對客戶的正式文件用——想要「有設計過」的那種就選這個）。'
      + '\n\n【每份文件的最後一定要跑這個】'
      + '你一段一段寫的時候看不到整份長什麼樣，所以這個標題挑 16pt、下一個挑 14pt，'
      + '每個決定分開看都合理，合起來就是忽大忽小。'
      + '這個工具是「不要再一段一段決定」，而是最後一次把規則講給每一段聽。'
      + '\n\n**所以不要用 word_format_range 去設字型和字級**，那正是不一致的來源。'
      + 'word_format_range 是用來設樣式階層（Heading1/2）和個別強調的，不是用來排版的。'
      + '\n\n它跟 word_normalize_layout 的差別：這個管字型字級顏色，那個只管對齊縮排。'
      + '兩個都跑，先跑這個。',
    inputSchema: {
      type: 'object',
      properties: {
        theme: { type: 'string', enum: ['formal', 'modern', 'academic', 'compact', 'spec', 'business', 'report'], description: '預設 modern。' },
        font: { type: 'string', description: '覆寫字型。不給就用該樣式的預設中文字型。' },
        body_align: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: '覆寫內文對齊。' },
        first_line_indent: { type: 'number', description: '覆寫首行縮排（點）。中文公文是 24。' },
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
        ...TRACK_REWRITE,
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
    name: 'word_read_attachment',
    description:
      '看使用者這則訊息附上的圖片。'
      + '\n\n【訊息說有附圖，就先呼叫這個再回答】——那張圖多半就是他要問的東西本身，'
      + '常見的是「照這張截圖的格式做一份文件」「這張表幫我打成 Word 的表格」。'
      + '\n\n不要先問他圖裡是什麼，你自己看得到。',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '第幾張圖（1 起算），預設 1。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_insert_attachment',
    description:
      '把使用者這則訊息附上的圖片**插進文件裡**。'
      + '\n\n跟 word_read_attachment 的差別：那個是你看，這個是放進去。'
      + '使用者附一張圖給你，多半不只是要你看——「照這張圖做一份文件」通常也包含'
      + '「把這張圖放在該放的位置」。所以先用 word_read_attachment 看懂它是什麼，'
      + '再決定它該放在哪一段之後，然後用這個插進去。'
      + '\n\n配一個 caption，圖才有編號可以在內文引用。',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '第幾張圖（1 起算），預設 1。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        width: { type: 'number', description: '寬度（點）。不給就用圖片原本的大小。內文寬度大約是 450 點。' },
        caption: { type: 'string', description: '圖說，例如「圖 1　系統架構」。會套用內建的標號樣式。' },
        track: { type: 'boolean', description: '預設 false。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_read_image',
    description:
      '看**文件裡本來就有的**圖片內容——插在內文裡的截圖、示意圖、貼進來的圖表。'
      + 'word_get_overview 會告訴你這份文件有幾張圖，但看不到內容，要內容就用這個。'
      + '\n\n跟 word_read_attachment 的差別：那個是使用者這則訊息附上的圖，這個是檔案裡的圖。'
      + '\n\n【只有在需要的時候才呼叫】使用者沒問到那張圖、而你要做的事也跟它無關，'
      + '就不要自己去看——每一張都是一次來回，而且圖很佔上下文。',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '第幾張圖（1 起算，順序同 word_get_overview），預設 1。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'word_read_file',
    description:
      '讀取使用者這則訊息上傳的檔案。訊息開頭會列出有哪些檔案、各自幾個字、分成幾段。'
      + '\n\nindex 是那份清單的編號（1 起算）。長檔案會分段，用 part 一段一段拿——'
      + '不要一次把整份 200 頁的 PDF 讀進來，先讀第一段看它在講什麼，需要再往下拿。'
      + '\n\n使用者上傳檔案多半是要你**依它產出一份 Word 文件**，'
      + '所以讀完就直接動手寫，不要只把內容複述一遍給他看。',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '第幾個檔案（1 起算），預設 1。' },
        part: { type: 'number', description: '第幾段，預設 1。清單會告訴你共有幾段。' },
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

/**
 * Answered by the SERVER, not by the pane.
 *
 * The file's text was extracted here when it was uploaded, so the add-in has
 * nothing to contribute — sending the call down to Word and back would add a
 * round trip and a way to fail, for no information. See excelBridge.
 *
 * Which also means it must survive the clientTools filter: the pane never
 * declares it, because the pane never runs it.
 */
export const WORD_SERVER_TOOLS = ['word_read_file'];

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

/** Mirrors hosts/word.js — the tools that edit what was already there. */
const TRACKED_BY_DEFAULT = new Set(['word_write_range', 'word_replace_all', 'word_delete_range']);

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
  if (name === 'word_insert_layout') {
    const n = Array.isArray(args.columns) ? args.columns.length : 0;
    return `把 ${n} 個區塊並排`;
  }
  if (name === 'word_insert_block') {
    const k = { fields: '標籤清單', kv: '資訊表', note: '附註區塊', lead: '前言句' }[String(args.kind || 'fields')] || '區塊';
    return `插入${k}` + (args.title ? `：${args.title}` : '');
  }
  if (name === 'word_insert_cover') {
    const kind = { report: '報告封面', form: '表單抬頭', letterhead: '公司信頭' }[String(args.layout || 'report')] || '封面';
    return `建立${kind}：${String(args.title || '').slice(0, 30)}`;
  }
  if (name === 'word_read_attachment') return '查看你附上的圖片';
  if (name === 'word_insert_attachment') {
    return `把你附的第 ${args.index || 1} 張圖插進文件` + (args.caption ? `：${args.caption}` : '');
  }
  if (name === 'word_read_image') return `讀取文件裡的第 ${args.index || 1} 張圖片`;
  if (name === 'word_read_file') return `讀取你上傳的檔案${args.index ? `（第 ${args.index} 個）` : ''}`;
  if (name === 'word_normalize_layout') return '統一內文的排版';
  if (name === 'word_apply_theme') return `套用「${String(args.theme || 'modern')}」文件樣式`;
  if (name === 'word_insert_equation') return `插入公式：${String(args.latex || '').slice(0, 60)}`;
  if (name === 'word_checkbox') {
    const op = String(args.op || 'insert');
    if (op === 'list') return '讀取核取方塊狀態';
    if (op === 'set') return `${args.checked === false ? '取消勾選' : '勾選'}第 ${args.index} 項`;
    const n = Array.isArray(args.items) ? args.items.length : 0;
    return `插入 ${n} 個核取方塊`;
  }
  if (name === 'word_insert_link') {
    if (String(args.op || 'add') === 'list') return '讀取文件裡的超連結';
    return args.find ? `把「${args.find}」設成連往 ${args.url} 的連結` : `插入連往 ${args.url} 的連結`;
  }
  if (name === 'word_page_design') {
    const parts: string[] = [];
    if (args.watermark) parts.push(`浮水印「${args.watermark}」`);
    if (args.border) parts.push('頁面框線');
    if (args.page_color) parts.push('頁面底色');
    return `設定${parts.join('、') || '版面'}`;
  }
  if (name === 'word_insert_textbox') {
    return `插入文字方塊：${String(args.text || '').slice(0, 40)}`;
  }
  if (name === 'word_header_footer') {
    const side = String(args.where || 'footer') === 'header' ? '頁首' : '頁尾';
    if (args.clear) return `清空${side}`;
    return `設定${side}` + (args.page_number ? '（含頁碼）' : '');
  }
  if (name === 'word_insert_break') {
    const k = String(args.type || 'page');
    const label = k === 'page' ? '插入分頁符號' : k === 'line' ? '插入換行符號' : '插入分節符號';
    return label + (args.paragraph ? `（段落 ${args.paragraph} 之後）` : '');
  }
  if (name === 'word_insert_diagram') {
    const kind = /^\s*(\w+)/.exec(String(args.code || ''));
    return `插入${kind ? kind[1] : ''}圖表` + (args.caption ? `：${args.caption}` : '');
  }
  if (name === 'word_insert_chart') {
    const kind = { column: '直條', bar: '橫條', line: '折線', pie: '圓餅' }[String(args.type || 'column')] || '';
    const n = Array.isArray(args.categories) ? args.categories.length : 0;
    return `插入${kind}圖` + (args.title ? `：${args.title}` : `（${n} 個分類）`);
  }
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
  if (name === 'word_page_design' && (args.border || args.page_color)) {
    parts.push('會重寫整份內文以套用版面設定');
  }
  if (name === 'word_run_script') {
    const lines = String(args.code || '').split('\n').length;
    parts.push(String(args.mode || '') === 'write' ? '執行程式並修改文件' : '執行程式讀取內容');
    parts.push(`${lines} 行`);
  }
  // Only say it when it is true. A footnote claiming "可逐條接受或拒絕" on a call
  // that writes directly is worse than no footnote.
  const tracked = TRACKED_BY_DEFAULT.has(name) ? args.track !== false : args.track === true;
  if (WORD_TOOLS.some(t => t.name === name && t.destructive) || name.startsWith('word_insert')) {
    parts.push(tracked ? '以追蹤修訂寫入，可逐條接受或拒絕' : '直接寫入，不標記為修訂');
  }
  return parts.join(' · ');
}
