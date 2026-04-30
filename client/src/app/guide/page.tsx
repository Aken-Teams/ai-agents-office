'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider, useTranslation } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';

// ─── Section data ────────────────────────────────────────────────────────────

const FEATURES = [
  {
    icon: 'present_to_all',
    color: 'text-warning',
    bg: 'bg-warning/10 border-warning/20',
    title: '簡報製作',
    desc: '用一句話描述主題，AI 自動生成完整 PowerPoint 簡報，含版面設計、圖表與內容。',
    tip: '「幫我做一份關於 Q3 業績回顧的 10 頁簡報」',
  },
  {
    icon: 'description',
    color: 'text-tertiary',
    bg: 'bg-tertiary/10 border-tertiary/20',
    title: '文件撰寫',
    desc: '生成專業 Word 文件，包含報告、提案、合約草稿、會議記錄等各類文書。',
    tip: '「幫我撰寫一份新產品上市計畫書」',
  },
  {
    icon: 'table_chart',
    color: 'text-success',
    bg: 'bg-success/10 border-success/20',
    title: '試算表分析',
    desc: '生成 Excel 試算表，支援財務模型、數據整理、公式建立與圖表視覺化。',
    tip: '「幫我建立一個月度預算追蹤表格」',
  },
  {
    icon: 'analytics',
    color: 'text-primary',
    bg: 'bg-primary/10 border-primary/20',
    title: '數據分析',
    desc: '上傳 CSV、Excel 資料，AI 自動分析趨勢、找出異常並產出視覺化圖表。',
    tip: '「分析這份銷售數據，找出成長最快的產品線」',
  },
  {
    icon: 'hub',
    color: 'text-tertiary',
    bg: 'bg-tertiary/10 border-tertiary/20',
    title: '知識庫分析',
    desc: '上傳多份文件，AI 跨檔案交叉分析，自動比對差異並整合洞察。',
    tip: '「幫我比較這 3 份合約的關鍵條款差異」',
  },
  {
    icon: 'travel_explore',
    color: 'text-on-surface-variant',
    bg: 'bg-surface-container-high border-outline-variant/30',
    title: '網路研究',
    desc: '自動搜尋網路資料，彙整多方來源，生成有條理的研究報告。',
    tip: '「研究 2024 年台灣電商市場趨勢並彙整摘要」',
  },
];

const STEPS = [
  {
    num: '01',
    icon: 'add_circle',
    title: '選擇功能類型',
    desc: '從側邊欄點擊「新建文件」，選擇你要生成的文件類型：簡報、Word、Excel、PDF 或分析類工具。',
  },
  {
    num: '02',
    icon: 'chat',
    title: '用自然語言描述需求',
    desc: '在對話框輸入你的需求。不需要技術語言，直接說清楚你要什麼就好。AI 會自動理解並拆解任務。',
  },
  {
    num: '03',
    icon: 'smart_toy',
    title: 'AI 多智能體協作處理',
    desc: '系統會自動派遣多個 AI 智能體分工協作：研究資料、規劃架構、生成內容、審查品質，全程自動完成。',
  },
  {
    num: '04',
    icon: 'download',
    title: '下載成果',
    desc: '任務完成後，即可直接下載生成的文件。所有檔案都保存在「檔案管理」頁面，隨時可以重新下載。',
  },
];

