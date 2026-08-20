'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAdminAuth } from '../components/AdminAuthProvider';

// ── Types ────────────────────────────────────────────────────────────────
interface AuthRow { auth_mode: string; calls: number; inTok: number; outTok: number }
interface DailyRow { d: string; auth_mode: string; calls: number; outTok: number }
interface ModelRow { model: string | null; auth_mode: string; calls: number; outTok: number }
interface SkillRow { skill_id: string | null; auth_mode: string; calls: number }
interface ReasonRow { reason: string | null; calls: number }
interface RecentRow { created_at: string; skill_id: string | null; model: string | null; reason: string | null; input_tokens: number; output_tokens: number; success: number }
/** The non-Anthropic lane: on-prem gateway and DeepSeek. Tracked separately
 *  because the question about it is reliability, not "explain the invoice". */
interface AuxProviderRow { auth_mode: string; model: string | null; calls: number; ok: number; inTok: number; outTok: number }
interface AuxFailureRow { auth_mode: string; reason: string | null; calls: number }
interface AuxFeatureRow { skill_id: string | null; auth_mode: string; calls: number; ok: number }
interface Stats {
  period: string; days: number; empty?: boolean;
  byAuth: AuthRow[]; daily: DailyRow[]; byModel: ModelRow[]; bySkill: SkillRow[]; reasons: ReasonRow[]; recentApiKey: RecentRow[];
  auxByProvider?: AuxProviderRow[]; auxFailures?: AuxFailureRow[]; auxByFeature?: AuxFeatureRow[];
}

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const num = (n: number) => n >= 1_000_000 ? (n / 1_000_000).toFixed(2) + 'M' : n >= 1_000 ? (n / 1_000).toFixed(1) + 'k' : String(n ?? 0);
const SKILL_LABELS: Record<string, string> = {
  router: '路由規劃', 'pptx-gen': 'PPT 生成', 'docx-gen': 'Word 生成', 'xlsx-gen': 'Excel 生成',
  'pdf-gen': 'PDF 生成', 'slides-gen': '投影片', 'webapp-gen': '網頁應用', 'data-analyst': '資料分析',
  research: '研究調查', 'rag-analyst': 'RAG 分析', 'email-agent': '信件助手', 'security-report': '資安報告',
  'fidelity-guard': '誠實度校驗',
  // Aux-LLM features (auxLlm.ts AuxFeature)
  'email-summary': '信件摘要', 'team-discussion': '團隊討論', 'team-synthesis': '團隊統整',
  greeting: '登入問候語', 'content-safety': '內容安全審查', 'team-builder': 'AI 團隊生成',
  'role-prompt': '角色描述生成', 'doc-narration': '文件旁白', 'topic-analysis': '主題分析',
};

const PROVIDER_LABELS: Record<string, { name: string; note: string; tone: string }> = {
  local: { name: '地端模型', note: '無 token 費用', tone: 'text-[#3FBBC0]' },
  deepseek: { name: 'DeepSeek API', note: '計費（低單價）', tone: 'text-[#F0A84B]' },
};
/** A failure reason a person can act on, not a stack trace. */
const labelAuxReason = (r: string | null) => {
  if (!r) return '—';
  if (r === 'timeout') return '逾時（機器太慢／卡住）';
  if (r === 'empty answer' || r === 'empty stream') return '回傳空白';
  if (r === 'partial (stream cut)') return '串流中斷（已有部分內容）';
  if (r.startsWith('HTTP 401') || r.startsWith('HTTP 403')) return `${r}（金鑰無效／無權限）`;
  if (r.startsWith('HTTP 5')) return `${r}（服務端錯誤）`;
  return r;
};
const labelSkill = (s: string | null) => s ? (SKILL_LABELS[s] ?? s) : '—';
const labelReason = (r: string | null) => {
  if (!r) return '—';
  if (r === 'primary') return '主要(帳號)';
  if (r === 'account-quota-fallback') return '帳號額度用滿 → 溢流';
  if (r === 'forced-api-key') return '強制 API key';
  if (r.startsWith('session-recovery')) return 'Session 自癒重試';
  return r;
};
const fmtTime = (s: string) => { try { return new Date(s).toLocaleString('zh-TW', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); } catch { return s; } };
const shortDate = (d: string) => d.length >= 10 ? d.slice(5).replace('-', '/') : d; // YYYY-MM-DD -> MM/DD

