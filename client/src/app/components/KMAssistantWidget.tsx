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
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

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
};

export default function KMAssistantWidget() {
  const [tab, setTab] = useState<Tab>('docs');

  // ── 文件 tab ──
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<KmDoc[]>([]);
  const [searchErr, setSearchErr] = useState('');
  const [searched, setSearched] = useState(false);
  const [detail, setDetail] = useState<{ doc: KmDoc; attachments: KmAttachment[] } | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailErr, setDetailErr] = useState('');
  const [viewer, setViewer] = useState<{ docId: string; filename: string; url: string; kind: 'pdf' | 'image' | 'other'; search?: string } | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);

  // ── 對話 tab ──
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [toolNote, setToolNote] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

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
      .then(d => setMessages((d.messages || []).map((m: any) => ({ role: m.role, content: m.content }))))
      .catch(() => {});
  }, [tab]);

  async function runSearch() {
    const q = query.trim();
    if (!q || searching) return;
    setSearching(true); setSearchErr(''); setSearched(true); setDetail(null);
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
      else { setSearchErr(''); setResults(toDocs(payload.data)); }
    } catch (err) {
      console.error('[KM search] fetch failed:', err);
      setSearchErr('KM 搜尋連線中斷,請稍後再試。');
      setResults([]);
    }
    finally { setSearching(false); }
  }

  async function openDoc(doc: KmDoc) {
    setDetailLoading(true); setDetailErr(''); setDetail({ doc, attachments: [] });
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
      if (!res.ok) { alert((data && data.error) || `無法開啟文件 #${id}`); return; }
      const atts = toAttachments(data);
      const viewable = atts.find(a => { const e = ext(a.filename); return e === 'pdf' || IMG_EXTS.has(e); });
      if (viewable) await viewAttachment(id, viewable.filename, highlight);
      else if (atts[0]) await downloadAttachment(id, atts[0].filename);
      else alert('這份文件沒有可開啟的附件。');
    } catch { alert('開啟文件失敗，請稍後再試。'); }
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

  async function viewAttachment(docId: string, filename: string, highlight?: string) {
    const e = ext(filename);
    const kind: 'pdf' | 'image' | 'other' = e === 'pdf' ? 'pdf' : IMG_EXTS.has(e) ? 'image' : 'other';
    if (kind === 'other') { await downloadAttachment(docId, filename); return; } // non-viewable → just download
    const search = highlight?.trim() || query.trim() || undefined; // carry the term → highlight in the PDF
    setViewerLoading(true); setViewer({ docId, filename, url: '', kind, search });
    try {
      const url = await fetchBlobUrl(docId, filename, false);
      setViewer({ docId, filename, url, kind, search });
    } catch (err) { setViewer(null); alert((err as Error).message); }
    finally { setViewerLoading(false); }
  }

  async function downloadAttachment(docId: string, filename: string) {
    try {
      const url = await fetchBlobUrl(docId, filename, true);
      const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) { alert((err as Error).message); }
  }

  function closeViewer() {
    if (viewer?.url) URL.revokeObjectURL(viewer.url);
    setViewer(null);
  }

  async function sendChat() {
    const msg = input.trim();
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
            else if (ev.type === 'tool_activity') { setToolNote(typeof ev.data === 'string' ? ev.data : '檢索 KM 中…'); }
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
                <div className="space-y-1.5">
                  {results.map(doc => (
                    <button key={doc.id} onClick={() => openDoc(doc)}
                      className="w-full text-left p-2.5 rounded-lg bg-surface-container hover:bg-surface-container-high transition-colors">
                      <div className="flex items-start gap-2">
                        <span className="material-symbols-outlined text-primary/70 text-lg shrink-0 mt-0.5">description</span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium text-on-surface truncate">{doc.title}</p>
                          <p className="text-[11px] text-on-surface-variant/60 truncate">#{doc.id}{doc.category ? ` · ${doc.category}` : ''}</p>
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="flex-1 flex flex-col min-h-0">
              <div className="p-3 shrink-0 border-b border-outline-variant/10">
                <button onClick={() => setDetail(null)} className="text-xs text-primary flex items-center gap-1 mb-2 hover:underline">
                  <span className="material-symbols-outlined text-sm">arrow_back</span>返回搜尋結果
                </button>
                <p className="text-sm font-semibold text-on-surface">{detail.doc.title}</p>
                <p className="text-[11px] text-on-surface-variant/60">#{detail.doc.id}{detail.doc.category ? ` · ${detail.doc.category}` : ''}</p>
              </div>
              <div className="flex-1 overflow-y-auto p-3 min-h-0">
                {detailLoading && <div className="text-sm text-on-surface-variant flex items-center gap-2"><span className="material-symbols-outlined animate-spin text-base">progress_activity</span>載入文件中…</div>}
                {detailErr && <div className="text-sm text-error py-2">{detailErr}</div>}
                {!detailLoading && !detailErr && detail.attachments.length === 0 && <div className="text-sm text-on-surface-variant py-4 text-center">這份文件沒有可下載的附件。</div>}
                <div className="space-y-1.5">
                  {detail.attachments.map((att, i) => {
                    const e = ext(att.filename);
                    const canView = e === 'pdf' || IMG_EXTS.has(e);
                    return (
                      <div key={i} className="flex items-center gap-2 p-2.5 rounded-lg bg-surface-container">
                        <span className="material-symbols-outlined text-on-surface-variant/70 text-lg shrink-0">{e === 'pdf' ? 'picture_as_pdf' : IMG_EXTS.has(e) ? 'image' : 'draft'}</span>
                        <p className="text-sm text-on-surface truncate flex-1 min-w-0">{att.filename}</p>
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
                        <div className="leading-relaxed break-words"><ReactMarkdown remarkPlugins={[remarkGfm]} components={compactMd}>{m.content}</ReactMarkdown></div>
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
                    ? <div className="leading-relaxed break-words"><ReactMarkdown remarkPlugins={[remarkGfm]} components={compactMd}>{streamText}</ReactMarkdown></div>
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
            <button onClick={sendChat} disabled={streaming || !input.trim()}
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
                : <iframe src={`${viewer.url}#navpanes=0&view=FitH${viewer.search ? `&search=${encodeURIComponent(viewer.search)}` : ''}`} title={viewer.filename} className="w-full h-full border-0 bg-white" />}
          </div>
        </div>
      )}
    </div>
  );
}
