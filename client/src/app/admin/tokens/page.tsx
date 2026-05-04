'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface TokenSummary {
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
  estimatedCost: number;
}

interface ChartPoint {
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
}

interface UserBreakdown {
  id: string;
  email: string;
  display_name: string | null;
  total_input: number;
  total_output: number;
  invocation_count: number;
}

interface LedgerEntry {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  conversation_id: string | null;
  conversation_title: string | null;
  user_prompt: string | null;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  duration_ms: number | null;
  created_at: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'k';
  return String(n);
}

export default function AdminTokens() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [summary, setSummary] = useState<TokenSummary | null>(null);
  const [chart, setChart] = useState<ChartPoint[]>([]);
  const [byUser, setByUser] = useState<UserBreakdown[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [ledgerTotal, setLedgerTotal] = useState(0);
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerTotalPages, setLedgerTotalPages] = useState(1);
  const [period, setPeriod] = useState<'7d' | '30d'>('7d');
  const [exporting, setExporting] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [exportFrom, setExportFrom] = useState('');
  const [exportTo, setExportTo] = useState('');
  const [dateError, setDateError] = useState('');
  const [modalTab, setModalTab] = useState<'csv' | 'quote'>('csv');
  const [quoteMonth, setQuoteMonth] = useState('');
  const [quoteCurrency, setQuoteCurrency] = useState<'USD' | 'TWD'>('USD');
  const [quoteRate, setQuoteRate] = useState('32');

  async function exportCsv() {
    if (!token || exporting) return;
    if (exportFrom && exportTo && exportTo < exportFrom) {
      setDateError('結束月份不可早於開始月份');
      return;
    }
    setDateError('');
    setExporting(true);
    try {
      const params = new URLSearchParams();
      if (exportFrom) params.set('from', exportFrom);
      if (exportTo)   params.set('to',   exportTo);
      const res = await fetch(`/api/admin/tokens/monthly-summary?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const rows: Array<{
        month: string; email: string; display_name: string;
        input_tokens: number; output_tokens: number; total_tokens: number;
        conversations: number; sessions: number;
      }> = await res.json();
      const header = ['月份', 'Email', '姓名', '輸入 Token', '輸出 Token', '總 Token', '預估費用 (USD)', '對話次數', 'API 呼叫次數'];
      const csvRows = rows.map(r => {
        const cost = ((r.input_tokens / 1_000_000) * 3 + (r.output_tokens / 1_000_000) * 15) * 10;
        return [r.month, r.email, r.display_name, r.input_tokens, r.output_tokens, r.total_tokens, cost.toFixed(4), r.conversations, r.sessions];
      });
      const csv = '\uFEFF' + [header, ...csvRows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const label = exportFrom || exportTo ? `${exportFrom || 'all'}_${exportTo || 'all'}` : 'all';
      a.href = url; a.download = `token_billing_${label}.csv`; a.click();
      URL.revokeObjectURL(url);
      setShowExportModal(false);
    } finally { setExporting(false); }
  }

  async function generateQuote() {
    if (!token || !quoteMonth || exporting) return;
    setExporting(true);
    try {
      const params = new URLSearchParams({ from: quoteMonth, to: quoteMonth });
      const res = await fetch(`/api/admin/tokens/monthly-summary?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const rows: Array<{
        month: string; email: string; display_name: string;
        input_tokens: number; output_tokens: number; total_tokens: number;
        conversations: number; sessions: number;
      }> = await res.json();

      const totalInput = rows.reduce((sum, r) => sum + r.input_tokens, 0);
      const totalOutput = rows.reduce((sum, r) => sum + r.output_tokens, 0);
      const totalTokens = rows.reduce((sum, r) => sum + r.total_tokens, 0);
      const totalConversations = rows.reduce((sum, r) => sum + r.conversations, 0);
      const totalSessions = rows.reduce((sum, r) => sum + r.sessions, 0);
      // Effective rates (include 10x service multiplier): $30/MTok input, $150/MTok output
      const INPUT_RATE  = 3  * 10; // $30/MTok
      const OUTPUT_RATE = 15 * 10; // $150/MTok
      const inputCostUSD  = (totalInput  / 1_000_000) * INPUT_RATE;
      const outputCostUSD = (totalOutput / 1_000_000) * OUTPUT_RATE;
      const totalCostUSD  = inputCostUSD + outputCostUSD;
      const isTWD = quoteCurrency === 'TWD';
      const rate  = parseFloat(quoteRate) || 32;
      const fx    = isTWD ? rate : 1;
      const sym   = isTWD ? 'NT$' : '$';
      const inputCost  = inputCostUSD  * fx;
      const outputCost = outputCostUSD * fx;
      const totalCost  = totalCostUSD  * fx;
      const inputUnitPrice  = isTWD ? `NT$${(INPUT_RATE  * rate).toFixed(0)}/MTok` : `$${INPUT_RATE}/MTok`;
      const outputUnitPrice = isTWD ? `NT$${(OUTPUT_RATE * rate).toFixed(0)}/MTok` : `$${OUTPUT_RATE}/MTok`;
      const [year, month] = quoteMonth.split('-');
      const quoteNo = `Q-${year}${month}-001`;
      const generatedAt = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });

      const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="UTF-8">
  <title>服務報價單 ${quoteNo} (${quoteCurrency})</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:'Segoe UI',system-ui,sans-serif;background:#fff;color:#1a1a1a;padding:56px 64px;font-size:14px;max-width:820px;margin:0 auto}
    .print-btn{position:fixed;top:24px;right:24px;padding:9px 22px;background:#0D9488;color:#fff;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:pointer;letter-spacing:0.04em;box-shadow:0 2px 8px rgba(13,148,136,0.3)}
    .print-btn:hover{background:#0b7b72}
    /* Header */
    .doc-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:40px}
    .brand-name{font-size:12px;font-weight:800;letter-spacing:0.18em;text-transform:uppercase;color:#0D9488}
    .doc-title{font-size:32px;font-weight:900;color:#111;letter-spacing:-1px;margin-top:6px}
    .doc-no{font-size:12px;color:#999;margin-top:4px;font-family:'Courier New',monospace}
    .doc-meta{text-align:right;line-height:2}
    .doc-meta .label{font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:0.08em}
    .doc-meta .value{font-size:13px;color:#333;font-weight:600}
    /* Divider */
    hr{border:none;border-top:2px solid #0D9488;margin-bottom:36px}
    /* Info row */
    .info-row{display:flex;gap:48px;margin-bottom:36px}
    .info-block .info-label{font-size:11px;color:#aaa;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:4px}
    .info-block .info-value{font-size:14px;color:#111;font-weight:600}
    .info-block .info-sub{font-size:12px;color:#888;margin-top:2px}
    /* Items table */
    table{width:100%;border-collapse:collapse;margin-bottom:0}
    thead tr{background:#0D9488}
    th{padding:11px 16px;text-align:left;font-size:11px;font-weight:700;letter-spacing:0.07em;text-transform:uppercase;color:#fff}
    th.r{text-align:right}
    td{padding:14px 16px;border-bottom:1px solid #f0f0f0;font-size:14px}
    td.r{text-align:right;font-family:'Courier New',monospace}
    td.desc{color:#333}
    td.qty{color:#666;font-family:'Courier New',monospace;font-size:13px}
    td.price{color:#666;font-family:'Courier New',monospace;font-size:13px;text-align:right}
    td.amount{font-family:'Courier New',monospace;font-weight:600;text-align:right;color:#111}
    /* Subtotal block */
    .subtotal-block{display:flex;justify-content:flex-end;margin-top:0}
    .subtotal-table{width:280px;border-collapse:collapse}
    .subtotal-table td{padding:8px 16px;font-size:13px;border:none}
    .subtotal-table .s-label{color:#888}
    .subtotal-table .s-value{text-align:right;font-family:'Courier New',monospace;color:#333}
    .total-row-final td{border-top:2px solid #0D9488;padding-top:14px;padding-bottom:14px}
    .total-row-final .s-label{font-size:15px;font-weight:800;color:#111}
    .total-row-final .s-value{font-size:18px;font-weight:900;color:#0D9488;text-align:right;font-family:'Courier New',monospace}
    /* Stats */
    .stats-box{margin-top:40px;padding:16px 20px;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb}
    .stats-box .stats-title{font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#aaa;margin-bottom:10px}
    .stats-grid{display:flex;gap:32px}
    .stat-item .s-num{font-size:20px;font-weight:900;color:#111}
    .stat-item .s-lbl{font-size:11px;color:#aaa;margin-top:2px}
    /* Footer */
    .doc-footer{margin-top:36px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:11px;color:#bbb;line-height:1.9}
    /* Signature */
    .sign-row{display:flex;justify-content:flex-end;margin-top:48px;gap:64px}
    .sign-block{text-align:center;width:140px}
    .sign-line{border-top:1px solid #ccc;margin-bottom:6px}
    .sign-label{font-size:11px;color:#aaa;letter-spacing:0.06em}
    @media print{.print-btn{display:none}body{padding:32px 40px}}
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">列印 / 儲存 PDF</button>

  <div class="doc-header">
    <div>
      <div class="brand-name">AI Agents Office</div>
      <div class="doc-title">服務報價單</div>
      <div class="doc-no">No. ${quoteNo}</div>
    </div>
    <div class="doc-meta">
      <div><span class="label">報價日期</span><br><span class="value">${generatedAt.split(' ')[0]}</span></div>
      <div><span class="label">計費月份</span><br><span class="value">${year} 年 ${month} 月</span></div>
    </div>
  </div>
  <hr>

  <div class="info-row">
    <div class="info-block">
      <div class="info-label">服務項目</div>
      <div class="info-value">AI Token 使用服務費</div>
    </div>
    <div class="info-block">
      <div class="info-label">使用人數</div>
      <div class="info-value">${rows.length} 位</div>
      <div class="info-sub">已啟用帳號</div>
    </div>
    <div class="info-block">
      <div class="info-label">總 Token 用量</div>
      <div class="info-value">${totalTokens.toLocaleString()}</div>
      <div class="info-sub">輸入 + 輸出</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width:36px">#</th>
        <th>服務項目</th>
        <th class="r">用量</th>
        <th class="r">單價</th>
        <th class="r">小計 (USD)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td style="color:#bbb;font-size:12px">1</td>
        <td class="desc"><strong>輸入 Token 使用費</strong><br><span style="font-size:12px;color:#888">Prompt / Input tokens</span></td>
        <td class="qty">${totalInput.toLocaleString()} tok</td>
        <td class="price">${inputUnitPrice}</td>
        <td class="amount">${sym}${inputCost.toFixed(2)}</td>
      </tr>
      <tr>
        <td style="color:#bbb;font-size:12px">2</td>
        <td class="desc"><strong>輸出 Token 使用費</strong><br><span style="font-size:12px;color:#888">Completion / Output tokens</span></td>
        <td class="qty">${totalOutput.toLocaleString()} tok</td>
        <td class="price">${outputUnitPrice}</td>
        <td class="amount">${sym}${outputCost.toFixed(2)}</td>
      </tr>
    </tbody>
  </table>

  <div class="subtotal-block">
    <table class="subtotal-table">
      <tr><td class="s-label">服務小計</td><td class="s-value">${sym}${(inputCost + outputCost).toFixed(2)}</td></tr>
      <tr><td class="s-label">稅額</td><td class="s-value">—</td></tr>
      <tr class="total-row-final"><td class="s-label">合計 (${quoteCurrency})</td><td class="s-value">${sym}${totalCost.toFixed(2)}</td></tr>
    </table>
  </div>

  <div class="stats-box">
    <div class="stats-title">本月使用統計</div>
    <div class="stats-grid">
      <div class="stat-item"><div class="s-num">${rows.length}</div><div class="s-lbl">使用人數</div></div>
      <div class="stat-item"><div class="s-num">${totalConversations}</div><div class="s-lbl">對話次數</div></div>
      <div class="stat-item"><div class="s-num">${totalSessions}</div><div class="s-lbl">API 呼叫次數</div></div>
      <div class="stat-item"><div class="s-num">${(totalTokens / 1000).toFixed(1)}k</div><div class="s-lbl">總 Token 用量</div></div>
    </div>
  </div>

  <div class="sign-row">
    <div class="sign-block"><div class="sign-line"></div><div class="sign-label">確認簽章</div></div>
    <div class="sign-block"><div class="sign-line"></div><div class="sign-label">主管核准</div></div>
  </div>

  <div class="doc-footer">
    ${isTWD ? `* 幣別換算：1 USD = ${rate} TWD（匯率僅供參考，實際以銀行牌告匯率為準）<br>` : ''}* 產生時間：${generatedAt}
  </div>
</body>
</html>`;

      const win = window.open('', '_blank');
      if (win) { win.document.write(html); win.document.close(); }
      setShowExportModal(false);
    } finally { setExporting(false); }
  }

  function toUTC(dateStr: string): Date {
    if (!dateStr) return new Date(0);
    const s = dateStr.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(dateStr) ? dateStr : dateStr.replace(' ', 'T') + 'Z';
    return new Date(s);
  }

  function timeAgo(dateStr: string): string {
    const diff = Math.floor((Date.now() - toUTC(dateStr).getTime()) / 1000);
    if (diff < 0) return toUTC(dateStr).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    if (diff < 60) return t('admin.tokens.time.justNow');
    if (diff < 3600) return t('admin.tokens.time.minutesAgo', { count: Math.floor(diff / 60) });
    if (diff < 86400) return t('admin.tokens.time.hoursAgo', { count: Math.floor(diff / 3600) });
    return t('admin.tokens.time.daysAgo', { count: Math.floor(diff / 86400) });
  }

  useEffect(() => {
    if (!token) return;
    const headers = { Authorization: `Bearer ${token}` };

    fetch('/api/admin/tokens/summary', { headers })
      .then(r => r.json()).then(setSummary).catch(console.error);

    fetch('/api/admin/tokens/by-user?limit=10', { headers })
      .then(r => r.json()).then(setByUser).catch(console.error);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    fetch(`/api/admin/tokens/chart?period=${period}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json()).then(setChart).catch(console.error);
  }, [token, period]);

  const fetchLedger = useCallback(() => {
    if (!token) return;
    fetch(`/api/admin/tokens/ledger?page=${ledgerPage}&limit=10`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => {
        setLedger(data.entries);
        setLedgerTotal(data.total);
        setLedgerTotalPages(data.totalPages);
      })
      .catch(console.error);
  }, [token, ledgerPage]);

  useEffect(() => { fetchLedger(); }, [fetchLedger]);

  const maxChart = Math.max(...chart.map(v => v.total_input + v.total_output), 1);
  const totalByUserTokens = byUser.reduce((sum, u) => sum + u.total_input + u.total_output, 0) || 1;

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <span className="text-base md:text-lg font-black text-on-surface font-headline truncate">{t('admin.tokens.title')}</span>
          <span className="text-[10px] md:text-sm px-1.5 md:px-2 py-0.5 bg-success/10 text-success rounded font-bold tracking-wider uppercase shrink-0">{t('admin.tokens.syncStatus')}</span>
        </div>
        <button
          onClick={() => setShowExportModal(true)}
          disabled={exporting}
          className="flex items-center gap-1.5 md:gap-2 px-2.5 md:px-4 py-1.5 md:py-2 bg-surface-container text-on-surface-variant text-xs md:text-sm font-bold uppercase tracking-wider hover:bg-surface-container-high transition-colors cursor-pointer shrink-0 disabled:opacity-50"
        >
          <span className="material-symbols-outlined text-sm">download</span>
          <span className="hidden md:inline">{t('admin.tokens.exportCsv')}</span>
          <span className="md:hidden">CSV</span>
        </button>
      </header>

      {/* Export / Quote Modal */}
      {showExportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={e => { if (e.target === e.currentTarget) setShowExportModal(false); }}>
          <div className="bg-surface-container-highest rounded-2xl shadow-2xl border border-outline-variant/20 w-80">
            {/* Header */}
            <div className="flex items-center gap-2 px-5 pt-5 pb-0">
              <span className="material-symbols-outlined text-primary text-[20px]">description</span>
              <h3 className="text-sm font-black text-on-surface">匯出 / 報價單</h3>
            </div>
            {/* Tabs */}
            <div className="flex px-5 mt-3 gap-1 border-b border-outline-variant/10">
              {([['csv', 'download', 'CSV 匯出'], ['quote', 'receipt', '產生報價單']] as const).map(([tab, icon, label]) => (
                <button
                  key={tab}
                  onClick={() => setModalTab(tab)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold cursor-pointer transition-colors border-b-2 -mb-px ${
                    modalTab === tab
                      ? 'border-primary text-primary'
                      : 'border-transparent text-on-surface-variant hover:text-on-surface'
                  }`}
                >
                  <span className="material-symbols-outlined text-[14px]">{icon}</span>
                  {label}
                </button>
              ))}
            </div>

            {/* CSV Tab */}
            {modalTab === 'csv' && (
              <>
                <div className="px-5 py-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-on-surface-variant w-10 shrink-0">開始</span>
                    <input
                      type="month"
                      value={exportFrom}
                      max={exportTo || undefined}
                      onChange={e => { setExportFrom(e.target.value); setDateError(''); }}
                      className="flex-1 bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-on-surface-variant w-10 shrink-0">結束</span>
                    <input
                      type="month"
                      value={exportTo}
                      min={exportFrom || undefined}
                      onChange={e => { setExportTo(e.target.value); setDateError(''); }}
                      className={`flex-1 bg-surface-container border rounded-lg px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary ${dateError ? 'border-error' : 'border-outline-variant/30'}`}
                    />
                  </div>
                  {dateError ? (
                    <p className="text-[11px] text-error pl-[52px] flex items-center gap-1">
                      <span className="material-symbols-outlined text-[13px]">error</span>{dateError}
                    </p>
                  ) : (
                    <p className="text-[11px] text-on-surface-variant pl-[52px]">留空則匯出全部資料</p>
                  )}
                </div>
                <div className="flex gap-2 px-5 pb-5">
                  <button onClick={() => setShowExportModal(false)} className="flex-1 py-2 rounded-lg text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer">取消</button>
                  <button onClick={exportCsv} disabled={exporting} className="flex-1 py-2 rounded-lg text-sm font-bold text-on-primary bg-primary hover:brightness-110 transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5">
                    <span className={`material-symbols-outlined text-sm ${exporting ? 'animate-spin' : ''}`}>{exporting ? 'progress_activity' : 'download'}</span>
                    下載 CSV
                  </button>
                </div>
              </>
            )}

            {/* Quote Tab */}
            {modalTab === 'quote' && (
              <>
                <div className="px-5 py-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-on-surface-variant w-10 shrink-0">月份</span>
                    <input
                      type="month"
                      value={quoteMonth}
                      onChange={e => setQuoteMonth(e.target.value)}
                      className="flex-1 bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs font-bold text-on-surface-variant w-10 shrink-0">幣別</span>
                    <div className="flex flex-1 rounded-lg overflow-hidden border border-outline-variant/30">
                      {(['USD', 'TWD'] as const).map(c => (
                        <button
                          key={c}
                          onClick={() => setQuoteCurrency(c)}
                          className={`flex-1 py-1.5 text-sm font-bold cursor-pointer transition-colors ${quoteCurrency === c ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'}`}
                        >{c}</button>
                      ))}
                    </div>
                  </div>
                  {quoteCurrency === 'TWD' && (
                    <div className="flex items-center gap-3">
                      <span className="text-xs font-bold text-on-surface-variant w-10 shrink-0">匯率</span>
                      <div className="flex-1 flex items-center gap-1.5">
                        <span className="text-xs text-on-surface-variant">1 USD =</span>
                        <input
                          type="number"
                          value={quoteRate}
                          min="1"
                          step="0.1"
                          onChange={e => setQuoteRate(e.target.value)}
                          className="w-20 bg-surface-container border border-outline-variant/30 rounded-lg px-3 py-1.5 text-sm text-on-surface focus:outline-none focus:border-primary text-center"
                        />
                        <span className="text-xs text-on-surface-variant">TWD</span>
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex gap-2 px-5 pb-5">
                  <button onClick={() => setShowExportModal(false)} className="flex-1 py-2 rounded-lg text-sm font-bold text-on-surface-variant bg-surface-container hover:bg-surface-container-high transition-colors cursor-pointer">取消</button>
                  <button
                    onClick={generateQuote}
                    disabled={exporting || !quoteMonth}
                    className="flex-1 py-2 rounded-lg text-sm font-bold text-on-primary bg-primary hover:brightness-110 transition-all cursor-pointer disabled:opacity-50 flex items-center justify-center gap-1.5"
                  >
                    <span className={`material-symbols-outlined text-sm ${exporting ? 'animate-spin' : ''}`}>{exporting ? 'progress_activity' : 'receipt'}</span>
                    預覽報價單
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      <div className="p-4 md:p-8 flex-1 space-y-4 md:space-y-6 overflow-y-auto">
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-6">
          {/* Total Usage */}
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>token</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.tokens.summary.totalUsage')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-on-surface">
              {summary ? formatTokens(summary.totalInput + summary.totalOutput) : '\u2014'}
            </span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">
              <span className="hidden md:inline">{t('admin.users.detail.tokenInput')}: {summary ? formatTokens(summary.totalInput) : '0'} | {t('admin.users.detail.tokenOutput')}: {summary ? formatTokens(summary.totalOutput) : '0'}</span>
              <span className="md:hidden">In: {summary ? formatTokens(summary.totalInput) : '0'} · Out: {summary ? formatTokens(summary.totalOutput) : '0'}</span>
            </p>
          </div>

          {/* Estimated Cost */}
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>attach_money</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.tokens.summary.estimatedCost')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-primary">
              ${summary?.estimatedCost.toFixed(4) ?? '0'}
            </span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">{t('admin.tokens.summary.pricingNote')}</p>
          </div>

          {/* Total Invocations */}
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>api</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.tokens.summary.totalInvocations')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-on-surface">
              {summary?.totalInvocations ?? 0}
            </span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">{t('admin.tokens.summary.apiCalls')}</p>
          </div>

          {/* Billing Status */}
          <div className="bg-surface-container p-3 md:p-6 rounded-lg group relative overflow-hidden">
            <span className="material-symbols-outlined absolute -bottom-4 -right-2 max-md:-bottom-2 max-md:-right-1 max-md:!text-[56px] text-on-surface opacity-[0.07] group-hover:opacity-[0.12] transition-opacity pointer-events-none" style={{ fontSize: 100 }}>check_circle</span>
            <p className="text-[10px] md:text-sm uppercase tracking-widest text-on-surface-variant mb-1 md:mb-2">{t('admin.tokens.summary.billingStatus')}</p>
            <span className="text-xl md:text-3xl font-headline font-black text-success">{t('admin.tokens.summary.billingActive')}</span>
            <p className="text-[10px] md:text-sm text-on-surface-variant mt-1 md:mt-2 font-mono">{t('admin.tokens.summary.billingPaygo')}</p>
          </div>
        </div>

        {/* Chart + User Breakdown */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-4 md:gap-6">
          {/* Token Chart */}
          <div className="md:col-span-8 bg-surface-container rounded-lg overflow-hidden">
            <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
              <div className="flex items-center gap-2 md:gap-3">
                <span className="material-symbols-outlined text-tertiary text-base md:text-[24px]">show_chart</span>
                <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.tokens.chart.title')}</span>
              </div>
              <div className="flex gap-1">
                {(['7d', '30d'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setPeriod(p)}
                    className={`px-2 md:px-3 py-0.5 md:py-1 text-xs md:text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                      p === '30d' ? 'hidden md:inline-block' : ''
                    } ${
                      period === p ? 'text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
            <div className="p-4 md:p-6">
              {chart.length === 0 ? (
                <div className="h-40 flex items-center justify-center text-on-surface-variant text-sm">
                  <span className="material-symbols-outlined mr-2">info</span>{t('admin.tokens.chart.noData')}
                </div>
              ) : (
                <div>
                  <div className={`flex items-end ${period === '30d' ? 'h-52 gap-px' : 'h-40 md:h-48 gap-1.5'}`}>
                    {chart.map((v, i) => {
                      const total = v.total_input + v.total_output;
                      const pct = (total / maxChart) * 100;
                      const barHeight = Math.max(pct, 3);
                      return (
                        <div key={i} className="flex-1 min-w-0 h-full flex items-end group/bar relative">
                          <div className="w-full bg-primary/60 rounded-t transition-all group-hover/bar:brightness-125" style={{ height: `${barHeight}%` }} />
                          <span className="absolute top-0 left-1/2 -translate-x-1/2 text-[10px] bg-surface-container-highest text-on-surface px-1.5 py-0.5 rounded opacity-0 group-hover/bar:opacity-100 transition-opacity font-mono font-bold whitespace-nowrap pointer-events-none z-10">
                            {v.date.slice(5)} · {formatTokens(total)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                  {/* Date labels */}
                  {period === '30d' ? (
                    <div className="flex gap-px mt-4 h-14">
                      {chart.map((v, i) => (
                        <div key={i} className="flex-1 min-w-0 relative">
                          <span className="absolute top-0 left-1/2 -translate-x-1/2 origin-top -rotate-55 text-[11px] text-outline font-mono whitespace-nowrap">
                            {v.date.slice(5)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="flex gap-1.5 mt-1.5">
                      {chart.map((v, i) => (
                        <span key={i} className="flex-1 min-w-0 text-xs text-center text-outline font-mono truncate">
                          {v.date.slice(5)}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* User Breakdown */}
          <div className="md:col-span-4 bg-surface-container rounded-lg overflow-hidden">
            <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
              <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">pie_chart</span>
              <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.tokens.userBreakdown.title')}</span>
            </div>
            <div className="p-4 md:p-6 space-y-3">
              {byUser.length === 0 ? (
                <p className="text-sm text-on-surface-variant text-center py-4">{t('admin.tokens.userBreakdown.empty')}</p>
              ) : (
                byUser.slice(0, 6).map(u => {
                  const total = u.total_input + u.total_output;
                  const pct = ((total / totalByUserTokens) * 100).toFixed(1);
                  return (
                    <div key={u.id}>
                      <div className="flex justify-between text-xs md:text-sm mb-1">
                        <span className="text-on-surface truncate max-w-[60%]">{u.display_name || u.email}</span>
                        <span className="text-on-surface-variant font-mono">{pct}%</span>
                      </div>
                      <div className="w-full h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                        <div className="h-full bg-primary/60 rounded-full" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Session Ledger */}
        <div className="bg-surface-container rounded-lg overflow-hidden">
          <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
            <div className="flex items-center gap-2 md:gap-3">
              <span className="material-symbols-outlined text-on-surface-variant text-base md:text-[24px]">receipt_long</span>
              <span className="text-xs md:text-sm font-bold uppercase tracking-widest">{t('admin.tokens.ledger.title')}</span>
            </div>
            <span className="text-xs md:text-sm text-on-surface-variant">{t('admin.tokens.ledger.count', { count: ledgerTotal })}</span>
          </div>

          {/* Desktop Table */}
          <table className="w-full hidden md:table">
            <thead>
              <tr className="text-left text-sm uppercase tracking-widest text-on-surface-variant border-b border-outline-variant/10">
                <th className="py-3 px-6 font-bold">{t('admin.tokens.ledger.sessionId')}</th>
                <th className="py-3 px-6 font-bold">{t('admin.tokens.ledger.documentAction')}</th>
                <th className="py-3 px-6 font-bold">{t('admin.tokens.ledger.user')}</th>
                <th className="py-3 px-6 font-bold text-right">Tokens</th>
                <th className="py-3 px-6 font-bold text-right">{t('admin.tokens.ledger.cost')}</th>
                <th className="py-3 px-6 font-bold text-right">{t('admin.tokens.ledger.time')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/10">
              {ledger.map(entry => {
                const cost = ((entry.input_tokens / 1_000_000) * 3 + (entry.output_tokens / 1_000_000) * 15) * 10;
                return (
                  <tr key={entry.id} className="hover:bg-surface-container-high/50 transition-colors">
                    <td className="py-3 px-6 text-sm text-primary font-mono">{entry.id.slice(0, 8)}</td>
                    <td className="py-3 px-6 text-sm text-on-surface truncate max-w-[300px]" title={entry.user_prompt || entry.conversation_title || ''}>
                      {entry.user_prompt || entry.conversation_title || '\u2014'}
                    </td>
                    <td className="py-3 px-6 max-w-[180px]">
                      <p className="text-sm text-on-surface truncate">{entry.display_name || entry.email.split('@')[0]}</p>
                      <p className="text-sm text-on-surface-variant font-mono truncate">{entry.email}</p>
                    </td>
                    <td className="py-3 px-6 text-right text-sm text-on-surface font-mono">
                      {formatTokens(entry.input_tokens + entry.output_tokens)}
                    </td>
                    <td className="py-3 px-6 text-right text-sm text-on-surface font-mono">
                      ${cost.toFixed(3)}
                    </td>
                    <td className="py-3 px-6 text-right text-sm text-on-surface-variant">
                      {timeAgo(entry.created_at)}
                    </td>
                  </tr>
                );
              })}
              {ledger.length === 0 && (
                <tr><td colSpan={6} className="py-12 text-center text-on-surface-variant">{t('admin.tokens.ledger.empty')}</td></tr>
              )}
            </tbody>
          </table>

          {/* Mobile Card List */}
          <div className="md:hidden divide-y divide-outline-variant/10">
            {ledger.map(entry => {
              const cost = ((entry.input_tokens / 1_000_000) * 3 + (entry.output_tokens / 1_000_000) * 15) * 10;
              return (
                <div key={entry.id} className="px-4 py-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-primary font-mono">{entry.id.slice(0, 8)}</span>
                    <span className="text-[10px] text-on-surface-variant">{timeAgo(entry.created_at)}</span>
                  </div>
                  <p className="text-sm text-on-surface font-medium truncate">{entry.user_prompt || entry.conversation_title || '\u2014'}</p>
                  <p className="text-xs text-on-surface-variant truncate">{entry.display_name || entry.email.split('@')[0]}</p>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-on-surface-variant font-mono">
                    <span>{formatTokens(entry.input_tokens + entry.output_tokens)} tokens</span>
                    <span>${cost.toFixed(3)}</span>
                  </div>
                </div>
              );
            })}
            {ledger.length === 0 && (
              <div className="py-12 text-center text-on-surface-variant text-sm">{t('admin.tokens.ledger.empty')}</div>
            )}
          </div>

          {/* Pagination */}
          {ledgerTotalPages > 1 && (
            <div className="flex items-center justify-between px-4 md:px-6 py-3 md:py-4 border-t border-outline-variant/10">
              <span className="text-xs text-on-surface-variant md:hidden">{ledgerPage}/{ledgerTotalPages}</span>
              <span className="text-sm text-on-surface-variant hidden md:block">
                {t('admin.tokens.ledger.paginationSummary', { start: (ledgerPage - 1) * 10 + 1, end: Math.min(ledgerPage * 10, ledgerTotal), total: ledgerTotal })}
              </span>
              <div className="flex gap-1">
                <button
                  onClick={() => setLedgerPage(p => Math.max(1, p - 1))}
                  disabled={ledgerPage === 1}
                  className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container-high text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                >
                  {t('common.prev')}
                </button>
                <button
                  onClick={() => setLedgerPage(p => Math.min(ledgerTotalPages, p + 1))}
                  disabled={ledgerPage === ledgerTotalPages}
                  className="px-2.5 md:px-3 py-1.5 text-xs md:text-sm bg-surface-container-high text-on-surface-variant rounded disabled:opacity-30 cursor-pointer"
                >
                  {t('common.next')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