// ── Section shell (matches other admin pages) ───────────────────────────────
function Section({ title, icon, action, children }: { title: string; icon: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="bg-surface-container rounded-xl overflow-hidden">
      <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center gap-2 md:gap-3">
        <span className="material-symbols-outlined text-primary text-[20px]">{icon}</span>
        <span className="text-sm md:text-base font-bold text-on-surface font-headline">{title}</span>
        {action && <span className="ml-auto">{action}</span>}
      </div>
      <div className="p-4 md:p-6">{children}</div>
    </div>
  );
}

// ── Donut helpers ───────────────────────────────────────────────────────────
const DONUT_COLORS = ['#3FBBC0', '#6B9BD2', '#F5A623', '#7BC87A', '#B07BB0', '#E07070', '#54B6B0', '#E8956D'];
function prepDonut(items: { label: string; value: number }[]) {
  const clean = items.filter(i => i.value > 0).sort((a, b) => b.value - a.value);
  const total = clean.reduce((s, i) => s + i.value, 0);
  const top = clean.slice(0, 8).map((it, i) => ({ ...it, color: DONUT_COLORS[i % DONUT_COLORS.length], pct: total ? Math.round((it.value / total) * 100) : 0 }));
  return { total, top };
}

// Interactive donut — hover a segment to highlight it; a floating tooltip (near the
// cursor) shows the value. The center always shows the total.
function DonutChart({ items, unit, size = 140, interactive = false }: { items: { label: string; value: number }[]; unit: string; size?: number; interactive?: boolean }) {
  const [hover, setHover] = useState<number | null>(null);
  const [tip, setTip] = useState({ x: 0, y: 0 });
  const wrapRef = useRef<HTMLDivElement>(null);
  const { total, top } = prepDonut(items);
  if (!total) return <p className="text-sm text-on-surface-variant py-8 text-center">無資料</p>;
  const cx = size / 2, cy = size / 2, R = size * 0.44, r = size * 0.28;
  let a0 = -Math.PI / 2;
  const arcs = top.map((it) => {
    const frac = it.value / total;
    let d = ''; let ring = false;
    if (frac >= 0.9999) { ring = true; }
    else {
      const a1 = a0 + frac * 2 * Math.PI;
      const large = frac > 0.5 ? 1 : 0;
      const p = (ang: number, rad: number): [number, number] => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
      const [x0, y0] = p(a0, R), [x1, y1] = p(a1, R), [xi1, yi1] = p(a1, r), [xi0, yi0] = p(a0, r);
      d = `M ${x0} ${y0} A ${R} ${R} 0 ${large} 1 ${x1} ${y1} L ${xi1} ${yi1} A ${r} ${r} 0 ${large} 0 ${xi0} ${yi0} Z`;
      a0 = a1;
    }
    return { ...it, d, ring };
  });
  const active = hover !== null ? arcs[hover] : null;
  const onMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (rect) setTip({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };
  return (
    <div ref={wrapRef} className="relative shrink-0" style={{ width: size, height: size }}
      onMouseMove={interactive ? onMove : undefined} onMouseLeave={() => setHover(null)}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        {arcs.map((a, i) => a.ring
          ? <circle key={i} cx={cx} cy={cy} r={(R + r) / 2} fill="none" stroke={a.color} strokeWidth={R - r} />
          : <path key={i} d={a.d} fill={a.color}
              opacity={hover === null || hover === i ? 1 : 0.3}
              onMouseEnter={interactive ? () => setHover(i) : undefined}
              style={{ transition: 'opacity .15s', cursor: interactive ? 'default' : undefined }}>
              {!interactive && <title>{`${a.label}: ${num(a.value)} (${a.pct}%)`}</title>}
            </path>
        )}
      </svg>
      {/* Center: always the total */}
      <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none px-4 text-center">
        <span className="font-black text-on-surface leading-none" style={{ fontSize: size * 0.15 }}>{num(total)}</span>
        <span className="text-on-surface-variant mt-1" style={{ fontSize: size * 0.06 }}>{unit}</span>
      </div>
      {/* Floating tooltip near the cursor */}
      {interactive && active && (
        <div className="absolute pointer-events-none z-20 bg-surface-container-highest border border-outline-variant/15 shadow-lg rounded-lg px-3 py-2 text-xs whitespace-nowrap"
          style={{ left: Math.min(tip.x + 12, size - 8), top: tip.y + 12 }}>
          <div className="flex items-center gap-2 mb-0.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: active.color }} />
            <span className="font-bold text-on-surface">{active.label}</span>
          </div>
          <p className="text-on-surface-variant pl-4 tabular-nums">{num(active.value)} · <span className="font-bold" style={{ color: active.color }}>{active.pct}%</span></p>
        </div>
      )}
    </div>
  );
}

function DonutLegend({ items }: { items: { label: string; value: number }[] }) {
  const { top } = prepDonut(items);
  if (!top.length) return <p className="text-sm text-on-surface-variant py-4 text-center">無資料</p>;
  return (
    <div className="space-y-1.5">
      {top.map((a, i) => (
        <div key={i} className="flex items-center gap-2 text-sm">
          <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: a.color }} />
          <span className="text-on-surface truncate flex-1 min-w-0" title={a.label}>{a.label}</span>
          <span className="text-on-surface-variant shrink-0 tabular-nums">{num(a.value)} · {a.pct}%</span>
        </div>
      ))}
    </div>
  );
}

