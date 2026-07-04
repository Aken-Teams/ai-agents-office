'use client';

/**
 * Create-only schedule modal. Building a schedule lives here; viewing schedules
 * and whether they ran on time lives on the /team/[id]/schedules calendar page.
 */

import { useState } from 'react';
import { useTranslation } from '../../i18n';
import { DOC_EXPORT, type ExportFormat } from './docFormats';

const DOW = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

export default function ScheduleCreateModal({
  teamId, token, defaultEmail, defaultQuestion, onClose, onCreated,
}: {
  teamId: string;
  token: string | null;
  defaultEmail: string;
  defaultQuestion?: string;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [question, setQuestion] = useState(defaultQuestion?.trim() || '');
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [time, setTime] = useState('09:00');
  const [email, setEmail] = useState(defaultEmail);
  // Optional: also produce a file each run ('' = text report only).
  const [docFormat, setDocFormat] = useState<ExportFormat | ''>('');
  const [docStyleId, setDocStyleId] = useState('');
  const docFmt = docFormat ? DOC_EXPORT.find(f => f.format === docFormat) : null;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headers = (): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {});

  function pickDocFormat(f: ExportFormat | '') {
    setDocFormat(f);
    if (f) setDocStyleId(DOC_EXPORT.find(x => x.format === f)!.styles[0].id);
  }

  const add = async () => {
    if (!question.trim() || !email.trim() || saving) return;
    const [h, m] = time.split(':').map(Number);
    setSaving(true);
    setError(null);
    let docFields: Record<string, string> = {};
    if (docFormat && docFmt) {
      const style = docFmt.styles.find(s => s.id === docStyleId) || docFmt.styles[0];
      docFields = { docFormat, docStylePrompt: (t(style.promptKey as never) as string) || '' };
    }
    try {
      const res = await fetch(`/api/teams/${teamId}/schedules`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), question: question.trim(), frequency, hour: h, minute: m, dayOfWeek, email: email.trim(), ...docFields }),
      });
      if (res.ok) { onCreated?.(); onClose(); return; }
      // Surface the server's reason instead of leaving the modal silently stuck.
      const msg = await res.json().catch(() => null);
      setError(msg?.error || `建立失敗（伺服器回應 ${res.status}）`);
    } catch {
      setError('無法連線到伺服器，請稍後再試。');
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-lg max-h-[88vh] overflow-y-auto p-6" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2 mb-1">
          <span className="material-symbols-outlined text-primary">add_alarm</span>
          <h3 className="text-lg font-headline font-bold text-on-surface">新增排程</h3>
        </div>
        <p className="text-sm text-on-surface-variant mb-5">設定時間，團隊會自動跑分析、把結果寄到信箱，並記錄在排程管理頁。</p>

        <label className="block text-xs font-bold text-on-surface-variant mb-1.5">排程名稱<span className="font-normal text-on-surface-variant/60">（給這個排程取個好認的名字）</span></label>
        <input value={name} onChange={e => setName(e.target.value)} placeholder="例如：每日台股盤勢"
          className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary mb-3" />

        <label className="block text-xs font-bold text-on-surface-variant mb-1.5">分析議題 / 需求<span className="font-normal text-on-surface-variant/60">（團隊真正要分析的內容）</span></label>
        <textarea value={question} onChange={e => setQuestion(e.target.value)} rows={2} placeholder="要團隊定期分析的議題，例如：今天的台股盤勢與我持股的風險"
          className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface resize-none focus:outline-none focus:border-primary mb-3" />

        <div className="flex flex-wrap items-center gap-3 mb-3">
          <div className="flex rounded-lg border border-outline-variant/30 overflow-hidden">
            <button onClick={() => setFrequency('daily')} className={`px-3 py-1.5 text-sm cursor-pointer ${frequency === 'daily' ? 'cyber-gradient text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>每天</button>
            <button onClick={() => setFrequency('weekly')} className={`px-3 py-1.5 text-sm cursor-pointer ${frequency === 'weekly' ? 'cyber-gradient text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>每週</button>
          </div>
          {frequency === 'weekly' && (
            <select value={dayOfWeek} onChange={e => setDayOfWeek(Number(e.target.value))}
              className="bg-surface-container border border-outline-variant/30 rounded-lg px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary cursor-pointer">
              {DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}
            </select>
          )}
          <input type="time" value={time} onChange={e => setTime(e.target.value)}
            className="bg-surface-container border border-outline-variant/30 rounded-lg px-2 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary" />
        </div>

        <label className="block text-xs font-bold uppercase tracking-wider text-on-surface-variant mb-1.5">收件 Email</label>
        <input value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com"
          className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary mb-4" />

        {/* Optional: also generate a file each run, delivered as a download link */}
        <label className="block text-xs font-bold text-on-surface-variant mb-1.5">順便產生文件<span className="font-normal text-on-surface-variant/60">（選填，每次跑完會產出檔案並附下載連結）</span></label>
        <div className="grid grid-cols-5 gap-2 mb-2">
          <button type="button" onClick={() => pickDocFormat('')}
            className={`flex flex-col items-center gap-0.5 rounded-xl border p-2 transition-colors cursor-pointer ${!docFormat ? 'border-primary bg-primary/10' : 'border-outline-variant/20 hover:bg-surface-container'}`}>
            <span className={`material-symbols-outlined text-[18px] ${!docFormat ? 'text-primary' : 'text-on-surface-variant'}`}>block</span>
            <span className={`text-[11px] font-bold ${!docFormat ? 'text-primary' : 'text-on-surface'}`}>不產生</span>
          </button>
          {DOC_EXPORT.map(f => (
            <button key={f.format} type="button" onClick={() => pickDocFormat(f.format)}
              className={`flex flex-col items-center gap-0.5 rounded-xl border p-2 transition-colors cursor-pointer ${docFormat === f.format ? 'border-primary bg-primary/10' : 'border-outline-variant/20 hover:bg-surface-container'}`}>
              <span className={`material-symbols-outlined text-[18px] ${docFormat === f.format ? 'text-primary' : 'text-on-surface-variant'}`}>{f.icon}</span>
              <span className={`text-[11px] font-bold ${docFormat === f.format ? 'text-primary' : 'text-on-surface'}`}>{f.label}</span>
            </button>
          ))}
        </div>
        {docFmt && (
          <div className="flex flex-wrap gap-1.5 mb-2">
            {docFmt.styles.map(s => (
              <button key={s.id} type="button" onClick={() => setDocStyleId(s.id)}
                className={`px-2.5 py-1 rounded-lg text-xs font-bold border transition-colors cursor-pointer ${docStyleId === s.id ? 'border-primary bg-primary/10 text-primary' : 'border-outline-variant/20 text-on-surface-variant hover:bg-surface-container'}`}>
                {(t(s.labelKey as never) as string) || s.id}
              </button>
            ))}
          </div>
        )}
        {docFmt && <p className="text-[11px] text-on-surface-variant/60 mb-5">產檔較久（簡報約 3–8 分鐘），排程在背景執行，不影響信件寄送；完成後下載連結會附在信裡。</p>}
        {!docFmt && <div className="mb-5" />}

        {error && (
          <div className="flex items-start gap-2 mb-3 px-3 py-2.5 rounded-xl bg-error-container/60 text-on-error-container text-sm">
            <span className="material-symbols-outlined text-base leading-5">error</span>
            <span>{error}</span>
          </div>
        )}

        <div className="flex items-center justify-end gap-2 pt-4 border-t border-outline-variant/15">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-bold text-on-surface-variant hover:bg-surface-container-high transition-colors cursor-pointer">取消</button>
          <button onClick={add} disabled={!question.trim() || !email.trim() || saving}
            className="px-5 py-2 rounded-xl text-sm font-bold text-on-primary cyber-gradient disabled:opacity-40 disabled:cursor-not-allowed transition-all cursor-pointer flex items-center gap-2">
            {saving && <span className="material-symbols-outlined animate-spin text-base">progress_activity</span>}
            建立排程
          </button>
        </div>
      </div>
    </div>
  );
}
