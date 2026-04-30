'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';

export type HelpPageId = 'dashboard' | 'assistant' | 'conversations' | 'files' | 'usage' | 'memories' | 'chat';

interface Step {
  icon: string;
  title: string;
  desc: string;
}

interface HelpContent {
  subtitle: string;
  title: string;
  desc: string;
  steps: Step[];
  tips: string[];
  guideHash: string;
}

const HELP_CONTENT: Record<HelpPageId, HelpContent> = {
  dashboard: {
    title: '儀表板',
    subtitle: '文件生成中心',
    desc: '選擇文件類型、輸入需求，AI 自動完成從研究到生成的全部工作。',
    steps: [
      { icon: 'apps', title: '選擇文件類型', desc: '點擊下方的類型卡片，或使用「範本精靈」選擇風格範本快速開始。' },
      { icon: 'chat', title: '輸入你的需求', desc: '用自然語言描述結果，越具體越好，可加上頁數、受眾、風格等細節。' },
      { icon: 'smart_toy', title: 'AI 多智能體協作', desc: 'AI 自動拆解任務，派遣多個智能體分工，右側面板可看到即時進度。' },
      { icon: 'download', title: '下載成果', desc: '生成後點擊下載，或到「檔案管理」找到所有歷史檔案重新下載。' },
    ],
    tips: [
      '上傳附件（PDF、Excel、圖片）讓 AI 以現有資料為基礎生成文件',
      '不滿意？直接說「把第二頁改得更精簡」，AI 會修改並重新生成',
      '複雜任務可在背景執行，切換其他頁面不影響進度',
    ],
    guideHash: 'dashboard',
  },
  assistant: {
    title: 'AI 助手',
    subtitle: '長期記憶工作夥伴',
    desc: 'AI 助手有跨對話的長期記憶，每次開啟都記得你的偏好、背景與過去討論。',
    steps: [
      { icon: 'add_circle', title: '新增助手', desc: '點擊「+」新增 AI 助手，最多 3 個，可分別用於不同領域或專案。' },
      { icon: 'psychology', title: '記憶自動累積', desc: 'AI 從對話中提取你的偏好與工作背景並記住，下次不需重複說明。' },
      { icon: 'alternate_email', title: '跨任務 @引用', desc: '輸入框旁的 @ 按鈕可引用其他助手的工作成果，讓多個助手協作。' },
    ],
    tips: [
      '對話歷史永久保留直到你主動刪除，適合長期使用',
      '@引用讓你把 A 助手的研究成果直接傳給 B 助手製作報告',
      '試試建立「研究助手」、「寫作助手」分工合作',
    ],
    guideHash: 'assistant',
  },
  conversations: {
    title: '對話記錄',
    subtitle: '所有文件任務的歷史',
    desc: '這裡記錄了所有文件生成任務的對話，可重新開啟繼續操作或查看背景任務。',
    steps: [
      { icon: 'history', title: '查看歷史任務', desc: '所有對話依時間排列，點擊任意一筆即可重新進入並繼續下指令。' },
      { icon: 'search', title: '搜尋與篩選', desc: '使用頂部搜尋框找關鍵字，或依文件類型篩選快速定位。' },
      { icon: 'notifications', title: '背景任務狀態', desc: '若有任務在背景執行，回到對話後頁面頂部會顯示即時進度。' },
    ],
    tips: [
      'AI 助手的對話不在這裡，請到「AI 助手」頁面查看',
      '點擊對話後可繼續下指令，例如「把報告加上執行摘要」',
      '分享按鈕可將對話記錄分享給他人瀏覽',
    ],
    guideHash: 'conversations',
  },
  files: {
    title: '檔案管理',
    subtitle: '所有生成檔案的倉庫',
    desc: '所有 AI 生成的文件集中在這裡，可篩選、下載，並查看每個檔案的版本歷史。',
    steps: [
      { icon: 'filter_list', title: '篩選文件類型', desc: '點擊頂部類型標籤（PPT、Word、Excel 等）快速篩選你要的檔案。' },
      { icon: 'download', title: '下載檔案', desc: '點擊下載按鈕，或進入詳情頁查看版本記錄並下載特定版本。' },
      { icon: 'open_in_new', title: '回到原始對話', desc: '點擊檔案可跳回原始對話，繼續下指令修改內容或風格。' },
    ],
    tips: [
      '找不到檔案？用搜尋框輸入關鍵字',
      '儲存空間進度條顯示目前使用量，接近上限時請清理舊檔',
      '同一任務多次生成會產生多個版本，可分別下載比較',
    ],
    guideHash: 'files',
  },
  usage: {
    title: '用量統計',
    subtitle: '掌握 AI Token 消耗',
    desc: '查看你的 AI 使用量、Token 消耗與費用分佈，了解各功能的使用效率。',
    steps: [
      { icon: 'bar_chart', title: '每日趨勢圖', desc: '折線圖顯示最近 30 天的消耗趨勢，快速了解哪幾天使用量較高。' },
      { icon: 'pie_chart', title: '功能分佈', desc: '圓餅圖顯示各文件類型佔用的 Token 比例，找出最耗資源的任務類型。' },
      { icon: 'download', title: '匯出記錄', desc: '點擊右上角「匯出 CSV」下載詳細用量記錄，用於對帳或費用追蹤。' },
    ],
    tips: [
      'Token 消耗與需求複雜度正相關，越詳細的任務越耗資源',
      '研究類任務通常比文件生成耗更多 Token',
      '費用上限由管理員設定，接近上限時會有提示',
    ],
    guideHash: 'usage',
  },
  memories: {
    title: 'AI 記憶',
    subtitle: '跨對話的個人化記憶',
    desc: 'AI 自動從對話中提取並儲存關於你的記憶，分為偏好記憶與工作紀錄兩類。',
    steps: [
      { icon: 'tune', title: '偏好記憶', desc: 'AI 學習到的個人偏好，例如簡報風格、語言習慣、格式要求等，自動套用。' },
      { icon: 'work_history', title: '工作紀錄', desc: 'AI 助手在各任務中的工作成果摘要，幫助在後續對話中延續工作脈絡。' },
      { icon: 'delete', title: '管理記憶', desc: '可隨時刪除特定記憶，AI 下次對話就不會再用到該資訊。' },
    ],
    tips: [
      '記憶是自動累積的，不需要手動設定',
      '覺得某條記憶有誤？刪除後在對話中重新說明即可',
      '「全部清除」會刪除所有記憶，讓 AI 重新學習你的偏好',
    ],
    guideHash: 'memories',
  },
  chat: {
    title: '對話操作',
    subtitle: '如何使用對話介面',
    desc: '在對話介面用自然語言下指令、上傳檔案，並在助手對話中引用其他 AI 成果。',
    steps: [
      { icon: 'attach_file', title: '上傳附件', desc: '點擊迴紋針上傳 PDF、Word、Excel、圖片，AI 會讀取並依你的指令分析或生成文件。' },
      { icon: 'alternate_email', title: '@引用其他助手', desc: '（僅 AI 助手對話）點擊 @ 按鈕選擇其他助手，系統自動帶入其工作成果作為上下文。' },
      { icon: 'analytics', title: '查看 AI 活動', desc: '對話過程中右側面板會即時顯示 AI 工具使用記錄與智能體任務進度。' },
    ],
    tips: [
      '按 Enter 送出訊息，Shift+Enter 換行',
      '任務執行中點擊「停止」可隨時中斷',
      '生成完成後繼續下指令，AI 會記住前一份文件的內容',
    ],
    guideHash: 'chat',
  },
};

