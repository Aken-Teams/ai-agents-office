'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { AuthProvider, useAuth } from '../../components/AuthProvider';
import Navbar from '../../components/Navbar';
import { I18nProvider, useTranslation } from '../../../i18n';
import { useSidebarMargin } from '../../hooks/useSidebarCollapsed';
import { useDocumentBlocks, type DocumentBlock } from '../hooks/useDocumentBlocks';
import DocumentEditor from '../components/DocumentEditor';
import BlockEditPanel from '../components/BlockEditPanel';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface GeneratedFile {
  id: string;
  filename: string;
  file_path: string;
  file_type: string;
  file_size: number;
  version?: number;
  created_at?: string;
}

function getFileIcon(type: string): string {
  const icons: Record<string, string> = {
    docx: 'description', doc: 'description',
    xlsx: 'table_chart', xls: 'table_chart', csv: 'table_chart',
    pptx: 'present_to_all', ppt: 'present_to_all',
    pdf: 'picture_as_pdf',
    html: 'slideshow', htm: 'slideshow',
  };
  return icons[type] || 'attach_file';
}

function getFileColor(type: string): string {
  const colors: Record<string, string> = {
    docx: 'text-tertiary', doc: 'text-tertiary',
    xlsx: 'text-success', xls: 'text-success',
    pptx: 'text-warning', ppt: 'text-warning',
    pdf: 'text-error',
    html: 'text-secondary', htm: 'text-secondary',
  };
  return colors[type] || 'text-primary';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** File types that can be previewed in an iframe */
const PREVIEWABLE = new Set(['html', 'htm', 'pdf']);

/** Block type templates for "Add block" */
const BLOCK_TEMPLATES: Record<string, { types: { type: string; label: string; icon: string; data: Record<string, unknown> }[] }> = {
  pptx: {
    types: [
      { type: 'title_slide', label: 'Title Slide', icon: 'title', data: { type: 'title_slide', title: 'New Slide', subtitle: '' } },
      { type: 'content', label: 'Content', icon: 'article', data: { type: 'content', title: 'Content', bullets: ['Point 1', 'Point 2'] } },
      { type: 'stats', label: 'Stats/KPI', icon: 'analytics', data: { type: 'stats', title: 'Key Metrics', items: [{ label: 'Metric', value: '0' }] } },
      { type: 'chart', label: 'Chart', icon: 'bar_chart', data: { type: 'chart', title: 'Chart', chartType: 'bar', data: [] } },
    ],
  },
  slides: {
    types: [
      { type: 'title', label: 'Title Slide', icon: 'title', data: { type: 'title', title: 'New Slide', subtitle: '' } },
      { type: 'content', label: 'Content', icon: 'article', data: { type: 'content', title: 'Content', bullets: ['Point 1', 'Point 2'] } },
      { type: 'dashboard', label: 'Dashboard', icon: 'dashboard', data: { type: 'dashboard', title: 'Dashboard', kpis: [{ value: '0', label: 'KPI' }] } },
      { type: 'chart', label: 'Chart', icon: 'bar_chart', data: { type: 'chart', title: 'Chart' } },
    ],
  },
  docx: {
    types: [
      { type: 'heading', label: 'Heading', icon: 'title', data: { type: 'heading', title: 'New Section' } },
      { type: 'paragraph', label: 'Paragraph', icon: 'article', data: { type: 'paragraph', content: 'Enter text here...' } },
      { type: 'list', label: 'List', icon: 'format_list_bulleted', data: { type: 'list', bullets: ['Item 1', 'Item 2'] } },
    ],
  },
  pdf: {
    types: [
      { type: 'section', label: 'Section', icon: 'segment', data: { type: 'section', title: 'New Section', content: '' } },
      { type: 'paragraph', label: 'Paragraph', icon: 'article', data: { type: 'paragraph', content: 'Enter text here...' } },
    ],
  },
  xlsx: {
    types: [
      { type: 'sheet', label: 'Sheet', icon: 'table_chart', data: { type: 'sheet', name: 'New Sheet', headers: ['Column A', 'Column B'], rows: [['', '']] } },
    ],
  },
};

function EditorContent() {
  const { user, token, isLoading } = useAuth();
  const { t } = useTranslation();
  const router = useRouter();
  const params = useParams();
  const conversationId = params.id as string;
  const sidebarMargin = useSidebarMargin();

  // Files
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [activeFileId, setActiveFileId] = useState<string | null>(null);
  const [conversationTitle, setConversationTitle] = useState('');

  // Preview
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewKeyRef = useRef(0); // force iframe reload

  // Block editor state
  const {
    record, blocks,
    loading: blocksLoading, error: blocksError,
    fetchBlocks, updateBlocks, updateBlock, deleteBlock, addBlock, rebuild, regenerate,
  } = useDocumentBlocks(token);

  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [saving, setSaving] = useState(false);
  const [regenBlockId, setRegenBlockId] = useState<string | null>(null);
  const [regenInput, setRegenInput] = useState('');
  const [regenLoading, setRegenLoading] = useState(false);
  const [showAddBlock, setShowAddBlock] = useState(false);

  // View mode: 'split' (preview + blocks) or 'blocks' (blocks only)
  const [viewMode, setViewMode] = useState<'split' | 'blocks'>('split');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  // Load conversation + files
  useEffect(() => {
    if (!token || !conversationId) return;
    fetch(`/api/conversations/${conversationId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => setConversationTitle(data.title || ''))
      .catch(() => router.replace('/dashboard'));

    fetch(`${SSE_BASE}/api/files?conversationId=${conversationId}`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : [])
      .then((data: GeneratedFile[]) => {
        setFiles(data);
        if (data.length > 0 && !activeFileId) selectFile(data[0].id, data);
      })
      .catch(() => {});
  }, [token, conversationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load preview for a given file
  const loadPreview = useCallback(async (fileId: string, fileList?: GeneratedFile[]) => {
    if (!token) return;
    const list = fileList || files;
    const file = list.find(f => f.id === fileId);
    if (!file || !PREVIEWABLE.has(file.file_type)) {
      setPreviewBlobUrl(null);
      return;
    }
    setPreviewLoading(true);
    try {
      const endpoint = file.file_type === 'html'
        ? `${SSE_BASE}/api/files/${fileId}/download`
        : `${SSE_BASE}/api/files/${fileId}/preview?editing=1`;
      const res = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error('preview failed');
      const blob = await res.blob();
      const ct = res.headers.get('Content-Type') || '';
      const type = ct.includes('pdf') ? 'application/pdf' : ct.includes('html') ? 'text/html' : ct;
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
      setPreviewBlobUrl(URL.createObjectURL(new Blob([blob], { type })));
    } catch {
      setPreviewBlobUrl(null);
    } finally {
      setPreviewLoading(false);
    }
  }, [token, files, previewBlobUrl]);

  const selectFile = useCallback((fileId: string, fileList?: GeneratedFile[]) => {
    setActiveFileId(fileId);
    setSelectedBlockId(null);
    fetchBlocks(fileId);
    loadPreview(fileId, fileList);
  }, [fetchBlocks, loadPreview]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => { if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reorder → save + auto-rebuild + refresh preview
  const handleReorder = useCallback(async (newBlocks: DocumentBlock[]) => {
    if (!activeFileId) return;
    await updateBlocks(activeFileId, newBlocks);
    setRebuilding(true);
    const result = await rebuild(activeFileId);
    setRebuilding(false);
    if (result.success && result.file) {
      setFiles(prev => prev.map(f => f.id === activeFileId ? { ...f, ...result.file } : f));
      previewKeyRef.current++;
      loadPreview(activeFileId);
    }
  }, [activeFileId, updateBlocks, rebuild, loadPreview]);

  const handleDelete = useCallback(async (blockId: string) => {
    if (!activeFileId) return;
    if (selectedBlockId === blockId) setSelectedBlockId(null);
    await deleteBlock(activeFileId, blockId);
  }, [activeFileId, selectedBlockId, deleteBlock]);

  const handleBlockSave = useCallback(async (blockId: string, data: Record<string, unknown>) => {
    if (!activeFileId) return;
    setSaving(true);
    await updateBlock(activeFileId, blockId, data);
    setSaving(false);
  }, [activeFileId, updateBlock]);

  const handleAddBlock = useCallback(async (type: string, data: Record<string, unknown>) => {
    if (!activeFileId) return;
    await addBlock(activeFileId, type, data, selectedBlockId || undefined);
    setShowAddBlock(false);
  }, [activeFileId, selectedBlockId, addBlock]);

  const handleRegenerateClick = useCallback((blockId: string) => {
    setRegenBlockId(blockId);
    setRegenInput('');
  }, []);

  const handleRegenerateSubmit = useCallback(async () => {
    if (!activeFileId || !regenBlockId || !regenInput.trim()) return;
    setRegenLoading(true);
    const result = await regenerate(activeFileId, regenBlockId, regenInput.trim());
    setRegenLoading(false);
    if (result.success) {
      setRegenBlockId(null);
      setRegenInput('');
      if (result.file) {
        setFiles(prev => prev.map(f => f.id === activeFileId ? { ...f, ...result.file } : f));
        previewKeyRef.current++;
        loadPreview(activeFileId);
      }
    }
  }, [activeFileId, regenBlockId, regenInput, regenerate, loadPreview]);

  const handleRebuild = useCallback(async () => {
    if (!activeFileId) return;
    setRebuilding(true);
    const result = await rebuild(activeFileId);
    setRebuilding(false);
    if (result.success && result.file) {
      setFiles(prev => prev.map(f => f.id === activeFileId ? { ...f, ...result.file } : f));
      previewKeyRef.current++;
      loadPreview(activeFileId);
    }
  }, [activeFileId, rebuild, loadPreview]);

  const handleDownload = useCallback(async (fileId: string, filename: string) => {
    if (!token) return;
    try {
      const res = await fetch(`${SSE_BASE}/api/files/${fileId}/download`, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) return;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {}
  }, [token]);

  if (isLoading || !user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface">
        <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
      </div>
    );
  }

  const activeFile = files.find(f => f.id === activeFileId);
  const selectedBlock = blocks.find(b => b.id === selectedBlockId);
  const docType = record?.docType || '';
  const templates = BLOCK_TEMPLATES[docType] || BLOCK_TEMPLATES.docx;
  const canPreview = activeFile && PREVIEWABLE.has(activeFile.file_type);

  return (
    <div className={`min-h-screen bg-surface ${sidebarMargin}`}>
      <div className="flex flex-col h-screen md:h-[calc(100vh)] overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-outline-variant/10 bg-surface-container/30 shrink-0">
          <button
            onClick={() => router.push(`/chat/${conversationId}`)}
            className="p-1.5 rounded-lg hover:bg-surface-container transition-colors cursor-pointer"
            title={t('editor.backToChat')}
          >
            <span className="material-symbols-outlined text-on-surface-variant text-xl">arrow_back</span>
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-on-surface truncate">{conversationTitle || t('editor.title')}</div>
            <div className="text-xs text-on-surface-variant">{t('editor.subtitle')}</div>
          </div>

          {/* View toggle */}
          {canPreview && (
            <div className="hidden md:flex items-center bg-surface-container rounded-lg p-0.5">
              <button
                onClick={() => setViewMode('split')}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${viewMode === 'split' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
              >
                <span className="material-symbols-outlined text-sm align-middle mr-0.5">vertical_split</span>
                {t('editor.viewSplit')}
              </button>
              <button
                onClick={() => setViewMode('blocks')}
                className={`px-2.5 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${viewMode === 'blocks' ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:text-on-surface'}`}
              >
                <span className="material-symbols-outlined text-sm align-middle mr-0.5">view_list</span>
                {t('editor.viewBlocks')}
              </button>
            </div>
          )}

          {activeFile && (
            <button
              onClick={() => handleDownload(activeFile.id, activeFile.filename)}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-surface-container-highest border border-outline-variant/10 rounded-lg text-xs font-medium text-on-surface hover:bg-surface-variant transition-colors cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">download</span>
              <span className="hidden sm:inline">{t('editor.download')}</span>
            </button>
          )}
        </div>

        {/* Main split view */}
        <div className="flex flex-1 min-h-0">
          {/* Left — File list (desktop) */}
          <div className="w-48 lg:w-56 border-r border-outline-variant/10 flex flex-col bg-surface-container/20 shrink-0 hidden md:flex">
            <div className="px-3 py-2 border-b border-outline-variant/5">
              <div className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">{t('editor.files')}</div>
            </div>
            <div className="flex-1 overflow-y-auto p-1.5 space-y-0.5">
              {files.length === 0 && (
                <div className="text-xs text-on-surface-variant/50 text-center py-8">{t('editor.noFiles')}</div>
              )}
              {files.map(file => (
                <button
                  key={file.id}
                  onClick={() => selectFile(file.id)}
                  className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all cursor-pointer ${
                    activeFileId === file.id
                      ? 'bg-primary/10 border border-primary/20'
                      : 'hover:bg-surface-container border border-transparent'
                  }`}
                >
                  <span className={`material-symbols-outlined text-base ${getFileColor(file.file_type)}`}>
                    {getFileIcon(file.file_type)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-on-surface truncate">{file.filename}</div>
                    <div className="text-[9px] text-on-surface-variant">
                      {file.file_type.toUpperCase()} · {formatSize(file.file_size)}
                    </div>
                  </div>
                </button>
              ))}
            </div>
            <div className="p-1.5 border-t border-outline-variant/5">
              <button
                onClick={() => router.push(`/chat/${conversationId}`)}
                className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs text-on-surface-variant hover:bg-surface-container transition-colors cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm">chat</span>
                {t('editor.backToChat')}
              </button>
            </div>
          </div>

          {/* Center — Live Preview (only in split mode) */}
          {viewMode === 'split' && canPreview && (
            <div className="flex-1 flex flex-col min-w-0 border-r border-outline-variant/10 hidden md:flex">
              {previewLoading ? (
                <div className="flex-1 flex items-center justify-center">
                  <span className="material-symbols-outlined animate-spin text-primary text-3xl">progress_activity</span>
                </div>
              ) : previewBlobUrl ? (
                <iframe
                  key={previewKeyRef.current}
                  src={previewBlobUrl}
                  className="flex-1 w-full border-0 bg-white"
                  title={activeFile?.filename || 'Preview'}
                  sandbox="allow-scripts allow-same-origin"
                  tabIndex={-1}
                />
              ) : (
                <div className="flex-1 flex items-center justify-center text-on-surface-variant/30">
                  <span className="material-symbols-outlined text-5xl">preview</span>
                </div>
              )}
            </div>
          )}

          {/* Right — Block Editor + Edit Panel */}
          <div className={`flex flex-col min-w-0 ${
            viewMode === 'split' && canPreview ? 'w-80 lg:w-96 shrink-0 hidden md:flex' : 'flex-1'
          }`}>
            {/* Mobile file selector */}
            <div className="md:hidden px-3 py-2 border-b border-outline-variant/5">
              <select
                value={activeFileId || ''}
                onChange={e => e.target.value && selectFile(e.target.value)}
                className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2 px-3 text-sm text-on-surface outline-none"
              >
                <option value="">{t('editor.selectFile')}</option>
                {files.map(f => (
                  <option key={f.id} value={f.id}>{f.filename}</option>
                ))}
              </select>
            </div>

            {/* Mobile: preview iframe */}
            {canPreview && previewBlobUrl && (
              <div className="md:hidden h-[40vh] border-b border-outline-variant/10">
                <iframe
                  key={previewKeyRef.current}
                  src={previewBlobUrl}
                  className="w-full h-full border-0 bg-white"
                  title={activeFile?.filename || 'Preview'}
                  sandbox="allow-scripts allow-same-origin"
                  tabIndex={-1}
                />
              </div>
            )}

            {/* Block list area — shrinks when edit panel is open */}
            <div className={`flex flex-col min-h-0 ${selectedBlock ? 'flex-1' : 'flex-1'}`}>
              {selectedBlock ? (
                // Edit panel replaces block list when a block is selected
                <BlockEditPanel
                  block={selectedBlock}
                  docType={docType}
                  onSave={handleBlockSave}
                  onClose={() => setSelectedBlockId(null)}
                  onRegenerate={handleRegenerateClick}
                  saving={saving}
                  t={t}
                />
              ) : (
                <DocumentEditor
                  record={record}
                  blocks={blocks}
                  loading={blocksLoading}
                  error={blocksError}
                  selectedBlockId={selectedBlockId}
                  onSelectBlock={setSelectedBlockId}
                  onReorder={handleReorder}
                  onDeleteBlock={handleDelete}
                  onRegenerateBlock={handleRegenerateClick}
                  onRebuild={handleRebuild}
                  onAddBlock={() => setShowAddBlock(true)}
                  rebuilding={rebuilding}
                  t={t}
                />
              )}
            </div>
          </div>
        </div>

        {/* Add block modal */}
        {showAddBlock && (
          <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4"
               onClick={() => setShowAddBlock(false)}>
            <div className="bg-surface rounded-t-2xl md:rounded-2xl shadow-2xl w-full max-w-md p-5 relative border border-outline-variant/10"
                 onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-outlined text-primary text-xl">add_circle</span>
                <h3 className="text-base font-bold text-on-surface">{t('editor.addBlock.title')}</h3>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {templates.types.map(tmpl => (
                  <button
                    key={tmpl.type}
                    onClick={() => handleAddBlock(tmpl.type, tmpl.data)}
                    className="flex items-center gap-2.5 p-3 rounded-xl border border-outline-variant/10 hover:border-primary/30 hover:bg-primary/5 transition-all cursor-pointer text-left"
                  >
                    <span className="material-symbols-outlined text-primary text-xl">{tmpl.icon}</span>
                    <div>
                      <div className="text-sm font-medium text-on-surface">{tmpl.label}</div>
                      <div className="text-[10px] text-on-surface-variant uppercase">{tmpl.type}</div>
                    </div>
                  </button>
                ))}
              </div>
              <button
                onClick={() => setShowAddBlock(false)}
                className="w-full mt-3 py-2 text-sm text-on-surface-variant hover:bg-surface-container rounded-lg transition-colors cursor-pointer"
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        )}

        {/* Regeneration prompt modal */}
        {regenBlockId && (
          <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4"
               onClick={() => { setRegenBlockId(null); setRegenInput(''); }}>
            <div className="bg-surface rounded-t-2xl md:rounded-2xl shadow-2xl w-full max-w-lg p-5 relative border border-outline-variant/10"
                 onClick={e => e.stopPropagation()}>
              <div className="flex items-center gap-2 mb-4">
                <span className="material-symbols-outlined text-primary text-xl">auto_fix_high</span>
                <h3 className="text-base font-bold text-on-surface">{t('editor.regenerate.title')}</h3>
              </div>
              <p className="text-xs text-on-surface-variant mb-3">{t('editor.regenerate.hint')}</p>
              <textarea
                value={regenInput}
                onChange={e => setRegenInput(e.target.value)}
                placeholder={t('editor.regenerate.placeholder')}
                rows={3}
                className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2.5 px-3.5 text-sm text-on-surface placeholder:text-outline focus:ring-1 focus:ring-primary/40 focus:border-primary/40 outline-none resize-none"
                autoFocus
                onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleRegenerateSubmit(); } }}
              />
              <div className="flex items-center justify-end gap-2 mt-3">
                <button
                  onClick={() => { setRegenBlockId(null); setRegenInput(''); }}
                  className="px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container rounded-lg transition-colors cursor-pointer"
                >
                  {t('common.cancel')}
                </button>
                <button
                  onClick={handleRegenerateSubmit}
                  disabled={!regenInput.trim() || regenLoading}
                  className="flex items-center gap-1.5 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-bold hover:bg-primary-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  {regenLoading && <span className="material-symbols-outlined animate-spin text-sm">progress_activity</span>}
                  {t('editor.regenerate.submit')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EditorWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <Navbar />
      <EditorContent />
    </I18nProvider>
  );
}

export default function EditorPage() {
  return (
    <AuthProvider>
      <EditorWithI18n />
    </AuthProvider>
  );
}
