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
        ...TRACK_NEW,
      },
      required: ['values'],
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
    name: 'word_insert_chart',
    description:
      '把一組數字畫成圖表插進文件：column（直條）、bar（橫條）、line（折線）、pie（圓餅）。'
      + '\n\n【什麼時候該用】報告裡出現三個以上可以比較的數字時。'
      + '「北中南三區的銷售」「四季的變化」「各項佔比」——寫成一段文字讀者要自己在腦中畫圖，給圖就不用。'
      + '\n\n【限制，要老實跟使用者說】Word 的增益集 API 沒有原生圖表物件，所以這是一張**圖片**：'
      + '插進去之後不能在 Word 裡點開改數字，數字變了要重新產生一張。'
      + '需要會跟資料連動的圖表，那是 Excel 的工作。'
      + '\n\n配一個 caption，圖才有編號可以在內文引用。',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: ['column', 'bar', 'line', 'pie'], description: '預設 column。' },
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
        caption: { type: 'string', description: '圖說，例如「圖 1　各季營收」。會套用內建的標號樣式。' },
        paragraph: { type: 'number', description: '基準段落編號。省略就插在文件最後。' },
        at: { type: 'string', enum: ['after', 'before'], description: '預設 after。' },
        ...TRACK_NEW,
      },
      required: ['categories'],
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
      '把整份文件套成同一套字型、字級、顏色和間距。四種：'
      + 'formal（公文體，標楷體、置中標題、首行縮排兩字）、'
      + 'modern（商務簡潔，微軟正黑體、靠左、藍色章節標題）、'
      + 'academic（學術論文，新細明體、雙倍行距、兩端對齊）、'
      + 'compact（緊湊，字小、間距密，適合表格多的文件）。'
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
        theme: { type: 'string', enum: ['formal', 'modern', 'academic', 'compact'], description: '預設 modern。' },
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
