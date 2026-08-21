/**
 * excel tool spec — the SINGLE source of truth for the workbook tools.
 *
 * Imported by BOTH sides of the bridge:
 *   - excelMcp.ts (a separate subprocess) → advertises these to the Claude CLI
 *   - excelBridge.ts (in the Express process) → decides which calls need a human
 *     confirmation and how to describe them in the confirm prompt
 *
 * Deliberately dependency-free (no config/db/express imports) so the MCP
 * subprocess stays instant to boot — the CLI has a short MCP handshake window and
 * a slow server means the tools never register.
 *
 * ── Why the tools are COARSE ──
 * Every call is a full round trip: CLI → mcp subprocess → HTTP loopback → SSE →
 * Office.js in the user's Excel → HTTP back. That is the single dominant cost in
 * this design, so each tool is built to do as much as possible per call (a whole
 * rectangle, not a cell) and reads return CSV rather than JSON to keep tokens down.
 */

export interface ExcelToolSpec {
  name: string;
  /** Written FOR the model — says when to reach for it, not just what it does. */
  description: string;
  inputSchema: Record<string, unknown>;
  /**
   * true = the call mutates the user's workbook. The add-in MUST get an explicit
   * human click before executing it. The CLI runs with --permission-mode dontAsk
   * (no human in that loop), so this flag is the ONLY thing standing between an
   * injected instruction and someone's real spreadsheet.
   */
  destructive?: boolean;
}

