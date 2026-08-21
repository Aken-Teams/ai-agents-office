/**
 * The PowerPoint bridge's tool surface — one definition, three readers:
 *
 *   - pptMcp.ts (a separate subprocess) → advertises these to the Claude CLI
 *   - routes/ppt.ts (in the Express process) → decides which calls need a human
 *   - the task pane (hosts/powerpoint.js) → actually executes them via Office.js
 *
 * Keeping it in one place is what stops the three drifting. A schema the model
 * can see but the pane cannot run is an agent looping on 未知的工具; a call the
 * pane will run but the route does not consider destructive is someone's deck
 * edited without being asked.
 *
 * ── How the risk model differs from Word's, and why it matters here ──
 * The Word bridge can be generous about confirmation because Word has two safety
 * nets: changes arrive as tracked revisions the person can reject one by one,
 * and the pane holds the document's OOXML from before every call.
 *
 * PowerPoint has NEITHER.
 *
 * There are no tracked changes in a presentation. And there is no cheap
 * whole-file snapshot below PowerPointApi 1.10 (Office 2601), so the pane's undo
 * works by inverse operation: it deletes the shapes it created. That covers
 * ADDING completely and covers nothing else at all.
 *
 * Which flips the line. In Word, rewriting a paragraph is recoverable and so it
 * passes without ceremony. Here, rewriting a shape's text destroys the old text
 * outright — the undo button cannot bring it back, and neither can anything else
 * this add-in has. So `ppt_set_text`, `ppt_format_shape` and `ppt_arrange` are
 * marked destructive even though the equivalent Word calls are not. That is not
 * excessive caution; it is the same standard applied to a host with fewer nets.
 */

export interface PptToolSpec {
  name: string;
  /** Written FOR the model — says when to reach for it, not just what it does. */
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * true = the add-in MUST get an explicit human click before executing it. The
   * CLI runs with --permission-mode dontAsk (no human in that loop), so this
   * flag is the ONLY thing between an injected instruction and a real deck.
   */
  destructive?: boolean;
}

/**
 * Where things go, quoted to the model so it does not invent coordinates.
 *
 * These are the same numbers hosts/powerpoint.js lays out against. Stating them
 * in the schemas rather than leaving the model to guess is the difference
 * between a deck and a pile of slides: two boxes at x=60 look deliberate, one at
 * 60 and one at 57 look broken and nobody can say why.
 */
const CANVAS = '投影片是 960×540 點（16:9）。內文左邊界 60、右邊界 900，'
  + '標題帶在 top 48 高 72，內文帶從 top 140 開始高 340，頁尾在 top 494。'
  + '雙欄的話每欄寬 404，中間留 32 的間距。';

const SLIDE_ARG = {
  slide: {
    type: 'number',
    description: '投影片編號（1 起算）。省略的話用**最後一張**，不是第一張。',
  },
};

/** Position and size only — the canvas note is already in GEOMETRY above. */
const GEOMETRY_BLOCK = {
  left: { type: 'number', description: '左邊界（點）。不給的話用內文區的左邊界 38。' },
  top: { type: 'number', description: '上邊界（點）。不給的話用內文區的上緣 124。' },
  width: { type: 'number', description: '總寬度（點）。不給的話用內文區寬度 884。' },
  height: { type: 'number', description: '高度（點）。' },
};

const GEOMETRY = {
  left: { type: 'number', description: `左邊界（點，從投影片左緣算）。${CANVAS}` },
  top: { type: 'number', description: '上邊界（點，從投影片上緣算）。' },
  width: { type: 'number', description: '寬度（點）。' },
  height: { type: 'number', description: '高度（點）。' },
};

const TYPOGRAPHY = {
  font: { type: 'string', description: '字型，預設微軟正黑體。' },
  size: {
    type: 'number',
    description:
      '字級（點）。簡報的字比文件大很多——大標 40、標題 32、小標 22、內文 18、'
      + '附註 14。**內文不要小於 16**，投影出來從後排看不到。',
  },
  bold: { type: 'boolean' },
  italic: { type: 'boolean' },
  color: { type: 'string', description: '文字顏色，#RRGGBB。' },
  align: { type: 'string', enum: ['left', 'center', 'right', 'justify'], description: '水平對齊。' },
  valign: { type: 'string', enum: ['top', 'middle', 'bottom'], description: '垂直對齊（在方塊內）。' },
};

