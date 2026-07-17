'use client';

/**
 * KM 助手 — the knowledge-base assistant panel body, hosted by AssistantDock (no
 * own bubble). Two tabs:
 *  • 文件: search KM → open a document → view / download its attachments. Direct
 *    calls (no AI, no tokens).
 *  • 對話: AI Q&A grounded in KM (streamed via /api/km-agent/chat), answers cite
 *    the source documents (which the user can open in the 文件 tab).
 *
 * Attachments are fetched as BLOBS (the API needs an Authorization header, which an
 * <iframe src> can't send) then shown via an object URL.
 */
import { useState, useRef, useEffect } from 'react';
import dynamic from 'next/dynamic';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkCjkFriendly from 'remark-cjk-friendly';
import remarkFlexibleMarkers from 'remark-flexible-markers';

// pdf.js is heavy — load the viewer only when a PDF is actually opened.
const KmPdfViewer = dynamic(() => import('./KmPdfViewer'), { ssr: false });

// Shared plugin set: gfm tables + CJK-friendly bold/italic + ==highlight== markers.
const MD_PLUGINS = [remarkGfm, remarkCjkFriendly, remarkFlexibleMarkers];

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

type Tab = 'docs' | 'chat';
interface KmDoc { id: string; title: string; category: string; raw: any }
interface KmAttachment { filename: string; raw: any }
interface ChatMsg { role: 'user' | 'assistant'; content: string }

// KM's JSON field names aren't fixed — read defensively.
function pick(obj: any, keys: string[]): string {
  for (const k of keys) { const v = obj?.[k]; if (v != null && v !== '') return String(v); }
  return '';
}
function toDocs(data: any): KmDoc[] {
  const arr = data?.documents ?? data?.results ?? data?.data ?? data?.items ?? data?.list ?? (Array.isArray(data) ? data : []);
  if (!Array.isArray(arr)) return [];
  return arr.map((d: any) => ({
    id: pick(d, ['document_id', 'id', 'documentId', 'docId']),
    title: pick(d, ['title', 'name', 'subject', 'document_name', 'documentName']) || '(未命名文件)',
    category: pick(d, ['category_path', 'category', 'folder_path', 'categoryPath', 'path']),
    raw: d,
  })).filter((d: KmDoc) => d.id);
}
function toAttachments(data: any): KmAttachment[] {
  const arr = data?.attachments ?? data?.document?.attachments ?? data?.files ?? data?.attachment_list ?? [];
  if (!Array.isArray(arr)) return [];
  return arr.map((a: any) => ({ filename: pick(a, ['filename', 'name', 'file_name', 'fileName']), raw: a })).filter((a: KmAttachment) => a.filename);
}
function ext(name: string): string { const i = name.lastIndexOf('.'); return i >= 0 ? name.slice(i + 1).toLowerCase() : ''; }
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);
// Office types the server converts to PDF (LibreOffice) so the pdf.js viewer can
// preview + highlight them.
const OFFICE_EXTS = new Set(['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls']);

// Colour-coded file-type icon (matches the usual PDF=red / PPT=orange / Word=blue
// / Excel=green / image=purple convention).
function fileIcon(name: string): { icon: string; cls: string } {
  const e = ext(name);
  if (e === 'pdf') return { icon: 'picture_as_pdf', cls: 'text-red-500' };
  if (e === 'pptx' || e === 'ppt') return { icon: 'slideshow', cls: 'text-orange-500' };
  if (e === 'docx' || e === 'doc') return { icon: 'description', cls: 'text-blue-600' };
  if (e === 'xlsx' || e === 'xls' || e === 'csv') return { icon: 'table_chart', cls: 'text-green-600' };
  if (IMG_EXTS.has(e)) return { icon: 'image', cls: 'text-purple-500' };
  return { icon: 'draft', cls: 'text-on-surface-variant/70' };
}

// Map the currently-running tool to a human-readable progress step (perceived speed).
function toolProgress(tool: string): string {
  if (tool.includes('km_search')) return '搜尋 KM 文件中…（結果多時較慢）';
  if (tool.includes('km_get_document')) return '讀取文件資訊中…';
  if (tool.includes('km_get_attachment')) return '讀取文件內容中…';
  if (tool.includes('ToolSearch')) return '準備工具中…';
  return '檢索 KM 中…';
}