export const EXCEL_TOOLS: ExcelToolSpec[] = [
  {
    name: 'excel_get_overview',
    description:
      '取得目前開啟活頁簿的結構：每張工作表的名稱、已使用範圍、大小，以及前幾列的內容預覽。'
      + '【每段對話一開始一定要先呼叫這個】，它很便宜，而且是你唯一能知道有哪些表、資料在哪裡的方式。'
      + '不要用 excel_read_range 去猜範圍——先看這裡。',
    inputSchema: {
      type: 'object',
      properties: {
        preview_rows: {
          type: 'number',
          description: '每張表要預覽幾列（含表頭），預設 5，最多 20。',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'excel_get_selection',
    description:
      '取得使用者目前在 Excel 裡選取的範圍（位址＋內容）。當使用者說「這一段」「這幾格」「選起來的部分」'
      + '這類指涉當下畫面的說法時使用。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'excel_read_range',
    description:
      '讀取一個矩形範圍的內容，回傳 CSV。mode=values 讀計算後的值、mode=formulas 讀公式、'
      + 'mode=both 兩者都要（要看懂模型怎麼算的就用 both）。'
      + '一次讀一整塊，不要逐格呼叫。超過上限會自動截斷並告訴你實際大小。',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', description: '工作表名稱（來自 excel_get_overview）' },
        range: { type: 'string', description: "A1 表示法，例如 'A1:D50'。省略則讀整張表的已使用範圍。" },
        mode: { type: 'string', enum: ['values', 'formulas', 'both'], description: '預設 values' },
      },
      required: ['sheet'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_run_script',
    description:
      '在使用者的 Excel 裡直接執行一段 JavaScript（Office.js），只把 return 的結果帶回來。'
      + '\n\n【什麼時候一定要用這個】要「分析」資料的時候。'
      + '一張 125 個料號 × 26 期的表有上萬格，用 excel_read_range 讀回來等於把上萬個數字塞進你的'
      + '上下文、再逐格心算，那會花好幾分鐘而且容易算錯。改成寫一段 script 讓 Excel 自己算，'
      + '回來的只有結論（「99 個料號有負值，最早在 PASSDUE」），又快又不會錯。'
      + '大量填值也一樣——一支 script 抵掉幾十次 excel_write_range 來回。'
      + '\n\n【可以用的東西】context（Excel.RequestContext；寫 ctx 也可以，兩個是同一個東西）、'
      + 'workbook（= context.workbook）、'
      + 'Excel（列舉常數用，例如 Excel.ChartType.line）、log(...)（訊息會跟結果一起回傳，除錯用）、'
      + 'store（**跨呼叫保留的暫存物件**）。'
      + '\n\n【store：多支 script 之間傳資料的正確方式】'
      + 'store 在同一個對話裡會一直存在，而且**完全不經過你的上下文**。'
      + '所以「先掃描、再寫入」要這樣做：第一支 script 算完把明細放進 store（store.rows = rows），'
      + '只 return 統計數字；第二支 script 直接讀 store.rows 寫進工作表。'
      + '不要把幾百筆資料 return 給自己再貼回去——那一趟來回會花掉幾十秒，也是這個工具本來要消滅的事。'
      + '整段程式碼是一個 async function 的內容，可以直接 await，用 return 交出結果。'
      + '\n\n【Office.js 的規矩】先 .load("欄位") 再 await context.sync() 才讀得到值；'
      + '不要在迴圈裡 sync，一次 load 一整塊再純 JS 運算。範例：'
      + '\nconst sh = workbook.worksheets.getItem("工作表1");'
      + '\nconst rng = sh.getUsedRange(); rng.load("values"); await context.sync();'
      + '\nconst rows = rng.values;   // 二維陣列，接下來都是純 JS'
      + '\nreturn { 缺料料號數: n, 最早期別: p };'
      + '\n\n【回傳什麼】回傳「結論」，不要回傳整份原始資料——那樣就退回讀一萬格的老路了。'
      + '物件／陣列會自動轉成 JSON，太大會被截斷。'
      + '**把回傳控制在 2 KB 以內**——通常是幾個數字，加上最多幾十筆重點項目。'
      + '要把幾百筆明細寫進工作表時，就在同一支 script 裡直接寫進去，不要先回傳給自己看一遍：'
      + '那等於又把資料搬進上下文，正是這個工具要避免的事。'
      + '\n\n【mode】只讀就填 read；會動到活頁簿（寫值、改格式、新增表、插圖表…）就填 write，'
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
          description: 'read=只讀不改；write=會改動活頁簿，需要使用者確認',
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
    name: 'excel_ask_user',
    description:
      '需要使用者在幾個具體做法之間選一個時，用這個工具問，不要用文字列出「1. … 2. …」再問「你要哪個」。'
      + '側邊欄會把選項變成按鈕，使用者點一下就好，不用打字描述他要哪個。'
      + '\n\n【什麼時候用】遇到真正的分歧——不同選擇會做出明顯不一樣的結果，而你沒有依據替他決定。'
      + '例如「這一列右邊有樞紐擋著刪不掉：要清空左邊的資料保留樞紐，還是先拆樞紐再刪整列？」'
      + '\n\n【什麼時候不要用】例行的判斷（欄寬、配色、要不要加粗）自己決定就好，'
      + '問太多會很煩；會改到資料的動作本來就會跳確認視窗，不需要再問一次。'
      + '一件事只問一次，不要連續問好幾輪。'
      + '\n\n回傳的是使用者選的那個選項（或他自己打的字），拿到之後直接照做，不用再確認一次。',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: '問題本身。先講清楚為什麼需要他決定（例如卡在哪），再問。',
        },
        options: {
          type: 'array',
          description: '2 到 4 個選項',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '按鈕上的字，越短越好，20 字以內' },
              detail: { type: 'string', description: '一行補充：選了會發生什麼、代價是什麼' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
      },
      required: ['question', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_search',
    description:
      '在活頁簿裡找含有某段文字的儲存格，回傳位址與內容。'
      + '要定位「客戶名稱那一欄在哪」「毛利率寫在哪一格」時用這個，'
      + '比用 excel_read_range 掃整張表便宜非常多。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的文字（不分大小寫、部分比對）' },
        sheet: { type: 'string', description: '限定某張表；省略則搜尋全部工作表' },
        max_results: { type: 'number', description: '最多回傳幾筆，預設 50' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_write_range',
    description:
      '把資料寫進一個矩形範圍。values 是二維陣列（外層是列、內層是欄）；'
      + "要寫公式就用 formulas，元素以 '=' 開頭，例如 '=SUM(B2:B10)'。"
      + '【使用者會先看到一個確認視窗，按了才會真的寫入】，所以請一次送出完整的一塊，'
      + '不要拆成很多次小寫入去疲勞轟炸使用者。寫入前請說明你要改什麼。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', description: '工作表名稱' },
        start_cell: { type: 'string', description: "左上角起點，例如 'B2'" },
        values: {
          type: 'array',
          description: '二維陣列的值（字串／數字／布林／null）。與 formulas 擇一。',
          items: { type: 'array', items: {} },
        },
        formulas: {
          type: 'array',
          description: "二維陣列的公式字串（'=' 開頭）。與 values 擇一。",
          items: { type: 'array', items: { type: 'string' } },
        },
      },
      required: ['sheet', 'start_cell'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_manage_sheet',
    description:
      '管理工作表：新增（add）、更名（rename）、刪除（delete）、切換到某張表（activate）、'
      + '調整順序（move）。要把結果放進「新的一張表」時，自己用 add 建，不要叫使用者手動建。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'rename', 'delete', 'activate', 'move'] },
        name: { type: 'string', description: 'add=新表名稱；其餘=目標工作表名稱' },
        new_name: { type: 'string', description: 'rename 用：改成什麼名字' },
        position: { type: 'number', description: 'add / move 用：放在第幾個位置（0 起算）' },
      },
      required: ['op'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_format_range',
    description:
      '設定範圍的外觀：數字格式、粗體斜體、字級字色、底色、對齊、換行、框線、欄寬列高、'
      + '合併儲存格。只給你要改的屬性即可，沒給的維持原狀。'
      + '可以跟寫入分開呼叫，但盡量一次把整塊的格式設完，不要一格一格設。'
      + '【欄寬】寫完資料後對整塊用 autofit_columns=true 就好，不要自己算 column_width。'
      + '【換行】wrap_text 會讓列變高；開了 wrap_text 就一起開 autofit_rows=true，'
      + '否則列高會停在很誇張的高度。要換行的長文字欄建議自己給 column_width（例如 40），'
      + '因為 Excel 對有換行的欄不會自動加寬，只會把列拉高。',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string' },
        range: { type: 'string', description: "A1 表示法，例如 'A1:E1'" },
        number_format: { type: 'string', description: "數字格式字串，例如 '#,##0'、'0.0%'、'yyyy-mm-dd'" },
        bold: { type: 'boolean' },
        italic: { type: 'boolean' },
        font_size: { type: 'number' },
        font_color: { type: 'string', description: "十六進位色碼，例如 '#FF0000'" },
        fill_color: { type: 'string', description: "底色十六進位色碼；'none' 可清除" },
        h_align: { type: 'string', enum: ['Left', 'Center', 'Right', 'General'] },
        v_align: { type: 'string', enum: ['Top', 'Center', 'Bottom'] },
        wrap_text: { type: 'boolean' },
        font_name: { type: 'string', description: "字體，例如 'Calibri'、'Microsoft JhengHei'、'Consolas'（數字對齊用等寬）" },
        borders: { type: 'string', enum: ['all', 'outline', 'bottom', 'top', 'none'], description: '要畫哪些邊' },
        border_color: { type: 'string', description: "框線色碼，例如 '#D0D0D0'。淺灰的細框線比預設黑框乾淨很多。" },
        border_weight: { type: 'string', enum: ['Hairline', 'Thin', 'Medium', 'Thick'], description: '框線粗細，預設 Thin' },
        border_style: { type: 'string', enum: ['Continuous', 'Dash', 'Dot', 'Double'], description: '框線樣式，預設 Continuous' },
        indent: { type: 'number', description: '縮排層級（0-15）。用來做階層感，比塞空白字元乾淨。' },
        column_width: { type: 'number', description: '欄寬，單位是「字元數」（跟 Excel 介面一致，預設約 8.4）。一般文字欄 15～25，長句子欄 40～60。' },
        row_height: { type: 'number', description: '列高（點），預設 15' },
        autofit_columns: { type: 'boolean', description: '依整欄內容自動調整欄寬。【優先用這個，不要自己猜欄寬數字】' },
        autofit_rows: { type: 'boolean', description: '依內容自動調整列高。開了 wrap_text 就要一起開，否則列會過高。' },
        merge: { type: 'boolean', description: 'true=合併這個範圍，false=取消合併' },
      },
      required: ['sheet', 'range'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_create_chart',
    description:
      '用某個範圍的資料建立圖表。data_range 要含標題列／類別欄，圖表才有圖例和座標軸標籤。'
      + 'anchor_cell 決定圖表放在哪裡（左上角），省略就放在資料右邊。',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', description: '圖表要放在哪張工作表' },
        data_range: { type: 'string', description: "資料範圍，可跨表，例如 '圖表分析!A4:E11'" },
        chart_type: {
          type: 'string',
          enum: ['ColumnClustered', 'ColumnStacked', 'BarClustered', 'BarStacked',
                 'Line', 'LineMarkers', 'Pie', 'Doughnut', 'XYScatter', 'Area', 'Radar'],
        },
        title: { type: 'string' },
        series_by: { type: 'string', enum: ['Auto', 'Columns', 'Rows'], description: '資料數列的方向，預設 Auto' },
        anchor_cell: { type: 'string', description: "圖表左上角放在哪一格，例如 'G2'" },
        width: { type: 'number', description: '寬度（點），預設 360' },
        height: { type: 'number', description: '高度（點），預設 220' },
        legend_position: {
          type: 'string',
          enum: ['Top', 'Bottom', 'Left', 'Right', 'None'],
          description: "圖例位置。單一數列時用 'None'（圖例只會佔位置），多數列建議 'Bottom'。",
        },
        show_data_labels: { type: 'boolean', description: '直接在資料點上標數值。長條圖和圓餅圖很適合，折線圖點多時不要開。' },
        chart_style: { type: 'number', description: 'Excel 內建圖表樣式編號（1-48）。不確定就別給。' },
      },
      required: ['sheet', 'data_range', 'chart_type'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_structure_op',
    description:
      '插入／刪除整列整欄，或清除範圍內容。'
      + '【會移動既有資料，使用者要確認】。刪除之後沒辦法用「復原上一步」救回來，'
      + '所以動手前要確定範圍是對的。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'clear'] },
        sheet: { type: 'string' },
        index: { type: 'number', description: '插入／刪除的起始位置（列或欄，1 起算）' },
        count: { type: 'number', description: '幾列／幾欄，預設 1' },
        range: { type: 'string', description: "clear 用：要清掉的範圍，例如 'B2:D10'" },
        clear_what: { type: 'string', enum: ['contents', 'formats', 'all'], description: 'clear 用，預設 contents' },
      },
      required: ['op', 'sheet'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_clean_data',
    description:
      '資料清理：去重、統一寫法、補空白、拆欄、併欄。'
      + '\n\n【匯出來的原始資料要先過這一關】。這些事用 excel_run_script 也做得到，'
      + '但這支工具會先算好「會刪掉幾列、會改幾格」再讓使用者確認，'
      + 'script 的確認視窗只能給他看一段程式碼，他看不出來你要動什麼。'
      + '\n\nop：'
      + '\n· dedupe 去掉重複的資料列。key_columns 指定只看哪幾欄算重複（例如只看訂單編號）；'
      + '不指定就是整列一模一樣才算。比對時會忽略頭尾空白。'
      + '範圍裡有公式會被拒絕——搬動資料列會讓相對參照指到別的列。'
      + '\n· normalize 統一寫法：去空白、全形轉半形、大小寫、文字數字轉成真數字（1,234 / (500) / 12%）、'
      + '文字日期轉成真日期（含民國年 113/1/5）。【使用者抱怨「加總是 0」「排序怪怪的」通常就是這個】——'
      + '那些格子是文字不是數字。'
      + '\n· fill 補空白：method=down 承接上一列的值（合併儲存格匯出的資料就長這樣），'
      + 'method=value 填固定值。'
      + '\n· split 拆欄：range 要同時含來源欄和放結果的欄，例如 B2:D50 是把 B 用分隔符號拆進 B、C、D。'
      + '先用 excel_get_overview 確認右邊那幾欄是空的。'
      + '\n· merge_columns 併欄：把 range 各欄併進最左邊那一欄，空的欄會跳過不留連續分隔符號。'
      + '\n\n全部都只改一個矩形、不插入也不刪除整列整欄，所以使用者按「復原上一步」可以完整退回。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['dedupe', 'normalize', 'fill', 'split', 'merge_columns'] },
        sheet: { type: 'string' },
        range: { type: 'string', description: "要清理的範圍，例如 'A1:F500'。省略則整張表的已使用範圍。" },
        has_headers: { type: 'boolean', description: '第一列是不是標題列，預設 true（標題列不會被動到）' },
        columns: {
          type: 'array',
          items: { type: 'number' },
          description: 'normalize / fill 用：只處理範圍內第幾欄（0 起算）。不給就是全部。',
        },
        key_columns: {
          type: 'array',
          items: { type: 'number' },
          description: 'dedupe 用：以哪幾欄判斷重複（0 起算，相對於 range）。不給就是比對整列。',
        },
        trim: { type: 'boolean', description: 'normalize 用：去頭尾空白並壓縮中間連續空白，預設 true' },
        collapse_spaces: { type: 'boolean', description: 'normalize 用，預設 true' },
        half_width: { type: 'boolean', description: 'normalize 用：全形英數符號轉半形' },
        letter_case: { type: 'string', enum: ['none', 'upper', 'lower'], description: 'normalize 用，預設 none' },
        to_number: { type: 'boolean', description: 'normalize 用：像數字的文字轉成數字。前導零的代號與 15 位以上數字會保留為文字。' },
        to_date: { type: 'boolean', description: 'normalize 用：像日期的文字轉成日期（y/m/d、y-m-d、民國年）' },
        method: { type: 'string', enum: ['down', 'value'], description: 'fill 用，預設 down' },
        fill_value: { description: 'fill + method=value 用：要填什麼，預設 0' },
        delimiter: { type: 'string', description: "split 用：分隔符號，預設 ','" },
        separator: { type: 'string', description: "merge_columns 用：接起來時中間放什麼，預設 ''" },
        keep_source: {
          type: 'boolean',
          description: 'split：來源欄保持原樣，結果從右邊一欄開始放（預設 false＝像 Excel 的資料剖析那樣取代來源）。'
            + 'merge_columns：併完之後保留原本各欄（預設 false＝清掉）。',
        },
      },
      required: ['op', 'sheet'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_table_ops',
    description:
      '排序、篩選、建立 Excel 表格物件、凍結窗格、設定條件式格式（色階／資料橫條／highlight）。'
      + '排序會實際移動資料列，所以要使用者確認。',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['sort', 'autofilter', 'create_table', 'freeze_panes', 'conditional_format'] },
        sheet: { type: 'string' },
        range: { type: 'string', description: '要操作的範圍（含標題列）' },
        sort_column: { type: 'number', description: 'sort 用：以範圍內第幾欄排序（0 起算）' },
        ascending: { type: 'boolean', description: 'sort 用，預設 true' },
        has_headers: { type: 'boolean', description: 'sort / create_table 用，預設 true' },
        filter_column: { type: 'number', description: 'autofilter 用：第幾欄套篩選（0 起算）' },
        filter_values: { type: 'array', items: { type: 'string' }, description: 'autofilter 用：要留下哪些值' },
        freeze_rows: { type: 'number', description: 'freeze_panes 用：凍結前幾列' },
        freeze_columns: { type: 'number', description: 'freeze_panes 用：凍結前幾欄' },
        format_type: {
          type: 'string',
          enum: ['ColorScale', 'DataBar', 'GreaterThan', 'LessThan', 'ContainsText', 'TopBottom'],
          description: 'conditional_format 用',
        },
        threshold: { type: 'number', description: 'GreaterThan / LessThan / TopBottom 用的門檻值' },
        text: { type: 'string', description: 'ContainsText 用的字串' },
        table_name: { type: 'string', description: 'create_table 用：表格名稱' },
        table_style: {
          type: 'string',
          description: "create_table 用：Excel 內建表格樣式，例如 'TableStyleMedium2'（藍）、"
            + "'TableStyleMedium7'（灰藍）、'TableStyleLight9'。套了就自帶隔行底色與標題樣式，"
            + '比自己一格一格塗快也整齊。',
        },
      },
      required: ['op', 'sheet'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_create_pivot',
    description:
      '建立真正的樞紐分析表（使用者可以自己拖欄位、換維度、展開收合的那種活物件）。'
      + 'rows／columns／values 裡填的是**來源資料標題列的欄位名稱**，不是儲存格位址。'
      + '注意：如果使用者只是要一份「彙總好的表」，直接算完用 excel_write_range 寫進去更快也更好讀；'
      + '只有他明確想要一個可以自己操作的樞紐時才用這個。',
    destructive: true,
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string', description: '樞紐要放在哪張工作表' },
        source_range: { type: 'string', description: "來源資料（含標題列），例如 '需求列表清單!A1:M36'" },
        destination_cell: { type: 'string', description: "樞紐左上角放哪，例如 'A3'" },
        name: { type: 'string', description: '樞紐名稱（同一份活頁簿不可重複）' },
        rows: { type: 'array', items: { type: 'string' }, description: '放在「列」的欄位名稱' },
        columns: { type: 'array', items: { type: 'string' }, description: '放在「欄」的欄位名稱' },
        values: {
          type: 'array',
          description: '放在「值」的欄位與彙總方式',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              summarize_by: {
                type: 'string',
                enum: ['Sum', 'Count', 'Average', 'Max', 'Min', 'CountNumbers'],
                description: '預設 Sum',
              },
            },
            required: ['field'],
            additionalProperties: false,
          },
        },
        filters: { type: 'array', items: { type: 'string' }, description: '放在「篩選」的欄位名稱' },
      },
      required: ['sheet', 'source_range', 'destination_cell', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_sheet_style',
    description:
      '工作表層級的外觀：關掉格線、隱藏欄列標題、設定分頁標籤顏色、設定預設欄寬。'
      + '【要做儀表板、行事曆、報表封面這類「看起來不像試算表」的東西，'
      + '第一步就是 show_gridlines=false】——那條格線是「這是一張試算表」最強的視覺訊號，'
      + '關掉之後你自己畫的底色區塊和框線才會變成版面。'
      + '純資料表就不要關，使用者需要格線對位。',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string' },
        show_gridlines: { type: 'boolean', description: 'false = 關掉格線' },
        show_headings: { type: 'boolean', description: 'false = 隱藏 A/B/C 與 1/2/3 標題列' },
        tab_color: { type: 'string', description: "分頁標籤顏色，例如 '#107C41'" },
        standard_width: { type: 'number', description: '這張表的預設欄寬（字元數）。做行事曆這種等寬格子時很有用。' },
      },
      required: ['sheet'],
      additionalProperties: false,
    },
  },
  {
    name: 'excel_trace_precedents',
    description:
      '追一格公式是從哪些儲存格算出來的，回傳每個前導格的位址、目前的值和它自己的公式。'
      + "mode='direct' 只看直接參照（預設）、mode='all' 會一路追到底（可跨工作表）。"
      + '使用者問「這個數字怎麼來的」「為什麼是這個值」「這格在算什麼」時用它，'
      + '不要自己讀公式然後用猜的推論。',
    inputSchema: {
      type: 'object',
      properties: {
        sheet: { type: 'string' },
        cell: { type: 'string', description: "單一儲存格，例如 'C42'" },
        mode: { type: 'string', enum: ['direct', 'all'], description: '預設 direct' },
      },
      required: ['sheet', 'cell'],
      additionalProperties: false,
    },
  },
];

