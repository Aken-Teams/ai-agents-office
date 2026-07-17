'use client';

/**
 * AssistantDock — the single bottom-right launcher that hosts the resident
 * assistants (信件助手 / KM 助手) under one bubble with a top switcher, so they no
 * longer clash in the corner. Each assistant renders in "embedded" mode (no own
 * bubble) inside the dock's panel body.
 *
 * The panel is always mounted (hidden when collapsed) so the email assistant's SSE
 * stays connected exactly as before. A gear opens 助手設定 to enable/disable each.
 */
import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import EmailAgentWidget, { type EmailWidgetStatus } from './EmailAgentWidget';
import KMAssistantWidget from './KMAssistantWidget';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
type Which = 'email' | 'km';

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export default function AssistantDock({ emailAvailable }: { emailAvailable: boolean }) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<Which>('email');
  const [settingsOpen, setSettingsOpen] = useState(false);

  // KM availability (endpoint 403 → KM not deployed) + user's on/off pref.
  const [kmAvailable, setKmAvailable] = useState(false);
  const [kmEnabled, setKmEnabled] = useState(false);
  // Email status lifted from the embedded widget → drives the bubble badge/icon/toast.
  const [emailStatus, setEmailStatus] = useState<EmailWidgetStatus>({ badge: 0, working: false, enabled: false, connected: false, toast: null });
  // Bumped when 助手設定 toggles email, so the embedded widget re-reads its pref
  // (otherwise the bubble wouldn't grey out after toggling email off in settings).
  const [emailPrefNonce, setEmailPrefNonce] = useState(0);
  // Dock-level "hide to edge": collapse the whole dock to a thin strip so the
  // corner isn't permanently occupied by an AI bubble. The panel stays MOUNTED
  // (hidden) so email SSE keeps running in the background.
  const [hidden, setHidden] = useState(false);
  // Toggle between "edge strip" mode and "corner bubble" mode (persisted). While
  // hidden, closing the panel returns to the strip (not the bubble) — the user
  // opted out of the corner bubble, so we respect that until they un-hide.
  const toggleHidden = () => setHidden(h => { const nv = !h; try { localStorage.setItem('assistant-dock-hidden', nv ? '1' : '0'); } catch { /* ignore */ } return nv; });

  // Email on/off pref (null = never asked, 0 = off, 1 = on). Drives whether the
  // email tab appears — off means it's dropped from the dock, not just AI-muted.
  const [emailPref, setEmailPref] = useState<number | null>(null);

  const loadKmPref = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/km-agent/preference`, { headers: authHeaders() });
      if (!res.ok) { setKmAvailable(false); return; }
      const d = await res.json();
      setKmAvailable(true);
      setKmEnabled(d.enabled === 1);
    } catch { setKmAvailable(false); }
  }, []);
  const loadEmailPref = useCallback(async () => {
    if (!emailAvailable) return;
    try {
      const res = await fetch(`${API_BASE}/api/email-agent/preference`, { headers: authHeaders() });
      if (res.ok) { const d = await res.json(); setEmailPref(d.enabled ?? null); }
    } catch { /* ignore */ }
  }, [emailAvailable]);
  const reloadPrefs = useCallback(() => { loadKmPref(); loadEmailPref(); }, [loadKmPref, loadEmailPref]);

  useEffect(() => {
    setMounted(true);
    reloadPrefs();
    try { if (localStorage.getItem('assistant-dock-hidden') === '1') setHidden(true); } catch { /* ignore */ }
  }, [reloadPrefs]);

  if (!mounted) return null;

  // A tab appears only when its assistant is ENABLED. Email: shown unless explicitly
  // turned off (0) — null (never asked) still shows so the opt-in flow works.
  const emailInDock = emailAvailable && emailPref !== 0;
  const kmInDock = kmAvailable && kmEnabled;

  const tabs: Which[] = [];
  if (emailInDock) tabs.push('email');
  if (kmInDock) tabs.push('km');
  const canConfigure = emailAvailable || kmAvailable; // settings reachable if any assistant exists
  if (tabs.length === 0 && !canConfigure) return null;

  const activeTab: Which = tabs.includes(active) ? active : (tabs[0] ?? 'email');
  const showSwitcher = tabs.length > 1;
  const title = activeTab === 'km' ? 'KM 助手' : '信件助手';

  // What the CLOSED bubble represents: the most relevant enabled assistant, so a
  // user can tell at a glance which is active (email off → shows the KM icon).
  const bubbleAssistant: Which =
    (emailInDock && emailStatus.enabled) ? 'email'
      : kmInDock ? 'km'
        : emailInDock ? 'email' : 'km';
  // Email is "live" (primary colour + badge + working dots) only when its AI is on.
  const emailLive = bubbleAssistant === 'email' && emailStatus.enabled;
  const bubbleColored = open ? true : (bubbleAssistant === 'km' || emailLive);
  const bubbleIcon = bubbleAssistant === 'km' ? 'menu_book' : 'smart_toy';
  const showBadge = !open && emailLive && emailStatus.badge > 0;
  const showWorking = !open && emailLive && emailStatus.working;

  const dock = (
    <>
      {/* Hidden (collapsed): edge tab on the right — click opens the panel */}
      {hidden && !open && (
        <button onClick={() => setOpen(true)}
          className="group fixed z-[90] bottom-24 right-0 w-9 h-[68px] pl-1 rounded-l-2xl bg-primary text-on-primary shadow-lg flex items-center justify-center hover:w-11 transition-all">
          <span className="material-symbols-outlined text-[22px]">{bubbleIcon}</span>
          {emailLive && emailStatus.badge > 0 && (
            <span className="absolute -top-1.5 left-0 min-w-[18px] h-[18px] flex items-center justify-center bg-error text-on-error text-[10px] font-bold rounded-full px-1 shadow">
              {emailStatus.badge > 99 ? '99+' : emailStatus.badge}
            </span>
          )}
          {/* Styled tooltip to the LEFT of the edge tab */}
          <span className="pointer-events-none absolute right-full mr-2 top-1/2 -translate-y-1/2 px-2.5 py-1 rounded-lg bg-inverse-surface text-inverse-on-surface text-[11px] font-medium whitespace-nowrap opacity-0 translate-x-1 transition-all duration-150 group-hover:opacity-100 group-hover:translate-x-0 shadow-lg">
            開啟 AI 助手{emailLive && emailStatus.badge > 0 ? `（${emailStatus.badge} 封未讀）` : ''}
          </span>
        </button>
      )}

      {/* Corner bubble — only when not hidden and collapsed */}
      {!hidden && !open && (
      <button
        onClick={() => setOpen(true)}
        className={`fixed bottom-4 right-4 md:bottom-6 md:right-6 ${open ? 'z-[96] scale-90 max-md:hidden' : 'z-[90]'} w-12 h-12 md:w-14 md:h-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-300 ${bubbleColored ? 'bg-primary text-on-primary hover:shadow-2xl' : 'bg-outline text-surface hover:shadow-2xl'}`}
        title="AI 助手"
      >
        {showWorking ? (
          <span className="flex items-center gap-[2px]">
            {[0, 1, 2].map(i => <span key={i} className="w-[5px] h-[5px] md:w-1.5 md:h-1.5 bg-on-primary rounded-full animate-bounce" style={{ animationDelay: `${i * 150}ms`, animationDuration: '0.8s' }} />)}
          </span>
        ) : (
          <span className="material-symbols-outlined text-xl md:text-2xl">{open ? 'close' : bubbleIcon}</span>
        )}
        {showBadge && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] md:min-w-[20px] md:h-5 flex items-center justify-center bg-error text-on-error text-[10px] md:text-xs font-bold rounded-full px-1">
            {emailStatus.badge > 99 ? '99+' : emailStatus.badge}
          </span>
        )}
        {!open && emailLive && emailStatus.connected && (
          <span className="absolute bottom-0 right-0 w-2.5 h-2.5 md:w-3 md:h-3 bg-success rounded-full border-2 border-surface" />
        )}
      </button>
      )}

      {/* New-mail toast — to the LEFT of the bubble; surfaced from the email widget
          so it pops even when the dock is collapsed. Click → open email. */}
      {!open && !hidden && emailLive && emailStatus.toast && (
        <div className="fixed z-[91] bottom-5 right-[76px] md:bottom-7 md:right-[92px] animate-in slide-in-from-right-2 fade-in duration-300">
          <button
            onClick={() => { setActive('email'); setOpen(true); }}
            className="w-[260px] md:w-[300px] text-left bg-surface-container-high border border-outline-variant/20 rounded-2xl shadow-xl px-3.5 py-2.5 hover:bg-surface-container-highest transition-colors"
          >
            <div className="flex items-start gap-2">
              <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5"><span className="material-symbols-outlined text-primary text-sm">mail</span></div>
              <div className="flex-1 min-w-0">
                <p className="text-xs md:text-sm text-on-surface leading-relaxed">{emailStatus.toast}</p>
                <p className="text-[10px] md:text-xs text-on-surface-variant/60 mt-1">點擊查看信件</p>
              </div>
            </div>
          </button>
        </div>
      )}

      {/* Panel — always mounted (hidden when collapsed/hidden) so email SSE stays alive */}
      <div className={`fixed top-0 right-0 bottom-0 left-0 md:top-auto md:left-auto md:bottom-24 md:right-6 z-[95] md:w-[min(520px,calc(100vw-5rem))] md:h-[min(700px,calc(100vh-8rem))] bg-surface-container-high md:rounded-2xl shadow-2xl md:border md:border-outline-variant/10 flex flex-col overflow-hidden safe-area-top safe-area-bottom ${open ? '' : 'hidden'}`}>
        {/* Switcher / title header */}
        <div className="flex items-center gap-1 px-2 py-1.5 border-b border-outline-variant/10 shrink-0">
          {showSwitcher ? (
            <div className="flex-1 flex items-center gap-1">
              {tabs.map(w => (
                <button key={w} onClick={() => setActive(w)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors flex items-center gap-1.5 ${activeTab === w ? 'bg-primary/10 text-primary' : 'text-on-surface-variant hover:bg-surface-container-highest'}`}>
                  <span className="material-symbols-outlined text-lg">{w === 'km' ? 'menu_book' : 'mail'}</span>
                  {w === 'km' ? 'KM 助手' : '信件助手'}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex-1 flex items-center gap-2 px-2">
              <span className="material-symbols-outlined text-primary text-xl">{activeTab === 'km' ? 'menu_book' : 'smart_toy'}</span>
              <span className="text-sm font-semibold text-on-surface">{title}</span>
            </div>
          )}
          <button onClick={() => setSettingsOpen(true)} title="助手設定" className="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest shrink-0">
            <span className="material-symbols-outlined text-xl">tune</span>
          </button>
          <button onClick={toggleHidden} title={hidden ? '改用角落泡泡' : '隱藏到側邊'} className="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest shrink-0">
            <span className="material-symbols-outlined text-xl">{hidden ? 'push_pin' : 'right_panel_close'}</span>
          </button>
          <button onClick={() => setOpen(false)} title="收合" className="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest shrink-0">
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* Body — both assistants mounted; inactive one hidden (keeps state/SSE) */}
        <div className="relative flex-1 min-h-0">
          {emailInDock && (
            <div className={activeTab === 'email' ? 'absolute inset-0' : 'hidden'}>
              <EmailAgentWidget embedded onStatus={setEmailStatus} prefNonce={emailPrefNonce} />
            </div>
          )}
          {kmAvailable && kmEnabled && (
            <div className={activeTab === 'km' ? 'absolute inset-0' : 'hidden'}>
              <KMAssistantWidget />
            </div>
          )}
        </div>
      </div>

      {settingsOpen && (
        <AssistantSettings
          emailAvailable={emailAvailable}
          kmAvailable={kmAvailable}
          onClose={() => setSettingsOpen(false)}
          onChanged={() => { reloadPrefs(); setEmailPrefNonce(n => n + 1); }}
        />
      )}
    </>
  );

  return createPortal(dock, document.body);
}

