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

/**
 * The structural knob, next to the colour one.
 *
 * Kept separate from `theme` because a look and a palette are independent
 * choices — 極簡 works in orange and in navy — and fusing them would need thirty
 * enum values to say what six and five say apart.
 */
const LOOK_ARG = {
  look: {
    type: 'string',
    enum: ['business', 'editorial', 'literary', 'minimal', 'soft', 'bold', 'tech',
      'academic', 'dashboard', 'courseware', 'handmade', 'whiteboard', 'eink'],
    description:
      '版式（跟配色是兩回事：配色決定顏色，版式決定長相）。'
      + '\n- business 企業：雙色頂條、短底線、方角卡片。對外提案、給主管看。'
      + '\n- editorial 雜誌：沒有色條，標題大而不粗，下面一條細滿版線。偏文青、像報導。'
      + '\n- literary 文青：暖色紙張滿版、明體標題、細框線，**完全沒有企業色**。'
      + '使用者講「文青」「有質感」「不要那麼商務」就是這個。'
      + '\n- minimal 極簡：沒有任何裝飾，只有字跟留白。內容夠強的時候最好看。'
      + '\n- soft 柔和：圓角、標題置中、色條短而圓。內部分享、教學、輕鬆場合。'
      + '\n- bold 大字：標題很大，左上角一塊實色。只有一個重點、要講得用力。'
      + '\n- tech 科技：深色底、細線、單色。技術簡報。'
      + '\n- academic 學術：整頁細框、密集分欄、編號分明。口試、技術審查、內部評審。'
      + '\n- dashboard 儀表板：左側整條色柱、點陣底。數據回顧、月結報告。'
      + '\n- courseware 教材：大字、圓角、步驟分明。教學、內訓、說明會。'
      + '\n- handmade 手作：**紙紋底＋手繪框線**。暖色、鬆一點的場合。'
      + '\n- whiteboard 白板：接近全白、**手繪線條**、沒有色塊。邊講邊畫的內容。'
      + '\n- eink 電子紙：**紙紋**、明體、純灰階。長文、報告、要被讀而不是被看的。'
      + '\n\n最後三個的紋理與手繪筆觸是在增益集裡用 SVG 算出來的，不是 AI 生圖——'
      + '**在 PowerPoint 裡按右鍵「轉換為圖形」之後還是可以編輯**。'
      + '需要 Office 2021 以上，舊版會自動退回沒有紋理的樣子。'
      + '\n**整份簡報只選一次，之後每一次呼叫都帶同一個值。**'
      + '換版式等於換一份簡報，中途換會非常明顯。預設 business。'
      + '\n\n**每個版式都自帶配色。** 不指定 theme 的話會用該版式原本設計的那一組——'
      + 'literary 與 handmade 配暖紙、editorial/minimal/whiteboard/eink 配墨黑、'
      + 'soft 配莫蘭迪、courseware 配清新綠。'
      + '選了風格又硬套企業藍，就是使用者說「文青一點」結果拿到藍配紅的原因。',
  },
};

const THEME_ARG = {
  theme: {
    type: 'string',
    enum: ['corporate', 'slate', 'fresh', 'warm', 'night', 'linen', 'muted', 'mono',
      'teal', 'sky', 'amber'],
    description:
      '配色：corporate 企業藍、slate 沉穩灰、fresh 清新綠、warm 暖橘、night 深色、'
      + 'linen 亞麻暖紙、muted 莫蘭迪、mono 墨黑、'
      + 'teal 藍綠、sky 淡藍、amber 黃橘。'
      + '\n**不要每次都 corporate。** 企業簡報不等於深藍配大紅——'
      + 'teal、sky、amber 一樣正式，而且一整份看下來不會那麼沉。'
      + '連續做給同一個單位的簡報，換個配色比換版式安全得多。'
      + '\n**整份簡報要用同一個**，不要每張換一個。'
      + '\n**不確定就不要給這個參數**——每個 look 都自帶設計好的配色，'
      + '硬指定反而會把風格拆掉一半。',
  },
};