// ── Chart card — donut inline (hover shows values); legend behind the top-right
//    icon as a popover. Mirrors the 使用分析 DistributionCard design. ──────────
function ChartCard({ icon, title, unit, items }: { icon: string; title: string; unit: string; items: { label: string; value: number }[] }) {
  const [showLegend, setShowLegend] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [popPos, setPopPos] = useState({ top: 0, right: 0 });
  const { total } = prepDonut(items);

  const toggle = () => {
    if (!showLegend && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect();
      setPopPos({ top: rect.bottom + 6, right: window.innerWidth - rect.right });
    }
    setShowLegend(v => !v);
  };
  useEffect(() => {
    if (!showLegend) return;
    const h = (e: MouseEvent) => {
      if (btnRef.current && !btnRef.current.contains(e.target as Node) && popRef.current && !popRef.current.contains(e.target as Node)) setShowLegend(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [showLegend]);

  return (
    <div className="bg-surface-container rounded-xl overflow-hidden">
      <div className="px-4 md:px-6 py-3 md:py-4 bg-surface-container-high flex items-center justify-between">
        <div className="flex items-center gap-2 md:gap-3">
          <span className="material-symbols-outlined text-primary text-[20px]">{icon}</span>
          <span className="text-sm md:text-base font-bold text-on-surface font-headline">{title}</span>
        </div>
        {total > 0 && (
          <button ref={btnRef} onClick={toggle} title={showLegend ? '收合圖例' : '展開圖例'}
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-colors cursor-pointer bg-transparent ${showLegend ? 'text-primary bg-primary/10' : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container'}`}>
            <span className="material-symbols-outlined text-base">legend_toggle</span>
          </button>
        )}
      </div>
      <div className="p-4 md:p-6 flex justify-center">
        <DonutChart items={items} unit={unit} size={200} interactive />
      </div>
      {showLegend && total > 0 && createPortal(
        <div ref={popRef} className="fixed z-[200] bg-surface-container-highest border border-outline-variant/20 shadow-2xl rounded-xl p-4 min-w-[200px] max-w-[280px]" style={{ top: popPos.top, right: popPos.right }}>
          <DonutLegend items={items} />
        </div>,
        document.body,
      )}
    </div>
  );
}

export default function ApiTrackingPage() {
  const { token } = useAdminAuth();
  const [period, setPeriod] = useState<'7d' | '30d' | '90d'>('30d');
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);

  const load = useCallback(async () => {
    if (!token) return;
    setLoading(true);
    try {
      const res = await fetch(`${SSE_BASE}/api/admin/api-tracking/stats?period=${period}`, { headers: { Authorization: `Bearer ${token}` } });
      if (res.status === 403) { setForbidden(true); setStats(null); return; }
      setStats(await res.json());
    } catch { setStats(null); } finally { setLoading(false); }
  }, [token, period]);

  useEffect(() => { load(); }, [load]);

  // ── Derived aggregates ─────────────────────────────────────────────────
  const account = stats?.byAuth?.find(r => r.auth_mode === 'account');
  const apikey = stats?.byAuth?.find(r => r.auth_mode === 'api_key');
  const accountCalls = Number(account?.calls || 0);
  const apiKeyCalls = Number(apikey?.calls || 0);
  const totalCalls = accountCalls + apiKeyCalls;
  const apiKeyOut = Number(apikey?.outTok || 0);
  const pctAccount = totalCalls ? Math.round((accountCalls / totalCalls) * 100) : 0;

  // Daily merged { date -> {account, apiKey} }
  const dailyMap = new Map<string, { account: number; apiKey: number }>();
  for (const r of stats?.daily || []) {
    const e = dailyMap.get(r.d) || { account: 0, apiKey: 0 };
    if (r.auth_mode === 'api_key') e.apiKey = Number(r.calls); else e.account = Number(r.calls);
    dailyMap.set(r.d, e);
  }
  // Fill the FULL selected window (7/30/90 days) so the x-axis reflects the period —
  // days with no calls render as empty slots. Without this, only days-with-data show
  // and every period looks identical.
  const daysN = stats?.days ?? (period === '7d' ? 7 : period === '90d' ? 90 : 30);
  // Fill every day in the window (empty days = zero) so the x-axis spans the period.
  const filled: [string, { account: number; apiKey: number }][] = [];
  {
    const now = new Date();
    for (let i = daysN - 1; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(d.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      filled.push([key, dailyMap.get(key) || { account: 0, apiKey: 0 }]);
    }
  }
  // Long windows (>31d): bucket by WEEK so the chart isn't a sea of empty daily bars.
  const weekly = daysN > 31;
  let chartArr = filled;
  if (weekly) {
    const buckets: [string, { account: number; apiKey: number }][] = [];
    for (let i = 0; i < filled.length; i += 7) {
      const chunk = filled.slice(i, i + 7);
      buckets.push([
        chunk[chunk.length - 1][0], // week-ending date
        { account: chunk.reduce((s, [, v]) => s + v.account, 0), apiKey: chunk.reduce((s, [, v]) => s + v.apiKey, 0) },
      ]);
    }
    chartArr = buckets;
  }
  const dailyMax = Math.max(1, ...chartArr.map(([, v]) => v.account + v.apiKey));
  const labelStep = Math.max(1, Math.ceil(chartArr.length / 12)); // ~12 x-axis labels max

  // Models merged
  const modelMap = new Map<string, { account: number; apiKey: number; out: number }>();
  for (const r of stats?.byModel || []) {
    const k = r.model || '(未知)';
    const e = modelMap.get(k) || { account: 0, apiKey: 0, out: 0 };
    if (r.auth_mode === 'api_key') e.apiKey += Number(r.calls); else e.account += Number(r.calls);
    e.out += Number(r.outTok || 0);
    modelMap.set(k, e);
  }
  const modelArr = [...modelMap.entries()].sort((a, b) => (b[1].account + b[1].apiKey) - (a[1].account + a[1].apiKey));

  // Busiest aux provider/model first — the one carrying the traffic is the one
  // whose reliability actually matters.
  const auxRows = [...(stats?.auxByProvider || [])].sort((a, b) => Number(b.calls) - Number(a.calls));

  // Skills merged (total calls per skill)
  const skillMap = new Map<string, number>();
  for (const r of stats?.bySkill || []) { const k = r.skill_id || '—'; skillMap.set(k, (skillMap.get(k) || 0) + Number(r.calls)); }
  const skillArr = [...skillMap.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <>
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <span className="text-base md:text-lg font-black text-on-surface font-headline truncate">
          API 追蹤<span className="hidden sm:inline"> · 用量與計費來源</span>
        </span>
        <div className="flex gap-1">
          {(['7d', '30d', '90d'] as const).map(p => (
            <button key={p} onClick={() => setPeriod(p)}
              className={`px-2 md:px-3 py-0.5 md:py-1 text-xs md:text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                period === p ? 'text-primary border-b-2 border-primary' : 'text-on-surface-variant hover:text-on-surface'
              }`}>{p}</button>
          ))}
        </div>
      </header>

      <div className="p-4 md:p-8 flex-1 space-y-4 md:space-y-6 overflow-y-auto">
        {forbidden ? (
          <div className="flex flex-col items-center justify-center py-24 text-on-surface-variant gap-2">
            <span className="material-symbols-outlined text-4xl">lock</span>
            <p>此頁僅限管理員檢視</p>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center py-24 text-on-surface-variant">
            <span className="material-symbols-outlined animate-spin text-3xl">progress_activity</span>
          </div>
        ) : (stats?.empty || totalCalls === 0) ? (
          <div className="flex flex-col items-center justify-center py-24 text-on-surface-variant gap-2">
            <span className="material-symbols-outlined text-4xl">database</span>
            <p>尚無記錄（部署後每次 AI 呼叫會開始逐筆記錄）</p>
          </div>
        ) : (
          <>
            {/* Hero: subscription vs API key */}
            <div className="bg-surface-container rounded-xl p-5 md:p-6">
              <p className="text-sm text-on-surface-variant mb-3">近 {stats?.days} 天，共 <b className="text-on-surface">{num(totalCalls)}</b> 次 AI 呼叫</p>
              <div className="flex h-4 rounded-full overflow-hidden bg-surface-container-high mb-3">
                <div className="bg-[#3FBBC0]" style={{ width: `${pctAccount}%` }} />
                <div className="bg-[#E07070]" style={{ width: `${100 - pctAccount}%` }} />
              </div>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-[#3FBBC0]" /><b className="text-on-surface">{pctAccount}%</b> 訂閱帳號 <span className="text-on-surface-variant">(免費 · {num(accountCalls)} 次)</span></span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-full bg-[#E07070]" /><b className="text-on-surface">{100 - pctAccount}%</b> API key <span className="text-on-surface-variant">(計費 · {num(apiKeyCalls)} 次)</span></span>
              </div>
            </div>

            {/* KPI cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-6">
              {[
                { icon: 'stacked_bar_chart', label: '總呼叫', value: num(totalCalls), tone: '' },
                { icon: 'verified', label: '訂閱(免費)', value: num(accountCalls), tone: 'text-[#3FBBC0]' },
                { icon: 'credit_card', label: 'API key(計費)', value: num(apiKeyCalls), tone: 'text-[#E07070]' },
                { icon: 'toll', label: 'API key 輸出 tokens', value: num(apiKeyOut), tone: 'text-[#E07070]' },
              ].map((c, i) => (
                <div key={i} className="bg-surface-container rounded-xl p-3 md:p-5">
                  <span className={`material-symbols-outlined text-[20px] ${c.tone || 'text-primary'}`}>{c.icon}</span>
                  <p className="text-xs text-on-surface-variant mt-1">{c.label}</p>
                  <p className={`text-xl md:text-2xl font-black font-headline ${c.tone || 'text-on-surface'}`}>{c.value}</p>
                </div>
              ))}
            </div>

            {/* Daily trend */}
            <Section title="每日趨勢（訂閱 vs API key）" icon="calendar_month">
              <div className="flex items-center gap-4 mb-3 text-xs text-on-surface-variant">
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-[#3FBBC0]" />訂閱</span>
                <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-[#E07070]" />API key</span>
                <span className="ml-auto">{weekly ? '每格 = 一週' : '每格 = 一天'}</span>
              </div>
              <div className="flex items-end gap-1 md:gap-1.5">
                {chartArr.map(([date, v], i) => (
                  <div key={date} className="flex flex-col items-center gap-1.5 flex-1 min-w-[6px]">
                    <div
                      className="flex flex-col justify-end h-40 w-full max-w-[40px] rounded-t overflow-hidden cursor-default"
                      title={`${weekly ? '該週至 ' : ''}${date}\n訂閱 ${v.account} 次 · API key ${v.apiKey} 次`}
                    >
                      {v.apiKey > 0 && <div className="w-full bg-[#E07070]" style={{ height: `${(v.apiKey / dailyMax) * 100}%` }} />}
                      {v.account > 0 && <div className="w-full bg-[#3FBBC0]" style={{ height: `${(v.account / dailyMax) * 100}%` }} />}
                    </div>
                    <span className="w-full text-center text-[10px] text-on-surface-variant whitespace-nowrap tabular-nums h-3 leading-3">
                      {(i % labelStep === 0 || i === chartArr.length - 1) ? shortDate(date) : ''}
                    </span>
                  </div>
                ))}
              </div>
            </Section>

            <div className="grid md:grid-cols-3 gap-4 md:gap-6">
              {/* By model — donut inline, legend behind the top-right icon */}
              <ChartCard icon="memory" title="各模型輸出量" unit="tokens"
                items={modelArr.map(([model, v]) => ({ label: model, value: v.out }))} />

              {/* By skill — donut inline, legend behind the top-right icon */}
              <ChartCard icon="widgets" title="各功能呼叫數" unit="次"
                items={skillArr.map(([skill, calls]) => ({ label: labelSkill(skill), value: calls }))} />

              {/* API key reasons */}
              <Section title="API key 呼叫原因" icon="help">
                {(stats?.reasons?.length ?? 0) === 0 ? (
                  <p className="text-sm text-on-surface-variant py-4 text-center">此期間沒有任何 API key 呼叫</p>
                ) : (
                  <div className="space-y-2">
                    {stats?.reasons?.map((r, i) => (
                      <div key={i} className="flex justify-between items-center text-sm py-1 border-b border-outline-variant/10 last:border-0">
                        <span className="text-on-surface">{labelReason(r.reason)}</span>
                        <span className="text-[#E07070] font-bold">{r.calls} 次</span>
                      </div>
                    ))}
                  </div>
                )}
              </Section>
            </div>

            {/* Recent API key calls */}
            <Section title="最近 API key 呼叫明細（逐筆佐證）" icon="receipt_long">
              {(stats?.recentApiKey?.length ?? 0) === 0 ? (
                <p className="text-sm text-on-surface-variant py-4 text-center">沒有 API key 呼叫記錄</p>
              ) : (
                <>
                  {/* Mobile: stacked cards (a 6-column table squishes on phones) */}
                  <div className="md:hidden space-y-2">
                    {stats?.recentApiKey?.map((r, i) => (
                      <div key={i} className="rounded-lg bg-surface-container-high p-3 space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-on-surface font-medium">{labelSkill(r.skill_id)}</span>
                          <span className="text-on-surface-variant text-xs shrink-0">{fmtTime(r.created_at)}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 text-xs">
                          <span className="font-mono text-on-surface-variant truncate">{r.model || '—'}</span>
                          <span className="tabular-nums text-on-surface shrink-0">
                            {num(r.output_tokens)} out{' '}
                            {r.success ? <span className="text-[#3FBBC0]">✓</span> : <span className="text-on-surface-variant">✕</span>}
                          </span>
                        </div>
                        <div className="text-xs text-on-surface-variant">{labelReason(r.reason)}</div>
                      </div>
                    ))}
                  </div>

                  {/* Desktop: full table */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-on-surface-variant border-b border-outline-variant/20">
                          <th className="py-2 pr-3 font-medium">時間</th>
                          <th className="py-2 pr-3 font-medium">功能</th>
                          <th className="py-2 pr-3 font-medium">模型</th>
                          <th className="py-2 pr-3 font-medium">原因</th>
                          <th className="py-2 pr-3 font-medium text-right">輸出 tokens</th>
                          <th className="py-2 font-medium text-center">結果</th>
                        </tr>
                      </thead>
                      <tbody>
                        {stats?.recentApiKey?.map((r, i) => (
                          <tr key={i} className="border-b border-outline-variant/10 last:border-0">
                            <td className="py-2 pr-3 text-on-surface-variant whitespace-nowrap">{fmtTime(r.created_at)}</td>
                            <td className="py-2 pr-3 text-on-surface whitespace-nowrap">{labelSkill(r.skill_id)}</td>
                            <td className="py-2 pr-3 font-mono text-xs text-on-surface-variant">{r.model || '—'}</td>
                            <td className="py-2 pr-3 text-on-surface-variant">{labelReason(r.reason)}</td>
                            <td className="py-2 pr-3 text-right tabular-nums text-on-surface">{num(r.output_tokens)}</td>
                            <td className="py-2 text-center">{r.success ? <span className="text-[#3FBBC0]">✓</span> : <span className="text-on-surface-variant">✕</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </Section>

            {/* ── Aux LLM lane: on-prem + DeepSeek ─────────────────────────
                Separate from everything above on purpose. The account-vs-key
                split explains the Anthropic invoice; this answers a different
                question — is the free lane dependable enough to keep routing
                work to it, and when it is not, why. */}
            <Section title="地端 / DeepSeek · 穩定性" icon="dns">
              {!auxRows.length ? (
                <div className="text-sm text-on-surface-variant py-4">
                  這段期間沒有地端或 DeepSeek 呼叫紀錄。
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4 mb-5">
                    {auxRows.map(r => {
                      const meta = PROVIDER_LABELS[r.auth_mode] || { name: r.auth_mode, note: '', tone: 'text-on-surface' };
                      const calls = Number(r.calls || 0);
                      const ok = Number(r.ok || 0);
                      const rate = calls ? (ok / calls) * 100 : 0;
                      // Green only when it is genuinely dependable; amber is a
                      // warning that the fallback is carrying real traffic.
                      const tone = rate >= 98 ? 'text-[#3FBBC0]' : rate >= 90 ? 'text-[#F0A84B]' : 'text-error';
                      return (
                        <div key={`${r.auth_mode}-${r.model}`} className="bg-surface-container-high rounded-lg p-4">
                          <div className="flex items-baseline gap-2 mb-1">
                            <span className={`text-sm font-bold ${meta.tone}`}>{meta.name}</span>
                            <span className="text-[11px] text-on-surface-variant">{meta.note}</span>
                          </div>
                          <div className="font-mono text-[11px] text-on-surface-variant mb-3 truncate" title={r.model || ''}>{r.model || '—'}</div>
                          <div className="flex items-end gap-4">
                            <div>
                              <div className={`text-3xl font-bold tabular-nums ${tone}`}>{rate.toFixed(1)}%</div>
                              <div className="text-[11px] text-on-surface-variant">成功率</div>
                            </div>
                            <div className="text-sm text-on-surface-variant pb-1">
                              {num(ok)} / {num(calls)} 次成功
                              {calls - ok > 0 && <span className="text-error"> · {num(calls - ok)} 次失敗</span>}
                            </div>
                            <div className="ml-auto text-right pb-1">
                              <div className="text-sm tabular-nums text-on-surface">{num(Number(r.outTok || 0))}</div>
                              <div className="text-[11px] text-on-surface-variant">輸出 tokens</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    <div>
                      <div className="text-xs font-bold text-on-surface-variant mb-2">失敗原因</div>
                      {!stats?.auxFailures?.length ? (
                        <div className="text-sm text-[#3FBBC0]">期間內沒有任何失敗</div>
                      ) : (
                        <div className="space-y-1.5">
                          {stats.auxFailures.map((f, i) => (
                            <div key={i} className="flex items-center gap-2 text-sm">
                              <span className={`text-[11px] px-1.5 py-0.5 rounded ${(PROVIDER_LABELS[f.auth_mode]?.tone) || ''} bg-surface-container-high`}>
                                {PROVIDER_LABELS[f.auth_mode]?.name || f.auth_mode}
                              </span>
                              <span className="text-on-surface-variant flex-1 truncate">{labelAuxReason(f.reason)}</span>
                              <span className="tabular-nums text-error">{f.calls} 次</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

                    <div>
                      <div className="text-xs font-bold text-on-surface-variant mb-2">各功能成功率</div>
                      <div className="space-y-1.5">
                        {(stats?.auxByFeature || []).map((f, i) => {
                          const calls = Number(f.calls || 0);
                          const ok = Number(f.ok || 0);
                          const rate = calls ? Math.round((ok / calls) * 100) : 0;
                          return (
                            <div key={i} className="flex items-center gap-2 text-sm">
                              <span className="text-on-surface flex-1 truncate">{labelSkill(f.skill_id)}</span>
                              <span className="text-[11px] text-on-surface-variant">{PROVIDER_LABELS[f.auth_mode]?.name || f.auth_mode}</span>
                              <span className={`tabular-nums ${rate >= 98 ? 'text-[#3FBBC0]' : rate >= 90 ? 'text-[#F0A84B]' : 'text-error'}`}>
                                {rate}%
                              </span>
                              <span className="text-[11px] text-on-surface-variant tabular-nums w-12 text-right">{num(calls)} 次</span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </Section>

          </>
        )}
      </div>
    </>
  );
}
