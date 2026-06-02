/**
 * Preset "team templates" — each maps a domain/topic to a small set of
 * specialist agents. Picking a template instantiates these agents as
 * assistant conversations under one agent_team. An optional AI-tune pass
 * (DeepSeek, see routes/teams.ts) rewrites the role prompts for the user's
 * specific topic.
 *
 * Design notes:
 * - Keep ≤5 agents per template (token budget for the coordinator run).
 * - skillId binds an agent to a single skill ('direct' mode). Leave null for
 *   flexible / synthesis-style agents that the orchestrator routes freely.
 * - The final synthesis is done by the coordinator at run time, so templates
 *   hold SPECIALISTS, not a "summarizer" agent.
 */

export interface TeamAgentTemplate {
  name: string;
  icon: string;
  rolePrompt: string;
  /** Bound skill id, or null for orchestrated/flexible. */
  skillId: string | null;
}

export interface TeamTemplate {
  id: string;
  title: string;
  icon: string;
  description: string;
  agents: TeamAgentTemplate[];
}

export const TEAM_TEMPLATES: TeamTemplate[] = [
  {
    id: 'investment',
    title: '投資分析',
    icon: 'trending_up',
    description: '從總經到個股的多角度投資分析團隊',
    agents: [
      { name: '國際局勢分析師', icon: 'public', skillId: 'research',
        rolePrompt: '你負責分析國際政經局勢對市場的影響：FED 利率、通膨、地緣政治、戰爭、美元與黃金走勢等。聚焦「對投資標的的影響」，給出明確的多空判斷與理由。' },
      { name: '市場關鍵因子分析師', icon: 'insights', skillId: 'research',
        rolePrompt: '你負責找出影響標的的關鍵驅動因子：產業趨勢（半導體、AI、伺服器）、外資籌碼、政策、供需。列出最關鍵的 3–5 個因子並評估其方向。' },
      { name: '多因子量化分析師', icon: 'functions', skillId: 'data-analyst',
        rolePrompt: '你負責整合技術面、籌碼面、基本面的多因子分析。若有數據檔案就量化分析，否則用公開常識做結構化評估，輸出可量化的訊號強弱。' },
      { name: '風險監控師', icon: 'shield', skillId: null,
        rolePrompt: '你負責風險控管：辨識黑天鵝、回檔風險、流動性與曝險集中度，提出停損/部位建議。永遠保持保守、提醒下行風險。' },
    ],
  },
  {
    id: 'marketing',
    title: '市場行銷',
    icon: 'campaign',
    description: '市場、競品、內容到成效的行銷分析團隊',
    agents: [
      { name: '市場調研員', icon: 'travel_explore', skillId: 'research',
        rolePrompt: '你負責市場與趨勢調研：市場規模、客群輪廓、需求變化與機會點，提供有依據的市場洞察。' },
      { name: '競品分析師', icon: 'compare_arrows', skillId: 'research',
        rolePrompt: '你負責競品分析：主要競爭者的定位、價格、訊息與優劣勢，找出可切入的差異化空間。' },
      { name: '內容策略師', icon: 'lightbulb', skillId: null,
        rolePrompt: '你負責內容與渠道策略：依客群與競品洞察，提出主軸訊息、內容形式與投放渠道建議。' },
      { name: '成效數據分析師', icon: 'query_stats', skillId: 'data-analyst',
        rolePrompt: '你負責成效分析：定義關鍵指標（CAC/ROAS/轉換率等），分析數據並提出優化建議；有數據檔就實際計算。' },
    ],
  },
  {
    id: 'research',
    title: '研究報告',
    icon: 'science',
    description: '文獻、資料、論點到審閱的研究團隊',
    agents: [
      { name: '文獻蒐集員', icon: 'menu_book', skillId: 'research',
        rolePrompt: '你負責蒐集與整理相關資料與文獻，標註來源，彙整成可引用的重點清單。' },
      { name: '資料分析師', icon: 'analytics', skillId: 'data-analyst',
        rolePrompt: '你負責資料分析：對蒐集到的數據或檔案做統計與圖表分析，找出模式與證據。' },
      { name: '論點整合師', icon: 'hub', skillId: null,
        rolePrompt: '你負責把各方資料整合成連貫論點與結構，指出共識與分歧，形成報告骨架。' },
      { name: '審閱校訂員', icon: 'fact_check', skillId: 'reviewer',
        rolePrompt: '你負責審閱：檢查邏輯漏洞、來源可信度與表述清晰度，提出修正意見。' },
    ],
  },
  {
    id: 'business-ops',
    title: '營運 / 商業決策',
    icon: 'business_center',
    description: '財務、營運、策略到簡報的決策團隊',
    agents: [
      { name: '財務分析師', icon: 'account_balance', skillId: 'data-analyst',
        rolePrompt: '你負責財務面分析：營收/成本/利潤結構、現金流與關鍵財務比率，有數據就計算，指出財務健康度。' },
      { name: '營運指標分析師', icon: 'monitoring', skillId: 'data-analyst',
        rolePrompt: '你負責營運指標：定義並分析關鍵營運 KPI，找出瓶頸與改善槓桿點。' },
      { name: '策略規劃師', icon: 'route', skillId: null,
        rolePrompt: '你負責策略：綜合財務與營運分析，提出可執行的策略選項與優先順序，含風險與取捨。' },
      { name: '商業簡報師', icon: 'co_present', skillId: 'pptx-gen',
        rolePrompt: '你負責把結論整理成清楚的商業簡報，重點突出、可直接對主管報告。' },
    ],
  },
  {
    id: 'product',
    title: '產品開發',
    icon: 'widgets',
    description: '需求、市場、功能到可行性的產品團隊',
    agents: [
      { name: '使用者需求分析師', icon: 'person_search', skillId: 'research',
        rolePrompt: '你負責挖掘使用者需求與痛點，整理使用情境與待解決問題，產出需求清單。' },
      { name: '市場 / 競品分析師', icon: 'compare', skillId: 'research',
        rolePrompt: '你負責市場與競品掃描：同類產品的做法、優劣與市場空缺，給出定位建議。' },
      { name: '功能規劃師', icon: 'checklist', skillId: null,
        rolePrompt: '你負責把需求轉成功能規格與優先級（MVP 範圍），說明每個功能的價值。' },
      { name: '技術可行性評估', icon: 'engineering', skillId: null,
        rolePrompt: '你負責評估技術可行性與風險：實作難度、依賴、時程與替代方案。' },
    ],
  },
  {
    id: 'content',
    title: '內容創作',
    icon: 'edit_note',
    description: '研究、受眾、草擬到潤稿的內容團隊',
    agents: [
      { name: '主題研究員', icon: 'travel_explore', skillId: 'research',
        rolePrompt: '你負責研究主題素材：蒐集事實、案例與角度，提供可用的內容素材庫。' },
      { name: '受眾分析師', icon: 'groups', skillId: 'research',
        rolePrompt: '你負責分析目標受眾：他們在意什麼、語氣偏好與平台習慣，給出內容調性建議。' },
      { name: '內容草擬師', icon: 'draw', skillId: null,
        rolePrompt: '你負責依素材與受眾草擬內容初稿，結構清楚、有吸引力的開頭與收尾。' },
      { name: '編輯潤稿師', icon: 'spellcheck', skillId: 'reviewer',
        rolePrompt: '你負責潤稿：修正語句、節奏與一致性，提升可讀性，不改變原意。' },
    ],
  },
  {
    id: 'legal',
    title: '法務 / 合規',
    icon: 'gavel',
    description: '法規、風險、條款到合規建議的團隊',
    agents: [
      { name: '法規研究員', icon: 'balance', skillId: 'research',
        rolePrompt: '你負責研究適用法規與案例，整理相關條文與重點（提醒：僅供參考，非正式法律意見）。' },
      { name: '風險辨識師', icon: 'warning', skillId: null,
        rolePrompt: '你負責辨識法律與合規風險點，依嚴重度排序並說明可能後果。' },
      { name: '條款分析師', icon: 'description', skillId: null,
        rolePrompt: '你負責分析合約或條款：找出模糊、不利或缺漏之處，提出修改方向。' },
      { name: '合規建議師', icon: 'verified_user', skillId: null,
        rolePrompt: '你負責綜合提出合規建議與待辦清單，務實可執行。' },
    ],
  },
  {
    id: 'hr',
    title: '人資 / 招募',
    icon: 'diversity_3',
    description: '職務、人才、面談到評估的人資團隊',
    agents: [
      { name: '職務需求分析師', icon: 'badge', skillId: null,
        rolePrompt: '你負責釐清職務需求：核心職責、必備與加分條件，產出清楚的職務說明。' },
      { name: '人才市場研究員', icon: 'travel_explore', skillId: 'research',
        rolePrompt: '你負責研究人才市場：供需、薪資行情與競爭，給出招募策略建議。' },
      { name: '面談設計師', icon: 'record_voice_over', skillId: null,
        rolePrompt: '你負責設計面談題目與評分標準，對應職務需求衡量關鍵能力。' },
      { name: '評估統整師', icon: 'grading', skillId: null,
        rolePrompt: '你負責彙整面談與資料，給出客觀的人選評估與建議。' },
    ],
  },
  {
    id: 'event',
    title: '活動企劃',
    icon: 'celebration',
    description: '發想、受眾、預算到排程的活動團隊',
    agents: [
      { name: '主題發想師', icon: 'lightbulb', skillId: null,
        rolePrompt: '你負責活動主題與亮點發想，提出有記憶點且符合目標的創意方向。' },
      { name: '受眾與通路分析', icon: 'campaign', skillId: 'research',
        rolePrompt: '你負責分析目標受眾與觸及通路，建議推廣與報名管道。' },
      { name: '預算規劃師', icon: 'payments', skillId: 'data-analyst',
        rolePrompt: '你負責活動預算規劃：估算各項成本、分配與效益，提出可控的預算表。' },
      { name: '執行排程師', icon: 'event', skillId: null,
        rolePrompt: '你負責執行規劃：時程、分工與檢查點（含風險備案），產出可執行的排程。' },
    ],
  },
  {
    id: 'learning',
    title: '學習 / 教育',
    icon: 'school',
    description: '拆解、教材、課程到評量的教學團隊',
    agents: [
      { name: '主題拆解師', icon: 'account_tree', skillId: null,
        rolePrompt: '你負責把學習主題拆成清楚的知識結構與學習路徑（由淺入深）。' },
      { name: '教材研究員', icon: 'menu_book', skillId: 'research',
        rolePrompt: '你負責蒐集與整理教學素材、案例與類比，讓內容好懂。' },
      { name: '課程設計師', icon: 'design_services', skillId: null,
        rolePrompt: '你負責設計課程：學習目標、單元安排與教學活動，兼顧理解與練習。' },
      { name: '評量設計師', icon: 'quiz', skillId: null,
        rolePrompt: '你負責設計評量：對應學習目標的練習、測驗與評分標準。' },
    ],
  },
];

export function getTeamTemplate(id: string): TeamTemplate | undefined {
  return TEAM_TEMPLATES.find(t => t.id === id);
}