export const PPT_TOOLS: PptToolSpec[] = [
  // ── Reading ────────────────────────────────────────────────────────────────
  {
    name: 'ppt_get_overview',
    description:
      '讀這份簡報的結構：有幾張投影片、每張的標題和物件數量，'
      + '外加**可用的版面配置清單（含 master_id / layout_id）**與**這份簡報已經在用的顏色**。'
      + '\n\n**動任何東西之前先呼叫這個。** 你不知道現在有幾張投影片、'
      + '也不知道使用者是要你從頭做還是接著改，猜錯的話會把東西加到錯的地方。'
      + '\n\n【要沿用簡報既有的風格，就靠這個工具的輸出】'
      + 'master_id 與 layout_id 只有這裡拿得到，沒讀過就只能用預設版面，'
      + '做出來的頁面會跟簡報裡原有的頁面對不起來。'
      + '顏色同理：輸出裡列出的就是這份簡報實際在用的配色，新增內容請直接沿用，不要另外套一組。',
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
      + '這個只給你一張空白的。'
      + '\n\n【要沿用簡報既有的版面】先呼叫 ppt_get_overview，它會列出這份簡報的母片與版面配置，'
      + '把其中一組 master_id + layout_id 帶進來，新投影片就會長得跟原有的頁面一致；'
      + '兩個都不給就會落到預設版面。',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '要加幾張，預設 1。' },
        layout_id: { type: 'string', description: '版面配置 ID，**從 ppt_get_overview 的輸出取得**。要跟 master_id 一起給，否則會失敗。' },
        master_id: { type: 'string', description: '投影片母片 ID，同樣來自 ppt_get_overview。' },
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
    name: 'ppt_plan_deck',
    description:
      '規劃整份簡報的走向：每頁一行，講這一頁要證明什麼、用什麼形式。'
      + '\n\n【做簡報的第一步，不是可選的】'
      + '一頁的簡報也要跑——「只做一頁」正是最需要規劃的情況，因為所有東西要擠進同一張紙，'
      + '位置是先決的，不是做到哪算哪。'
      + '\n\n清單要先給使用者看：走向錯了，每一頁做得再好都是白做，'
      + '而他看一眼就知道順序對不對——那比看完五頁成品再說「不是這個方向」便宜太多。'
      + '\n\n列完檢查三件事：相鄰的頁形式有沒有重複太多（連三頁條列就是沒在規劃）、'
      + '有沒有哪一頁只是上一頁換句話說（有就合併）、密度要不要一致'
      + '（開場結論可以輕、中間論證該重，但不要隨機）。',
    inputSchema: {
      type: 'object',
      properties: {
        headline: { type: 'string', description: '整份要讓人記得的那一句話。' },
        audience: { type: 'string', description: '給誰看的，影響密度和用詞。' },
        slides: {
          type: 'array',
          description: '每頁一個物件，照順序。',
          items: {
            type: 'object',
            properties: {
              purpose: { type: 'string', description: '這一頁要證明什麼，例如「問題：採用高但成效低」。' },
              form: { type: 'string', description: '用什麼形式，例如「左圖右表」「三欄階段卡」。' },
            },
            required: ['purpose', 'form'],
          },
        },
      },
      required: ['slides'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_plan_slide',
    description:
      '規劃一頁的版面：分成幾塊、各佔哪裡、每塊用什麼媒材以及為什麼。'
      + '\n\n【ppt_build_slide 會檢查這個跑過沒有】沒規劃過的頁做不了，這不是提醒是一道門。'
      + '因為先想內容再找地方放，做出來的頁面是把區塊依序堆下去的結果——'
      + '每一塊都對，但整頁沒有人規劃過。'
      + '\n\n**headline 要寫成一句主張**（「採用衝很快，成效跟不上」），'
      + '不是題目名稱（「AI 趨勢分析」）。那句話決定這一頁其餘所有東西怎麼排。'
      + '\n\n每一塊都要說得出 why——說不出「為什麼這塊用圖不用條列」，'
      + '通常代表那塊其實不需要存在，或者它該換一種形式。'
      + '\n\n**給座標等於給了設計稿。** 每一塊帶 left/top/width/height 的話，'
      + '後面每個工具照著放，排不歪也不重疊——這是做出真正看板式一頁的唯一方法。'
      + '投影片是 960×540 點，內容區大約從 y=104 開始、左右各留 30~38。'
      + '\n\n媒材怎麼挑：兩組數字要比較→長條圖；多個項目的多個欄位→表格；'
      + '階段流程→並排的階段卡；單一關鍵數字→數字卡；真的只能用講的→條列，一頁最多一到兩塊。',
    inputSchema: {
      type: 'object',
      properties: {
        slide: { type: 'number', description: '第幾頁，從 1 開始。預設 1。' },
        headline: { type: 'string', description: '這一頁要讓人記得的那句主張。' },
        blocks: {
          type: 'array',
          description: '這一頁分成哪幾塊。一頁最多三到四塊，再多就是擠。',
          items: {
            type: 'object',
            properties: {
              area: { type: 'string', description: '佔哪裡，例如「左上」「下半橫排」。' },
              media: { type: 'string', description: '用什麼，例如「長條圖」「表格」「階段卡」「數字卡」。' },
              why: { type: 'string', description: '為什麼是這個媒材。' },
            },
            required: ['area', 'media'],
          },
        },
      },
      required: ['headline', 'blocks'],
      additionalProperties: false,
    },
  },
{
    name: 'ppt_build_slide',
    description:
      '**一次做好一整張排版完成的投影片。這應該是你最常用的工具。**'
      + '\n\n【一頁就一次呼叫】kpi、callout、footband 都是這個工具的參數。'
      + '把它們寫進同一次呼叫，版面會自己把高度分配好，上中下三層剛好填滿。'
      + '分成三次呼叫的話，每一次都要你自己算 top——算出來的落差就變成'
      + '使用者看到的那幾塊空白（「一頁 PPT 這樣也太少東西了」就是這麼來的）。'
      + '\nppt_add_kpi / ppt_add_callout 留給「事後補一個到既有的頁面上」用。'
      + '\n\n【為什麼不要用 ppt_add_text 慢慢拼】一張投影片用基本工具拼要五六次呼叫，'
      + '每次都是一趟來回，而且每次的座標都是你自己編的——'
      + '結果就是兩張投影片的標題差了 4 點，看起來很不專業但沒人說得出哪裡怪。'
      + '這個工具用同一套格線，所以每張投影片都對得起來。'
      + '\n\n【版型】'
      + '\n· **title**：封面。滿版主色底、置中大標。整份只用一次。'
      + '\n· **bullets**：標題＋條列。最常用的內容頁。'
      + '\n· **two_column**：雙欄並排。左右各一組條列，適合「現況／建議」。'
      + '\n· **compare**：雙欄對照，兩邊各有底色方框。適合方案 A／方案 B。'
      + '\n· **timeline**：時程主視覺。一條貫穿的軸線，停靠點上下交錯，'
      + '每一站有時間、事件、一句說明。**時程、里程碑、導入階段用這個，不要做成條列**——'
      + '條列會把時程唯一的資訊（順序和疏密）丟掉。'
      + '用 `items: [{ at, label, note, highlight }]`，最多 6 站。'
      + '\n· **quadrant**：兩軸四格矩陣。'
      + '「這兩個維度交叉之後有四種情況」用這個——優先順序、風險、自製或外購。'
      + '用 `items: [{ title, text }]`（四個，左上、右上、左下、右下）'
      + '加上 `x_axis` / `y_axis`。**軸名一定要給**，沒有軸名就只是四個方塊，不是矩陣。'
      + '\n· **feature**：大圖配小卡。左邊一張大圖，右邊二到四張小卡。'
      + '一個東西是主角、其餘是關於它的資訊時用這個——產品、據點、案例。'
      + '圖的網址給 `image`，卡片給 `items: [{ title, text }]`。'
      + '\n· **list_image**：圖文列表。每一列一張小圖＋一段字，二到四列。'
      + '「五種產品」「四個部門」這種每一項都需要一張臉或一個圖示的內容。'
      + '這個版型只排出圖片的框並**回傳每一格的座標**，'
      + '再用 `ppt_add_photo`（mode: "block"）一張一張填進去。'      + '\n· **zigzag**：圖文交錯。三到四段，色塊左右交錯排。'
      + '步驟、要點、三件事用這個比 bullets 有節奏。用 `items: [{ title, text, number }]`。'      + '\n· **quote**：引言，帶引號裝飾和署名。'
      + '\n\n【沒有章節分隔頁，也沒有單一大數字頁——這是刻意拿掉的】'
      + '看報告的人是一路往下讀的。中間插一頁滿版深色的「01 資本與成本」、'
      + '或一頁只有一個巨大的數字，除非那一頁強到值得被打斷，否則只是突兀。'
      + '\n**章節寫進每一頁的 `eyebrow`。** 內容頁左上角那行「01 資本與成本」'
      + '就是章節標記，而且它每一頁都在，比一頁分隔頁有用得多。'
      + '\n**關鍵數字放進 `kpi`**，跟旁邊的內容擺在一起——'
      + '這樣它有上下文，而不是一個沒頭沒尾的大字。'
      + '\n\n【預設會新增一張投影片】不想新增、要在現有的那張上面做，就給 slide 或 append=false。'
      + '\n\n【條列寫法】body 給陣列，一項一句，**一項不要超過兩行**。'
      + '投影片不是文件，整段文字貼上去沒有人會讀。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: ['title', 'bullets', 'two_column', 'compare',
            'quote', 'timeline', 'quadrant', 'zigzag', 'feature', 'list_image'],
          description: '版型，預設 bullets。',
        },
        title: { type: 'string', description: '主標題。' },
        items: {
          type: 'array',
          description:
            'timeline / quadrant / zigzag 用這個。'
            + '\ntimeline：`[{ at: "2024 Q1", label: "試點", note: "兩條產線" }]`'
            + '\nquadrant：`[{ title, text }]` 四個，順序是左上、右上、左下、右下'
            + '\nzigzag：`[{ title, text }]` 三到四個',
          items: { type: 'object', additionalProperties: true },
        },
        x_axis: { type: 'string', description: 'quadrant 的橫軸名稱，例如「規則明確度 →」。' },
        y_axis: { type: 'string', description: 'quadrant 的縱軸名稱，例如「↑ 發生頻率」。' },
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
        kpi: {
          type: 'array',
          description:
            '在內容上方放一排數據卡（大數字＋標籤＋小註），最多 5 個，三到四個最好看。'
            + '\n**寫在這裡，不要另外呼叫 ppt_add_kpi。** 放在這裡的話，'
            + '版面會自己把剩下的高度分配給下面的內容；'
            + '另外呼叫的話你要自己算 top，算出來的落差就是使用者看到的那塊空白。',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: '大數字，例如「65%」「$37B」。' },
              label: { type: 'string', description: '這個數字是什麼。' },
              note: { type: 'string', description: '小字註解，來源或比較基準。' },
              color: { type: 'string' },
            },
            required: ['value'],
            additionalProperties: false,
          },
        },
        callout: {
          type: 'string',
          description:
            '一句結論，放在這一頁的最底下（淺色底、左邊一條色帶）。'
            + '\n這一頁的數字講「發生了什麼」，這句講「所以呢」。**只寫一句**，'
            + '變成條列就等於把內容換個顏色再講一次。'
            + '\n同樣**寫在這裡，不要另外呼叫 ppt_add_callout**——理由跟 kpi 一樣。',
        },
        motif: {
          type: 'string',
          enum: ['waves', 'diamonds', 'arcs', 'grid', 'topo', 'ribbon', 'corner', 'none'],
          description:
            '整份簡報共用的背景幾何——就是市售 PPT 模板每一頁都有的那層東西。'
            + '\n白底加上很淡的波浪／菱形／弧線，**不會蓋過內容**，'
            + '但整份看起來就像套過模板，而且它是形狀不是圖片，'
            + '使用者右鍵「轉換為圖形」之後每一筆都能編輯。'
            + '\n\n**整份只挑一次，每一頁都帶同一個值。** 一致才有模板感；'
            + '每頁換一個就不是模板，是拼貼。'
            + '\n不指定的話用版式預設的那一個。不想要就給 `none`。'
            + '\n\nwaves 波浪（溫和，泛用）／diamonds 菱形（活潑）／arcs 弧線（柔和）／'
            + 'grid 格線（資料、技術）／topo 等高線（安靜、有層次）／'
            + 'ribbon 斜帶（有力）／corner 角落三角（幾乎沒有存在感）。'
            + '\n\n**這個是背景的正解，不要為了做背景去生圖。**'
            + '生一張圖要十幾秒、每頁都不一樣、而且可能跟主題無關；'
            + '母題是零成本、每頁一致、永遠不會離題。',
        },
        cover: {
          type: 'string',
          enum: ['panel', 'split', 'stack', 'triptych', 'bleed', 'band', 'plain', 'paper',
            'imageLeft', 'imageRight', 'imageTop'],
          description:
            '封面的構圖（只有 kind="title" 有用）。'
            + '\n**做封面的時候這個參數一定要給。** 不給就會落到版式的預設值，而同一個版式的預設永遠是同一種——'
            + '結果就是每一份簡報的封面都長一樣，明明有十一種可以選。'
            + '先看這一份簡報是什麼題目、有沒有圖可以用，再挑一種。'
            + '\n- panel 左右：左邊整條色塊＋跨出頁面的圓形，右邊放標題'
            + '\n- split 左右：白底、左緣一條窄色邊，字全部靠左'
            + '\n- stack 上下：上面三分之二是色塊，字在下面，一條色條跨過交界'
            + '\n- triptych 三欄：三條同色系直欄，標題橫跨過去'
            + '\n- bleed 滿版：整頁一個顏色，字置中'
            + '\n- band 中央：淺色頁面上一塊圓角深色板'
            + '\n- plain 極簡：只有字'
            + '\n- paper 紙張：暖色紙滿版＋細框線'
            + '\n- **imageLeft / imageRight 左右**：圖片佔一側 40%，另一側放字'
            + '\n- **imageTop 上下**：圖片是上方 208 點的一條帶，字在下面'
            + '\n\n**圖片佔一部分通常比滿版好看。** 整頁鋪滿一張圖再把標題壓上去，'
            + '除非那張圖極為精彩，否則只是一個「背景」，衝擊感反而更低。'
            + '\n\n**封面值得多花一點力氣。** 它只被看一次、沒有前後文可以對照，'
            + '而且決定了使用者對整份簡報的第一印象。'
            + '\n主題適合的話，用 `ppt_generate_image`（mode: "hero"）或 `ppt_add_photo` '
            + '做一張滿版背景，再把標題壓在上面——那是所有做法裡最有份量的一種。',
        },
        image: {
          type: 'string',
          description:
            '圖片網址（來自 ppt_generate_image 或 ppt_find_art）。'
            + 'cover 選 imageLeft / imageRight / imageTop，或 kind 是 feature 的時候有用——'
            + '圖會被放進那個版型的圖片區塊，**保持原比例置中**，版面繞著它排。'
            + '\n插畫不會被拉變形，所以框給大一點沒關係，它只會用到自己需要的那塊。',
        },
        footband: {
          type: 'boolean',
          description:
            '把頁尾做成**滿版深色帶**（而不是一行小灰字）。'
            + '\n內容偏少、下半頁會空的時候請打開：深色帶會給版面一個「地板」，'
            + '內容就不會浮在投影片中間。頁碼也會自動移到帶子的右邊。'
            + '\n整份簡報請一致——要嘛每頁都有，要嘛都沒有。',
        },
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
        ...LOOK_ARG,
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
    name: 'ppt_review_layout',
    description:
      '做完整份之後看一次，只修「壞掉」的：物件跑到版面外、兩個物件疊在一起、字太小。'
      + '\n\n【它刻意不碰設計】不會去對齊、等距、統一大小——那些是你剛剛為這一頁做的決定，'
      + '檢查沒有資格覆蓋。它只抓「不管什麼設計都不該發生」的事。'
      + '\n\n跑到版面外的會自動夾回來（位置算得出來）；疊在一起的**只報告**，'
      + '因為該讓誰讓開是設計問題——它會告訴你是哪兩個，你決定怎麼調。'
      + '\n\n【每做完一份就跑一次】尤其是用 ppt_draw 畫的頁——'
      + '座標是你自己算的，算錯一個數字就會有東西掉到版面外，而那在縮圖上看不出來。',
    inputSchema: {
      type: 'object',
      properties: {
        slide: { type: 'number', description: '只檢查某一頁。不給就整份。' },
        fix: { type: 'boolean', description: '預設 true（會把跑出去的夾回來）。false 就只報告。' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_add_infographic',
    description:
      '畫一張常見的資訊圖：SWOT、金字塔、環形流程、箭頭步驟、文氏圖。座標都算好了。'
      + '\n\n【這是少數該用模組的地方】'
      + '版面要自己畫（見 ppt_draw），但這五種是**圖表類型**，跟長條圖同一類——'
      + '結構本來就該一致，而且座標算一次就不用每次重算。'
      + '把這部分交給工具，你的心力就能花在這一頁其餘的部分。'
      + '\n\n· `swot` —— 四個六角形聚成一簇。items 給四個，每個有 key（S/W/O/T）和 label。'
      + '\n· `pyramid` —— 梯形層層疊，右邊自動接引線和說明。由下而上給，最底層放第一個。'
      + '\n· `cycle` —— 圓形節點繞一圈，可以給 hub 當軸心。三到七個。'
      + '\n· `steps` —— Chevron 橫排，後一個壓前一個。'
      + '\n· `venn` —— 三個圓用半透明疊，交集自己就疊出來，不用另外補色塊。'
      + '\n\n顏色不給就從 accent 推一組同色相的深淺階；個別要指定就在 items 裡給 color。'
      + '\n\n**圖只負責結構，說明文字自己用 ppt_draw 補**——'
      + '那些說明該放哪裡、多寬、幾行，是這一頁的版面問題，不是這張圖的事。',
    inputSchema: {
      type: 'object',
      properties: {
        slide: { type: 'number' },
        kind: { type: 'string', enum: ['swot', 'pyramid', 'cycle', 'steps', 'venn'] },
        items: {
          type: 'array',
          description: 'swot 四個、venn 三個、cycle 三到七個、其餘不限（上限 6）。',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '區塊上的字。' },
              key: { type: 'string', description: 'swot 專用：六角形裡的字母。' },
              value: { type: 'string', description: 'pyramid 專用：梯形裡的數字或百分比。' },
              color: { type: 'string', description: '這一塊的顏色。不給就自動推。' },
            },
          },
        },
        hub: { type: 'string', description: 'cycle 專用：中心軸的字。' },
        center: { type: 'string', description: 'venn 專用：三圓交集的字。' },
        accent: { type: 'string', description: '推導深淺階用的主色。' },
        left: { type: 'number' }, top: { type: 'number' },
        width: { type: 'number' }, height: { type: 'number' },
        node: { type: 'number', description: 'cycle/venn 的圓徑。' },
        radius: { type: 'number', description: 'cycle 的排列半徑。' },
        text_color: { type: 'string' }, block_text: { type: 'string' },
        look: { type: 'string' }, theme: { type: 'string' },
      },
      required: ['kind', 'items'],
      /**
       * 這裡刻意不設 additionalProperties: false。
       *
       * 設了之後，模型只要多帶一個我沒想到的欄位（每層的金額、節點的說明、整張圖的
       * 標題），整個呼叫就在派送之前被擋掉——而錯誤訊息只說「失敗」，看不出是哪個欄位。
       *
       * 實測是 SWOT 和箭頭步驟成功、金字塔和環形流程和文氏圖失敗，差別正是**後三種的
       * 需求比較豐富，所以模型想多帶東西**。一個為了嚴謹而加的限制，把最需要這個工具
       * 的那幾種擋在門外。多餘的欄位忽略就好——那比整個呼叫失敗好得多。
       */
    },
  },
{
    name: 'ppt_run_script',
    description:
      '在使用者的 PowerPoint 裡直接執行一段 JavaScript（Office.js），只把 return 的結果帶回來。'
      + '\n\n【什麼時候一定要用這個】**版面上有任何重複結構的時候。**'
      + '一個 5×8 的表格是 40 個矩形、一條時間軸是 6 個圓點加 6 段線、一面指標牆是 12 張卡 ×3 層文字。'
      + '把這些逐個寫成座標 JSON 要三千個 token；寫成一支迴圈是三十個——而且改間距只要改一個數字，'
      + '不必重寫四十組座標。'
      + '\n\n**一頁六十幾個物件正是該用這支工具的訊號，不是該逐個列舉的理由。**'
      + '\n\n【可以用的東西】context（PowerPoint.RequestContext）、presentation（= context.presentation）、'
      + 'PowerPoint（列舉常數用，例如 PowerPoint.GeometricShapeType.rectangle）、'
      + 'log(...)（訊息會跟結果一起回傳，除錯用）、store（**跨呼叫保留的暫存物件**）。'
      + '整段程式碼是一個 async function 的內容，可以直接 await，用 return 交出結果。'
      + '\n\n【座標】投影片是 960×540 點，左上角是 (0,0)。'
      + '\n\n【Office.js 的規矩】先 .load("欄位") 再 await context.sync() 才讀得到值；'
      + '**不要在迴圈裡 sync**——建立物件時連續呼叫 addGeometricShape，最後統一 sync 一次就好。'
      + '範例（一排等距的卡片）：'
      + '\nconst slide = presentation.slides.getItemAt(0);'
      + '\nconst W = 200, GAP = 24, TOP = 180;'
      + '\nfor (let i = 0; i < 4; i++) {'
      + '\n  const card = slide.shapes.addGeometricShape('
      + 'PowerPoint.GeometricShapeType.roundRectangle,'
      + ' { left: 60 + i * (W + GAP), top: TOP, width: W, height: 150 });'
      + '\n  card.fill.setSolidColor("F4F6F8");'
      + '\n  card.textFrame.textRange.text = titles[i];'
      + '\n}'
      + '\nreturn "已建立 4 張卡片";'
      + '\n\n【store：多支 script 之間傳資料的正確方式】'
      + 'store 在同一個對話裡會一直存在，而且**完全不經過你的上下文**。'
      + '先算好的版面參數（每一欄的 x、每一列的 y、配色表）放進 store，下一支 script 直接讀，'
      + '不要 return 給自己再貼回去——那一趟來回正是這個工具要消滅的成本。'
      + '\n\n【回傳什麼】回傳「結論」（「已建立 40 格，表頭 5 欄」），不要回傳整份物件清單。'
      + '**把回傳控制在 2 KB 以內。**'
      + '\n\n【什麼時候不要用】單一個物件、或兩三個沒有規律的物件——那用 ppt_draw 更直接。'
      + '圖表一律用 ppt_add_chart，不要自己畫長條。'
      + '\n\n【mode】只讀就填 read；會動到簡報（新增／修改／刪除物件）就填 write，'
      + 'write 會先跳確認視窗給使用者按。誠實填——伺服器會另外掃描程式碼，'
      + '填了 read 卻含寫入動作，一樣會跳確認視窗。',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript 程式碼（一個 async function 的內容，用 return 交出結果）',
        },
        mode: {
          type: 'string',
          enum: ['read', 'write'],
          description: 'read=只讀不改；write=會改動簡報，需要使用者確認',
        },
        explain: {
          type: 'string',
          description: '一句話說明這段程式要做什麼，會直接顯示給使用者（確認視窗上就是這句），請寫人話。',
        },
      },
      required: ['code', 'mode', 'explain'],
      additionalProperties: false,
    },
  },
{
    name: 'ppt_draw',
    description:
      '一次畫一整批物件：矩形、文字、線條，各自帶座標和顏色。'
      + '\n\n【這是讓版面真正自由的工具】'
      + '其他工具都是**模組**——ppt_add_kpi 給資料排成數字卡、ppt_add_table 排成表，'
      + '格式是固定的。好用，但也是天花板：能做的事只剩「挑模組、填資料」。'
      + '\n\n真正好的看板不是這樣做的，它們是一塊一塊畫出來的——'
      + '表格是一格一格的矩形、卡片是底板加色條加三層字、區塊之間還有箭頭和小結論。'
      + '所以能做到四個區塊再各自拆細，因為沒有模組在限制粒度。'
      + '\n\n**模組是捷徑，不是上限。** 合適就用 ppt_add_table；'
      + '不合適（要特殊欄寬、某幾格要獨立配色、要在表格中間插一條分隔）就自己畫。'
      + '\n\n投影片是 960×540 點。一次最多 120 個物件——'
      + '六十幾個物件的看板很正常，那正是這個工具存在的理由。'
      + '\n\n每個物件：'
      + '\n· `rect`：底板、卡片、表格的每一格、色條。給 text 的話字就在框裡。'
      + '\n· `text`：純文字，沒有底色（給了 fill 就有）。'
      + '\n· `line`：分隔線、底線。'
      + '\n· 其他形狀用 `shape` 指定（Ellipse、RightArrow、Chevron）。'
      + '\n\n先用 ppt_plan_slide 把每塊的座標定下來，再照著畫——'
      + '規劃有座標、畫的時候照著放，才排不歪也不重疊。',
    inputSchema: {
      type: 'object',
      properties: {
        slide: { type: 'number', description: '第幾頁，從 1 開始。預設目前這一頁。' },
        theme: { type: 'string', description: '沒給顏色的物件用哪一套配色。' },
        font: { type: 'string', description: '整批的預設字型。' },
        shapes: {
          type: 'array',
          description: '要畫的物件，照順序疊上去（後面的蓋前面的）。',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', enum: ['rect', 'text', 'line'], description: '預設 rect。' },
              shape: { type: 'string', description: '非矩形時指定，例如 Ellipse、RightArrow、Chevron。' },
              left: { type: 'number' }, top: { type: 'number' },
              width: { type: 'number' }, height: { type: 'number' },
              fill: { type: 'string', description: '底色。給 null 或空字串就透明。' },
              line_color: { type: 'string' }, line_width: { type: 'number' },
              weight: { type: 'number', description: 'line 的粗細。' },
              text: { type: 'string' },
              size: { type: 'number', description: '字級，預設 11。' },
              bold: { type: 'boolean' },
              color: { type: 'string', description: '字色（line 的話是線色）。' },
              align: { type: 'string', enum: ['left', 'center', 'right'] },
              valign: { type: 'string', enum: ['top', 'middle', 'bottom'] },
              font: { type: 'string' },
              wrap: { type: 'boolean', description: '預設會換行。false 的話字超出就裁掉。' },
            },
          },
        },
      },
      required: ['shapes'],
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
        shape: {
          type: 'string',
          enum: ['Rectangle', 'RoundRectangle', 'Ellipse', 'Chevron', 'RightArrow',
            'Triangle', 'Diamond', 'Donut', 'Frame', 'Plus', 'Star5', 'Hexagon',
            'Pentagon', 'Trapezoid', 'HomePlate', 'Wave', 'Arc', 'Pie', 'Teardrop',
            'Cloud', 'Heart', 'Moon'],
          description:
            '圖形類型，預設 Rectangle。**只有列舉裡的名字有效。**'
            + '圓形是 `Ellipse`（不是 Oval）、箭頭是 `RightArrow` 或 `Chevron`、'
            + '梯形方向鍵是 `HomePlate`。名字打錯的話會退回矩形。',
        },
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
    description:
      '刪掉投影片上的物件。編號來自 ppt_read_slide。復原鍵拿不回來。'
      + '\n\n**要刪很多個就一次給完，不要一個一個刪。** 刪除每次都會跳出確認卡，'
      + '分成八次呼叫就是八張確認卡要使用者按八次「允許」——'
      + '按到第三次就沒人在看內容了，那個確認等於白做。'
      + '\n- 刪幾個指定的：`shapes: [3, 5, 8]`'
      + '\n- 整張清空重做：`all: true`'
      + '\n\n編號會在刪除後位移，但這個工具內部會處理，你照 ppt_read_slide 讀到的編號給就好。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        shapes: {
          type: 'array',
          items: { type: 'number' },
          description: '要刪的物件編號，一次給完。',
        },
        shape: { type: 'number', description: '只刪一個的時候用。' },
        all: { type: 'boolean', description: '清空這張投影片上的所有物件。要重做一整張的時候用。' },
        ...SLIDE_ARG,
      },
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
    name: 'ppt_add_table',
    description:
      '【預設請改用 ppt_draw 自己畫】這個模組的格式是固定的，用了它這一頁就會長得跟上一頁一樣——而「每份簡報都長一樣」正是使用者最不滿的地方。' + '表格自己畫才做得出該有的細節（色條、三層字級、某幾格獨立配色）。只有在格式剛好合適、而且這一頁其他部分已經夠有設計感的時候才用它。' +
      '在投影片上排一張表格。用方塊拼成的——PowerPointApi 沒有建立表格的方法。'
      + '\n\n【這是讓一頁變豐富最有效的工具，不要忘了它】'
      + '多個項目的多個欄位（面向／採用／成效／落差）用表格，條列講不出欄與欄的對應關係。'
      + '一頁如果全是卡片和圖，加一張表就會從「堆了幾個區塊」變成「有人規劃過」。'
      + '\n\n**每一格的底色和字色都能單獨控制**，所以做得出真正好讀的表：'
      + '表頭深底白字、斑馬紋淡到幾乎看不見、負數自動標紅、最後一列是平均就再深一階。'
      + '負數（-30、−35.7、(12)、▼）會自動用警示色，不用自己標。'
      + '\n\n上限是 8 欄 12 列。超過的話那是文件不是投影片——挑重點或拆兩頁。'
      + '\n\n使用者不能用表格工具改它，要直接點進某一格改字。這件事工具回報時會講，'
      + '你不用再提醒一次。',
    inputSchema: {
      type: 'object',
      properties: {
        slide: { type: 'number', description: '第幾頁，從 1 開始。預設目前這一頁。' },
        rows: {
          type: 'array',
          description: '二維陣列，第一列通常是欄名。',
          items: { type: 'array', items: { type: 'string' } },
        },
        header: { type: 'boolean', description: '第一列是不是欄名，預設 true。' },
        total_row: { type: 'boolean', description: '最後一列是合計或平均，底色再深一階。' },
        numeric_columns: {
          type: 'array',
          description: '哪幾欄是數字（從 1 開始），會靠右對齊。數字不靠右就對不齊。',
          items: { type: 'number' },
        },
        widths: {
          type: 'array',
          description: '各欄寬度的比例或點數。不給就第一欄寬一點、其餘平分。',
          items: { type: 'number' },
        },
        left: { type: 'number' }, top: { type: 'number' }, width: { type: 'number' },
        row_height: { type: 'number', description: '列高，預設 26。' },
        size: { type: 'number', description: '字級，預設 11。' },
        header_fill: { type: 'string' }, header_text: { type: 'string' },
        band_fill: { type: 'string' }, total_fill: { type: 'string' },
        text_color: { type: 'string' }, warn_color: { type: 'string' },
        look: { type: 'string', description: '配色風格，跟其他工具同一套。' },
      },
      required: ['rows'],
      additionalProperties: false,
    },
  },
{
    name: 'ppt_add_cards',
    description:
      '【預設請改用 ppt_draw 自己畫】這個模組的格式是固定的，用了它這一頁就會長得跟上一頁一樣——而「每份簡報都長一樣」正是使用者最不滿的地方。' + '卡片自己畫才做得出該有的細節（色條、三層字級、某幾格獨立配色）。只有在格式剛好合適、而且這一頁其他部分已經夠有設計感的時候才用它。' +
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
        ...LOOK_ARG,
      },
      required: ['cards'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_add_kpi',
    description:
      '【預設請改用 ppt_draw 自己畫】這個模組的格式是固定的，用了它這一頁就會長得跟上一頁一樣——而「每份簡報都長一樣」正是使用者最不滿的地方。' + '數字卡自己畫才做得出該有的細節（色條、三層字級、某幾格獨立配色）。只有在格式剛好合適、而且這一頁其他部分已經夠有設計感的時候才用它。' +
      '一排數據卡：大數字 + 標籤 + 小註，每張卡頂一條自己的色條。'
      + '\n\n【這是讓版面「有東西」最快的方法】一頁只有圖表和文字，下半部就會空。'
      + '把三到四個關鍵數字排成一列放在圖表上方或下方，版面立刻有上下層次，'
      + '而且那幾個數字本來就是觀眾要記的。'
      + '\n\n跟 ppt_add_cards 的差別：卡片裝**一句話**，數據卡裝**一個數字**。'
      + '要放句子用 ppt_add_cards，要放 65%、$37B、5.1 個月 這種就用這個。'
      + '\n\n最多 5 個，三到四個最好看。每張會自動配不同顏色——'
      + '一排同色是表格，一排不同色才是儀表板。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLIDE_ARG,
        items: {
          type: 'array',
          description: '每個數據卡。value 是那個數字，label 是它是什麼，note 是來源或比較基準。',
          items: {
            type: 'object',
            properties: {
              value: { type: 'string', description: '大數字，例如「65%」「$37B」「5.1 個月」。' },
              label: { type: 'string', description: '這個數字是什麼，例如「組織已導入 GenAI」。' },
              note: { type: 'string', description: '小字註解，例如資料來源或比較基準。' },
              color: { type: 'string', description: '這張卡的色條顏色，省略就自動配。' },
            },
            required: ['value'],
            additionalProperties: false,
          },
        },
        top: { type: 'number', description: '這一列的 y 座標，預設 124（內文區頂端）。' },
        left: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number', description: '卡片高度，預設 101。' },
        ...THEME_ARG,
        ...LOOK_ARG,
      },
      required: ['items'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_add_callout',
    description:
      '一句結論，放在淺色底的框裡，左邊一條色帶。'
      + '\n\n【一頁的數字講「發生了什麼」，這個講「所以呢」】'
      + '好的簡報幾乎每一頁都有一句這樣的話。它同時做兩件事：把結論講明白，'
      + '以及給版面第三層——內容就不會浮在投影片中間。'
      + '\n\n**只寫一句**。變成條列就等於把內容換個顏色再講一次，那樣整頁就沒有結論了。'
      + '預設放在 y=430，也就是內文區的底部。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLIDE_ARG,
        text: { type: 'string', description: '那句結論。' },
        label: { type: 'string', description: '前面的小標，例如「洞察」「重點」「風險」。可省略。' },
        top: { type: 'number', description: '預設 430（內文區底部）。' },
        left: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number', description: '預設 46。字多就加高。' },
        color: { type: 'string' },
        ...THEME_ARG,
        ...LOOK_ARG,
      },
      required: ['text'],
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
      + '\n\n【用 slide 指定放在哪一張】省略的話放在**最後一張**，也就是你剛做好的那張。'
      + '做一整套簡報時每張圖都要帶上它自己的 slide，否則整份的圖會疊在同一張上。'
      + '\n\n【單一系列給一維陣列，多系列給二維】values: [10,20,30] 或 [[10,20],[30,40]]。'
      + '\n\n【一頁可以放兩張】呼叫兩次，自己給座標：'
      + '\n左邊 `left: 38, width: 430`、右邊 `left: 492, width: 430`，高度都給 300。'
      + '「現況 vs 目標」「量 vs 金額」本來就是要並排看的，拆成兩頁反而對照不起來。'
      + '\n\n【別忘了 radar】兩個對象在同幾個面向上的強弱，用雷達圖一眼就看得出輪廓，'
      + '做成兩組長條圖要讀者自己在腦中疊起來。能力盤點、成熟度評估、競品比較都適合。'
      + '\n【甘特圖】type: "gantt"，資料走 `tasks`，不是 categories/values：'
      + '\n`[{ name: "需求確認", group: "MVP", start: "2026-10-13", end: "2026-10-24" }]`。'
      + '日期一律 YYYY-MM-DD，`end` 可以換成 `days`。`group` 會變成背景色帶，用來分階段；'
      + '`today` 給今天的日期就會畫一條線，不在範圍內會自動略過。'
      + '\n**不要用 mermaid 的 gantt 語法畫時程**——它把任務名畫在長條上，'
      + '真實的排程一定會互相重疊，日期也會全部擠在一起。'
      + '\n【數學的圖用 plot】type: "plot"，資料走 `curves`：'
      + '`[{ name: "N log N", points: [[256, 2048], [1024, 10240]] }]`，'
      + '每條線至少兩個點，points 是 [x, y]。'
      + '\n**跟其他圖的差別是 X 軸是真的數值軸，不是分類軸。**'
      + '函數曲線、量測數據、複雜度比較、頻率響應都要用這個——'
      + 'N² 跟 N log N 畫在平均刻度上，那張圖唯一要講的「差距越拉越開」正好被藏起來。'
      + '\n跨好幾個數量級就開 `log_y`（或 `log_x`），不然會變成一條平線加一根尖刺。'
      + '記得給 `x_axis` 和 `y_axis`：數值軸不會自己說明自己。'
      + '`dashed: true` 畫虛線，`dots: true` 標出實際量到的點。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLIDE_ARG,
        type: {
          type: 'string',
          enum: ['column', 'bar', 'line', 'area', 'pie', 'donut',
            'waterfall', 'funnel', 'radar', 'timeline', 'gantt', 'plot', 'map',
            'scatter', 'stacked', 'stacked100', 'box'],
          description:
            'column 直條（比大小，最常用）、bar 橫條（分類名稱長的時候用）、'
            + 'line 折線（看趨勢）、area 區域、pie 圓餅（看佔比，最多 5 項）、'
            + 'donut 甜甜圈（可在中間放一個關鍵數字）。預設 column。'
            + '\n\n【這四種是長條圖畫不出來的問題，遇到就用，不要硬塞直條圖】'
            + '\n- **waterfall 瀑布**：一個數字怎麼從 A 變成 B。'
            + '「營收從 100 到 128，中間發生了什麼」用這個。'
            + '每一根從上一根結束的地方接上去，所以整條路徑是看得到的形狀，'
            + '不是要讀者自己心算。合計那幾根用 `total: [0, 4]` 標出來（索引），'
            + '或在分類名稱前面加 `=`。'
            + '\n- **funnel 漏斗**：每一關剩下多少。轉換率和流失率會自動算在段與段之間，'
            + '那才是重點——形狀變窄是讀者本來就知道的事。'
            + '\n- **radar 雷達**：一個對象在好幾個面向上的強弱，或兩個對象比較。'
            + '至少三個面向，最多畫三個系列。'
            + '注意：雷達圖上不同軸之間的面積是不能互相比較的，只拿來看輪廓。'
            + '\n- **scatter 散佈**：兩個數字有沒有關係。「規模越大、成熟度越高」這種主張，'
      + '只有它表達得出來，而且它誠實——點散成一團就是沒有關係，句子不會這樣承認。'
      + '用 `points: [{ x, y, label, group }]`，**`x_axis` 和 `y_axis` 一定要給**，'
      + '不然就只是兩個沒有名字的數字。'
      + '\n- **stacked 堆疊長條**：總量在變，組成也在變。並排長條看得出各自高低、'
      + '看不出總和——讀者得在腦中把三根加起來。堆疊把總和變成柱高、組成變成柱裡的分段。'
      + '`stacked100` 是百分比堆疊，每根等高、只看組成；'
      + '**總量本身有意義的時候不要用它**，那會把成長藏起來。'
      + '\n- **box 箱型圖**：每一組的分布，不只是平均。兩間廠交期平均一樣，'
      + '一間穩定五到七天、一間在兩天和二十天之間擺盪——長條圖把它們畫成一樣高，'
      + '而變異通常才是會議真正要談的事。給每組原始數值 `values: [[...], [...]]`，'
      + '四分位和離群值會自己算。'
      + '　**但多數聽眾看不懂箱型圖。** 場合夠技術、或分布本身就是結論才用；'
      + '只是要比四個數字就用長條圖——簡報要的是被看懂，不是正確。'      + '\n- **map 地圖**：地區填色圖。內建世界（161 國）、中國（33 省）、台灣（18 縣市）。'
      + '用 `map` 選哪一份、`categories` 給地區名、`values` 給數字。'
      + '世界地圖用英文名（China、Taiwan、United States of America），'
      + '中國和台灣用中文名（广东、台北）。'
      + '\n　**兩種用法。** 給 `values` 是深淺圖（哪裡多、哪裡少）；'
      + '**只給 `categories` 不給 `values` 就是標示圖**——「這幾個地方」，'
      + '被點名的用強調色、其餘留白。歷史、據點、市場範圍、事件發生地都是後者，'
      + '那種題目本來就沒有「每個地區一個數字」，而那正是最常需要地圖的場合。'
      + '\n　**地圖只回答「哪裡多、哪裡少」。** 沒有人能從深淺讀出精確數字，'
      + '所以要比排名就用 `bar`，地圖是給「分布」用的。'
      + '沒給值的地區會畫成最淺色（代表沒有資料），不會消失。'
      + '\n- **timeline 時間軸**：事件照時間排。用 `events` 而不是 categories/values：'
            + '`[{ at: 2024, label: "試點", note: "兩條產線", highlight: true }]`。'
            + '`at` 給數字就照實際間隔放（三月兩件、十一月一件的疏密才是重點），'
            + '給文字就平均排開。',
        },
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
          description: 'box 專用，資料已經算好的時候用：'
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
        title: { type: 'string', description: '圖表標題。' },
        categories: { type: 'array', items: { type: 'string' }, description: 'X 軸分類，例如 ["Q1","Q2","Q3"]。' },
        values: { type: 'array', description: '數值。單系列給 [10,20,30]，多系列給 [[10,20],[30,40]]。' },
        series: { type: 'array', items: { type: 'string' }, description: '多系列時每個系列的名稱，會做成圖例。' },
        colors: { type: 'array', items: { type: 'string' }, description: '每個系列的顏色。不給就用配色。' },
        data_labels: { type: 'boolean', description: '長條上是否標數字，預設 true。' },
        labels: { type: 'boolean', description: 'scatter 專用：設 false 不標點的名稱。超過 12 點本來就不標。' },
        area: { type: 'boolean', description: 'line 專用：線下方填色。' },
        tasks: {
          type: 'array',
          description: 'gantt 專用：每一列 `{ name, start, end, group, done, milestone }`，'
            + '日期用 YYYY-MM-DD。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '工作名稱。' },
              start: { type: 'string', description: '開始日，YYYY-MM-DD。' },
              end: { type: 'string', description: '結束日，YYYY-MM-DD。' },
              group: { type: 'string', description: '階段名稱，相鄰的同名會併成一段。' },
              done: { type: 'number', description: '完成比例 0～1，畫成長條裡的深色段。' },
              milestone: { type: 'boolean', description: '設 true 畫成菱形里程碑，不用 end。' },
            },
            required: ['name', 'start'],
            additionalProperties: false,
          },
        },
        today: { type: 'string', description: 'gantt 專用：畫一條「今天」的線，YYYY-MM-DD。' },
        center: { type: 'string', description: 'donut 中間的大字，例如「70%」。' },
        center_label: { type: 'string', description: 'donut 中間大字底下的說明。' },
        ...GEOMETRY_BLOCK,
        ...THEME_ARG,
      },
      // timeline 用 events，其他用 values——所以這裡不能硬性要求 values。
      additionalProperties: false,
    },
  },
  // ── Pictures ───────────────────────────────────────────────────────────────
  {
    name: 'ppt_generate_image',
    description:
      '用公司內部的地端影像模型生一張圖，**只給背景和封面用**。'
      + '\n\n【什麼時候用這個】'
      + '\n封面、章節頁、內容頁側欄——也就是**這張圖沒有要傳達什麼特定資訊，'
      + '只是要讓這一頁好看**的時候。'
      + '\n\n【什麼時候絕對不要用】'
      + '\n- 資訊圖表、趨勢圖、任何有數字的東西 → `ppt_add_chart`'
      + '\n- 流程、架構、步驟 → `ppt_add_diagram`'
      + '\n- 概念說明、要看得懂在畫什麼的插畫 → `ppt_find_art`（內建 417 張扁平插畫）'
      + '\n這個模型的中文字畫不好，而且**圖裡的字改不了**。'
      + '任何需要文字、數字、標籤的東西一律不要交給它。'
      + '\n\n【有人的圖，膚色要寫出來】'
      + '這個模型在沒有指定的時候，常常把人畫成綠色、藍色或其他明顯不是膚色的顏色——'
      + '一張簡報裡出現一個綠皮膚的人，使用者第一個反應是「這張不能用」。'
      + '\nsubject 裡只要有人，就明確寫 natural skin tone 或 realistic human skin tone，'
      + '例如「a woman enjoying street food, natural skin tone, warm illustration」。'
      + '這一句很短，但它是「能用」和「要重畫」的差別。'
      + '\n如果這一頁其實不需要人（大多數情況都不需要），畫場景、食物、建築、物件'
      + '反而更安全也更好看——人物是這個模型最容易出錯的題材。'
      + '\n\n【怎麼下 subject】只寫「畫什麼」，**英文**，一句話。'
      + '配色、風格、構圖、留白位置都會依這份簡報的版式自動補上——'
      + '你寫得越花，反而越容易蓋掉那些設定。'
      + '\n好：`a modern automated warehouse interior`'
      + '\n不好：`一張很美的倉庫照片，藍色調，左邊留白給標題`（那些都會自動加）'
      + '\n\n【要有耐心】一張 10～20 秒，精細模式 50 秒以上。'
      + '這是單機 GPU，**一次只能算一張，不要連續呼叫**。'
      + '一份簡報最多兩到三張，再多就從簡報變成畫冊了。'
      + '\n\n回來的是一個 30 分鐘內有效的網址，接著用 `ppt_add_photo` 放上去。',
    inputSchema: {
      type: 'object',
      properties: {
        subject: {
          type: 'string',
          description: '這張圖畫什麼，英文一句話。不用寫顏色和構圖。',
        },
        style: {
          type: 'string',
          enum: ['abstract', 'flat', 'handdrawn', 'isometric', 'photo', 'gradient', 'texture'],
          description:
            '畫法。**預設 abstract，不是照片。**'
            + '\n- abstract 疊層色塊，最安全，當背景幾乎不會出錯'
            + '\n- flat 扁平向量插畫（人物、場景），跟內建插畫庫同一個調性'
            + '\n- handdrawn 手繪線稿＋淡彩'
            + '\n- isometric 等角立體方塊，適合系統、架構'
            + '\n- photo 寫實照片。**只在題目真的有實體畫面的時候用**'
            + '（現場、產品、城市）；抽象題目配照片就會變成一張無關的美圖'
            + '\n- gradient / texture 純色場、材質，適合當很安靜的底'
            + '\n\n**同一份簡報固定用一種畫法**，混用非常明顯。',
        },
        mode: {
          type: 'string',
          enum: ['hero', 'side', 'block'],
          description:
            'hero 滿版背景（1024×576，左邊會留空給標題）／side 側欄直式（768×1024）／'
            + 'block 內文區。預設 hero。放上去的時候 ppt_add_photo 要用同一個。',
        },
        look: { type: 'string', description: '這份簡報的版式，用來決定畫面的調性。' },
        theme: { type: 'string', description: '這份簡報的配色，用來決定圖的顏色。' },
        mood: { type: 'string', description: '額外的氣氛補充，英文，可省略。' },
        quality: {
          type: 'boolean',
          description: '設 true 用 24 步（約 50 秒以上）。預設 10 步就夠背景用了。',
        },
      },
      required: ['subject'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_find_art',
    description:
      '在內建的插畫庫裡找圖（417 張扁平風格向量插畫，46 個主題分類）。'
      + '\n\n【插畫跟照片解決的是不同問題】'
      + '\n照片必須**跟內容有關**才成立。一張倉庫照放在講倉儲吞吐量的頁面上很好，'
      + '放在講「流程優化」的頁面上就只是一張假裝成論點的倉庫照——'
      + '簡報看起來像模板，通常就是這個原因。'
      + '\n插畫不會有這個問題。它讀起來像圖解的親切版本：填得滿版面、給得了氣氛、'
      + '而且沒有人會把它誤認成證據。所以**照片會變成填充物的那些頁面，就改用插畫**。'
      + '\n\n【怎麼用】先用這個找，拿到網址之後用 `ppt_add_photo` 放上去，'
      + 'mode 用 `side` 或 `block`。插畫是透明背景的向量圖，**不要拿來當 hero 滿版底圖**。'
      + '\n\n【分類是英文的】用 data analytics、teamwork、security、nature 這種字去找。'
      + '找不到就不要硬塞——一張不相干的插畫比留白更糟。',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '主題關鍵字，英文。例如 data analytics、teamwork、cloud、education。',
        },
        limit: { type: 'number', description: '最多回幾筆，預設 12。' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'ppt_add_photo',
    description:
      '從網址抓一張照片放到投影片上，並且**幫你排好版**（不是單純貼上去）。'
      + '\n\n【三種模式是三種不同的用途】'
      + '\n- `hero`：滿版背景照 + 壓在上面的深色遮罩 + 白色大標。'
      + '開場、章節首頁用這個。這是「一頁滿版」最直接的做法。'
      + '\n- `side`：照片佔右邊（或左邊）40% 的滿高直欄，文字放另外 60%。'
      + '雜誌式的分割，一般內容頁套上去就會變得像有設計過。'
      + '\n- `block`：照片放在內文區裡面。給「照片本身就是證據」的那種頁面。'
      + '\n\n【去哪裡找圖】Unsplash 是免費可商用的：`https://images.unsplash.com/photo-xxxxx`。'
      + '裁切參數不用你加——這個工具會依照模式自己改寫 w/h/fit，你給照片網址就好。'
      + '\n\n【什麼時候不要用】題目純技術、純財務的時候不要硬塞風景照。'
      + '一張跟內容無關的美圖會讓整頁看起來像模板，不是像簡報。'
      + '那種情況用 `ppt_add_chart`、`ppt_add_diagram`、`ppt_add_kpi` 更專業。'
      + '\n\n【抓不到圖是正常的】圖片主機要允許跨來源讀取，公司內網的檔案通常不允許。'
      + '失敗的話不要一直換網址重試，直接請使用者把圖片拖進對話框，改用 ppt_insert_attachment。',
    destructive: false,
    inputSchema: {
      type: 'object',
      properties: {
        ...SLIDE_ARG,
        url: { type: 'string', description: '圖片的直接網址（http/https）。' },
        mode: {
          type: 'string',
          enum: ['hero', 'side', 'block'],
          description: 'hero 滿版背景／side 側欄 40%／block 放在內文區。預設 block。',
        },
        position: {
          type: 'string',
          enum: ['right', 'left'],
          description: 'side 模式下照片在哪一邊，預設 right。連續兩頁都用 side 就左右交替。',
        },
        title: { type: 'string', description: 'hero 的大標，或 side 模式下放在文字那半邊的標題。' },
        subtitle: { type: 'string' },
        eyebrow: { type: 'string', description: 'hero 大標上面的小字。' },
        caption: { type: 'string', description: '圖說。照片有出處的時候寫。' },
        scrim: {
          type: 'number',
          description:
            'hero 的遮罩濃度，0～0.9，預設 0.45。'
            + '照片很亮或很花的時候調高到 0.6，否則白字會讀不到。',
        },
        ...GEOMETRY_BLOCK,
        ...THEME_ARG,
        ...LOOK_ARG,
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
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
      + '\n【時程、沿革、里程碑都不要用這支】'
      + '\n- 有起訖日期的工作排程 → `ppt_add_chart` 的 `type: "gantt"`'
      + '\n- 一條軸上的事件（沿革、里程碑、發展史）→ `ppt_add_chart` 的 `type: "timeline"`，資料走 `events`'
      + '\nmermaid 的 `gantt` 會把任務名疊在長條上、日期擠成一團；它的 `timeline` 則是把事件平均排開，而時間軸真正要講的就是「哪裡密、哪裡疏」——平均排開正好把它抹掉。原生的那兩支會量字寬、會閃避相鄰的標籤，排不下才斷行。'
      + '\n\n【用 slide 指定放在哪一張】省略的話放在**最後一張**，也就是你剛做好的那張。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SLIDE_ARG,
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
        ...SLIDE_ARG,
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

/** The style enum minus 「photo」, with its bullet removed from the prose. */
function withoutPhoto(tool: PptToolSpec): PptToolSpec {
  const props = (tool.inputSchema.properties || {}) as Record<string, unknown>;
  const style = props.style as { enum?: string[]; description?: string } | undefined;
  if (!style?.enum?.includes('photo')) return tool;
  return {
    ...tool,
    description: tool.description
      + '\n\n【這份部署關閉了寫實照片】這個模型現在只生背景和插畫。'
      + '需要實拍畫面的話，請使用者自己放照片，不要用別的畫法去模仿照片。',
    inputSchema: {
      ...tool.inputSchema,
      properties: {
        ...props,
        style: {
          ...style,
          enum: style.enum.filter(v => v !== 'photo'),
          // The bullet AND its continuation line: the description is assembled
          // from concatenated strings, so 「photo」's explanation spills onto the
          // line after it. Leaving half of it behind would describe an option
          // the enum no longer offers, which is how a model ends up arguing for
          // a value it cannot pass.
          description: String(style.description || '').split('\n')
            .filter(line => !line.startsWith('- photo ')
              && !line.startsWith('（現場、產品、城市）'))
            .join('\n'),
        },
      },
    },
  };
}

/**
 * The tool list this run may actually use.
 *
 * ── Why the switch cuts the schema rather than the wording ──
 * Three rounds of increasingly firm paragraphs failed to stop the model using
 * 章節頁; removing the value from the enum stopped it immediately. The lesson
 * generalises: a description is advice the model weighs against everything else
 * in the turn, an enum is a wall.
 *
 * Only photography is behind the switch. A background claims nothing and an
 * illustration is visibly drawn — a photograph claims that what it shows exists,
 * and that is the only generated picture someone can mistake for a record.
 */
export function pptToolsFor(opts: { allowPhoto?: boolean } = {}): PptToolSpec[] {
  return opts.allowPhoto === false ? PPT_TOOLS.map(withoutPhoto) : PPT_TOOLS;
}

/**
 * Why this run may not draw that, in words the model can act on.
 *
 * ── Why it lives beside the schema rather than in the bridge ──
 * The schema is what stops the model ASKING; the bridge is what stops the
 * request being SERVED. Both are this switch, and they must not drift — a
 * refusal naming a style the enum no longer offers would send the model in a
 * circle. One function, so the wall and the reason are written once.
 *
 * Returns null when there is nothing to refuse.
 */
export function imageStyleRefusal(
  style: unknown,
  allowPhoto: boolean,
): string | null {
  if (allowPhoto) return null;
  if (String(style ?? '').toLowerCase() !== 'photo') return null;
  // 「不行」 gets retried; naming the alternatives does not. The 「開啟」 half
  // matters too: the model relays it, and the switch is two clicks away in a
  // menu the user may not have opened.
  return '這份部署關閉了寫實照片生成（使用者可以在 ＋ 選單裡開啟）。'
    + '改用 abstract 或 gradient 當背景，或用 flat／handdrawn 畫插畫；'
    + '真的需要實拍畫面的話，請使用者自己放照片。';
}

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
  if (name === 'ppt_add_kpi') {
    const n = Array.isArray(args.items) ? args.items.length : 0;
    return `放上 ${n} 個數據卡`;
  }
  if (name === 'ppt_add_callout') return '放上一句結論';
  if (name === 'ppt_generate_image') return `正在生圖：${String(args.subject || '')}`;
  if (name === 'ppt_find_art') return `找插畫：${String(args.query || '')}`;
  if (name === 'ppt_add_photo') {
    const m = String(args.mode || 'block');
    return m === 'hero' ? '放上滿版背景照' : m === 'side' ? '放上側欄照片' : '插入照片';
  }
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
  if (name === 'ppt_delete_shape') {
    if (args.all === true) return `清空${where(args)}上的所有物件`;
    const list: number[] = Array.isArray(args.shapes) ? args.shapes : [];
    const n = list.length + (args.shape === undefined ? 0 : 1);
    if (n > 1) return `刪除${where(args)}的 ${n} 個物件`;
    return `刪除${where(args)}第 ${list[0] ?? args.shape} 個物件`;
  }
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
    const kind = { column: '直條', bar: '橫條', line: '折線', area: '區域', pie: '圓餅',
      donut: '甜甜圈', waterfall: '瀑布', funnel: '漏斗', radar: '雷達', timeline: '時間軸',
      map: '地圖', scatter: '散佈', stacked: '堆疊', stacked100: '百分比堆疊', box: '箱型',
    }[String(args.type || 'column')] || '';
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
