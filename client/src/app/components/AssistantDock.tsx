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
import EmailAgentWidget from './EmailAgentWidget';
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

  const loadKmPref = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/km-agent/preference`, { headers: authHeaders() });
      if (!res.ok) { setKmAvailable(false); return; }
      const d = await res.json();
      setKmAvailable(true);
      setKmEnabled(d.enabled === 1);
    } catch { setKmAvailable(false); }
  }, []);

  useEffect(() => { setMounted(true); loadKmPref(); }, [loadKmPref]);

  if (!mounted) return null;

  // Tabs currently available in the dock.
  const tabs: Which[] = [];
  if (emailAvailable) tabs.push('email');
  if (kmAvailable && kmEnabled) tabs.push('km');
  const canConfigure = emailAvailable || kmAvailable; // settings reachable if any assistant exists
  if (tabs.length === 0 && !canConfigure) return null;

  const activeTab: Which = tabs.includes(active) ? active : (tabs[0] ?? 'email');
  const showSwitcher = tabs.length > 1;
  const title = activeTab === 'km' ? 'KM 助手' : '信件助手';

  const dock = (
    <>
      {/* One bubble */}
      <button
        onClick={() => setOpen(o => !o)}
        className={`fixed bottom-4 right-4 md:bottom-6 md:right-6 ${open ? 'z-[96] scale-90' : 'z-[90]'} w-12 h-12 md:w-14 md:h-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-300 ${open ? 'bg-surface-container-high text-on-surface max-md:hidden' : 'bg-primary text-on-primary hover:shadow-2xl'}`}
        title="AI 助手"
      >
        <span className="material-symbols-outlined text-xl md:text-2xl">{open ? 'close' : 'smart_toy'}</span>
      </button>

      {/* Panel — always mounted (hidden when collapsed) so email SSE stays alive */}
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
          <button onClick={() => setOpen(false)} title="收合" className="w-8 h-8 flex items-center justify-center rounded-full text-on-surface-variant hover:bg-surface-container-highest shrink-0 md:hidden">
            <span className="material-symbols-outlined text-xl">close</span>
          </button>
        </div>

        {/* Body — both assistants mounted; inactive one hidden (keeps state/SSE) */}
        <div className="relative flex-1 min-h-0">
          {emailAvailable && (
            <div className={activeTab === 'email' ? 'absolute inset-0' : 'hidden'}>
              <EmailAgentWidget embedded />
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
          onChanged={loadKmPref}
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