// Pull cited KM documents out of an AI answer so they can be shown as clickable
// source chips. The retriever prompt cites them as 「標題（#3474）」; we also catch
// bare #ids as a fallback.
function extractSources(text: string): { id: string; title: string }[] {
  const out: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  const titled = /([^\n（()）]{2,40})[（(]\s*#(\d{2,})\s*[）)]/g;
  let m: RegExpExecArray | null;
  while ((m = titled.exec(text))) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, title: m[1].trim().replace(/^[-*・•\d.、）)\s]+/, '').slice(0, 40) });
  }
  const bare = /#(\d{2,})/g;
  while ((m = bare.exec(text))) {
    const id = m[1];
    if (!seen.has(id)) { seen.add(id); out.push({ id, title: `文件 #${id}` }); }
  }
  return out;
}

const compactMd = {
  p: (p: any) => <p className="mb-1.5 last:mb-0" {...p} />,
  ul: (p: any) => <ul className="list-disc pl-4 mb-1.5 space-y-0.5" {...p} />,
  ol: (p: any) => <ol className="list-decimal pl-4 mb-1.5 space-y-0.5" {...p} />,
  table: (p: any) => <div className="overflow-x-auto my-1.5"><table className="text-xs border-collapse" {...p} /></div>,
  th: (p: any) => <th className="border border-outline-variant/30 px-1.5 py-0.5 bg-surface-container-high" {...p} />,
  td: (p: any) => <td className="border border-outline-variant/20 px-1.5 py-0.5" {...p} />,
  code: (p: any) => <code className="px-1 py-0.5 rounded bg-surface-container text-[0.85em]" {...p} />,
  mark: (p: any) => <mark className="bg-amber-200/35 text-on-surface rounded px-1 [box-decoration-break:clone] [-webkit-box-decoration-break:clone]" {...p} />,
};

