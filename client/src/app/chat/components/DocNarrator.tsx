'use client';

import { useState, useRef, useEffect, useCallback, useMemo, type ReactNode } from 'react';

/**
 * Document broadcast / narrator (pro-out only).
 *
 * Speaker button → confirm dialog → full-screen "broadcast mode":
 *  - the overlay covers the screen (so the left chat is hidden)
 *  - the current page's narration shows as large subtitles on the right
 *  - the sentence currently being spoken is highlighted in yellow
 *  - the editor follows along page-by-page via onSelectBlock
 *
 * Voice uses the browser's built-in Web Speech API (free, no backend). The
 * per-page script comes from POST /api/blocks/:fileId/narration. We speak
 * sentence-by-sentence (short utterances) to avoid Chrome's long-utterance
 * cutoff and to drive an exact per-sentence highlight without onboundary.
 */

const IS_OUT = process.env.NEXT_PUBLIC_DEPLOY_MODE === 'pro-out';
const SUPPORTED = new Set(['pptx', 'pdf', 'docx']);

interface Segment { blockId: string; label: string; text: string; }

interface Props {
  fileId: string | null;
  fileType?: string;
  blocks: Array<{ id: string }>;
  onSelectBlock: (id: string | null) => void;
  token: string | null;
  /** Render the page preview for block index (left pane of broadcast mode). */
  renderPreview?: (index: number) => ReactNode;
}

/** Split a narration line into sentences (keep it natural for highlighting). */
function splitSentences(t: string): string[] {
  const parts = (t || '').split(/(?<=[。！？!?；;\n])/).map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : (t ? [t] : []);
}

type Phase = 'idle' | 'confirm' | 'loading' | 'playing' | 'paused';