// ── 助手設定 — enable/disable each resident assistant ──
function AssistantSettings({ emailAvailable, kmAvailable, onClose, onChanged }: {
  emailAvailable: boolean; kmAvailable: boolean; onClose: () => void; onChanged: () => void;
}) {
  const [emailPref, setEmailPref] = useState<number | null>(null);
  const [kmPref, setKmPref] = useState<number | null>(null);
  const [saving, setSaving] = useState<string>('');

  useEffect(() => {
    if (emailAvailable) fetch(`${API_BASE}/api/email-agent/preference`, { headers: authHeaders() }).then(r => r.json()).then(d => setEmailPref(d.enabled ?? null)).catch(() => {});
    if (kmAvailable) fetch(`${API_BASE}/api/km-agent/preference`, { headers: authHeaders() }).then(r => r.json()).then(d => setKmPref(d.enabled ?? null)).catch(() => {});
  }, [emailAvailable, kmAvailable]);

  async function setPref(which: 'email' | 'km', on: boolean) {
    setSaving(which);
    try {
      const url = which === 'email' ? '/api/email-agent/preference' : '/api/km-agent/preference';
      await fetch(`${API_BASE}${url}`, { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: on }) });
      if (which === 'email') setEmailPref(on ? 1 : 0); else setKmPref(on ? 1 : 0);
      onChanged();
    } catch { /* ignore */ }
    finally { setSaving(''); }
  }

  const Row = ({ id, icon, label, desc, on, note }: { id: 'email' | 'km'; icon: string; label: string; desc: string; on: boolean; note?: string }) => (
    <div className="flex items-start gap-3 p-3 rounded-xl bg-surface-container">
      <span className="material-symbols-outlined text-primary text-xl mt-0.5 shrink-0">{icon}</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-on-surface">{label}</p>
        <p className="text-xs text-on-surface-variant/70 mt-0.5">{desc}</p>
        {note && <p className="text-[11px] text-on-surface-variant/50 mt-1">{note}</p>}
      </div>
      <button onClick={() => setPref(id, !on)} disabled={saving === id}
        className={`shrink-0 transition-colors ${on ? 'text-primary' : 'text-on-surface-variant/50'} disabled:opacity-50`}>
        <span className={`material-symbols-outlined text-[32px] ${saving === id ? 'animate-spin' : ''}`}>{saving === id ? 'progress_activity' : on ? 'toggle_on' : 'toggle_off'}</span>
      </button>
    </div>
  );

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-md p-5" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-primary">tune</span>
          <h3 className="text-lg font-bold text-on-surface">助手設定</h3>
          <button onClick={onClose} className="ml-auto w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container"><span className="material-symbols-outlined">close</span></button>
        </div>
        <p className="text-xs text-on-surface-variant/70 mb-4">選擇右下角要開啟哪些 AI 駐守。開啟多個時，可在面板上方切換。</p>
        <div className="space-y-2.5">
          {emailAvailable && (
            <Row id="email" icon="mail" label="信件助手" on={emailPref === 1}
              desc="AI 摘要、分類、深度分析你的 Outlook 信件。"
              note={emailPref === 1 ? '已開啟 AI（依用量計費）' : '關閉時仍可純檢視信件、不計費'} />
          )}
          {kmAvailable && (
            <Row id="km" icon="menu_book" label="KM 助手" on={kmPref === 1}
              desc="搜尋、檢視、下載你有權限的 KM 文件；並可 AI 問答附來源。" />
          )}
          {!emailAvailable && !kmAvailable && (
            <p className="text-sm text-on-surface-variant py-4 text-center">目前沒有可用的助手。</p>
          )}
        </div>
      </div>
    </div>
  );
}