export default function HelpButton({ pageId }: { pageId: HelpPageId }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const content = HELP_CONTENT[pageId];

  // Avoid SSR mismatch — portals need document
  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open]);

  // Panel rendered via portal so it always escapes any backdrop-filter / transform ancestor
  const overlay = (
    <>
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-[9998] bg-scrim/20 backdrop-blur-sm transition-opacity duration-300 ${open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
        onClick={() => setOpen(false)}
      />

      {/* Slide-in Panel */}
      <div
        className={`fixed top-0 right-0 z-[9999] h-screen w-full max-w-[340px] bg-surface shadow-2xl border-l border-outline-variant/20 flex flex-col transition-transform duration-300 ${
          open ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {/* Header */}
        <div className="flex items-start justify-between px-5 py-4 border-b border-outline-variant/15 shrink-0">
          <div>
            <span className="text-primary text-xs font-bold tracking-[0.2em] uppercase block mb-0.5">{content.subtitle}</span>
            <h3 className="text-lg font-headline font-bold text-on-surface">{content.title}</h3>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:bg-surface-container transition-colors cursor-pointer shrink-0 mt-0.5"
          >
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-5">
          <p className="text-sm text-on-surface-variant leading-relaxed">{content.desc}</p>

          {/* Steps */}
          <div className="space-y-3">
            {content.steps.map((step, i) => (
              <div key={i} className="flex gap-3">
                <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                  <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>{step.icon}</span>
                </div>
                <div>
                  <p className="text-sm font-bold text-on-surface mb-0.5">{step.title}</p>
                  <p className="text-xs text-on-surface-variant leading-relaxed">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>

          {/* Tips */}
          <div className="bg-surface-container rounded-xl p-4">
            <p className="text-xs font-bold text-primary uppercase tracking-widest mb-2.5">使用技巧</p>
            <ul className="space-y-2">
              {content.tips.map((tip, i) => (
                <li key={i} className="flex gap-2 text-xs text-on-surface-variant leading-relaxed">
                  <span className="material-symbols-outlined text-primary/60 text-sm shrink-0 mt-0.5" style={{ fontVariationSettings: "'FILL' 1" }}>tips_and_updates</span>
                  {tip}
                </li>
              ))}
            </ul>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-outline-variant/15 shrink-0">
          <Link
            href={`/guide#${content.guideHash}`}
            className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl border border-primary/20 bg-primary/5 text-primary text-sm font-bold hover:bg-primary/10 transition-colors"
            onClick={() => setOpen(false)}
          >
            <span className="material-symbols-outlined text-base">menu_book</span>
            查看完整使用說明
          </Link>
        </div>
      </div>
    </>
  );

  return (
    <>
      {/* ? Trigger button */}
      <button
        onClick={() => setOpen(true)}
        className="w-7 h-7 flex items-center justify-center rounded-full border border-outline-variant/30 text-on-surface-variant hover:text-primary hover:border-primary/40 hover:bg-primary/8 transition-all cursor-pointer shrink-0"
        title="使用說明"
        aria-label="使用說明"
      >
        <span className="material-symbols-outlined text-base" style={{ fontVariationSettings: "'FILL' 0" }}>help</span>
      </button>

      {/* Portal: renders directly in document.body, escaping any ancestor backdrop-filter / transform */}
      {mounted && createPortal(overlay, document.body)}
    </>
  );
}