export default function DocNarrator({ fileId, fileType, blocks, onSelectBlock, token, renderPreview }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [segments, setSegments] = useState<Segment[]>([]);
  const [segIdx, setSegIdx] = useState(0);
  const [sentIdx, setSentIdx] = useState(0);
  const [error, setError] = useState('');
  const [voiceName, setVoiceName] = useState('');
  const [voiceNatural, setVoiceNatural] = useState(false);

  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const cancelRef = useRef(false);
  const activeSentRef = useRef<HTMLSpanElement>(null);
  const segsRef = useRef<Segment[]>([]);
  const sentencesRef = useRef<string[][]>([]);

  // Pick the best Chinese voice, preferring natural/neural ones (e.g. Edge's free
  // "Microsoft … Online (Natural)" voices). Re-run on demand because voices load
  // asynchronously (and only after user interaction in some browsers).
  const pickVoice = useCallback(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return null;
    const vs = window.speechSynthesis.getVoices() || [];
    const score = (v: SpeechSynthesisVoice) => {
      let s = 0;
      if (/zh[-_]?TW/i.test(v.lang)) s += 5;
      else if (/zh[-_]?(HK|Hant)/i.test(v.lang)) s += 3;
      else if (/zh|cmn/i.test(v.lang)) s += 2;
      if (/natural|neural|online/i.test(v.name)) s += 4; // Edge neural voices
      return s;
    };
    const best = vs.filter(v => score(v) > 0).sort((a, b) => score(b) - score(a))[0] || null;
    voiceRef.current = best;
    setVoiceName(best?.name || '');
    setVoiceNatural(!!best && /natural|neural|online/i.test(best.name));
    return best;
  }, []);

  useEffect(() => {
    if (!IS_OUT || typeof window === 'undefined' || !window.speechSynthesis) return;
    pickVoice();
    window.speechSynthesis.addEventListener?.('voiceschanged', pickVoice);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', pickVoice);
  }, [pickVoice]);

  // Always stop speaking if the component unmounts.
  useEffect(() => () => { try { window.speechSynthesis?.cancel(); } catch { /* noop */ } }, []);

  // Keep the sentence being spoken in view (the subtitle pane is small on mobile).
  useEffect(() => {
    activeSentRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [segIdx, sentIdx]);

  const stop = useCallback(() => {
    cancelRef.current = true;
    try { window.speechSynthesis.cancel(); } catch { /* noop */ }
    setPhase('idle');
    setSegIdx(0);
    setSentIdx(0);
  }, []);

  // Speak segment i, sentence j; chains to the next on end.
  const speakNext = useCallback((i: number, j: number) => {
    if (cancelRef.current) return;
    const segs = segsRef.current;
    if (i >= segs.length) { setPhase('idle'); return; }
    const sentences = sentencesRef.current[i] || [];
    if (j >= sentences.length) { speakNext(i + 1, 0); return; }
    if (j === 0) onSelectBlock(segs[i].blockId);   // page follow
    setSegIdx(i);
    setSentIdx(j);
    const u = new SpeechSynthesisUtterance(sentences[j]);
    u.lang = 'zh-TW';
    if (voiceRef.current) u.voice = voiceRef.current;
    u.rate = 1; u.pitch = 1;
    u.onend = () => { if (!cancelRef.current) speakNext(i, j + 1); };
    u.onerror = () => { if (!cancelRef.current) speakNext(i, j + 1); };
    try { window.speechSynthesis.speak(u); } catch { /* noop */ }
  }, [onSelectBlock]);

  const start = useCallback(async () => {
    if (!fileId || !token) return;
    setPhase('loading');
    setError('');
    cancelRef.current = false;
    try {
      const res = await fetch(`/api/blocks/${fileId}/narration`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || '播報稿產生失敗，請稍後再試');
      }
      const data = await res.json() as { segments: Segment[] };
      const segs = (data.segments || []).filter(s => s && s.text);
      if (!segs.length) throw new Error('沒有可播報的內容');
      segsRef.current = segs;
      sentencesRef.current = segs.map(s => splitSentences(s.text));
      setSegments(segs);
      setSegIdx(0);
      setSentIdx(0);
      cancelRef.current = false;
      pickVoice();   // refresh now that the user has interacted (voices are loaded)
      setPhase('playing');
      // Resume the speech engine in case it was left paused/suspended.
      try { window.speechSynthesis.cancel(); window.speechSynthesis.resume(); } catch { /* noop */ }
      speakNext(0, 0);
    } catch (e) {
      setError(e instanceof Error ? e.message : '播報失敗');
      setPhase('idle');
    }
  }, [fileId, token, speakNext, pickVoice]);

  const pause = useCallback(() => { try { window.speechSynthesis.pause(); } catch { /* noop */ } setPhase('paused'); }, []);
  const resume = useCallback(() => { try { window.speechSynthesis.resume(); } catch { /* noop */ } setPhase('playing'); }, []);

  const currentSentences = useMemo(
    () => sentencesRef.current[segIdx] || splitSentences(segments[segIdx]?.text || ''),
    [segIdx, segments],
  );

  if (!IS_OUT || !fileId || !fileType || !SUPPORTED.has(fileType) || blocks.length === 0) return null;

  const broadcasting = phase === 'playing' || phase === 'paused';

  return (
    <>
      {/* Trigger button (sits in the toolbar next to 重建) */}
      <button
        onClick={() => { setError(''); setPhase('confirm'); }}
        className="flex items-center gap-1 px-2 sm:px-2.5 py-1.5 rounded-lg text-xs font-bold border border-primary/30 text-primary hover:bg-primary/10 transition-colors cursor-pointer"
        title="語音播報"
      >
        <span className="material-symbols-outlined text-sm">campaign</span>
        <span className="hidden sm:inline">播報</span>
      </button>

      {error && phase === 'idle' && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[80] px-4 py-2 rounded-lg bg-error text-on-error text-sm shadow-lg">
          {error}
        </div>
      )}

      {/* Confirm dialog */}
      {phase === 'confirm' && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" onClick={() => setPhase('idle')}>
          <div className="w-full max-w-sm rounded-2xl bg-surface p-6 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-2">
              <span className="material-symbols-outlined text-primary">campaign</span>
              <h3 className="text-base font-bold text-on-surface">開始語音播報</h3>
            </div>
            <p className="text-sm text-on-surface-variant leading-relaxed mb-5">
              系統會逐頁朗讀這份文件並自動翻頁，播報期間會進入全螢幕字幕模式。確定要開始嗎？
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setPhase('idle')}
                className="px-4 py-2 rounded-lg text-sm text-on-surface-variant hover:bg-surface-container transition-colors cursor-pointer"
              >
                取消
              </button>
              <button
                onClick={start}
                className="px-4 py-2 rounded-lg text-sm font-bold bg-primary text-on-primary hover:bg-primary-hover transition-colors cursor-pointer"
              >
                確定播報
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Loading overlay while the script is generated */}
      {phase === 'loading' && (
        <div className="fixed inset-0 z-[70] flex flex-col items-center justify-center gap-3 bg-black/70">
          <div className="w-8 h-8 border-2 border-white/30 border-t-white rounded-full animate-spin" />
          <p className="text-white/80 text-sm">正在準備播報內容…</p>
        </div>
      )}

      {/* Broadcast mode — full-screen (hides the left chat); 2:1 preview | subtitles */}
      {broadcasting && (
        <div className="fixed inset-0 z-[70] flex flex-col bg-slate-100">
          {/* Header — clean light bar (compact on mobile, no wrap) */}
          <div className="flex items-center justify-between gap-2 px-4 sm:px-8 py-2.5 bg-white border-b border-slate-200 shadow-sm shrink-0">
            <div className="flex items-center gap-2 min-w-0 text-sm font-semibold text-slate-700">
              <span className="material-symbols-outlined text-[20px] text-amber-500 shrink-0">campaign</span>
              <span className="hidden sm:inline">語音播報</span>
              <span className="text-slate-300 hidden sm:inline">·</span>
              <span className="tabular-nums text-slate-500 font-normal shrink-0">第 {segIdx + 1}/{segments.length} 段</span>
              <span
                className={`inline-flex items-center gap-1 text-xs font-normal px-1.5 sm:px-2 py-0.5 rounded-full shrink-0 ${voiceNatural ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-700'}`}
                title={voiceNatural
                  ? `自然神經語音：${voiceName}`
                  : `${voiceName || '瀏覽器預設語音'}（較機械）— 改用 Edge 瀏覽器可獲得自然語音`}
              >
                <span className="material-symbols-outlined text-[14px]">{voiceNatural ? 'graphic_eq' : 'warning'}</span>
                <span className="hidden sm:inline">{voiceNatural ? '自然語音' : (voiceName ? '本機語音' : '預設語音')}</span>
              </span>
            </div>
            <button
              onClick={stop}
              className="flex items-center gap-1 px-2.5 sm:px-3 py-1.5 rounded-lg text-sm text-slate-500 hover:bg-slate-100 hover:text-slate-700 transition-colors cursor-pointer shrink-0"
            >
              <span className="material-symbols-outlined text-[18px]">close</span>
              <span className="hidden sm:inline">結束</span>
            </button>
          </div>

          {/* Body: left = page preview (≈2), right = subtitles (≈1) */}
          <div className="flex-1 flex flex-col md:flex-row min-h-0">
            {/* Preview pane — real page preview, framed on a soft dark stage.
                Mobile 1:1 with the subtitle; desktop 2:1. */}
            <div className="flex-1 md:flex-[2] flex min-h-0 min-w-0 overflow-hidden bg-slate-800 p-2 sm:p-5">
              <div className="flex-1 flex min-h-0 min-w-0 overflow-hidden rounded-xl shadow-2xl ring-1 ring-black/20">
                {renderPreview ? renderPreview(segIdx) : (
                  <div className="flex-1 flex items-center justify-center text-slate-400 text-sm">無預覽</div>
                )}
              </div>
            </div>

            {/* Subtitle pane — bright, teleprompter-style card */}
            <div className="flex-1 md:flex-[1] flex flex-col min-h-0 bg-white border-t md:border-t-0 md:border-l border-slate-200">
              {segments[segIdx]?.label && (
                <div className="px-6 pt-5 pb-2 shrink-0 flex items-center gap-2">
                  <span className="w-1 h-4 rounded-full bg-amber-400" />
                  <span className="text-slate-500 text-xs font-bold tracking-wide uppercase">{segments[segIdx].label}</span>
                </div>
              )}
              {/* Subtitles — current sentence highlighted amber */}
              <div className="flex-1 overflow-y-auto px-6 py-3">
                <p className="text-base leading-relaxed sm:text-2xl sm:leading-loose md:text-[1.7rem] font-medium tracking-wide">
                  {currentSentences.map((s, k) => (
                    <span
                      key={k}
                      ref={k === sentIdx ? activeSentRef : undefined}
                      className={k === sentIdx
                        ? 'bg-amber-300/90 text-slate-900 rounded-md px-1 py-0.5 box-decoration-clone shadow-sm'
                        : 'text-slate-400'}
                    >
                      {s}
                    </span>
                  ))}
                </p>
              </div>

              {/* Progress dots + controls */}
              <div className="shrink-0 px-6 py-4 border-t border-slate-100 bg-slate-50/80">
                <div className="flex flex-wrap items-center gap-1.5 mb-3">
                  {segments.map((_, k) => (
                    <span
                      key={k}
                      className={`h-1.5 rounded-full transition-all ${k === segIdx ? 'w-6 bg-amber-400' : k < segIdx ? 'w-1.5 bg-slate-400' : 'w-1.5 bg-slate-200'}`}
                    />
                  ))}
                </div>
                <div className="flex items-center gap-2">
                  {phase === 'playing' ? (
                    <button
                      onClick={pause}
                      className="flex items-center justify-center gap-1.5 flex-1 px-4 py-2.5 rounded-full bg-slate-800 text-white hover:bg-slate-700 transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[20px]">pause</span>
                      暫停
                    </button>
                  ) : (
                    <button
                      onClick={resume}
                      className="flex items-center justify-center gap-1.5 flex-1 px-4 py-2.5 rounded-full bg-amber-400 text-slate-900 font-bold hover:bg-amber-300 transition-colors cursor-pointer"
                    >
                      <span className="material-symbols-outlined text-[20px]">play_arrow</span>
                      繼續
                    </button>
                  )}
                  <button
                    onClick={stop}
                    className="flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-[20px]">stop</span>
                    停止
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