export const EXCEL_TOOL_NAMES = EXCEL_TOOLS.map(t => t.name);

/** MCP tool names as the CLI sees them — must match --allowedTools entries. */
export const EXCEL_MCP_TOOL_NAMES = EXCEL_TOOL_NAMES.map(n => `mcp__excel__${n}`);

/**
 * Does this call need a human to approve it first?
 *
 * The line is **can it lose data**, not "does it change anything". Confirming
 * every cosmetic tweak trains people to click 允許 without reading, which is
 * exactly how a prompt-injected destructive call gets waved through. So:
 *
 *   confirm     — overwriting cells, inserting/deleting rows, deleting or
 *                 renaming a sheet, sorting (it physically reorders rows)
 *   no confirm  — formatting, charts, adding a sheet, filters, freeze panes,
 *                 conditional formatting: all additive or trivially reversible
 *
 * Some tools are destructive only for certain ops, hence args.
 */
/**
 * Does this script write to the workbook?
 *
 * Used as a second opinion on the model's own `mode` declaration — see
 * isDestructiveTool. It matches Office.js's mutation surface specifically rather
 * than "any assignment", because scripts assign to their own accumulator objects
 * constantly (`acc.total = 0`) and treating that as a write would put a
 * confirmation dialog in front of every read.
 *
 * This is a heuristic and can be fooled by computed access (r["val"+"ues"] = x).
 * It is not the security boundary on its own; it exists so that a mislabelled
 * call fails safe. The boundary is the human clicking the confirmation.
 */