const ADVANCED = [
  {
    icon: 'psychology',
    color: 'text-secondary',
    bg: 'bg-secondary/10 border-secondary/20',
    title: 'AI 助手（長期記憶）',
    desc: 'AI 助手有跨對話記憶，每次開啟都記得你的偏好、工作背景與過去的討論，像個熟悉你的專業夥伴。最多可建立 3 個助手，分別用於不同領域。',
    link: '/assistant',
    linkLabel: '前往 AI 助手',
  },
  {
    icon: 'alternate_email',
    color: 'text-primary',
    bg: 'bg-primary/10 border-primary/20',
    title: '跨任務 @引用',
    desc: '在 AI 助手對話中，輸入框旁的 @ 按鈕可引用其他助手的工作成果。例如：讓 A 助手整理的資料，直接傳給 B 助手來製作報告，無需重新輸入。',
    link: '/assistant',
    linkLabel: '試試跨任務引用',
  },
  {
    icon: 'upload_file',
    color: 'text-warning',
    bg: 'bg-warning/10 border-warning/20',
    title: '上傳檔案分析',
    desc: '在任何對話中都可以上傳檔案（PDF、Word、Excel、圖片等）。AI 會讀取檔案內容，根據你的指令進行分析、整理或以此為基礎生成新文件。',
    link: '/dashboard',
    linkLabel: '開始上傳分析',
  },
  {
    icon: 'notifications',
    color: 'text-tertiary',
    bg: 'bg-tertiary/10 border-tertiary/20',
    title: '背景處理',
    desc: '複雜任務可能需要幾分鐘。你可以關閉頁面或切換到其他功能，任務會在背景繼續執行。回來後頁面頂部會顯示執行進度。',
    link: '/conversations',
    linkLabel: '查看對話記錄',
  },
];

const TIPS = [
  { icon: 'lightbulb', text: '需求越具體越好：提供受眾、頁數、風格或範例，AI 的輸出品質會更高。' },
  { icon: 'refresh', text: '不滿意結果可以直接在對話中提出修改：「把第三頁換成橫向排版」、「語氣改得更正式一點」。' },
  { icon: 'folder_open', text: '所有生成的檔案都在「檔案管理」頁面集中管理，支援版本記錄，不會遺失。' },
  { icon: 'psychology', text: 'AI 記憶會自動學習你的偏好，下次不需要重複說明背景資訊。' },
  { icon: 'hub', text: '知識庫分析最適合多文件交叉比對，上傳越多相關文件，分析結果越準確。' },
];

// ─── Component ───────────────────────────────────────────────────────────────

