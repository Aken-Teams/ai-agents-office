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
      + '可以跟寫入分開呼叫，但盡量一次把整塊的格式設完，不要一格一格設。',
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
        borders: { type: 'string', enum: ['all', 'outline', 'bottom', 'none'], description: '框線樣式' },
        column_width: { type: 'number', description: '欄寬（字元數）' },
        row_height: { type: 'number', description: '列高（點）' },
        autofit_columns: { type: 'boolean', description: '依內容自動調整欄寬' },
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
      },
      required: ['op', 'sheet'],
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
export function isDestructiveTool(name: string, args: Record<string, unknown> = {}): boolean {
  if (EXCEL_TOOLS.some(t => t.name === name && t.destructive)) return true;
  const op = String(args.op || '');
  if (name === 'excel_manage_sheet') return op === 'delete' || op === 'rename';
  if (name === 'excel_table_ops') return op === 'sort';
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

/**
 * One human-readable line describing what a call is about to do. Shown in the
 * add-in's confirmation dialog, so it must be honest and specific — "寫入 12 格"
 * is what lets someone catch an injected instruction before it lands.
 */
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
  return name;
}
