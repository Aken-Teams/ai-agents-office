'use client';

import { useState } from 'react';

// ──────────────────────────────────────────────────────────────────────────
// Feature spotlight — a game-style "what's new" modal shown once per user on
// the dashboard. Hardcoded content for now; bump SPOTLIGHT_VERSION to re-show
// everyone the next time there's something new to announce.
//
// Screenshots: drop PNG/JPG files into `client/public/announcements/` using the
// `image` filenames below. Until they exist, a styled placeholder shows instead.
// ──────────────────────────────────────────────────────────────────────────

export const SPOTLIGHT_VERSION = 'editor-2026-06g';
const SEEN_KEY = 'spotlight_seen';

interface Step {
  image: string;       // file under /public/announcements/
  badge: string;       // small chip on the hero
  icon: string;        // material symbol fallback when image missing
  title: string;
  desc: string;
}

const STEPS: Step[] = [
  {
    image: 'editor-edit.png',
    badge: '就地編輯',
    icon: 'ads_click',
    title: '文件做好後，不用整份重來',
    desc: '以前想改一個地方得讓系統整份重跑。現在在預覽裡點任何一頁或一個區塊，直接用中文說「把這頁標題改成…」「這張卡換藍色」，AI 就只改那裡，其餘完全不動。',
  },
  {
    image: 'editor-delegate.png',
    badge: '交給 AI',
    icon: 'auto_fix_high',
    title: '這些都能直接丟給 AI 改',
    desc: '改文字內容、換配色與主題、改圖表類型、調整版面、單頁重做、整份美編——點選後說一句話就好，不必重新輸入整份需求、也不必整份重生。',
  },
  {
    image: 'editor-consistent.png',
    badge: '風格一致',
    icon: 'auto_awesome',
    title: '改一頁，也能整份風格一致',
    desc: '不論你改單頁、單區塊或按「重建」整份重做，AI 都以相同設計重生整份、只變更你要求的內容，風格不會忽然走鐘；線上簡報還能一鍵換 9 種佈景主題。',
  },
  {
    image: 'ai-assistant.png',
    badge: 'AI 助手',
    icon: 'smart_toy',
    title: '需要長期幫手？專屬「AI 助手」',
    desc: '左上選單的「AI 助手」是你的常駐 AI 工作夥伴：自由對話、分析資料、產出文件，還能讀 Email；最棒的是有跨對話記憶——每次打開都記得你之前聊過什麼、累積你的偏好。最多 3 個席位。',
  },
  {
    image: 'ai-team.png',
    badge: 'AI 團隊',
    icon: 'groups',
    title: '一句話，組一支 AI 團隊',
    desc: '在 AI 助手裡可建立「AI 團隊」：選個領域、或直接描述你的議題，系統就自動組出一組分工合作的 AI 助手——各司其職、互相討論完成任務，最後彙整成一份統整結論，還能把成果分享出去。',
  },
];

/** Has the user already seen the current spotlight version? */
export function hasSeenSpotlight(): boolean {
  try { return localStorage.getItem(SEEN_KEY) === SPOTLIGHT_VERSION; }
  catch { return true; } // SSR / privacy mode → don't show
}

function markSeen() {
  try { localStorage.setItem(SEEN_KEY, SPOTLIGHT_VERSION); } catch { /* ignore */ }
}

/** Hero image with a graceful placeholder when the screenshot isn't there yet. */
function HeroImage({ step }: { step: Step }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="relative aspect-video w-full bg-gradient-to-br from-primary/10 via-surface-container to-tertiary/10 overflow-hidden flex items-center justify-center p-3">
      {/* subtle dotted texture behind the framed screenshot */}
      <div className="absolute inset-0 opacity-[0.06] bg-[radial-gradient(circle_at_1px_1px,currentColor_1px,transparent_0)] [background-size:18px_18px] text-primary" />
      {!failed && (
        // object-contain → never crop the screenshot; framed so any capture looks tidy
        <img
          src={`/announcements/${step.image}`}
          alt={step.title}
          className="relative max-w-full max-h-full object-contain rounded-lg shadow-md ring-1 ring-black/5"
          onError={() => setFailed(true)}
        />
      )}
      {failed && (
        // Polished illustrative fallback (shows until a real screenshot is dropped in)
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="absolute inset-0 opacity-[0.07] bg-[radial-gradient(circle_at_1px_1px,currentColor_1px,transparent_0)] [background-size:18px_18px] text-primary" />
          <div className="w-20 h-20 rounded-2xl bg-surface-container-lowest/80 backdrop-blur shadow-md flex items-center justify-center">
            <span className="material-symbols-outlined text-4xl text-primary">{step.icon}</span>
          </div>
        </div>
      )}
      {/* eyebrow chip */}
      <div className="absolute top-3 left-3 px-2.5 py-1 rounded-full bg-surface-container-lowest/85 backdrop-blur text-xs font-medium text-primary shadow-sm">
        {step.badge}
      </div>
    </div>
  );
}

export default function FeatureSpotlightModal({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const isLast = step === STEPS.length - 1;
  const cur = STEPS[step];

  const close = () => { markSeen(); onClose(); };

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in" onClick={close} />
      <div className="relative bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-3xl mx-4 overflow-hidden animate-in zoom-in-95 fade-in duration-200">
        {/* ✨ New badge */}
        <div className="absolute top-3 right-3 z-10 flex items-center gap-1.5">
          <span className="px-2.5 py-1 rounded-full bg-primary text-on-primary text-xs font-bold shadow-sm">✨ 新功能上線</span>
          <button
            onClick={close}
            aria-label="關閉"
            className="w-7 h-7 rounded-full bg-surface-container-lowest/85 backdrop-blur flex items-center justify-center hover:bg-surface-container transition-colors cursor-pointer shadow-sm"
          >
            <span className="material-symbols-outlined text-lg text-on-surface-variant">close</span>
          </button>
        </div>

        <HeroImage step={cur} />

        {/* Body */}
        <div className="px-6 pt-5 pb-3">
          <h3 className="font-headline font-bold text-lg text-on-surface mb-1.5">{cur.title}</h3>
          <p className="text-sm text-on-surface-variant leading-relaxed min-h-[3.75rem]">{cur.desc}</p>
        </div>

        {/* Dots */}
        <div className="flex items-center justify-center gap-1.5 pb-4">
          {STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              aria-label={`第 ${i + 1} 頁`}
              className={`h-1.5 rounded-full transition-all cursor-pointer ${i === step ? 'w-5 bg-primary' : 'w-1.5 bg-outline-variant/40 hover:bg-outline-variant/70'}`}
            />
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-6 pb-6 pt-1 border-t border-outline-variant/10">
          <button
            onClick={close}
            className="text-sm text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
          >
            不再顯示
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep(s => s - 1)}
                className="px-4 py-2.5 rounded-lg text-sm font-medium text-on-surface-variant bg-surface-container-high hover:bg-surface-container-highest transition-colors cursor-pointer"
              >
                上一步
              </button>
            )}
            <button
              onClick={() => { if (isLast) close(); else setStep(s => s + 1); }}
              className="px-5 py-2.5 rounded-lg text-sm font-bold text-on-primary bg-primary hover:bg-primary-hover transition-colors cursor-pointer shadow-sm"
            >
              {isLast ? '立即試試' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
