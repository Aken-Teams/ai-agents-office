'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';

// ─── Tab definitions ──────────────────────────────────────────────────────────

interface GuideStep {
  icon: string;
  title: string;
  desc: string;
  example?: string;
}

interface GuideSection {
  id: string;
  icon: string;
  label: string;
  color: string;
  bg: string;
  pageLink?: string;
  pageLinkLabel?: string;
  intro: string;
  steps: GuideStep[];
  tips: string[];
}

const SECTIONS: GuideSection[] = [
  {
    id: 'overview',
    icon: 'rocket_launch',
    label: '快速開始',
    color: 'text-primary',
    bg: 'bg-primary/10 border-primary/20',
    intro: 'AI Agents Office 是一個多智能體 AI 平台，讓你只需用自然語言描述需求，系統就會自動派遣多個 AI 智能體協作完成任務——從資料研究、內容規劃到文件生成，全程自動化。',
    steps: [
      {
        icon: 'apps',
        title: '從儀表板選擇功能',
        desc: '登入後進入儀表板，選擇你要的功能類型：製作簡報、撰寫文件、分析數據、或啟用 AI 助手長期工作夥伴。',
      },
      {
        icon: 'chat',
        title: '用自然語言描述需求',
        desc: '在對話框輸入你的需求，不需要技術語言。越具體越好，可以包含頁數、目標受眾、風格、格式等細節。',
        example: '「幫我做一份 12 頁的 Q3 業績回顧簡報，受眾是董事會，風格專業簡潔」',
      },
      {
        icon: 'hub',
        title: 'AI 多智能體協作',
        desc: '系統自動分析你的需求，派遣 Router → Research → Planner → Worker 等多個智能體分工完成。你可以在右側面板看到即時進度。',
      },
      {
        icon: 'download',
        title: '下載並繼續修改',
        desc: '任務完成後直接下載。不滿意？繼續在對話中說明修改需求，AI 會重新生成。所有版本都保存在「檔案管理」。',
      },
    ],
    tips: [
      '第一次使用建議先從「簡報製作」試試，體驗多智能體協作流程',
      '任務可在背景執行，不需要盯著等待，切換頁面進度不受影響',
      '需求越詳細，輸出品質越高。可以提供參考範例或附上現有資料',
    ],
  },
  {
    id: 'dashboard',
    icon: 'dashboard',
    label: '儀表板',
    color: 'text-primary',
    bg: 'bg-primary/10 border-primary/20',
    pageLink: '/dashboard',
    pageLinkLabel: '前往儀表板',
    intro: '儀表板是你的工作起點。從這裡選擇文件類型、使用範本精靈，或直接輸入需求啟動 AI 生成流程。',
    steps: [
      {
        icon: 'present_to_all',
        title: '選擇文件類型',
        desc: '儀表板提供 9 種功能類型：簡報、Word 文件、Excel 試算表、PDF、網頁簡報、互動網頁、數據分析、知識庫分析、網路研究。點擊卡片直接進入該功能的對話。',
      },
      {
        icon: 'tune',
        title: '使用範本精靈',
        desc: '點擊「範本精靈」，選擇文件類型與風格範本（如「極簡專業」、「科技暗黑」、「企業藍」），AI 會以對應風格生成文件。',
      },
      {
        icon: 'send',
        title: '直接輸入需求',
        desc: '底部的輸入框可直接輸入任何需求，AI 會自動判斷最適合的功能類型並開始執行，適合不確定要用哪個功能時使用。',
        example: '「分析附件裡的銷售數據，找出成長最快的產品線並做成視覺化圖表」',
      },
      {
        icon: 'upload_file',
        title: '上傳附件',
        desc: '點擊迴紋針圖示上傳 PDF、Word、Excel、圖片等檔案，AI 會以現有資料為基礎生成或分析，不需重新輸入資料內容。',
      },
    ],
    tips: [
      '頁面頂部顯示本月文件生成次數、Token 用量與費用，隨時掌握使用狀況',
      '儀表板的對話是「一次性文件任務」，若需要長期記憶，請使用 AI 助手',
      '上傳圖片可讓 AI 讀取圖中文字或以圖片為基礎延伸生成內容',
    ],
  },
  {
    id: 'assistant',
    icon: 'smart_toy',
    label: 'AI 助手',
    color: 'text-secondary',
    bg: 'bg-secondary/10 border-secondary/20',
    pageLink: '/assistant',
    pageLinkLabel: '前往 AI 助手',
    intro: 'AI 助手是有長期記憶的工作夥伴，每次開啟都記得你的偏好、工作背景與過去討論。適合需要持續互動的長期專案或工作角色。',
    steps: [
      {
        icon: 'add_circle',
        title: '建立 AI 助手',
        desc: '點擊頁面右上角「+」新增助手，並替它取一個名字（例如「研究助手」、「行銷寫手」）。最多可建立 3 個，分別專注於不同領域。',
      },
      {
        icon: 'psychology',
        title: '記憶自動累積',
        desc: 'AI 會從你們的每次對話中自動提取並記憶：你的偏好、工作背景、寫作風格、常用術語等。下次對話不需要重複說明。',
      },
      {
        icon: 'alternate_email',
        title: '跨任務 @引用',
        desc: '在輸入框旁點擊 @ 按鈕，可以引用其他助手的工作成果。系統自動把被引用助手的對話摘要帶入當前任務，讓多個助手無縫協作。',
        example: '引用「研究助手」的市場分析成果，讓「簡報助手」直接基於這些資料製作簡報',
      },
      {
        icon: 'work_history',
        title: '查看工作紀錄',
        desc: '前往「AI 記憶」頁面可以看到每個助手累積的工作紀錄摘要，了解各助手分別幫你做了哪些事情。',
      },
    ],
    tips: [
      '對話歷史永久保留直到你主動刪除，無需擔心資料遺失',
      '可以為不同客戶、不同專案各建立一個助手，避免記憶混雜',
      '助手也可以生成文件，功能與儀表板相同，但多了長期記憶加持',
    ],
  },
  {
    id: 'chat',
    icon: 'chat',
    label: '對話操作',
    color: 'text-tertiary',
    bg: 'bg-tertiary/10 border-tertiary/20',
    intro: '不論是文件生成任務還是 AI 助手對話，操作方式都相同。掌握以下幾個技巧，可以大幅提升輸出品質與效率。',
    steps: [
      {
        icon: 'attach_file',
        title: '上傳附件分析',
        desc: '點擊迴紋針圖示可上傳 PDF、Word、Excel、圖片等格式。AI 會讀取並理解檔案內容，根據你的指令進行分析、整理，或以此為素材生成新文件。',
        example: '上傳競品分析報告 → 「幫我整理出 3 個最關鍵的差異點，製成比較表格」',
      },
      {
        icon: 'alternate_email',
        title: '@引用 AI 助手成果',
        desc: '（僅 AI 助手對話可用）點擊輸入框旁的 @ 按鈕，從清單中選擇要引用的助手。系統會自動把對方的工作成果帶入，讓 AI 直接運用而不需重新研究。',
      },
      {
        icon: 'analytics',
        title: '即時查看 AI 活動',
        desc: '對話過程中，右側面板（桌面版）或對話下方（手機版）會顯示每個 AI 智能體的任務進度、工具使用記錄（搜尋了什麼、讀取了哪些檔案）等詳情。',
      },
      {
        icon: 'edit',
        title: '持續修改完善',
        desc: '生成完成後，可以繼續對話下修改指令，AI 會記住前一份文件的內容並進行調整，不需要重頭說明。',
        example: '「第三章的語氣太技術性，改得更口語一點」→「在結尾加上行動呼籲段落」',
      },
    ],
    tips: [
      '按 Enter 送出，Shift+Enter 換行（桌面版）',
      '任務執行中點擊「停止」可隨時中斷並重新下指令',
      '複雜任務執行時可以切換到其他頁面，背景繼續執行，完成後回來查看',
    ],
  },
  {
    id: 'files',
    icon: 'folder_open',
    label: '檔案管理',
    color: 'text-warning',
    bg: 'bg-warning/10 border-warning/20',
    pageLink: '/files',
    pageLinkLabel: '前往檔案管理',
    intro: '所有 AI 生成的文件集中在這裡統一管理。支援依類型篩選、關鍵字搜尋、版本查看，以及回到原始對話繼續修改。',
    steps: [
      {
        icon: 'filter_list',
        title: '篩選與搜尋',
        desc: '頁面頂部的類型標籤（PPT、Word、Excel、PDF 等）可快速篩選。右上角搜尋框支援依檔名關鍵字搜尋。',
      },
      {
        icon: 'download',
        title: '下載檔案',
        desc: '點擊檔案列右側的下載按鈕直接下載最新版本。若有多個版本，點擊檔名進入詳情頁可選擇特定版本下載。',
      },
      {
        icon: 'history',
        title: '版本記錄',
        desc: '同一份對話中多次生成（例如修改後重新生成）會產生多個版本，每個版本獨立保存，可隨時回溯比較。',
      },
      {
        icon: 'open_in_new',
        title: '回到原始對話',
        desc: '點擊檔案名稱可跳回生成該檔案的原始對話，繼續下指令進行進一步修改或補充。',
      },
    ],
    tips: [
      '頁面右側的儲存空間指示器顯示目前使用量，接近上限時請清理不需要的舊檔',
      '檔案名稱通常由 AI 自動命名，可在原始對話中說「把檔案命名為 xxx」來指定',
      '大型 Excel 或 PDF 檔案下載可能需要幾秒鐘，請稍候',
    ],
  },
  {
    id: 'usage',
    icon: 'bar_chart',
    label: '用量統計',
    color: 'text-success',
    bg: 'bg-success/10 border-success/20',
    pageLink: '/usage',
    pageLinkLabel: '前往用量統計',
    intro: '查看你的 AI Token 消耗、費用分佈與使用趨勢，協助你了解使用效率並掌控預算。',
    steps: [
      {
        icon: 'show_chart',
        title: '每日消耗趨勢',
        desc: '頁面頂部的折線圖顯示最近 30 天的 Token 消耗趨勢，快速識別高用量的日期或時段。',
      },
      {
        icon: 'pie_chart',
        title: '功能使用分佈',
        desc: '圓餅圖顯示各文件類型（簡報、Word、數據分析等）佔用 Token 的比例，了解哪類任務最耗資源。',
      },
      {
        icon: 'receipt_long',
        title: '詳細使用記錄',
        desc: '頁面下方的列表顯示每次任務的詳細 Token 消耗，包含 Input / Output Token 與對應費用。',
      },
      {
        icon: 'download',
        title: '匯出 CSV',
        desc: '點擊右上角「匯出 CSV」下載完整用量記錄，適合用於月結對帳或製作費用報表。',
      },
    ],
    tips: [
      'Token 消耗與任務複雜度正相關，多智能體協作任務比單一任務消耗更多',
      '研究類（需要搜尋網路）通常比純文件生成消耗更多 Token',
      '費用上限由管理員設定，接近上限時畫面會顯示警告',
    ],
  },
  {
    id: 'memories',
    icon: 'psychology',
    label: 'AI 記憶',
    color: 'text-tertiary',
    bg: 'bg-tertiary/10 border-tertiary/20',
    pageLink: '/memories',
    pageLinkLabel: '前往 AI 記憶',
    intro: 'AI 會自動從你的對話中提取並儲存有用資訊，讓每次對話都更了解你。記憶分為「偏好記憶」與「工作紀錄」兩類。',
    steps: [
      {
        icon: 'tune',
        title: '偏好記憶',
        desc: 'AI 從對話中學習到的個人偏好：例如你喜歡的簡報風格、語言習慣、排版偏好、常用術語、工作領域等。下次對話自動套用，不需重複說明。',
      },
      {
        icon: 'work_history',
        title: '工作紀錄',
        desc: '每個 AI 助手在各個任務中的工作成果摘要。讓 AI 在後續對話中能快速了解你做過哪些事，延續工作脈絡而不是每次從頭開始。',
      },
      {
        icon: 'search',
        title: '搜尋與篩選',
        desc: '記憶頁面支援關鍵字搜尋，以及依「偏好記憶」或「工作紀錄」類別篩選，快速找到特定記憶內容。',
      },
      {
        icon: 'delete',
        title: '管理記憶',
        desc: '點擊任意記憶右側的刪除按鈕可單獨刪除。「全部清除」會清空所有記憶，讓 AI 重新從零開始學習你的偏好。',
      },
    ],
    tips: [
      '記憶完全自動，不需要任何設定，使用越多 AI 越了解你',
      '如果某條記憶不準確，刪除它，然後在對話中重新說明正確資訊',
      '工作紀錄只針對 AI 助手對話生成，一般文件任務不會產生工作紀錄',
    ],
  },
];