const FILL = {
  fill: { type: 'string', description: '填色，#RRGGBB。空字串代表不填色。' },
  line_color: { type: 'string', description: '外框顏色，#RRGGBB。' },
  line_width: { type: 'number', description: '外框粗細（點）。' },
  line: { type: 'boolean', description: '設 false 代表不要外框。' },
};

const THEME_ARG = {
  theme: {
    type: 'string',
    enum: ['corporate', 'slate', 'fresh', 'warm', 'night'],
    description:
      '配色：corporate 企業藍、slate 沉穩灰、fresh 清新綠、warm 暖橘、night 深色。'
      + '**整份簡報要用同一個**，不要每張換一個。預設 corporate。',
  },
};

export const PPT_TOOLS: PptToolSpec[] = [
  // ── Reading ────────────────────────────────────────────────────────────────
  {
    name: 'ppt_get_overview',
    description:
      '讀這份簡報的結構：有幾張投影片、每張的標題和物件數量。'
      + '\n\n**動任何東西之前先呼叫這個。** 你不知道現在有幾張投影片、'
      + '也不知道使用者是要你從頭做還是接著改，猜錯的話會把東西加到錯的地方。',
    inputSchema: {
      type: 'object',
      properties: {
        slides: { type: 'number', description: '最多列幾張，預設 40。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_read_slide',
    description:
      '讀某一張投影片的完整內容：每個物件的名稱、類型、**座標、大小**和文字。'
      + '\n\n【要改既有的投影片就一定要先讀這個】物件是用編號定位的，'
      + '而編號來自這個工具的輸出。沒讀過就呼叫 ppt_set_text 或 ppt_arrange 等於亂猜。'
      + '\n\n座標也是你要對齊東西時唯一的依據。',
    inputSchema: {
      type: 'object',
      properties: { ...SLIDE_ARG },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_get_selection',
    description: '看使用者現在選了哪張投影片。他說「這張」「這裡」的時候用這個確認。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },

  // ── Slides ─────────────────────────────────────────────────────────────────
  {
    name: 'ppt_add_slide',
    description:
      '新增空白投影片。'
      + '\n\n【PowerPoint API 的兩個硬限制，一定要知道】'
      + '\n1. 新投影片**只能加在最後面**。沒有「插在第 3 張後面」這種選項。'
      + '\n2. **沒有搬移投影片的 API**。做好了就不能重新排序。'
      + '\n\n所以請**照最終順序由前往後建立**，不要想著之後再調。'
      + '\n\n多數情況你應該用 ppt_build_slide 而不是這個——那個會直接做出排好版的投影片，'
      + '這個只給你一張空白的。',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '要加幾張，預設 1。' },
        layout_id: { type: 'string', description: '版面配置 ID。要跟 master_id 一起給，否則會失敗。' },
        master_id: { type: 'string', description: '投影片母片 ID。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_delete_slide',
    description:
      '刪除投影片。**這個增益集的復原鍵救不回來**（PowerPoint 沒有整份快照的 API），'
      + '只能靠使用者自己在 PowerPoint 裡按 Ctrl+Z。所以除非使用者明講要刪，否則不要用。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        slide: { type: 'number', description: '要刪的投影片編號（1 起算）。' },
        to: { type: 'number', description: '刪一個範圍時的結束編號（含）。' },
      },
      required: ['slide'],
      additionalProperties: false,
    },
  },

  // ── The tool that should do most of the work ───────────────────────────────
  {
    name: 'ppt_build_slide',
    description:
      '**一次做好一整張排版完成的投影片。這應該是你最常用的工具。**'
      + '\n\n【為什麼不要用 ppt_add_text 慢慢拼】一張投影片用基本工具拼要五六次呼叫，'
      + '每次都是一趟來回，而且每次的座標都是你自己編的——'
      + '結果就是兩張投影片的標題差了 4 點，看起來很不專業但沒人說得出哪裡怪。'
      + '這個工具用同一套格線，所以每張投影片都對得起來。'
      + '\n\n【七種版型】'
      + '\n· **title**：封面。滿版主色底、置中大標。整份只用一次。'
      + '\n· **section**：章節分隔頁。用來把長簡報切成段落，觀眾才知道講到哪。'
      + '\n· **bullets**：標題＋條列。最常用的內容頁。'
      + '\n· **two_column**：雙欄並排。左右各一組條列，適合「現況／建議」。'
      + '\n· **compare**：雙欄對照，兩邊各有底色方框。適合方案 A／方案 B。'
      + '\n· **statement**：一個大數字或一句話，超大字置中。用在關鍵結論。'
      + '\n· **quote**：引言，帶引號裝飾和署名。'
      + '\n\n【預設會新增一張投影片】不想新增、要在現有的那張上面做，就給 slide 或 append=false。'
      + '\n\n【條列寫法】body 給陣列，一項一句，**一項不要超過兩行**。'
      + '投影片不是文件，整段文字貼上去沒有人會讀。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['title', 'section', 'bullets', 'two_column', 'compare', 'statement', 'quote'],
          description: '版型，預設 bullets。',
        },
        title: { type: 'string', description: '主標題。statement 版型的話這裡放那個大數字或那句話。' },
        body: {
          type: 'array',
          items: { type: 'string' },
          description: '內容。bullets 版型會加上項目符號；title/section/statement 當副標。',
        },
        left: { type: 'array', items: { type: 'string' }, description: 'two_column／compare 的左欄內容。' },
        right: { type: 'array', items: { type: 'string' }, description: 'two_column／compare 的右欄內容。' },
        left_title: { type: 'string', description: '左欄小標，例如「現況」。' },
        right_title: { type: 'string', description: '右欄小標，例如「建議做法」。' },
        eyebrow: {
          type: 'string',
          description:
            '標題上方的小字，通常是章節編號和名稱，例如「04　AI AGENTS」。'
            + '**每一張內容頁都應該給**——這是觀眾判斷「講到哪了」的唯一線索，'
            + '也是讓十張投影片看起來像同一份簡報的關鍵之一。'
            + 'section 版型的話這裡放章節編號（例如「04」），會變成左邊那個大數字。',
        },
        page: { type: 'string', description: '右上角的頁碼標記，例如「P.03」。' },
        footer: { type: 'string', description: '頁尾註記，例如資料來源。' },
        append: { type: 'boolean', description: '是否先新增一張投影片，預設 true。' },
        chrome: {
          type: 'boolean',
          description:
            '是否套用共用骨架（頂部色條、眉標、標題、標題下短線），預設 true。'
            + '除非使用者要一張完全自訂的投影片，否則**不要關掉**——'
            + '骨架就是整份簡報看起來一致的原因。',
        },
        ...SLIDE_ARG,
        ...THEME_ARG,
      },
      additionalProperties: false,
    },
  },

  // ── Primitives ─────────────────────────────────────────────────────────────
  {
    name: 'ppt_add_text',
    description:
      '在投影片上加一個文字方塊，指定位置和大小。'
      + '\n\n用在 ppt_build_slide 的版型放不下的東西：角落的標籤、圖表旁邊的說明、'
      + '流程圖上的註記。**整張投影片的主要內容不要用這個一塊一塊拼**，用 ppt_build_slide。'
      + `\n\n${CANVAS}`,
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '文字內容，可用 \\n 分行。' },
        ...GEOMETRY,
        ...TYPOGRAPHY,
        ...FILL,
        wrap: { type: 'boolean', description: '是否自動換行，預設是。' },
        autofit: { type: 'boolean', description: '文字超出方塊時是否自動縮小，預設是。設 false 會讓文字溢出。' },
        padding: { type: 'number', description: '內距（點）。' },
        ...SLIDE_ARG,
        ...THEME_ARG,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_add_shape',
    description:
      '加一個幾何圖形，可以帶文字。'
      + '\n\n用途：流程步驟的方框、強調用的色塊、箭頭、標號的圓形。'
      + '\n\n常用的 shape 值：Rectangle、RoundRectangle、Ellipse、Chevron（箭頭標籤）、'
      + 'RightArrow、Diamond（決策點）、Pentagon、FlowChartProcess、FlowChartDecision。'
      + '\n\n【要畫完整的流程圖就不要用這個】一個一個拼很慢也對不齊，'
      + '用 ppt_add_diagram 寫 mermaid 語法，一次畫好。',
    inputSchema: {
      type: 'object',
      properties: {
        shape: { type: 'string', description: '圖形類型，預設 Rectangle。' },
        text: { type: 'string', description: '圖形裡的文字。' },
        ...GEOMETRY,
        ...TYPOGRAPHY,
        ...FILL,
        ...SLIDE_ARG,
        ...THEME_ARG,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_add_line',
    description:
      '畫一條線。用在分隔線、時間軸、連接兩個方塊。'
      + '\n\n【座標的意義跟其他工具不一樣，很容易搞錯】'
      + 'left/top 是線的**起點**，width/height 是**到終點的位移**，不是外框大小。'
      + '所以一條從 (60,300) 到 (900,300) 的水平線是 left=60, top=300, width=840, height=0。',
    inputSchema: {
      type: 'object',
      properties: {
        ...GEOMETRY,
        connector: { type: 'string', enum: ['Straight', 'Elbow', 'Curve'], description: '線的形狀，預設 Straight。' },
        line_color: { type: 'string', description: '顏色，#RRGGBB。' },
        line_width: { type: 'number', description: '粗細（點），預設 1.5。' },
        ...SLIDE_ARG,
        ...THEME_ARG,
      },
      additionalProperties: false,
    },
  },

  // ── Editing what is already there ──────────────────────────────────────────
  {
    name: 'ppt_set_text',
    description:
      '改寫某個物件的文字。'
      + '\n\n【shape 編號來自 ppt_read_slide】先讀再改，不要猜編號。'
      + '\n\n【原本的文字會直接消失】PowerPoint 沒有追蹤修訂，'
      + '這個增益集的復原鍵也只能移除新增的物件、拿不回被覆蓋的文字。'
      + '所以改之前要確定改對了物件。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        shape: { type: 'number', description: '物件編號，來自 ppt_read_slide 的列表。' },
        text: { type: 'string', description: '新的文字。' },
        ...TYPOGRAPHY,
        ...SLIDE_ARG,
      },
      required: ['shape', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_format_shape',
    description:
      '調整既有物件的位置、大小、顏色或字型。'
      + '\n\n【shape 編號來自 ppt_read_slide】'
      + '\n\n要把好幾個物件對齊或平均分散，用 ppt_arrange，不要一個一個算座標。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        shape: { type: 'number', description: '物件編號。' },
        ...GEOMETRY,
        ...TYPOGRAPHY,
        ...FILL,
        ...SLIDE_ARG,
      },
      required: ['shape'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_delete_shape',
    description: '刪掉某個物件。編號來自 ppt_read_slide。復原鍵拿不回來。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        shape: { type: 'number', description: '物件編號。' },
        ...SLIDE_ARG,
      },
      required: ['shape'],
      additionalProperties: false,
    },
  },

  // ── The differentiator ─────────────────────────────────────────────────────
  {
    name: 'ppt_arrange',
    description:
      '把一組物件對齊、平均分散、或統一大小。'
      + '\n\n【這是這個增益集最有價值的工具】網頁版可以幫使用者「產生」一份簡報，'
      + '但沒辦法打開他手上這一份、看到第 4 張上那六個方塊實際在哪、然後把它們排整齊。'
      + '那需要讀取開啟中檔案的即時座標，只有增益集做得到。'
      + '\n\n使用者說「幫我對齊一下」「排整齊」「大小弄一樣」的時候就用這個。'
      + '\n\n【how 的選項，跟 PowerPoint 功能區裡的同名】'
      + '\n· left / right / top / bottom：靠某一邊對齊'
      + '\n· center_h / center_v：水平置中／垂直置中對齊'
      + '\n· distribute_h / distribute_v：水平／垂直平均分散間距'
      + '\n· same_width / same_height / same_size：統一大小'
      + '\n\n不給 shapes 就是對這張投影片上的**所有**物件動作。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        how: {
          type: 'string',
          enum: ['left', 'right', 'top', 'bottom', 'center_h', 'center_v',
            'distribute_h', 'distribute_v', 'same_width', 'same_height', 'same_size'],
          description: '要做什麼。',
        },
        shapes: {
          type: 'array',
          items: { type: 'number' },
          description: '要動的物件編號（來自 ppt_read_slide）。省略代表整張投影片上的所有物件。',
        },
        value: { type: 'number', description: 'same_width／same_height 要指定的尺寸。省略就用現有最大的。' },
        ...SLIDE_ARG,
      },
      required: ['how'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_apply_theme',
    description:
      '把一組配色和字型套到整份簡報。'
      + '\n\n【預設只動這個增益集自己建立的物件】使用者自己放的內容不會被改——'
      + '把別人排好的東西重新上色不叫套主題，叫破壞，而且這裡的復原鍵救不回來。'
      + '真的要全部套用才給 all=true，而且要先問過使用者。'
      + '\n\n做完一份簡報的最後可以呼叫一次，確保前後一致。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        ...THEME_ARG,
        all: {
          type: 'boolean',
          description: '是否連使用者自己放的物件也一起套用，預設 false。設 true 之前要先問過使用者。',
        },
      },
      additionalProperties: false,
    },
  },

  {
    name: 'ppt_add_cards',
    description:
      '在投影片上排一列（或多列）卡片。**這是把投影片做得像樣的主力工具。**'
      + '\n\n【為什麼重要】拆解一份手工做的精美簡報，每張投影片有 17 到 47 個圖形；'
      + '只放標題加條列的話大概 5 個。差距就在這裡——內容做成卡片，不是做成一段文字。'
      + '而且**完全不花時間**：40 個圖形和 5 個圖形是同一批送出、同一次來回。'
      + '\n\n【兩種樣式】'
      + '\n· `bar="left"`：寬卡片，左側一條 5pt 色條。適合**由上往下讀**的清單——'
      + '議程、發現、建議事項。搭配 number 和 note 就是標準的目錄頁。'
      + '\n· `bar="top"`：窄卡片，頂部一條色條。適合**由左往右讀**的並列項目——'
      + '流程的五個階段、四大支柱。搭配 arrows=true 會在卡片之間加箭頭。'
      + '\n\n【怎麼用】每張卡給 title（一句話）和 text（補充，可省略）。'
      + '顏色會自動循環主色／次色／強調色，不用自己指定。'
      + '\n\n【什麼時候該用】只要內容是**三到六個並列的項目**就用這個，不要用條列。'
      + '條列頁一頁只能講一件事，卡片可以讓五件事同時被看見而且有結構。',
    inputSchema: {
      type: 'object',
      properties: {
        cards: {
          type: 'array',
          description: '1 到 8 張卡片。',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', description: '卡片標題，一句話。' },
              text: { type: 'string', description: '補充說明，可省略。要短。' },
              number: { type: 'string', description: '編號徽章，例如「01」。目錄頁用。' },
              note: { type: 'string', description: '右側註記，例如「P.03」。只有 bar="left" 會顯示。' },
              color: { type: 'string', description: '這張卡的色條顏色。不給就自動循環。' },
              fill: { type: 'string', description: '這張卡的底色。不給就用配色的預設。' },
            },
          },
        },
        bar: { type: 'string', enum: ['left', 'top'], description: '色條位置。不給的話 3 張以下用 left、4 張以上用 top。' },
        columns: { type: 'number', description: '一列幾張。不給就自動。' },
        arrows: { type: 'boolean', description: '卡片之間加箭頭（流程用）。只有 bar="top" 有效。' },
        gutter: { type: 'number', description: '卡片間距（點），預設 24。' },
        row_gap: { type: 'number', description: '多列時的列間距（點），預設 18。' },
        size: { type: 'number', description: '卡片標題字級，預設 14。' },
        small: { type: 'number', description: '卡片內文字級，預設 11.5。' },
        ...GEOMETRY_BLOCK,
        // After the spread on purpose: here `height` is ONE CARD's height, not
        // the block's, and that is the more useful description of the two.
        height: { type: 'number', description: '單張卡片的高度（點）。left 預設 68、top 預設 92。' },
        ...SLIDE_ARG,
        ...THEME_ARG,
      },
      required: ['cards'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_add_chart',
    description:
      '畫一張圖表放進投影片：直條、橫條、折線、區域、圓餅、甜甜圈。'
      + '\n\n【三個以上可比較的數字就該畫成圖】「營收成長 23%」是一句話，'
      + '四季的營收放成長條圖是一眼就懂的形狀。簡報比文件更需要這件事。'
      + '\n\n【限制，要老實告訴使用者】PowerPoint 的 API **沒有建立圖表的方法**，'
      + '所以這裡畫的是 SVG 向量圖。好處是投影不會糊，而且使用者可以按右鍵'
      + '「轉換為圖形」把每一根長條變成可以編輯的物件。'
      + '**但它不是 PowerPoint 的圖表物件，沒有連結的資料表**——'
      + '要改數字就再呼叫一次重新產生，不能在 PowerPoint 裡開資料表編輯。'
      + '你在回覆裡提到這張圖時要講清楚這件事，不要讓使用者以為可以雙擊編輯資料。'
      + '\n\n【它會放在目前選取的投影片上】跟圖片一樣，Common API 沒辦法指定投影片。'
      + '\n\n【單一系列給一維陣列，多系列給二維】values: [10,20,30] 或 [[10,20],[30,40]]。',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: ['column', 'bar', 'line', 'area', 'pie', 'donut'],
          description:
            'column 直條（比大小，最常用）、bar 橫條（分類名稱長的時候用）、'
            + 'line 折線（看趨勢）、area 區域、pie 圓餅（看佔比，最多 5 項）、'
            + 'donut 甜甜圈（可在中間放一個關鍵數字）。預設 column。',
        },
        title: { type: 'string', description: '圖表標題。' },
        categories: { type: 'array', items: { type: 'string' }, description: 'X 軸分類，例如 ["Q1","Q2","Q3"]。' },
        values: { type: 'array', description: '數值。單系列給 [10,20,30]，多系列給 [[10,20],[30,40]]。' },
        series: { type: 'array', items: { type: 'string' }, description: '多系列時每個系列的名稱，會做成圖例。' },
        colors: { type: 'array', items: { type: 'string' }, description: '每個系列的顏色。不給就用配色。' },
        data_labels: { type: 'boolean', description: '長條上是否標數字，預設 true。' },
        center: { type: 'string', description: 'donut 中間的大字，例如「70%」。' },
        center_label: { type: 'string', description: 'donut 中間大字底下的說明。' },
        ...GEOMETRY_BLOCK,
        ...THEME_ARG,
      },
      required: ['values'],
      additionalProperties: false,
    },
  },
  // ── Pictures ───────────────────────────────────────────────────────────────
  {
    name: 'ppt_add_diagram',
    description:
      '用 mermaid 語法畫圖並放進投影片：流程圖、循序圖、甘特圖、狀態圖、心智圖。'
      + '\n\n【簡報比文件更需要圖】投影片上一段講「流程」的文字，觀眾要自己在腦中畫一次；'
      + '給圖就不用。出現「流程」「架構」「步驟」「時程」「誰跟誰互動」就該畫。'
      + '\n\n【這裡的圖是向量的，比 Word 版好】只要 Office 支援 ImageCoercion 1.2，'
      + '插進去的是 SVG——投影不會糊，而且使用者可以按右鍵「轉換為圖形」之後直接拖動裡面的方塊。'
      + '\n\n語法範例：'
      + '\n`flowchart LR` / `A[需求訪談] --> B[系統設計]` / `B --> C{可行?}` / `C -->|是| D[開發]`'
      + '\n`sequenceDiagram` / `使用者->>系統: 送出申請` / `系統-->>使用者: 回覆結果`'
      + '\n\n【它會放在目前選取的投影片上】Common API 沒辦法指定投影片，'
      + '所以要先確定使用者在對的那一張，或剛建好那一張。',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'mermaid 原始碼，不要包 ``` 圍欄。' },
        ...GEOMETRY,
        raster: { type: 'boolean', description: '設 true 強制用點陣圖而不是 SVG。一般不需要。' },
        font: { type: 'string', description: '圖裡的字型。預設微軟正黑體，中文才不會變方框。' },
        ...THEME_ARG,
      },
      required: ['code'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_add_image',
    description:
      '把一張 base64 圖片放進目前的投影片。通常是使用者上傳的圖，或你從別的工具拿到的圖。'
      + '\n\n不給座標的話會自動置中並縮到內文範圍內。',
    inputSchema: {
      type: 'object',
      properties: {
        data: { type: 'string', description: 'base64 圖片資料（不含 data: 前綴也可以）。' },
        natural_width: { type: 'number', description: '原始寬度，用來算比例。' },
        natural_height: { type: 'number', description: '原始高度。' },
        ...GEOMETRY,
      },
      required: ['data'],
      additionalProperties: false,
    },
  },

  // ── Meta ───────────────────────────────────────────────────────────────────
  {
    name: 'ppt_ask_user',
    description:
      '問使用者一個問題並等他回答。'
      + '\n\n簡報比文件更需要問，因為「做一份產品簡報」少了對象和長度就沒辦法開始：'
      + '給誰看（客戶／主管／工程師）、幾分鐘、要不要放數字。'
      + '一次問一件事，給選項。',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '問題本身，一句話。' },
        options: { type: 'array', items: { type: 'string' }, description: '選項，2 到 4 個。' },
      },
      required: ['question'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_read_attachment',
    description: '看使用者貼在對話裡的圖片。他說「照這張圖做」「這個版面」的時候用。',
    inputSchema: {
      type: 'object',
      properties: { index: { type: 'number', description: '第幾張，1 起算，預設 1。' } },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_insert_attachment',
    description: '把使用者貼在對話裡的圖片直接放進投影片。',
    inputSchema: {
      type: 'object',
      properties: {
        index: { type: 'number', description: '第幾張，1 起算，預設 1。' },
        ...GEOMETRY,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_read_file',
    description:
      '讀使用者上傳的檔案（PDF、Word、Excel、文字檔）內容。'
      + '\n\n他說「照這份文件做成簡報」的時候用這個，先讀完再開始規劃投影片。',
    inputSchema: {
      type: 'object',
      properties: {
        file_id: { type: 'string', description: '檔案 ID。' },
        max_chars: { type: 'number', description: '最多讀幾個字，預設 40000。' },
      },
      additionalProperties: false,
    },
  },
];

export const PPT_TOOL_NAMES = PPT_TOOLS.map(t => t.name);

/**
 * Answered by the Express process, never by the task pane.
 *
 * Same split as Word's: an uploaded file lives on the server, so relaying the
 * request through the browser and back would move megabytes for no reason.
 */
export const PPT_SERVER_TOOLS = ['ppt_read_file'];

export const PPT_MCP_TOOL_NAMES = PPT_TOOL_NAMES.map(n => `mcp__ppt__${n}`);

/**
 * Script patterns that mean "this writes", checked independently of what the
 * model declared. Same list as Word's, retargeted at the PowerPoint API surface.
 */
const SCRIPT_MUTATION_PATTERNS = [
  /\.\s*(add|delete|clear|insert|set|remove)[A-Za-z]*\s*\(/,
  /\.\s*(left|top|width|height|name|text|visible|rotation)\s*=/,
  /\.\s*(fill|lineFormat|textFrame|font|paragraphFormat)\b[^=]*=/,
  /\bslides\s*\.\s*add\b/,
  /setSelectedDataAsync/,
];

export function scriptMutatesPresentation(code: string): boolean {
  return SCRIPT_MUTATION_PATTERNS.some(re => re.test(code));
}

export function isDestructiveTool(name: string, args: Record<string, unknown> = {}): boolean {
  if (PPT_TOOLS.some(t => t.name === name && t.destructive)) return true;
  if (name === 'ppt_run_script') {
    // Declaration AND verification. The model declares `mode`, but the code is
    // scanned independently: a call that says `read` while moving shapes still
    // gets a confirmation. Neither signal is trusted alone.
    return String(args.mode || '') === 'write' || scriptMutatesPresentation(String(args.code || ''));
  }
  return false;
}

/**
 * Calls the undo button genuinely cannot take back.
 *
 * The pane's undo deletes the shapes it created, so ADDING is always
 * recoverable. Everything on this list either removes something that was already
 * there or overwrites it, and for those the button is honest about being unable
 * to help — which is exactly when the person should be asked first.
 */
export function toolRisk(name: string, args: Record<string, unknown> = {}): 'high' | 'normal' {
  if (name === 'ppt_delete_slide' || name === 'ppt_delete_shape') return 'high';
  // Repainting shapes the person made themselves is not recoverable here.
  if (name === 'ppt_apply_theme') return args.all === true ? 'high' : 'normal';
  if (name === 'ppt_run_script') {
    return /\.\s*delete\s*\(/.test(String(args.code || '')) ? 'high' : 'normal';
  }
  return 'normal';
}

const where = (args: Record<string, unknown>): string =>
  args.slide === undefined ? '最後一張投影片' : `投影片 ${args.slide}`;

const ARRANGE_LABEL: Record<string, string> = {
  left: '靠左對齊', right: '靠右對齊', top: '靠上對齊', bottom: '靠下對齊',
  center_h: '水平置中對齊', center_v: '垂直置中對齊',
  distribute_h: '水平平均分散', distribute_v: '垂直平均分散',
  same_width: '統一寬度', same_height: '統一高度', same_size: '統一大小',
};

const KIND_LABEL: Record<string, string> = {
  title: '封面', section: '章節頁', bullets: '條列頁', two_column: '雙欄',
  compare: '對照頁', statement: '大數字頁', quote: '引言頁',
};

export function describeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === 'ppt_get_overview') return '讀取簡報結構';
  if (name === 'ppt_read_slide') return `讀取${where(args)}的內容`;
  if (name === 'ppt_get_selection') return '讀取目前選取的投影片';
  if (name === 'ppt_add_slide') {
    const n = Number(args.count) || 1;
    return n > 1 ? `新增 ${n} 張投影片` : '新增一張投影片';
  }
  if (name === 'ppt_delete_slide') {
    const from = args.slide;
    const to = args.to;
    return to !== undefined && to !== from ? `刪除投影片 ${from}-${to}` : `刪除投影片 ${from}`;
  }
  if (name === 'ppt_build_slide') {
    const kind = KIND_LABEL[String(args.kind || 'bullets')] || String(args.kind || '');
    return `做一張${kind}` + (args.title ? `：${String(args.title).slice(0, 30)}` : '');
  }
  if (name === 'ppt_add_text') return `在${where(args)}加文字：${String(args.text || '').slice(0, 24)}`;
  if (name === 'ppt_add_shape') return `在${where(args)}加圖形${args.text ? `：${String(args.text).slice(0, 20)}` : ''}`;
  if (name === 'ppt_add_line') return `在${where(args)}畫一條線`;
  if (name === 'ppt_set_text') return `改寫${where(args)}第 ${args.shape} 個物件的文字`;
  if (name === 'ppt_format_shape') return `調整${where(args)}第 ${args.shape} 個物件`;
  if (name === 'ppt_delete_shape') return `刪除${where(args)}第 ${args.shape} 個物件`;
  if (name === 'ppt_arrange') {
    const how = ARRANGE_LABEL[String(args.how || '')] || String(args.how || '');
    const n = Array.isArray(args.shapes) ? args.shapes.length : 0;
    return `把${where(args)}的${n ? `${n} 個` : '所有'}物件${how}`;
  }
  if (name === 'ppt_apply_theme') {
    return `把配色套到整份簡報${args.all === true ? '（含使用者自己放的物件）' : ''}`;
  }
  if (name === 'ppt_add_diagram') {
    const kind = /^\s*(\w+)/.exec(String(args.code || ''));
    return `插入${kind ? kind[1] : ''}圖表`;
  }
  if (name === 'ppt_add_cards') {
    const n = Array.isArray(args.cards) ? args.cards.length : 0;
    return `在${where(args)}排 ${n} 張卡片`;
  }
  if (name === 'ppt_add_chart') {
    const kind = { column: '直條', bar: '橫條', line: '折線', area: '區域', pie: '圓餅', donut: '甜甜圈' }[String(args.type || 'column')] || '';
    return `插入${kind}圖` + (args.title ? `：${args.title}` : '');
  }
  if (name === 'ppt_add_image') return '插入圖片';
  if (name === 'ppt_ask_user') return String(args.question || '請你決定一件事');
  if (name === 'ppt_read_attachment') return '看你貼的圖';
  if (name === 'ppt_insert_attachment') return '把你貼的圖放進投影片';
  if (name === 'ppt_read_file') return '讀取你上傳的檔案';
  return name;
}

/**
 * The technical footnote: HOW, as opposed to WHAT.
 *
 * The undo note is the important one here and it says something different from
 * Word's, because it is true of something different. Word can promise "可逐條接受
 * 或拒絕"; this cannot promise anything of the sort, and a footnote that implied
 * otherwise would be worse than none.
 */
export function describeToolMeta(name: string, args: Record<string, unknown>): string {
  const parts: string[] = [];
  if (name === 'ppt_delete_slide' || name === 'ppt_delete_shape') {
    parts.push('復原鍵拿不回來，只能用 PowerPoint 自己的 Ctrl+Z');
  } else if (name === 'ppt_set_text') {
    parts.push('原本的文字會被覆蓋，復原鍵拿不回來');
  } else if (name === 'ppt_arrange' || name === 'ppt_format_shape') {
    parts.push('會改動物件位置，復原鍵拿不回原本的座標');
  } else if (name === 'ppt_apply_theme' && args.all === true) {
    parts.push('包含使用者自己放的物件，復原鍵拿不回來');
  } else if (name.startsWith('ppt_add') || name === 'ppt_build_slide') {
    // Cards and charts are additions, which is the one case undo really covers.
    // The one case the undo button genuinely covers, so it is worth saying.
    parts.push('新增的物件可以用復原鍵移除');
  }
  return parts.join(' · ');
}
