'use client';

/**
 * Create-only schedule modal. Building a schedule lives here; viewing schedules
 * and whether they ran on time lives on the /team/[id]/schedules calendar page.
 */

import { useState } from 'react';

const DOW = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

export default function ScheduleCreateModal({
  teamId, token, defaultEmail, onClose, onCreated,
}: {
  teamId: string;
  token: string | null;
  defaultEmail: string;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [name, setName] = useState('');
  const [question, setQuestion] = useState('');
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('daily');
  const [dayOfWeek, setDayOfWeek] = useState(1);
  const [time, setTime] = useState('09:00');
  const [email, setEmail] = useState(defaultEmail);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const headers = (): HeadersInit => (token ? { Authorization: `Bearer ${token}` } : {});

  const add = async () => {
    if (!question.trim() || !email.trim() || saving) return;
    const [h, m] = time.split(':').map(Number);
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/teams/${teamId}/schedules`, {
        method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), question: question.trim(), frequency, hour: h, minute: m, dayOfWeek, email: email.trim() }),
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
          className="w-full bg-surface-container border border-outline-variant/30 rounded-xl px-3 py-2.5 text-sm text-on-surface focus:outline-none focus:border-primary mb-5" />

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
