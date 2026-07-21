'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface AuditEntry {
  event_type: string;
  event_id: string;
  actor: string | null;
  actor_name: string | null;
  detail: string | null;
  created_at: string;
}

interface MailGatewayStats {
  max: number; active: number; queued: number; peakQueued: number; cooldownMs: number;
  totalRequests: number; rateLimited: number; recovered: number; surfaced: number;
}
interface SecurityStats {
  totalAuditEntries: number;
  totalUsers: number;
  suspendedUsers: number;
  totalConversations: number;
  totalFiles: number;
  securityEventsCount: number;
  blockedThreats: number;
  systemUptime: number;
  mailGateway?: MailGatewayStats;
}

interface SecurityEvent {
  id: string;
  user_id: string;
  user_email: string | null;
  user_name: string | null;
  event_type: string;
  severity: string;
  detail: string;
  raw_input: string | null;
  created_at: string;
}

interface WorkspaceScan {
  userId: string;
  email: string;
  displayName: string | null;
  dirCount: number;
  fileCount: number;
  totalSize: number;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

export default function AdminSecurity() {
  const { token, isReadonly } = useAdminAuth();
  const { t } = useTranslation();
  const [stats, setStats] = useState<SecurityStats | null>(null);
  const [auditLog, setAuditLog] = useState<AuditEntry[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditPage, setAuditPage] = useState(1);
  const [auditTotalPages, setAuditTotalPages] = useState(1);
  const [workspace, setWorkspace] = useState<WorkspaceScan[]>([]);
  const [scanning, setScanning] = useState(false);
  const [lastScan, setLastScan] = useState<string | null>(null);
  const [secEvents, setSecEvents] = useState<SecurityEvent[]>([]);
  const [secPage, setSecPage] = useState(1);
  const [secTotal, setSecTotal] = useState(0);
  const [secTotalPages, setSecTotalPages] = useState(1);
  const [exporting, setExporting] = useState(false);
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportFrom, setReportFrom] = useState('');
  const [reportTo, setReportTo] = useState('');
  const [reportStage, setReportStage] = useState('');
  const [reportError, setReportError] = useState('');
  // 信件 Gateway 壓測 (reproduces the class-burst without needing 30 AD accounts).
  const [gwN, setGwN] = useState(30);
  const [gwRounds, setGwRounds] = useState(1);
  const [gwTesting, setGwTesting] = useState(false);
  const [gwTest, setGwTest] = useState<any>(null);
  // Read an SSE (data: {...}) stream, calling onEvent for each parsed event.
  async function readSSE(res: Response, onEvent: (ev: any) => void) {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop() || '';
      for (const part of parts) {
        const line = part.split('\n').find(l => l.startsWith('data:'));
        if (line) { try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* skip */ } }
      }
    }
  }

  async function runGwTest() {
    if (!token || gwTesting) return;
    setGwTesting(true); setGwTest(null);
    try {
      const r = await fetch('/api/admin/security/mail-gateway/selftest', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ n: gwN, rounds: gwRounds }),
      });
      if (!r.ok || !r.body) { const d = await r.json().catch(() => null); setGwTest({ error: (d && d.error) || `測試失敗（${r.status}）` }); return; }
      let doneEv: any = null;
      await readSSE(r, ev => { if (ev.type === 'done') doneEv = ev; });
      setGwTest(doneEv || { error: '沒有回應' });
      fetch('/api/admin/security/stats', { headers: { Authorization: `Bearer ${token}` } })
        .then(res => res.json()).then(setStats).catch(() => {});
    } catch { setGwTest({ error: '連線失敗' }); }
    finally { setGwTesting(false); }
  }

  async function generateReport() {
    if (!token || exporting) return;
    if (reportFrom && reportTo && reportTo < reportFrom) {
      setReportError('\u7D50\u675F\u65E5\u671F\u4E0D\u53EF\u65E9\u65BC\u958B\u59CB\u65E5\u671F');
      return;
    }
    setReportError('');
    setExporting(true);
    setReportStage('\u6B63\u5728\u5F59\u6574\u8CC7\u5B89\u8CC7\u6599\u2026');
    // Translate raw HTTP failures into plain language so a permission block
    // reads as "no permission" rather than a cryptic code that looks like a bug.
    const friendlyHttp = (status: number) =>
      status === 403 ? '\u60A8\u7684\u5E33\u865F\u6C92\u6709\u7522\u751F\u6B64\u5831\u544A\u7684\u6B0A\u9650\uFF0C\u8ACB\u806F\u7E6B\u7CFB\u7D71\u7BA1\u7406\u8005'
        : status === 401 ? '\u767B\u5165\u5DF2\u903E\u671F\uFF0C\u8ACB\u91CD\u65B0\u767B\u5165\u5F8C\u518D\u8A66'
        : `\u4F3A\u670D\u5668\u56DE\u61C9\u7570\u5E38\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66 (\u4EE3\u78BC ${status})`;
    try {
      const startRes = await fetch('/api/admin/security/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ from: reportFrom || null, to: reportTo || null }),
      });
      if (!startRes.ok) throw new Error(friendlyHttp(startRes.status));
      const { jobId } = await startRes.json();
      setReportStage('AI \u6B63\u5728\u64B0\u5BEB\u5C08\u696D\u5831\u544A\uFF0C\u7D04\u9700 1\u20133 \u5206\u9418\u2026');

      // Poll until done / error (report generation can take a couple of minutes).
      const deadline = Date.now() + 6 * 60_000;
      for (;;) {
        await new Promise(r => setTimeout(r, 3000));
        if (Date.now() > deadline) throw new Error('timeout');
        const st = await fetch(`/api/admin/security/report/${jobId}/status`, { headers: { Authorization: `Bearer ${token}` } });
        if (!st.ok) throw new Error(friendlyHttp(st.status));
        const data = await st.json();
        if (data.status === 'error') throw new Error(data.error || '\u7522\u751F\u5931\u6557');
        if (data.status === 'done') break;
      }

      setReportStage('\u6B63\u5728\u4E0B\u8F09\u5831\u544A\u2026');
      const dl = await fetch(`/api/admin/security/report/${jobId}/download`, { headers: { Authorization: `Bearer ${token}` } });
      if (!dl.ok) throw new Error(friendlyHttp(dl.status));
      const blob = await dl.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `security_report_${new Date().toISOString().slice(0, 10)}.docx`; a.click();
      URL.revokeObjectURL(url);
      setShowReportModal(false);
      setReportStage('');
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      setReportError(msg === 'timeout' ? '\u7522\u751F\u903E\u6642\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66' : (msg || '\u7522\u751F\u5831\u544A\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66'));
      setReportStage('');
    } finally { setExporting(false); }
  }

  const EVENT_META: Record<string, { label: string; color: string }> = {
    user_registered:      { label: t('admin.security.event.userRegistered'), color: 'text-tertiary' },
    conversation_created: { label: t('admin.security.event.conversationCreated'), color: 'text-on-surface-variant' },
    file_generated:       { label: t('admin.security.event.fileGenerated'), color: 'text-success' },
    admin_suspend_user:   { label: t('admin.security.event.adminSuspendUser'), color: 'text-error' },
    admin_activate_user:  { label: t('admin.security.event.adminActivateUser'), color: 'text-success' },
  };

  function formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) parts.push(`${d}${t('admin.security.uptime.days')}`);
    if (h > 0) parts.push(`${h}${t('admin.security.uptime.hours')}`);
    parts.push(`${m}${t('admin.security.uptime.minutes')}`);
    return parts.join(' ');
  }

  useEffect(() => {
    if (!token) return;
    fetch('/api/admin/security/stats', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json()).then(setStats).catch(console.error);
  }, [token]);

  const fetchAudit = useCallback(() => {
    if (!token) return;
    fetch(`/api/admin/security/audit-log?page=${auditPage}&limit=13`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setAuditLog(data.entries);
        setAuditTotal(data.total);
        setAuditTotalPages(data.totalPages);
      })
      .catch(console.error);
  }, [token, auditPage]);

  useEffect(() => { fetchAudit(); }, [fetchAudit]);

  const fetchSecEvents = useCallback(() => {
    if (!token) return;
    fetch(`/api/admin/security/events?page=${secPage}&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setSecEvents(data.events);
        setSecTotal(data.total);
        setSecTotalPages(data.totalPages);
      })
      .catch(console.error);
  }, [token, secPage]);

  useEffect(() => { fetchSecEvents(); }, [fetchSecEvents]);

  function handleScan() {
    if (!token || scanning) return;
    setScanning(true);
    fetch('/api/admin/security/workspace-scan', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setWorkspace(data);
        setLastScan(new Date().toLocaleTimeString('zh-TW'));
      })
      .catch(console.error)
      .finally(() => setScanning(false));
  }

  const totalDisk = workspace.reduce((sum, w) => sum + w.totalSize, 0);
  const totalFiles = workspace.reduce((sum, w) => sum + w.fileCount, 0);
  const maxSize = Math.max(...workspace.map(w => w.totalSize), 1);

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <span className="text-base md:text-lg font-black text-on-surface font-headline">{t('admin.security.title')}</span>
        {/* Report generation is admin-only; reviewers (readonly) don't see it. */}
        {!isReadonly && (
          <button
            onClick={() => { setShowReportModal(true); setReportError(''); setReportStage(''); }}
            disabled={exporting}
            className="flex items-center gap-1.5 md:gap-2 px-2.5 md:px-4 py-1.5 md:py-2 bg-surface-container text-on-surface-variant text-xs md:text-sm font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer shrink-0 disabled:opacity-50"
          >
            <span className={`material-symbols-outlined text-sm ${exporting ? 'animate-spin' : ''}`}>{exporting ? 'progress_activity' : 'description'}</span>
            {t('admin.security.exportLog')}
          </button>
        )}
      </header>

      {/* AI Security Report Modal — pick date range, then AI writes a formal Word report */}
      {showReportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={() => { if (!exporting) setShowReportModal(false); }}>
          <div className="w-full max-w-md bg-surface rounded-2xl shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 px-5 py-4 border-b border-outline-variant/10">
              <span className="material-symbols-outlined text-primary">shield_lock</span>
              <h3 className="text-sm font-black text-on-surface">產生資安稽核報告（Word）</h3>
            </div>
            <div className="px-5 py-4 space-y-3">
              <p className="text-xs text-on-surface-variant leading-relaxed">
                由 AI 依實際系統日誌與資安事件，撰寫一份極度專業的正式資安稽核報告，並匯出為 Word (.docx) 檔案。
              </p>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-on-surface-variant w-10 shrink-0">開始</span>
                <input
                  type="date"
                  value={reportFrom}
                  max={reportTo || undefined}
                  disabled={exporting}
                  onChange={e => { setReportFrom(e.target.value); setReportError(''); }}
                  className="flex-1 bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary disabled:opacity-50"
                />
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs font-bold text-on-surface-variant w-10 shrink-0">結束</span>
                <input
                  type="date"
                  value={reportTo}
                  min={reportFrom || undefined}
                  disabled={exporting}
                  onChange={e => { setReportTo(e.target.value); setReportError(''); }}
                  className={`flex-1 bg-surface-container border rounded-lg px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary disabled:opacity-50 ${reportError ? 'border-error' : 'border-outline-variant/30'}`}
                />
              </div>
              {reportError ? (
                <p className="text-[11px] text-error pl-[52px] flex items-center gap-1">
                  <span className="material-symbols-outlined text-[13px]">error</span>{reportError}
                </p>
              ) : reportStage ? (
                <p className="text-[11px] text-primary pl-[52px] flex items-center gap-1.5">
                  <span className="material-symbols-outlined text-[13px] animate-spin">progress_activity</span>{reportStage}
                </p>
              ) : (
                <p className="text-[11px] text-on-surface-variant pl-[52px]">留空則涵蓋全部歷史資料</p>
              )}
            </div>
            <div className="flex gap-2 px-5 pb-5">
              <button
                onClick={() => setShowReportModal(false)}
                disabled={exporting}
                className="flex-1 py-2 rounded-lg text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer disabled:opacity-50"
              >取消</button>
              <button
                onClick={generateReport}
                disabled={exporting}
                className="flex-1 py-2 rounded-lg text-sm font-bold text-on-primary bg-primary hover:brightness-110 transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                <span className={`material-symbols-outlined text-sm ${exporting ? 'animate-spin' : ''}`}>{exporting ? 'progress_activity' : 'description'}</span>
                {exporting ? '產生中…' : '產生 Word 報告'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="p-4 md:p-8 flex-1 space-y-4 md:space-y-6 overflow-y-auto">
        {/* Stats Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-6">
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>shield</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.security.stats.securityEvents')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-on-surface">{stats?.securityEventsCount ?? 0}</span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">{t('admin.security.stats.securityEventsDesc')}</p>
          </div>
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>block</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.security.stats.blockedThreats')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-error">{stats?.blockedThreats ?? 0}</span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">{t('admin.security.stats.blockedThreatsDesc')}</p>
          </div>
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>schedule</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.security.stats.systemUptime')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-on-surface">{stats ? formatUptime(stats.systemUptime) : '\u2014'}</span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono hidden md:block">{t('admin.security.stats.systemUptimeDesc')}</p>
          </div>
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>description</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.security.stats.filesGenerated')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-primary">{stats?.totalFiles ?? 0}</span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">{t('admin.security.stats.filesGeneratedDesc', { count: stats?.totalConversations ?? 0 })}</p>
          </div>
        </div>

        {/* 信件 Gateway 限流閘門 — proof the rate-limit fix is absorbing bursts */}
        {stats?.mailGateway && (
          <div className="bg-surface-container rounded-lg overflow-hidden mb-4 md:mb-6">
            <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
              <span className="material-symbols-outlined text-primary text-base md:text-[24px]">mail_lock</span>
              <span className="text-xs md:text-sm font-bold uppercase tracking-widest flex-1">信件 GATEWAY 限流閘門</span>
              <span className="text-xs text-on-surface-variant/60">同時上限 {stats.mailGateway.max}</span>
            </div>
            <div className="p-4 md:p-6">
              {/* Cumulative counters */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
                {[
                  { label: '累計請求', v: stats.mailGateway.totalRequests, cls: 'text-on-surface' },
                  { label: 'gateway 回 429', v: stats.mailGateway.rateLimited, cls: 'text-warning' },
                  { label: '自動退避救回（無感）', v: stats.mailGateway.recovered, cls: 'text-success' },
                  { label: '真的失敗到前端', v: stats.mailGateway.surfaced, cls: stats.mailGateway.surfaced > 0 ? 'text-error' : 'text-on-surface-variant/50' },
                ].map((c, i) => (
                  <div key={i} className="rounded-lg bg-surface-container-high p-3">
                    <p className={`text-2xl font-headline font-bold ${c.cls}`}>{c.v}</p>
                    <p className="text-[11px] text-on-surface-variant/70 mt-0.5">{c.label}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-on-surface-variant/60 mt-3">
                目前在飛 {stats.mailGateway.active}／排隊 {stats.mailGateway.queued}（尖峰曾排 {stats.mailGateway.peakQueued}）。
                <span className="text-success">「自動退避救回」代表 429 有發生、但使用者沒感覺</span>；「真的失敗到前端」應接近 0。
              </p>

              {/* Self-test: fire N concurrent gateway requests (one token = same server IP burst)
                  through the gate, proving it queues the burst and serves everyone with 0 failures. */}
              <div className="mt-4 pt-4 border-t border-outline-variant/10">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium text-on-surface-variant">壓測(模擬多人同時開)：</span>
                  <input type="number" min={1} max={100} value={gwN} onChange={e => setGwN(Math.min(100, Math.max(1, parseInt(e.target.value) || 1)))}
                    className="w-16 px-2 py-1 text-sm rounded bg-surface-container-high border border-outline-variant/20" />
                  <span className="text-xs text-on-surface-variant/60">個併發 ×</span>
                  <input type="number" min={1} max={20} value={gwRounds} onChange={e => setGwRounds(Math.min(20, Math.max(1, parseInt(e.target.value) || 1)))}
                    className="w-14 px-2 py-1 text-sm rounded bg-surface-container-high border border-outline-variant/20" title="連續重複幾輪（測「持續速率」型的限流）" />
                  <span className="text-xs text-on-surface-variant/60">輪(持續)</span>
                  <button onClick={runGwTest} disabled={gwTesting}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 text-primary text-xs font-bold uppercase tracking-wider rounded hover:bg-primary/20 disabled:opacity-50">
                    <span className={`material-symbols-outlined text-sm ${gwTesting ? 'animate-spin' : ''}`}>{gwTesting ? 'progress_activity' : 'bolt'}</span>
                    經閘門壓測
                  </button>
                </div>
                {gwTest && (gwTest.error
                  ? <p className="mt-2 text-xs text-error">{gwTest.error}</p>
                  : <p className="mt-2 text-xs px-2.5 py-2 rounded bg-success/5 border border-success/20 text-on-surface">
                      <b className="text-success">經閘門</b>：{gwTest.total} 個請求({gwTest.n}併發×{gwTest.rounds}輪) → <b className="text-success">前端收到 429 {gwTest.rateLimitedResponses} 個</b>、成功 {gwTest.ok}；期間 gateway 實際回 429 <b>{gwTest.gateway429Hit}</b> 個(全被自動退避救回、使用者無感),峰值排隊 {gwTest.peakQueued},共 {(gwTest.totalMs / 1000).toFixed(1)}s。
                    </p>)}
                <p className="mt-1.5 text-[11px] text-on-surface-variant/50">模擬 N 個人同一秒打開信件助手。閘門會把爆量請求排隊、逐一送出,證明「前端收到 429 = 0、全部成功」。想測更兇就加大併發或輪數。</p>
              </div>
            </div>
          </div>
        )}

        {/* Workspace Scan + Audit Log */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 md:gap-6">
          {/* Workspace Disk Usage */}
          <div className="md:col-span-5 bg-surface-container rounded-lg overflow-hidden flex flex-col">
            <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
              <div className="flex items-center gap-2 md:gap-3">
                <span className="material-symbols-outlined text-primary text-base md:text-[24px]">hard_drive_2</span>
                <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.security.workspace.title')}</span>
              </div>
              <button
                onClick={handleScan}
                disabled={scanning}
                className="flex items-center gap-1 md:gap-1.5 px-2 md:px-3 py-1 md:py-1.5 bg-primary/10 text-primary text-xs md:text-sm font-bold uppercase tracking-wider rounded hover:bg-primary/20 transition-colors cursor-pointer disabled:opacity-50"
              >
                <span className={`material-symbols-outlined text-sm ${scanning ? 'animate-spin' : ''}`}>
                  {scanning ? 'progress_activity' : 'radar'}
                </span>
                {scanning ? t('admin.security.workspace.scanning') : t('admin.security.workspace.scan')}
              </button>
            </div>

            {workspace.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center p-6 md:p-8 text-on-surface-variant">
                <span className="material-symbols-outlined text-3xl md:text-4xl mb-3 opacity-30">folder_open</span>
                <p className="text-xs md:text-sm mb-1">{t('admin.security.workspace.notScanned')}</p>
                <p className="text-xs md:text-sm text-outline">{t('admin.security.workspace.notScannedHint')}</p>
              </div>
            ) : (
              <div className="flex-1 overflow-y-auto">
                <div className="px-4 md:px-6 py-2 md:py-3 border-b border-outline-variant/10 flex items-center justify-between">
                  <span className="text-xs md:text-sm text-on-surface-variant">
                    {t('admin.security.workspace.sandboxCount', { count: workspace.length })} · {t('admin.security.workspace.fileCount', { count: totalFiles })}
                    {lastScan && <span className="hidden md:inline text-outline ml-2">({t('admin.security.workspace.lastScan')} {lastScan})</span>}
                  </span>
                  <span className="text-xs md:text-sm font-mono font-bold text-on-surface">{formatFileSize(totalDisk)}</span>
                </div>
                <div className="divide-y divide-outline-variant/10">
                  {workspace.slice(0, 5).map(w => {
                    const pct = (w.totalSize / maxSize) * 100;
                    return (
                      <div key={w.userId} className="px-4 md:px-6 py-2.5 md:py-3 hover:bg-surface-container-high/50 transition-colors">
                        <div className="flex justify-between items-center mb-1.5">
                          <div className="min-w-0 flex-1">
                            {w.email === w.userId && !w.displayName ? (
                              <>
                                <p className="text-xs md:text-sm text-on-surface-variant truncate">{t('admin.security.workspace.unknownUser' as any) || '未知用戶'}</p>
                                <p className="text-[10px] md:text-sm text-on-surface-variant/50 font-mono truncate">{w.userId.slice(0, 8)}…</p>
                              </>
                            ) : (
                              <>
                                <p className="text-xs md:text-sm text-on-surface truncate">{w.displayName || w.email.split('@')[0]}</p>
                                <p className="text-[10px] md:text-sm text-on-surface-variant font-mono truncate">{w.email}</p>
                              </>
                            )}
                          </div>
                          <div className="text-right shrink-0 ml-3">
                            <p className="text-xs md:text-sm font-mono font-bold text-on-surface">{formatFileSize(w.totalSize)}</p>
                            <p className="text-[10px] md:text-sm text-on-surface-variant">{t('admin.security.workspace.fileCount', { count: w.fileCount })}</p>
                          </div>
                        </div>
                        <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                          <div className="h-full bg-primary/60 rounded-full transition-all" style={{ width: `${Math.max(pct, 2)}%` }} />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Audit Log Terminal */}
          <div className="md:col-span-7 bg-surface-container-lowest border border-outline-variant/10 rounded-lg overflow-hidden flex flex-col">
            <div className="px-4 md:px-6 py-2.5 md:py-3 bg-surface-container-low flex items-center justify-between border-b border-outline-variant/10">
              <div className="flex items-center gap-2 md:gap-3">
                <div className="flex gap-1.5">
                  <div className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-error/60" />
                  <div className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-warning/60" />
                  <div className="w-2.5 h-2.5 md:w-3 md:h-3 rounded-full bg-success/60" />
                </div>
                <span className="text-xs md:text-sm text-on-surface-variant font-mono tracking-wider truncate">SYSTEM_AUDIT_LOG</span>
              </div>
              <span className="text-xs md:text-sm text-on-surface-variant font-mono shrink-0">{t('admin.security.audit.total', { count: auditTotal })}</span>
            </div>
            <div className="flex-1 overflow-y-auto p-3 md:p-4 font-mono text-xs md:text-sm space-y-1 min-h-[200px] md:min-h-[300px] max-h-[400px] md:max-h-[500px]">
              {auditLog.length === 0 ? (
                <div className="text-on-surface-variant py-8 text-center">
                  <p className="text-xs md:text-sm">{t('admin.security.audit.emptyTitle')}</p>
                  <p className="text-outline mt-1 text-xs md:text-sm">{t('admin.security.audit.emptyHint')}</p>
                </div>
              ) : (
                auditLog.map(entry => {
                  const meta = EVENT_META[entry.event_type] || { label: entry.event_type, color: 'text-on-surface-variant' };
                  const actor = entry.actor_name || entry.actor?.split('@')[0] || '';
                  return (
                    <div key={entry.event_id} className="flex flex-col md:flex-row md:gap-2 py-1">
                      <span className="text-outline shrink-0">[{new Date(entry.created_at.endsWith('Z') ? entry.created_at : entry.created_at + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}]</span>
                      <div className="flex gap-1.5 md:gap-2 flex-wrap">
                        <span className={`${meta.color} shrink-0`}>[{meta.label}]</span>
                        <span className="text-on-surface-variant">
                          <span className="text-on-surface">{actor}</span>
                          {entry.detail ? ` \u2014 ${entry.detail}` : ''}
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {auditTotalPages > 1 && (
              <div className="flex items-center justify-between px-4 md:px-6 py-2.5 md:py-3 border-t border-outline-variant/10 bg-surface-container-low">
                <span className="text-xs text-on-surface-variant md:hidden">{auditPage}/{auditTotalPages}</span>
                <span className="text-sm text-on-surface-variant hidden md:block">
                  {t('admin.security.audit.paginationSummary', { start: (auditPage - 1) * 13 + 1, end: Math.min(auditPage * 13, auditTotal), total: auditTotal })}
                </span>
                <div className="flex gap-1">
                  <button
                    onClick={() => setAuditPage(p => Math.max(1, p - 1))}
                    disabled={auditPage === 1}
                    className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                  >{t('common.prev')}</button>
                  <button
                    onClick={() => setAuditPage(p => Math.min(auditTotalPages, p + 1))}
                    disabled={auditPage === auditTotalPages}
                    className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                  >{t('common.next')}</button>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Security Events (Input Guard) */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
            <div className="flex items-center gap-2 md:gap-3">
              <span className="material-symbols-outlined text-error text-base md:text-[24px]">gpp_maybe</span>
              <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.security.inputGuard.title')}</span>
            </div>
            <span className="text-xs md:text-sm text-on-surface-variant font-mono">{t('admin.security.inputGuard.total', { count: secTotal })}</span>
          </div>
          {secEvents.length === 0 ? (
            <div className="p-6 md:p-8 text-center text-on-surface-variant">
              <span className="material-symbols-outlined text-3xl md:text-4xl mb-3 opacity-30">verified_user</span>
              <p className="text-xs md:text-sm">{t('admin.security.inputGuard.empty')}</p>
              <p className="text-xs md:text-sm text-outline mt-1">{t('admin.security.inputGuard.emptyHint')}</p>
            </div>
          ) : (
            <>
              {/* Desktop Table */}
              <table className="w-full text-sm hidden md:table">
                <thead>
                  <tr className="border-b border-outline-variant/10 text-on-surface-variant uppercase tracking-wider">
                    <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colTime')}</th>
                    <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colSeverity')}</th>
                    <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colType')}</th>
                    <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colUser')}</th>
                    <th className="py-3 px-4 text-left font-bold">{t('admin.security.inputGuard.colDetail')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/10">
                  {secEvents.map(ev => {
                    const sevColor = ev.severity === 'critical' ? 'text-error font-bold' :
                      ev.severity === 'high' ? 'text-error' :
                      ev.severity === 'medium' ? 'text-warning' : 'text-on-surface-variant';
                    const sevLabel = ev.severity === 'critical' ? t('admin.security.inputGuard.severityCritical') :
                      ev.severity === 'high' ? t('admin.security.inputGuard.severityHigh') :
                      ev.severity === 'medium' ? t('admin.security.inputGuard.severityMedium') : t('admin.security.inputGuard.severityLow');
                    return (
                      <tr key={ev.id} className="hover:bg-surface-container-high/50 transition-colors">
                        <td className="py-3 px-4 text-on-surface-variant font-mono whitespace-nowrap">
                          {new Date(ev.created_at.endsWith('Z') ? ev.created_at : ev.created_at + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded text-sm font-bold uppercase ${sevColor} bg-current/10`}>
                            {sevLabel}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-on-surface font-mono">{ev.event_type}</td>
                        <td className="py-3 px-4 text-on-surface-variant">{ev.user_name || ev.user_email || ev.user_id}</td>
                        <td className="py-3 px-4 text-on-surface-variant max-w-xs truncate">{ev.detail}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {/* Mobile Card List */}
              <div className="md:hidden divide-y divide-outline-variant/10">
                {secEvents.map(ev => {
                  const sevColor = ev.severity === 'critical' ? 'text-error font-bold' :
                    ev.severity === 'high' ? 'text-error' :
                    ev.severity === 'medium' ? 'text-warning' : 'text-on-surface-variant';
                  const sevLabel = ev.severity === 'critical' ? t('admin.security.inputGuard.severityCritical') :
                    ev.severity === 'high' ? t('admin.security.inputGuard.severityHigh') :
                    ev.severity === 'medium' ? t('admin.security.inputGuard.severityMedium') : t('admin.security.inputGuard.severityLow');
                  return (
                    <div key={ev.id} className="px-4 py-3">
                      <div className="flex items-center justify-between mb-1">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${sevColor} bg-current/10`}>{sevLabel}</span>
                        <span className="text-[10px] text-on-surface-variant font-mono">
                          {new Date(ev.created_at.endsWith('Z') ? ev.created_at : ev.created_at + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <p className="text-xs text-on-surface font-mono">{ev.event_type}</p>
                      <p className="text-xs text-on-surface-variant truncate">{ev.user_name || ev.user_email || ev.user_id}</p>
                      <p className="text-xs text-on-surface-variant/70 truncate mt-0.5">{ev.detail}</p>
                    </div>
                  );
                })}
              </div>

              {secTotalPages > 1 && (
                <div className="flex items-center justify-between px-4 md:px-6 py-3 border-t border-outline-variant/10 bg-surface-container-high">
                  <span className="text-xs text-on-surface-variant md:hidden">{secPage}/{secTotalPages}</span>
                  <span className="text-sm text-on-surface-variant hidden md:block">
                    {t('admin.security.audit.paginationSummary', { start: (secPage - 1) * 10 + 1, end: Math.min(secPage * 10, secTotal), total: secTotal })}
                  </span>
                  <div className="flex gap-1">
                    <button
                      onClick={() => setSecPage(p => Math.max(1, p - 1))}
                      disabled={secPage === 1}
                      className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                    >{t('common.prev')}</button>
                    <button
                      onClick={() => setSecPage(p => Math.min(secTotalPages, p + 1))}
                      disabled={secPage === secTotalPages}
                      className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                    >{t('common.next')}</button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {/* Security Architecture */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
            <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">security</span>
            <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.security.architecture.title')}</span>
          </div>
          <div className="p-4 md:p-6 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 md:gap-4">
            <div className="bg-surface-container-high p-3 md:p-5 border-l-2 border-primary">
              <div className="flex items-center gap-2 mb-1 md:mb-2">
                <span className="material-symbols-outlined text-primary text-base md:text-lg">folder_special</span>
                <h4 className="text-on-surface font-bold text-xs md:text-sm">{t('admin.security.architecture.dirIsolationTitle')}</h4>
              </div>
              <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed">{t('admin.security.architecture.dirIsolationDesc')}</p>
            </div>
            <div className="bg-surface-container-high p-3 md:p-5 border-l-2 border-tertiary">
              <div className="flex items-center gap-2 mb-1 md:mb-2">
                <span className="material-symbols-outlined text-tertiary text-base md:text-lg">build_circle</span>
                <h4 className="text-on-surface font-bold text-xs md:text-sm">{t('admin.security.architecture.toolWhitelistTitle')}</h4>
              </div>
              <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed">{t('admin.security.architecture.toolWhitelistDesc')}</p>
            </div>
            <div className="bg-surface-container-high p-3 md:p-5 border-l-2 border-success">
              <div className="flex items-center gap-2 mb-1 md:mb-2">
                <span className="material-symbols-outlined text-success text-base md:text-lg">verified_user</span>
                <h4 className="text-on-surface font-bold text-xs md:text-sm">{t('admin.security.architecture.authTitle')}</h4>
              </div>
              <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed">{t('admin.security.architecture.authDesc')}</p>
            </div>
            <div className="bg-surface-container-high p-3 md:p-5 border-l-2 border-error">
              <div className="flex items-center gap-2 mb-1 md:mb-2">
                <span className="material-symbols-outlined text-error text-base md:text-lg">shield</span>
                <h4 className="text-on-surface font-bold text-xs md:text-sm">{t('admin.security.architecture.inputGuardTitle')}</h4>
              </div>
              <p className="text-xs md:text-sm text-on-surface-variant leading-relaxed">{t('admin.security.architecture.inputGuardDesc')}</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