export default function KMAssistantWidget() {
  const [tab, setTab] = useState<Tab>('docs');

  // ── 文件 tab ──
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<KmDoc[]>([]);
  const [searchErr, setSearchErr] = useState('');
  const [searched, setSearched] = useState(false);
  // Opt-in AI relevance ranking of the current results (one Haiku call, metadata-only).
  const [ranks, setRanks] = useState<Record<string, { level: string; reason: string }>>({});
  const [ranking, setRanking] = useState(false);
  const [detail, setDetail] = useState<{ doc: KmDoc; attachments: KmAttachment[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState('');
  const [viewer, setViewer] = useState<{ docId: string; filename: string; url: string; kind: 'pdf' | 'image' | 'other'; search?: string; page?: number } | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  // 命中位置 (Phase 2): which pages of the open document mention the search term.
  const [hits, setHits] = useState<{ filename: string; loading: boolean; items: { page: number | null; snippets: string[] }[]; err?: string } | null>(null);
  // "問 AI 這份在講什麼" — shown INLINE in the 文件 detail and cached per document,
  // so re-opening shows the previous answer (no re-ask). Badged in the result list.
  const [explain, setExplain] = useState<{ docId: string; text: string; streaming: boolean; cached: boolean } | null>(null);
  const [explainOpen, setExplainOpen] = useState(false); // default collapsed; auto-open on fresh ask
  const [explainedIds, setExplainedIds] = useState<Set<string>>(new Set());

  // ── 對話 tab ──
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [toolNote, setToolNote] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  // In-widget toast (replaces browser alert()).
  const [toast, setToast] = useState('');
  useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(''), 4000); return () => clearTimeout(t); }, [toast]);
  const showToast = (msg: string) => setToast(msg);

  const authHeaders = (): Record<string, string> => {
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  };

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages, streamText]);

  // Load chat history once when the chat tab is first opened.
  const historyLoaded = useRef(false);
  useEffect(() => {
    if (tab !== 'chat' || historyLoaded.current) return;
    historyLoaded.current = true;
    fetch(`${API_BASE}/api/km-agent/history`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : { messages: [] })
      // Don't clobber an in-flight message the user just sent while history loaded.
      .then(d => setMessages(prev => prev.length ? prev : (d.messages || []).map((m: any) => ({ role: m.role, content: m.content }))))
      .catch(() => {});
  }, [tab]);

  async function runSearch() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true); setSearchErr(''); setSearched(true); setDetail(null); setResults([]); setRanks({});
    try {
      // The endpoint STREAMS (keepalives while KM is slow, then a single data: event
      // with the result) — so broad terms complete instead of the proxy resetting.
      const res = await fetch(`${API_BASE}/api/km-agent/search`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => null);
        setSearchErr((d && d.error) || `KM 搜尋失敗（${res.status}）`); setResults([]); return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let payload: any = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (line) { try { payload = JSON.parse(line.slice(5).trim()); } catch { /* skip */ } }
        }
      }
      if (!payload) setSearchErr('KM 搜尋沒有回應，請稍後再試。');
      else if (!payload.ok) setSearchErr(payload.error || 'KM 搜尋失敗，請稍後再試。');
      else { setSearchErr(''); setResults(toDocs(payload.data)); loadExplainedIds(); }
    } catch (err) {
      console.error('[KM search] fetch failed:', err);
      setSearchErr('KM 搜尋連線中斷,請稍後再試。');
      setResults([]);
    }
    finally { setSearching(false); }
  }

  async function openDoc(doc: KmDoc) {
    setDetailLoading(true); setDetailErr(''); setDetail({ doc, attachments: [] });
    setHits(null); setExplain(null); setExplainOpen(false);
    // Show a previously-cached AI explanation for this doc, if any (no re-ask).
    fetch(`${API_BASE}/api/km-agent/document/${encodeURIComponent(doc.id)}/explain`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && d.answer) setExplain({ docId: doc.id, text: d.answer, streaming: false, cached: true }); })
      .catch(() => {});
    try {
      const res = await fetch(`${API_BASE}/api/km-agent/document/${encodeURIComponent(doc.id)}`, { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) { setDetailErr(data.error || '無法開啟文件'); setDetail({ doc, attachments: [] }); }
      else setDetail({ doc, attachments: toAttachments(data) });
    } catch { setDetailErr('取文件失敗，請再試一次。'); }
    finally { setDetailLoading(false); }
  }

  // Open a document straight from a chat answer's source chip: fetch its detail,
  // then view the first viewable attachment (or download if none is viewable).
  const [openingSource, setOpeningSource] = useState<string>('');
  async function openDocById(id: string, highlight?: string) {
    setOpeningSource(id);
    try {
      const res = await fetch(`${API_BASE}/api/km-agent/document/${encodeURIComponent(id)}`, { headers: authHeaders() });
      const data = await res.json().catch(() => null);
      if (!res.ok) { showToast((data && data.error) || `無法開啟文件 #${id}`); return; }
      const atts = toAttachments(data);
      const viewable = atts.find(a => { const e = ext(a.filename); return e === 'pdf' || IMG_EXTS.has(e); });
      if (viewable) await viewAttachment(id, viewable.filename, highlight);
      else if (atts[0]) await downloadAttachment(id, atts[0].filename);
      else showToast('這份文件沒有可開啟的附件。');
    } catch { showToast('開啟文件失敗，請稍後再試。'); }
    finally { setOpeningSource(''); }
  }

  async function fetchBlobUrl(docId: string, filename: string, download: boolean): Promise<string> {
    const res = await fetch(
      `${API_BASE}/api/km-agent/document/${encodeURIComponent(docId)}/attachment/${encodeURIComponent(filename)}${download ? '?download=1' : ''}`,
      { headers: authHeaders() },
    );
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || `下載失敗（${res.status}）`); }
    return URL.createObjectURL(await res.blob());
  }

  async function viewAttachment(docId: string, filename: string, highlight?: string, page?: number) {
    const e = ext(filename);
    const isOffice = OFFICE_EXTS.has(e);
    // Office files are converted to PDF server-side, so they view (and highlight) via
    // the same pdf.js viewer.
    const kind: 'pdf' | 'image' | 'other' = (e === 'pdf' || isOffice) ? 'pdf' : IMG_EXTS.has(e) ? 'image' : 'other';
    if (kind === 'other') { await downloadAttachment(docId, filename); return; } // non-viewable → just download
    const search = highlight?.trim() || query.trim() || undefined; // carry the term → highlight in the PDF
    setViewerLoading(true); setViewer({ docId, filename, url: '', kind, search, page });
    try {
      const url = isOffice ? await fetchAsPdfBlobUrl(docId, filename) : await fetchBlobUrl(docId, filename, false);
      setViewer({ docId, filename, url, kind, search, page });
    } catch (err) { setViewer(null); showToast((err as Error).message); }
    finally { setViewerLoading(false); }
  }

  // Fetch an Office attachment converted to PDF (for preview + highlight).
  async function fetchAsPdfBlobUrl(docId: string, filename: string): Promise<string> {
    const res = await fetch(`${API_BASE}/api/km-agent/document/${encodeURIComponent(docId)}/attachment/${encodeURIComponent(filename)}/as-pdf`, { headers: authHeaders() });
    if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error((d && d.error) || `轉檔預覽失敗（${res.status}）`); }
    return URL.createObjectURL(await res.blob());
  }

  // Load 命中位置: which pages of this attachment mention the current search term.
  async function loadHits(docId: string, filename: string) {
    const q = query.trim();
    if (!q) return;
    setHits({ filename, loading: true, items: [] });
    try {
      const res = await fetch(`${API_BASE}/api/km-agent/document/${encodeURIComponent(docId)}/attachment/${encodeURIComponent(filename)}/hits?q=${encodeURIComponent(q)}`, { headers: authHeaders() });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setHits({ filename, loading: false, items: [], err: (data && data.error) || '無法定位關鍵字' }); return; }
      setHits({ filename, loading: false, items: data.hits || [] });
    } catch { setHits({ filename, loading: false, items: [], err: '定位失敗，請再試一次。' }); }
  }

  async function downloadAttachment(docId: string, filename: string) {
    try {
      const url = await fetchBlobUrl(docId, filename, true);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) { showToast((err as Error).message); }
  }

  function closeViewer() {
    if (viewer?.url) URL.revokeObjectURL(viewer.url);
    setViewer(null);
  }

  async function rankResults() {
    if (!results.length || ranking) return;
    setRanking(true);
    try {
      // Streamed (keepalives while the model works, then a data event with {ranked}).
      const res = await fetch(`${API_BASE}/api/km-agent/rank`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), docs: results.map(d => ({ id: d.id, title: d.title, category: d.category })) }),
      });
      if (!res.ok || !res.body) { const d = await res.json().catch(() => null); showToast((d && d.error) || `AI 相關性判斷失敗（${res.status}）`); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let payload: any = null;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (line) { try { payload = JSON.parse(line.slice(5).trim()); } catch { /* skip */ } }
        }
      }
      if (payload && Array.isArray(payload.ranked) && payload.ranked.length) {
        const map: Record<string, { level: string; reason: string }> = {};
        for (const r of payload.ranked) if (r && r.id) map[String(r.id)] = { level: String(r.level || ''), reason: String(r.reason || '') };
        setRanks(map);
      } else { showToast('AI 沒有回傳相關性結果，請稍後再試。'); }
    } catch { showToast('AI 相關性判斷連線失敗，請稍後再試。'); }
    finally { setRanking(false); }
  }

  const loadExplainedIds = () => {
    fetch(`${API_BASE}/api/km-agent/explained`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d && Array.isArray(d.ids)) setExplainedIds(new Set(d.ids.map(String))); })
      .catch(() => {});
  };

  // Ask the AI to explain a specific document — streamed INLINE in the 文件 detail
  // (not the chat tab) and cached server-side so it persists next time.
  async function explainDoc(doc: KmDoc) {
    const q = query.trim();
    setExplain({ docId: doc.id, text: '', streaming: true, cached: false });
    setExplainOpen(true); // fresh ask → auto-expand
    let acc = '';
    try {
      const res = await fetch(`${API_BASE}/api/km-agent/document/${encodeURIComponent(doc.id)}/explain`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: doc.title, keyword: q || undefined }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => null);
        setExplain({ docId: doc.id, text: (d && (d.message || d.error)) || '解讀失敗，請稍後再試。', streaming: false, cached: false });
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.type === 'text') { acc += ev.data as string; setExplain(e => (e && e.docId === doc.id ? { ...e, text: acc } : e)); }
          } catch { /* skip */ }
        }
      }
    } catch { if (!acc) acc = '解讀連線中斷，請再試一次。'; }
    finally {
      setExplain(e => (e && e.docId === doc.id ? { ...e, text: acc || e.text, streaming: false } : e));
      setExplainedIds(prev => new Set(prev).add(doc.id));
    }
  }

  async function sendChat(override?: string) {
    const msg = (override ?? input).trim();
    if (!msg || streaming) return;
    setInput(''); setToolNote('');
    setMessages(prev => [...prev, { role: 'user', content: msg }]);
    setStreaming(true); setStreamText('');
    let acc = '';
    try {
      const res = await fetch(`${API_BASE}/api/km-agent/chat`, {
        method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      });
      if (!res.ok || !res.body) {
        const d = await res.json().catch(() => ({}));
        setMessages(prev => [...prev, { role: 'assistant', content: d.message || d.error || '回應失敗，請稍後再試。' }]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop() || '';
        for (const part of parts) {
          const line = part.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          try {
            const ev = JSON.parse(line.slice(5).trim());
            if (ev.type === 'text') { acc += ev.data as string; setStreamText(acc); }
            else if (ev.type === 'tool_activity') { setToolNote(toolProgress((ev.data && ev.data.tool) || '')); }
          } catch { /* skip */ }
        }
      }
    } catch {
      if (!acc) acc = '連線中斷，請再試一次。';
    } finally {
      setStreaming(false); setToolNote('');
      setStreamText('');
      setMessages(prev => [...prev, { role: 'assistant', content: acc || '（沒有取得回應）' }]);
    }
  }

  return (
    <div className="absolute inset-0 bg-surface-container-high flex flex-col overflow-hidden">
      {/* Toast (replaces browser alert) */}
      {toast && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-[140] max-w-[90%] animate-in fade-in slide-in-from-bottom-2 duration-200">
          <div className="flex items-center gap-2 px-3.5 py-2.5 rounded-xl bg-inverse-surface text-inverse-on-surface text-xs shadow-xl">
            <span className="material-symbols-outlined text-base text-amber-300">info</span>
            <span className="leading-snug">{toast}</span>
            <button onClick={() => setToast('')} className="ml-1 shrink-0 opacity-70 hover:opacity-100"><span className="material-symbols-outlined text-base">close</span></button>
          </div>
        </div>
      )}
      {/* Tab bar */}
      <div className="flex border-b border-outline-variant/10 shrink-0">
        {([{ id: 'docs' as Tab, icon: 'folder_open', label: '文件' }, { id: 'chat' as Tab, icon: 'chat', label: '對話' }]).map(tb => (
          <button key={tb.id} onClick={() => setTab(tb.id)}
            className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 text-sm font-medium transition-colors relative ${tab === tb.id ? 'text-primary' : 'text-on-surface-variant hover:text-on-surface'}`}>
            <span className="material-symbols-outlined text-lg">{tb.icon}</span>{tb.label}
            {tab === tb.id && <span className="absolute bottom-0 left-1/4 right-1/4 h-0.5 bg-primary rounded-full" />}
          </button>
        ))}
      </div>

      {/* ── 文件 tab ── */}
      {tab === 'docs' && (
        <div className="flex-1 flex flex-col min-h-0">
          {!detail ? (
            <>
              <div className="p-3 shrink-0 flex gap-2">
                <input value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
                  placeholder="搜尋 KM 文件關鍵字（如：請假、差旅）"
                  className="flex-1 px-3 py-2 text-sm rounded-lg bg-surface-container border border-outline-variant/20 focus:outline-none focus:border-primary" />
                <button onClick={runSearch} disabled={searching || !query.trim()}
                  className="px-3 py-2 rounded-lg bg-primary text-on-primary text-sm font-medium disabled:opacity-40 flex items-center gap-1">
                  <span className={`material-symbols-outlined text-lg ${searching ? 'animate-spin' : ''}`}>{searching ? 'progress_activity' : 'search'}</span>
                </button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 pb-3 min-h-0">
                {searchErr && <div className="text-sm text-error px-1 py-2">{searchErr}</div>}
                {searching && <div className="text-sm text-on-surface-variant px-1 py-2 flex items-center gap-2"><span className="material-symbols-outlined animate-spin text-base">progress_activity</span>KM 搜尋中（可能較慢）…</div>}
                {!searching && searched && !searchErr && results.length === 0 && <div className="text-sm text-on-surface-variant px-1 py-6 text-center">找不到相關文件，換個關鍵字試試。</div>}
                {!searching && !searched && <div className="text-sm text-on-surface-variant/60 px-1 py-8 text-center">輸入關鍵字搜尋你有權限的 KM 文件。</div>}
                {!searching && results.length > 0 && (
                  <div className="flex items-center justify-between px-1 mb-1.5">
                    <span className="text-[11px] text-on-surface-variant/50">{results.length} 筆結果{Object.keys(ranks).length > 0 ? '（依相關性排序）' : ''}</span>
                    <button onClick={rankResults} disabled={ranking}
                      className="inline-flex items-center gap-1 text-[11px] text-primary hover:bg-primary/10 rounded-lg px-2 py-1 disabled:opacity-50">
                      <span className={`material-symbols-outlined text-sm ${ranking ? 'animate-spin' : ''}`}>{ranking ? 'progress_activity' : 'target'}</span>AI 判斷相關性
                    </button>
                  </div>
                )}
                <div className="space-y-1.5">
                  {(Object.keys(ranks).length
                    ? [...results].sort((a, b) => (({ '高': 0, '中': 1, '低': 2 } as any)[ranks[a.id]?.level] ?? 3) - (({ '高': 0, '中': 1, '低': 2 } as any)[ranks[b.id]?.level] ?? 3))
                    : results
                  ).map(doc => {
                    const rk = ranks[doc.id];
                    const rkCls = rk?.level === '高' ? 'bg-green-500/15 text-green-600' : rk?.level === '中' ? 'bg-amber-500/15 text-amber-600' : rk?.level === '低' ? 'bg-surface-container-highest text-on-surface-variant/60' : '';
                    return (
                      <button key={doc.id} onClick={() => openDoc(doc)}
                        className="w-full text-left p-2.5 rounded-lg bg-surface-container hover:bg-primary/5 border border-transparent hover:border-primary/20 transition-colors">
                        <div className="flex items-start gap-2">
                          <span className="material-symbols-outlined text-primary/70 text-lg shrink-0 mt-0.5">description</span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              {rk && <span title={rk.reason} className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-bold ${rkCls}`}>{rk.level}</span>}
                              <p className="text-sm font-medium text-on-surface truncate">{doc.title}</p>
                              {explainedIds.has(doc.id) && (
                                <span title="AI 已解讀過" className="shrink-0 inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-primary/10 text-primary text-[10px] font-medium">
                                  <span className="material-symbols-outlined text-[12px]">smart_toy</span>AI
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-on-surface-variant/60 truncate">#{doc.id}{doc.category ? ` · ${doc.category}` : ''}</p>
                            {rk?.reason && <p className="text-[10px] text-on-surface-variant/45 truncate">{rk.reason}</p>}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="p-3 shrink-0 border-b border-outline-variant/10">
                <button onClick={() => setDetail(null)} className="text-xs text-primary flex items-center gap-1 mb-2 hover:opacity-80">
                  <span className="material-symbols-outlined text-sm">arrow_back</span>返回搜尋結果
                </button>
                <p className="text-sm font-semibold text-on-surface">{detail.doc.title}</p>
                <p className="text-[11px] text-on-surface-variant/60">#{detail.doc.id}{detail.doc.category ? ` · ${detail.doc.category}` : ''}</p>
                {!(explain && explain.docId === detail.doc.id) && (
                  <button onClick={() => explainDoc(detail.doc)}
                    className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20">
                    <span className="material-symbols-outlined text-sm">smart_toy</span>問 AI：這份在講什麼{query.trim() ? `／跟「${query.trim()}」的關係` : ''}
                  </button>
                )}
              </div>
              <div className="flex-1 overflow-y-auto p-3 min-h-0 space-y-3">
                {/* AI 解讀 — inline, cached (shows previous answer without re-asking) */}
                {explain && explain.docId === detail.doc.id && (
                  <div className="rounded-xl bg-primary/5 border border-primary/15 overflow-hidden">
                    <div className="flex items-center gap-1.5 px-3 py-2">
                      <button onClick={() => setExplainOpen(o => !o)} className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                        <span className="material-symbols-outlined text-primary text-lg shrink-0">smart_toy</span>
                        <span className="text-xs font-medium text-primary">AI 解讀{explain.cached ? '（先前已回答）' : ''}</span>
                        {!explainOpen && explain.text && <span className="text-[11px] text-on-surface-variant/50 truncate">— {explain.text.replace(/[#*=`>-]/g, '').slice(0, 24)}…</span>}
                        <span className="material-symbols-outlined text-on-surface-variant/60 text-lg ml-auto shrink-0">{explainOpen ? 'expand_less' : 'expand_more'}</span>
                      </button>
                      {!explain.streaming && (
                        <div className="relative group/tip shrink-0">
                          <button onClick={() => explainDoc(detail.doc)} className="w-7 h-7 flex items-center justify-center rounded-full text-primary/70 hover:bg-primary/10">
                            <span className="material-symbols-outlined text-lg">refresh</span>
                          </button>
                          <span className="pointer-events-none absolute right-0 top-full mt-1 px-2 py-1 rounded-lg bg-inverse-surface text-inverse-on-surface text-[11px] whitespace-nowrap opacity-0 group-hover/tip:opacity-100 transition-opacity shadow-lg z-10">重新問 AI</span>
                        </div>
                      )}
                    </div>
                    {explainOpen && (
                      <div className="px-3 pb-3">
                        {explain.text
                          ? <div className="text-sm leading-relaxed break-words"><ReactMarkdown remarkPlugins={MD_PLUGINS} components={compactMd}>{explain.text}</ReactMarkdown></div>
                          : <div className="text-xs text-on-surface-variant flex items-center gap-1.5"><span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>AI 讀取文件中…</div>}
                        {explain.streaming && explain.text && <span className="inline-block w-1.5 h-4 bg-primary/60 animate-pulse ml-0.5 rounded-sm" />}
                      </div>
                    )}
                  </div>
                )}
                {detailLoading && <div className="text-sm text-on-surface-variant flex items-center gap-2"><span className="material-symbols-outlined animate-spin text-base">progress_activity</span>載入文件中…</div>}
                {detailErr && <div className="text-sm text-error py-2">{detailErr}</div>}
                {!detailLoading && !detailErr && detail.attachments.length === 0 && <div className="text-sm text-on-surface-variant py-4 text-center">這份文件沒有可下載的附件。</div>}
                <div className="space-y-1.5">
                  {detail.attachments.map((att, i) => {
                    const e = ext(att.filename);
                    const canView = e === 'pdf' || IMG_EXTS.has(e) || OFFICE_EXTS.has(e);
                    const q = query.trim();
                    const attHits = hits && hits.filename === att.filename ? hits : null;
                    return (
                      <div key={i} className="rounded-lg bg-surface-container overflow-hidden">
                        <div className="flex items-center gap-2 p-2.5">
                          <span className={`material-symbols-outlined ${fileIcon(att.filename).cls} text-lg shrink-0`}>{fileIcon(att.filename).icon}</span>
                          <p className="text-sm text-on-surface truncate flex-1 min-w-0">{att.filename}</p>
                          {q && (e === 'pdf' || OFFICE_EXTS.has(e)) && (
                            <button onClick={() => loadHits(detail.doc.id, att.filename)} title={`找「${q}」在哪`}
                              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-primary shrink-0">
                              <span className="material-symbols-outlined text-lg">manage_search</span>
                            </button>
                          )}
                          {canView && (
                            <button onClick={() => viewAttachment(detail.doc.id, att.filename)} title="檢視"
                              className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-primary shrink-0">
                              <span className="material-symbols-outlined text-lg">visibility</span>
                            </button>
                          )}
                          <button onClick={() => downloadAttachment(detail.doc.id, att.filename)} title="下載"
                            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-primary shrink-0">
                            <span className="material-symbols-outlined text-lg">download</span>
                          </button>
                        </div>
                        {attHits && (
                          <div className="px-2.5 pb-2.5 pt-1 border-t border-outline-variant/10">
                            {attHits.loading && <div className="text-xs text-on-surface-variant flex items-center gap-1.5 py-1"><span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>定位「{q}」中…</div>}
                            {attHits.err && <div className="text-xs text-error py-1">{attHits.err}</div>}
                            {!attHits.loading && !attHits.err && attHits.items.length === 0 && <div className="text-xs text-on-surface-variant/70 py-1">此附件內文找不到「{q}」(可能在圖片或別的附件)。</div>}
                            <div className="space-y-1">
                              {attHits.items.map((h, hi) => (
                                <button key={hi} onClick={() => viewAttachment(detail.doc.id, att.filename, q, h.page ?? undefined)}
                                  className="w-full text-left px-2 py-1.5 rounded-md hover:bg-surface-container-high">
                                  <span className="text-[11px] font-medium text-primary">{h.page ? `第 ${h.page} 頁` : '內文'} · 開啟並跳到此處</span>
                                  <p className="text-[11px] text-on-surface-variant/80 line-clamp-2">…{h.snippets[0]}…</p>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── 對話 tab ── */}
      {tab === 'chat' && (
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex-1 overflow-y-auto p-3 space-y-3 min-h-0">
            {messages.length === 0 && !streaming && (
              <div className="text-sm text-on-surface-variant/60 py-8 text-center px-4">
                問我 KM 知識庫的問題，我會查文件、依內容回答並附上來源（可到「文件」分頁開啟或下載）。
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                {m.role === 'assistant' && <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5 shrink-0"><span className="material-symbols-outlined text-primary text-sm">menu_book</span></div>}
                <div className={`px-3.5 py-2.5 rounded-xl text-sm ${m.role === 'user' ? 'max-w-[80%] bg-primary text-on-primary rounded-br-sm' : 'flex-1 min-w-0 bg-surface-container text-on-surface rounded-bl-sm'}`}>
                  {m.role === 'assistant'
                    ? <>
                        <div className="leading-relaxed break-words"><ReactMarkdown remarkPlugins={MD_PLUGINS} components={compactMd}>{m.content}</ReactMarkdown></div>
                        {(() => { const src = extractSources(m.content); return src.length > 0 && (
                          <div className="mt-2 pt-2 border-t border-outline-variant/15">
                            <p className="text-[11px] text-on-surface-variant/60 mb-1">來源文件（點擊開啟原文）</p>
                            <div className="flex flex-wrap gap-1.5">
                              {src.map(s => (
                                <button key={s.id} onClick={() => openDocById(s.id)} disabled={openingSource === s.id}
                                  className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-primary/10 text-primary text-xs hover:bg-primary/20 disabled:opacity-50 max-w-full">
                                  <span className={`material-symbols-outlined text-sm ${openingSource === s.id ? 'animate-spin' : ''}`}>{openingSource === s.id ? 'progress_activity' : 'description'}</span>
                                  <span className="truncate">{s.title}</span>
                                  <span className="material-symbols-outlined text-sm shrink-0">open_in_new</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ); })()}
                      </>
                    : <p className="whitespace-pre-wrap leading-relaxed break-words">{m.content}</p>}
                </div>
              </div>
            ))}
            {streaming && (
              <div className="flex justify-start">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center mr-2 mt-0.5 shrink-0"><span className="material-symbols-outlined text-primary text-sm">menu_book</span></div>
                <div className="flex-1 min-w-0 px-3.5 py-2.5 rounded-xl rounded-bl-sm bg-surface-container text-on-surface text-sm">
                  {streamText
                    ? <div className="leading-relaxed break-words"><ReactMarkdown remarkPlugins={MD_PLUGINS} components={compactMd}>{streamText}</ReactMarkdown></div>
                    : <div className="flex items-center gap-2 text-on-surface-variant"><span className="material-symbols-outlined text-base animate-spin">progress_activity</span>{toolNote || '檢索 KM 中…'}</div>}
                </div>
              </div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="border-t border-outline-variant/10 p-2.5 shrink-0 flex gap-2">
            <textarea value={input} onChange={e => setInput(e.target.value)} rows={1}
              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
              placeholder="輸入 KM 相關問題…"
              className="flex-1 resize-none px-3 py-2 text-sm rounded-lg bg-surface-container border border-outline-variant/20 focus:outline-none focus:border-primary max-h-24" />
            <button onClick={() => sendChat()} disabled={streaming || !input.trim()}
              className="w-9 h-9 shrink-0 flex items-center justify-center rounded-lg bg-primary text-on-primary disabled:opacity-40">
              <span className="material-symbols-outlined text-lg">{streaming ? 'progress_activity' : 'arrow_upward'}</span>
            </button>
          </div>
        </div>
      )}

      {/* Attachment viewer — full-screen overlay (breaks out of the small dock panel),
          native PDF thumbnails hidden + fit-width; the search term is passed to the
          PDF viewer so occurrences are highlighted. */}
      {viewer && (
        <div className="fixed inset-0 z-[130] bg-black/80 flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 bg-surface-container-high shrink-0">
            <span className="material-symbols-outlined text-on-surface-variant text-lg">{viewer.kind === 'pdf' ? 'picture_as_pdf' : 'image'}</span>
            <p className="text-sm text-on-surface truncate flex-1 min-w-0">{viewer.filename}</p>
            {viewer.search && viewer.kind === 'pdf' && (
              <span className="text-[11px] text-on-surface-variant/70 shrink-0 hidden sm:inline">已標示「{viewer.search}」</span>
            )}
            <button onClick={() => downloadAttachment(viewer.docId, viewer.filename)} title="下載" className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant"><span className="material-symbols-outlined text-lg">download</span></button>
            <button onClick={closeViewer} title="關閉" className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface-container text-on-surface-variant"><span className="material-symbols-outlined text-lg">close</span></button>
          </div>
          <div className="flex-1 min-h-0 bg-neutral-800 flex items-center justify-center overflow-auto">
            {viewerLoading || !viewer.url
              ? <div className="text-sm text-white/80 flex items-center gap-2"><span className="material-symbols-outlined animate-spin text-base">progress_activity</span>載入中…</div>
              : viewer.kind === 'image'
                ? <img src={viewer.url} alt={viewer.filename} className="max-w-full max-h-full object-contain" />
                : <KmPdfViewer url={viewer.url} search={viewer.search} initialPage={viewer.page} />}
          </div>
        </div>
      )}
    </div>
  );
}