// ─── Component ────────────────────────────────────────────────────────────────

function GuideContent() {
  const { user, isLoading } = useAuth();
  const sidebarMargin = useSidebarMargin();
  const [activeId, setActiveId] = useState('overview');

  // Sync active tab with URL hash
  useEffect(() => {
    const hash = window.location.hash.replace('#', '');
    if (hash && SECTIONS.some(s => s.id === hash)) {
      setActiveId(hash);
    }
  }, []);

  const active = SECTIONS.find(s => s.id === activeId) ?? SECTIONS[0];

  if (isLoading || !user) return null;

  return (
    <>
      <Navbar />
      <main className={`${sidebarMargin} pt-16 md:pt-10 pb-16 transition-all duration-300`}>

        {/* Page Header */}
        <div className="px-4 md:px-10 mt-4 md:mt-0 mb-6 md:mb-8">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-primary text-xs font-bold tracking-[0.3em] uppercase">USER GUIDE</span>
            <div className="h-px w-8 md:w-12 bg-primary/30" />
          </div>
          <h1 className="text-2xl md:text-4xl font-headline font-bold text-on-surface tracking-tight mb-2">使用說明</h1>
          <p className="text-sm text-on-surface-variant max-w-xl">
            選擇左側的功能分類，查看詳細的使用步驟與技巧。
          </p>
        </div>

        <div className="flex flex-col md:flex-row gap-0 md:gap-0">

          {/* ── Left Tab Nav (desktop: sidebar, mobile: horizontal scroll) ── */}
          <nav className="shrink-0 md:w-48 lg:w-56">
            {/* Mobile: horizontal scroll */}
            <div className="md:hidden flex gap-1.5 overflow-x-auto px-4 pb-3 scrollbar-hide">
              {SECTIONS.map(sec => (
                <button
                  key={sec.id}
                  onClick={() => setActiveId(sec.id)}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer shrink-0 ${
                    activeId === sec.id
                      ? 'bg-primary text-on-primary shadow-md'
                      : 'bg-surface-container text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  <span className="material-symbols-outlined text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>{sec.icon}</span>
                  {sec.label}
                </button>
              ))}
            </div>

            {/* Desktop: vertical sidebar */}
            <div className="hidden md:flex flex-col gap-0.5 px-4 md:px-4 sticky top-16 pt-2">
              {SECTIONS.map(sec => (
                <button
                  key={sec.id}
                  onClick={() => setActiveId(sec.id)}
                  className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-sm font-medium transition-all cursor-pointer text-left w-full ${
                    activeId === sec.id
                      ? 'bg-primary/10 text-primary font-bold'
                      : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface'
                  }`}
                >
                  <span
                    className={`material-symbols-outlined text-base shrink-0 ${activeId === sec.id ? 'text-primary' : 'text-on-surface-variant'}`}
                    style={{ fontVariationSettings: `'FILL' ${activeId === sec.id ? '1' : '0'}` }}
                  >
                    {sec.icon}
                  </span>
                  {sec.label}
                  {activeId === sec.id && (
                    <span className="ml-auto w-1 h-4 bg-primary rounded-full shrink-0" />
                  )}
                </button>
              ))}
            </div>
          </nav>

          {/* ── Right Content ── */}
          <div className="flex-1 min-w-0 px-4 md:px-6 lg:px-8 md:border-l border-outline-variant/15">

            {/* Section Header */}
            <div className={`rounded-2xl border p-5 md:p-6 mb-5 md:mb-6 ${active.bg}`}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center bg-surface/50`}>
                    <span className={`material-symbols-outlined text-xl ${active.color}`} style={{ fontVariationSettings: "'FILL' 1" }}>{active.icon}</span>
                  </div>
                  <div>
                    <h2 className="text-lg md:text-2xl font-headline font-bold text-on-surface">{active.label}</h2>
                  </div>
                </div>
                {active.pageLink && (
                  <Link
                    href={active.pageLink}
                    className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-bold border ${active.bg} ${active.color} hover:opacity-80 transition-opacity shrink-0`}
                  >
                    {active.pageLinkLabel}
                    <span className="material-symbols-outlined text-sm">arrow_forward</span>
                  </Link>
                )}
              </div>
              <p className="text-sm text-on-surface-variant leading-relaxed mt-3">{active.intro}</p>
            </div>

            {/* Steps */}
            <div className="mb-5 md:mb-6">
              <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-3">操作步驟</h3>
              <div className="space-y-3">
                {active.steps.map((step, i) => (
                  <div key={i} className="flex gap-4 bg-surface-container rounded-xl p-4">
                    <div className="flex flex-col items-center gap-1 shrink-0">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${active.bg}`}>
                        <span className={`material-symbols-outlined text-base ${active.color}`} style={{ fontVariationSettings: "'FILL' 1" }}>{step.icon}</span>
                      </div>
                      <span className={`text-xs font-black font-headline ${active.color} opacity-40`}>{String(i + 1).padStart(2, '0')}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-bold text-on-surface mb-1">{step.title}</p>
                      <p className="text-xs text-on-surface-variant leading-relaxed">{step.desc}</p>
                      {step.example && (
                        <div className="mt-2 bg-surface rounded-lg px-3 py-2 text-xs text-on-surface-variant/70 italic border border-outline-variant/10">
                          <span className={`${active.color} not-italic font-medium opacity-70`}>範例：</span> {step.example}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Tips */}
            <div className="mb-6">
              <h3 className="text-xs font-bold text-on-surface-variant uppercase tracking-widest mb-3">使用技巧</h3>
              <div className="bg-surface-container rounded-xl divide-y divide-outline-variant/10">
                {active.tips.map((tip, i) => (
                  <div key={i} className="flex items-start gap-3 px-4 py-3">
                    <span className={`material-symbols-outlined text-sm mt-0.5 shrink-0 ${active.color} opacity-70`} style={{ fontVariationSettings: "'FILL' 1" }}>tips_and_updates</span>
                    <p className="text-xs text-on-surface-variant leading-relaxed">{tip}</p>
                  </div>
                ))}
              </div>
            </div>

            {/* Navigation between sections */}
            <div className="flex items-center justify-between gap-3 pt-2 border-t border-outline-variant/15 pb-4">
              {(() => {
                const idx = SECTIONS.findIndex(s => s.id === activeId);
                const prev = SECTIONS[idx - 1];
                const next = SECTIONS[idx + 1];
                return (
                  <>
                    <div className="flex-1">
                      {prev && (
                        <button
                          onClick={() => setActiveId(prev.id)}
                          className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                        >
                          <span className="material-symbols-outlined text-base">arrow_back</span>
                          <span>{prev.label}</span>
                        </button>
                      )}
                    </div>
                    <div className="flex-1 flex justify-end">
                      {next && (
                        <button
                          onClick={() => setActiveId(next.id)}
                          className="flex items-center gap-2 text-sm text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                        >
                          <span>{next.label}</span>
                          <span className="material-symbols-outlined text-base">arrow_forward</span>
                        </button>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>

          </div>
        </div>
      </main>
    </>
  );
}

export default function GuidePage() {
  return (
    <AuthProvider>
      <I18nProvider>
        <GuideContent />
      </I18nProvider>
    </AuthProvider>
  );
}