const SCRIPT_MUTATION_PATTERNS: RegExp[] = [
  // Assignment into a property only Office.js has. Generic names (name, title,
  // color, size, height, text…) are deliberately NOT here: analysis scripts build
  // plain objects with those keys constantly, and a confirmation dialog in front
  // of every read would train people to click through the ones that matter.
  /\.\s*(values|formulas|formulasR1C1|numberFormat|numberFormatLocal|columnWidth|rowHeight|wrapText|horizontalAlignment|verticalAlignment|indentLevel|tabColor|showGridlines|standardWidth|useSharedFormulas)\s*=(?!=)/,
  // Anything under .format — covers fill.color, font.bold, borders, and friends
  // in one pattern. Plain JS objects almost never have a `.format.` chain.
  /\.format\b[^=\n]*=(?!=)/,
  // `.add(` is scoped to Office.js collections: bare `.add(` would fire on every
  // `Set.add()` an analysis script uses to dedupe.
  /\.(worksheets|charts|tables|pivotTables|conditionalFormats|names|comments|shapes|slicers)\s*\.\s*add\s*\(/,
  /\.\s*(delete|insert|merge|unmerge|clear|clearContents|clearFormats|copyFrom|autofitColumns|autofitRows|convertToRange|applyFilter|freezePanes|freezeRows|freezeColumns|setPosition|setDynamicArray)\s*\(/,
  // Excel's sort is `range.sort.apply(...)`; a bare `.sort(` is Array.prototype.
  /\.\s*sort\s*\.\s*apply\s*\(/,
  // Excel's replaceAll takes a criteria object; String.prototype.replaceAll does
  // not. Matching on argument count fails, because `replaceAll(",", "")` — the
  // usual way to strip thousands separators — has a comma inside a string literal.
  /\.\s*replaceAll\s*\([^;]*\{/,
];

export function scriptMutatesWorkbook(code: string): boolean {
  return SCRIPT_MUTATION_PATTERNS.some(re => re.test(code));
}

export function isDestructiveTool(name: string, args: Record<string, unknown> = {}): boolean {
  if (EXCEL_TOOLS.some(t => t.name === name && t.destructive)) return true;
  const op = String(args.op || '');
  if (name === 'excel_manage_sheet') return op === 'delete' || op === 'rename';
  if (name === 'excel_table_ops') return op === 'sort';
  if (name === 'excel_run_script') {
    // Declaration AND verification. The model declares `mode`, but we also scan the
    // code independently: a call that says `read` while assigning to .values still
    // gets a confirmation. Neither signal is trusted alone, because this flag is the
    // only thing between an instruction hidden in a downloaded workbook and someone's
    // real data (the CLI runs --permission-mode dontAsk; there is no human in it).
    return String(args.mode || '') === 'write' || scriptMutatesWorkbook(String(args.code || ''));
  }
  return false;
}

const SHEET_OP_LABEL: Record<string, string> = {
  add: '新增工作表', rename: '重新命名工作表', delete: '刪除工作表',
  activate: '切換工作表', move: '搬移工作表',
};
const STRUCT_OP_LABEL: Record<string, string> = {
  insert_rows: '插入列', delete_rows: '刪除列',
  insert_columns: '插入欄', delete_columns: '刪除欄', clear: '清除內容',
};
const TABLE_OP_LABEL: Record<string, string> = {
  sort: '排序', autofilter: '套用篩選', create_table: '建立表格',
  freeze_panes: '凍結窗格', conditional_format: '設定條件式格式',
};
const CLEAN_OP_LABEL: Record<string, string> = {
  dedupe: '去除重複資料列', normalize: '統一資料寫法', fill: '補上空白格',
  split: '把一欄拆成多欄', merge_columns: '把多欄併成一欄',
};

/**
 * One human-readable line describing what a call is about to do. Shown in the
 * add-in's confirmation dialog, so it must be honest and specific — "寫入 12 格"
 * is what lets someone catch an injected instruction before it lands.
 */

/**
 * Calls that destroy data that cannot be got back.
 *
 * Separate from isDestructiveTool, which asks "does this change the workbook" —
 * nearly everything on this bridge does. This asks the narrower question the
 * confirmation card actually needs: is the undo button going to be able to help.
 *
 * The gap this closes: excel_structure_op delete_rows was classified high while
 * an excel_run_script containing sheet.getRange("371:373").delete() was not, even
 * though they are the same act through a different door — and the script is the
 * one the agent actually reaches for. Classify by what the call DOES, not by
 * which tool it arrived on.
 */
const SCRIPT_DESTROYS_DATA = /\.\s*(delete|remove|clear|clearContents)\s*\(/;

export function toolRisk(name: string, args: Record<string, unknown> = {}): 'high' | 'normal' {
  const op = String(args.op || '');
  if (name === 'excel_manage_sheet') return op === 'delete' ? 'high' : 'normal';
  if (name === 'excel_structure_op') {
    if (op === 'delete_rows' || op === 'delete_columns') return 'high';
    // Clearing formats is cosmetic; clearing contents is a delete by another name.
    if (op === 'clear') return String(args.clear_what || 'contents') === 'formats' ? 'normal' : 'high';
    return 'normal';
  }
  if (name === 'excel_run_script') return SCRIPT_DESTROYS_DATA.test(String(args.code || '')) ? 'high' : 'normal';
  return 'normal';
}

export function describeToolCall(name: string, args: Record<string, unknown>): string {
  const op = String(args.op || '');
  if (name === 'excel_write_range') {
    const grid = (args.formulas || args.values) as unknown[][] | undefined;
    const rows = Array.isArray(grid) ? grid.length : 0;
    const cols = Array.isArray(grid?.[0]) ? (grid[0] as unknown[]).length : 0;
    const kind = args.formulas ? '公式' : '值';
    return `寫入 ${args.sheet}!${args.start_cell} 起 ${rows}×${cols} 格（${kind}）`;
  }
  if (name === 'excel_read_range') return `讀取 ${args.sheet}${args.range ? `!${args.range}` : '（整張表）'}`;
  if (name === 'excel_search') return `搜尋「${args.query}」`;
  if (name === 'excel_get_overview') return '讀取活頁簿結構';
  if (name === 'excel_get_selection') return '讀取目前選取範圍';
  if (name === 'excel_manage_sheet') {
    const label = SHEET_OP_LABEL[op] || op;
    if (op === 'rename') return `${label}：${args.name} → ${args.new_name}`;
    return `${label}：${args.name ?? ''}`;
  }
  if (name === 'excel_format_range') return `設定 ${args.sheet}!${args.range} 的格式`;
  if (name === 'excel_create_chart') return `以 ${args.data_range} 建立${args.chart_type}圖表`;
  if (name === 'excel_structure_op') {
    const label = STRUCT_OP_LABEL[op] || op;
    if (op === 'clear') return `${label}：${args.sheet}!${args.range}`;
    return `${label}：${args.sheet} 第 ${args.index} 起 ${args.count ?? 1} 個`;
  }
  if (name === 'excel_table_ops') {
    return `${TABLE_OP_LABEL[op] || op}：${args.sheet}${args.range ? `!${args.range}` : ''}`;
  }
  if (name === 'excel_clean_data') {
    // Deliberately no counts here. The add-in inspects the range before drawing
    // the card and writes the real numbers — 「會刪掉 37 列重複資料」 — onto it;
    // guessing them from the arguments alone would put a number on the card that
    // nothing verified.
    return `${CLEAN_OP_LABEL[op] || op}：${args.sheet}${args.range ? `!${args.range}` : '（整張表）'}`;
  }
  if (name === 'excel_create_pivot') {
    const rows = Array.isArray(args.rows) ? (args.rows as string[]).join('、') : '';
    return `以 ${args.source_range} 在 ${args.sheet}!${args.destination_cell} 建立樞紐分析表`
      + (rows ? `（列：${rows}）` : '');
  }
  if (name === 'excel_ask_user') return String(args.question || '請你決定一件事');
  if (name === 'excel_trace_precedents') return `追蹤 ${args.sheet}!${args.cell} 的公式來源`;
  if (name === 'excel_sheet_style') return `調整工作表「${args.sheet}」的外觀`;
  if (name === 'excel_run_script') {
    // The model's own one-line explanation, and nothing else. HOW it will be done
    // (a script, this many lines) is real information but it is not the decision,
    // so it goes on its own line via describeToolMeta below. Cramming both into
    // one sentence is what produced 「將三張工作表的所有文字字型改為微軟正黑體
    // （執行程式並修改活頁簿，10 行）」.
    const explain = String(args.explain || '').trim();
    if (explain) return explain;
    return String(args.mode || '') === 'write' ? '執行程式並修改活頁簿' : '執行程式讀取資料';
  }
  return name;
}

/**
 * The technical footnote for a call: HOW, as opposed to WHAT. Rendered as small
 * print under the action in the confirmation card. Empty when there is nothing
 * worth adding, and the card then omits the line entirely.
 */
export function describeToolMeta(name: string, args: Record<string, unknown>): string {
  if (name === 'excel_run_script') {
    const lines = String(args.code || '').split('\n').length;
    const kind = String(args.mode || '') === 'write' ? '執行程式並修改活頁簿' : '執行程式讀取資料';
    return `${kind} · ${lines} 行`;
  }
  return '';
}