function GuideContent() {
  const { user, isLoading } = useAuth();
  const { t } = useTranslation();
  const sidebarMargin = useSidebarMargin();
  const [activeSection, setActiveSection] = useState<string | null>(null);

  if (isLoading || !user) return null;

  return (
    <>
      <Navbar />
      <main className={`${sidebarMargin} pt-16 md:pt-10 pb-16 px-4 md:px-10 transition-all duration-300`}>

        {/* Page Header */}
        <header className="mt-4 md:mt-0 mb-8 md:mb-12">
          <div className="flex items-center gap-2 mb-1 md:mb-2">
            <span className="text-primary text-xs md:text-sm font-bold tracking-[0.3em] uppercase">USER GUIDE</span>
            <div className="h-px w-8 md:w-12 bg-primary/30" />
          </div>
          <h1 className="text-2xl md:text-4xl font-headline font-bold text-on-surface tracking-tight mb-3">使用說明</h1>
          <p className="text-sm md:text-base text-on-surface-variant leading-relaxed max-w-2xl">
            AI Agents Office 是一個 AI 驅動的智慧文件生成平台。透過自然語言描述你的需求，多個 AI 智能體會自動協作，幫你完成從研究、撰寫到生成文件的全部工作。
          </p>
        </header>

        {/* Quick Start Steps */}
        <section className="mb-10 md:mb-14">
          <h2 className="text-base md:text-xl font-headline font-bold text-on-surface mb-4 md:mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">rocket_launch</span>
            快速開始
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 md:gap-4">
            {STEPS.map((step) => (
              <div key={step.num} className="relative bg-surface-container rounded-xl p-4 md:p-5 border border-outline-variant/20">
                <div className="flex items-start gap-3 mb-3">
                  <span className="text-2xl md:text-3xl font-headline font-bold text-primary/20 leading-none shrink-0">{step.num}</span>
                  <span className="material-symbols-outlined text-primary text-xl mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>{step.icon}</span>
                </div>
                <h3 className="font-bold text-sm md:text-base text-on-surface mb-1.5">{step.title}</h3>
                <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed">{step.desc}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Feature Cards */}
        <section className="mb-10 md:mb-14">
          <h2 className="text-base md:text-xl font-headline font-bold text-on-surface mb-4 md:mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">apps</span>
            功能一覽
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 md:gap-4">
            {FEATURES.map((feat) => (
              <div
                key={feat.title}
                className={`rounded-xl p-4 md:p-5 border transition-all ${feat.bg}`}
              >
                <div className="flex items-center gap-2.5 mb-2.5">
                  <span className={`material-symbols-outlined text-xl ${feat.color}`} style={{ fontVariationSettings: "'FILL' 1" }}>{feat.icon}</span>
                  <h3 className="font-bold text-sm md:text-base text-on-surface">{feat.title}</h3>
                </div>
                <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed mb-3">{feat.desc}</p>
                <div className="bg-surface-container/60 rounded-lg px-3 py-2 text-xs text-on-surface-variant/70 italic border border-outline-variant/10">
                  <span className="text-primary/60 not-italic font-medium">範例：</span> {feat.tip}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Advanced Features */}
        <section className="mb-10 md:mb-14">
          <h2 className="text-base md:text-xl font-headline font-bold text-on-surface mb-4 md:mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">auto_awesome</span>
            進階功能
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
            {ADVANCED.map((item) => (
              <div key={item.title} className={`rounded-xl p-4 md:p-5 border ${item.bg}`}>
                <div className="flex items-center gap-2.5 mb-2.5">
                  <span className={`material-symbols-outlined text-xl ${item.color}`} style={{ fontVariationSettings: "'FILL' 1" }}>{item.icon}</span>
                  <h3 className="font-bold text-sm md:text-base text-on-surface">{item.title}</h3>
                </div>
                <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed mb-3">{item.desc}</p>
                <Link
                  href={item.link}
                  className={`inline-flex items-center gap-1.5 text-xs font-bold ${item.color} hover:underline`}
                >
                  {item.linkLabel}
                  <span className="material-symbols-outlined text-sm">arrow_forward</span>
                </Link>
              </div>
            ))}
          </div>
        </section>

        {/* Tips */}
        <section className="mb-10 md:mb-14">
          <h2 className="text-base md:text-xl font-headline font-bold text-on-surface mb-4 md:mb-6 flex items-center gap-2">
            <span className="material-symbols-outlined text-primary text-xl">tips_and_updates</span>
            使用技巧
          </h2>
          <div className="bg-surface-container rounded-xl border border-outline-variant/20 divide-y divide-outline-variant/15">
            {TIPS.map((tip, i) => (
              <div key={i} className="flex items-start gap-3 px-4 py-3.5 md:px-5 md:py-4">
                <span className="material-symbols-outlined text-primary/70 text-base mt-0.5 shrink-0" style={{ fontVariationSettings: "'FILL' 1" }}>{tip.icon}</span>
                <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed">{tip.text}</p>
              </div>
            ))}
          </div>
        </section>

        {/* CTA */}
        <section className="rounded-2xl bg-primary/8 border border-primary/15 px-5 py-6 md:px-8 md:py-8 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <div>
            <h2 className="font-headline font-bold text-base md:text-lg text-on-surface mb-1">準備好開始了嗎？</h2>
            <p className="text-xs md:text-sm text-on-surface-variant">前往儀表板，選擇一個文件類型，直接輸入你的第一個需求。</p>
          </div>
          <Link
            href="/dashboard"
            className="cyber-gradient text-on-primary font-headline font-bold text-xs md:text-sm uppercase px-5 py-2.5 rounded-lg tracking-widest shadow-lg hover:opacity-90 transition-opacity shrink-0"
          >
            前往儀表板
          </Link>
        </section>

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
