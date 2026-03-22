'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';

interface FileItem {
  id: string;
  filename: string;
  file_type: string;
  file_size: number;
  conversation_id: string | null;
  created_at: string;
}

interface ConversationInfo {
  id: string;
  title: string;
}

interface UploadItem {
  id: string;
  filename: string;
  original_name: string;
  file_type: string;
  file_size: number;
  scan_status: 'pending' | 'clean' | 'suspicious' | 'rejected';
  scan_detail: string | null;
  conversation_id: string | null;
  created_at: string;
}

interface UploadStorageInfo {
  used: number;
  quota: number;
  count: number;
  percentage: number;
  formatted: { used: string; quota: string };
}

const FILE_TYPE_CONFIG: Record<string, { icon: string; color: string; bgColor: string }> = {
  pptx: { icon: 'present_to_all', color: '#FF8A65', bgColor: 'rgba(255,138,101,0.1)' },
  ppt:  { icon: 'present_to_all', color: '#FF8A65', bgColor: 'rgba(255,138,101,0.1)' },
  docx: { icon: 'description', color: '#2196F3', bgColor: 'rgba(33,150,243,0.1)' },
  doc:  { icon: 'description', color: '#2196F3', bgColor: 'rgba(33,150,243,0.1)' },
  xlsx: { icon: 'table_chart', color: '#4CAF50', bgColor: 'rgba(76,175,80,0.1)' },
  xls:  { icon: 'table_chart', color: '#4CAF50', bgColor: 'rgba(76,175,80,0.1)' },
  pdf:  { icon: 'picture_as_pdf', color: '#FF5252', bgColor: 'rgba(255,82,82,0.1)' },
  md:   { icon: 'code', color: '#7bd0ff', bgColor: 'rgba(123,208,255,0.1)' },
};

// Types that render as text (fetched as text, shown in <pre>)
const TEXT_TYPES = new Set(['md', 'txt', 'csv']);
// Types that render as images
const IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg']);

const FILTER_TABS = [
  { value: '', label: '全部' },
  { value: 'pptx', label: 'PPT' },
  { value: 'docx', label: 'Word' },
  { value: 'xlsx', label: 'Excel' },
  { value: 'pdf', label: 'PDF' },
];

const PAGE_SIZE = 12;

/* ============================================================
   Delete Confirmation Modal
   ============================================================ */
function DeleteConfirmModal({
  filename, onConfirm, onCancel,
}: {
  filename: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onConfirm, onCancel]);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center" onClick={onCancel}>
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div
        className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-sm mx-4 overflow-hidden animate-in"
        onClick={e => e.stopPropagation()}
      >
        {/* Icon */}
        <div className="flex flex-col items-center pt-8 pb-4 px-6">
          <div className="w-14 h-14 rounded-full bg-error/10 flex items-center justify-center mb-4">
            <span className="material-symbols-outlined text-error text-3xl">delete_forever</span>
          </div>
          <h3 className="font-headline font-bold text-lg text-on-surface mb-2">確定刪除？</h3>
          <p className="text-sm text-on-surface-variant text-center leading-relaxed">
            即將刪除 <span className="font-medium text-on-surface">{filename}</span>，此操作無法復原。
          </p>
        </div>

        {/* Actions */}
        <div className="flex gap-3 p-6 pt-2">
          <button
            onClick={onCancel}
            className="flex-1 py-2.5 px-4 bg-surface-container-highest border border-outline-variant/10 text-on-surface font-bold text-xs uppercase tracking-widest rounded cursor-pointer hover:bg-surface-variant transition-colors"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            className="flex-1 py-2.5 px-4 bg-error text-on-error font-bold text-xs uppercase tracking-widest rounded cursor-pointer hover:bg-error/80 transition-colors"
          >
            刪除
          </button>
        </div>
      </div>
    </div>
  );
}

/* ============================================================
   Preview Modal
   ============================================================ */
function PreviewModal({
  file, token, onClose, onDownload,
}: {
  file: FileItem;
  token: string;
  onClose: () => void;
  onDownload: (id: string, name: string) => void;
}) {
  const [textContent, setTextContent] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const config = FILE_TYPE_CONFIG[file.file_type] || { icon: 'attach_file', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)' };
  const isText = TEXT_TYPES.has(file.file_type);
  const isImage = IMAGE_TYPES.has(file.file_type);

  useEffect(() => {
    let revoke: string | null = null;
    const headers = { Authorization: `Bearer ${token}` };

    if (isText) {
      // Text files: fetch as text
      fetch(`/api/files/${file.id}/preview`, { headers })
        .then(r => { if (!r.ok) throw new Error(); return r.text(); })
        .then(t => { setTextContent(t); setLoading(false); })
        .catch(() => { setError(true); setLoading(false); });
    } else {
      // Everything else (PDF, images, Office→PDF/HTML): fetch as blob
      fetch(`/api/files/${file.id}/preview`, { headers })
        .then(r => {
          if (!r.ok) throw new Error();
          return r.blob().then(blob => ({ blob, contentType: r.headers.get('Content-Type') || '' }));
        })
        .then(({ blob, contentType }) => {
          // If server returned HTML (JS fallback for office), treat as text
          if (contentType.includes('text/html')) {
            blob.text().then(html => { setTextContent(html); setLoading(false); });
          } else {
            const url = URL.createObjectURL(blob);
            revoke = url;
            setBlobUrl(url);
            setLoading(false);
          }
        })
        .catch(() => { setError(true); setLoading(false); });
    }

    return () => { if (revoke) URL.revokeObjectURL(revoke); };
  }, [file.id, token, isText, isImage]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Determine what to render
  const isPdfBlob = blobUrl && !isImage;
  const isHtmlContent = !isText && textContent !== null; // HTML from Office conversion

  return (
    <div className="fixed inset-0 z-[100] flex" onClick={onClose}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" />

      <div className="relative flex w-full h-full animate-in" onClick={e => e.stopPropagation()}>
        {/* Close button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 w-10 h-10 flex items-center justify-center rounded bg-surface-container-high/80 hover:bg-surface-container-highest text-on-surface-variant hover:text-on-surface cursor-pointer transition-colors"
        >
          <span className="material-symbols-outlined">close</span>
        </button>

        {/* ===== Preview Area ===== */}
        <div className="flex-1 flex items-center justify-center p-8 relative overflow-hidden">
          {/* Background grid */}
          <div className="absolute inset-0 opacity-[0.03] pointer-events-none bg-pattern" />

          {/* Content */}
          <div className="relative w-full max-w-5xl max-h-[calc(100vh-6rem)]">
            {loading ? (
              <div className="flex flex-col items-center justify-center py-20">
                <div className="w-8 h-8 border-2 border-primary/30 border-t-primary rounded-full animate-spin mb-4" />
                <p className="text-xs text-on-surface-variant uppercase tracking-widest">正在轉換預覽...</p>
              </div>
            ) : error ? (
              <div className="flex flex-col items-center justify-center py-20 bg-surface-container/50 rounded-lg border border-outline-variant/10">
                <span className="material-symbols-outlined text-4xl text-error mb-4">error</span>
                <p className="text-sm text-on-surface-variant mb-2">預覽載入失敗</p>
                <p className="text-xs text-on-surface-variant/60 mb-6">請確認檔案完整性，或直接下載查看。</p>
                <button
                  onClick={() => onDownload(file.id, file.filename)}
                  className="px-6 py-2.5 cyber-gradient text-on-primary font-bold text-xs uppercase tracking-widest flex items-center gap-2 cursor-pointer hover:opacity-90 transition-opacity"
                >
                  <span className="material-symbols-outlined text-sm">download</span>
                  下載檔案
                </button>
              </div>
            ) : isPdfBlob ? (
              /* PDF (native or LibreOffice converted) */
              <iframe
                src={`${blobUrl}#toolbar=0`}
                className="w-full h-[calc(100vh-8rem)] bg-white rounded"
                title={file.filename}
              />
            ) : isImage && blobUrl ? (
              /* Image */
              <div className="flex items-center justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={blobUrl}
                  alt={file.filename}
                  className="max-w-full max-h-[calc(100vh-8rem)] object-contain rounded"
                />
              </div>
            ) : isHtmlContent ? (
              /* HTML from Office JS-fallback conversion */
              <div className="bg-surface-container rounded border border-outline-variant/10 overflow-auto max-h-[calc(100vh-8rem)]">
                <iframe
                  srcDoc={textContent!}
                  className="w-full h-[calc(100vh-8rem)] rounded"
                  title={file.filename}
                  sandbox="allow-same-origin"
                />
              </div>
            ) : isText && textContent !== null ? (
              /* Plain text / CSV / Markdown */
              <div className="bg-surface-container rounded border border-outline-variant/10 overflow-auto max-h-[calc(100vh-8rem)]">
                <div className="p-6">
                  <pre className="text-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap font-body break-words">
                    {textContent}
                  </pre>
                </div>
              </div>
            ) : null}
          </div>

          {/* Watermark overlay — rendered AFTER content so it sits ON TOP of document */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden z-30 select-none" aria-hidden>
            <div className="absolute inset-[-50%] flex flex-wrap gap-24 rotate-[-30deg]">
              {Array.from({ length: 40 }).map((_, i) => (
                <span key={i} className="text-3xl font-headline font-bold tracking-[0.3em] uppercase whitespace-nowrap" style={{ color: 'rgba(128,128,128,0.18)' }}>
                  CONFIDENTIAL 機密文件
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* ===== Right Sidebar ===== */}
        <aside className="w-80 bg-surface-container border-l border-outline-variant/10 flex flex-col shrink-0">
          {/* File info */}
          <div className="p-6 border-b border-outline-variant/10">
            <h3 className="text-xs font-headline font-bold uppercase tracking-widest text-primary mb-4 flex items-center gap-2">
              <span className="material-symbols-outlined text-sm">info</span> 文件資訊
            </h3>
            <div className="space-y-3">
              <div className="p-3 bg-surface-container-low rounded">
                <p className="text-[10px] text-on-surface-variant uppercase font-medium mb-1 tracking-wider">檔案名稱</p>
                <p className="text-sm font-medium text-on-surface break-all">{file.filename}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 bg-surface-container-low rounded">
                  <p className="text-[10px] text-on-surface-variant uppercase font-medium mb-1 tracking-wider">格式</p>
                  <p className="text-sm font-bold uppercase" style={{ color: config.color }}>{file.file_type}</p>
                </div>
                <div className="p-3 bg-surface-container-low rounded">
                  <p className="text-[10px] text-on-surface-variant uppercase font-medium mb-1 tracking-wider">大小</p>
                  <p className="text-sm font-bold text-on-surface">{formatSize(file.file_size)}</p>
                </div>
              </div>
              <div className="p-3 bg-surface-container-low rounded">
                <p className="text-[10px] text-on-surface-variant uppercase font-medium mb-1 tracking-wider">建立日期</p>
                <p className="text-sm text-on-surface">{new Date(file.created_at).toLocaleString('zh-TW')}</p>
              </div>
              <div className="p-3 bg-surface-container-low rounded">
                <p className="text-[10px] text-on-surface-variant uppercase font-medium mb-1 tracking-wider">安全等級</p>
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-primary shadow-[0_0_8px_#00dbe9]" />
                  <p className="text-sm font-bold text-on-surface">機密</p>
                </div>
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="p-6 flex-1">
            <div className="space-y-2">
              <button
                onClick={() => onDownload(file.id, file.filename)}
                className="w-full py-2.5 px-4 cyber-gradient text-on-primary font-bold text-[11px] uppercase tracking-widest flex items-center justify-center gap-2 cursor-pointer hover:opacity-90 transition-opacity"
              >
                <span className="material-symbols-outlined text-sm">download</span>
                下載到本機
              </button>
            </div>
          </div>

          {/* Bottom indicator */}
          <div className="p-4 bg-primary/5 flex items-center gap-3 border-t border-outline-variant/10">
            <span className="material-symbols-outlined text-primary text-base">shield</span>
            <div>
              <p className="text-xs font-bold text-on-surface">本地沙盒儲存</p>
              <p className="text-[10px] text-on-surface-variant">所有檔案皆加密保護</p>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ============================================================
   Files Page Content
   ============================================================ */
interface StorageInfo {
  used: number;
  quota: number;
  percentage: number;
  warning: boolean;
  formatted: { used: string; quota: string };
}

function FilesContent() {
  const { user, token, isLoading } = useAuth();
  const router = useRouter();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [previewFile, setPreviewFile] = useState<FileItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<FileItem | null>(null);
  const [storageInfo, setStorageInfo] = useState<StorageInfo | null>(null);
  const [activeTab, setActiveTab] = useState<'generated' | 'uploads'>('generated');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [uploadStorage, setUploadStorage] = useState<UploadStorageInfo | null>(null);
  const [conversations, setConversations] = useState<ConversationInfo[]>([]);
  const sidebarMargin = useSidebarMargin();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const fetchStorage = useCallback(() => {
    if (!token) return;
    fetch('/api/files/storage', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setStorageInfo)
      .catch(console.error);
  }, [token]);

  useEffect(() => {
    if (!token) return;
    const url = filter ? `/api/files?type=${filter}` : '/api/files';
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setFiles)
      .catch(console.error);
    fetchStorage();
  }, [token, filter, fetchStorage]);

  const fetchUploads = useCallback(() => {
    if (!token) return;
    fetch('/api/uploads', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setUploads)
      .catch(console.error);
    fetch('/api/uploads/storage', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setUploadStorage)
      .catch(console.error);
  }, [token]);

  useEffect(() => { fetchUploads(); }, [fetchUploads]);

  // Fetch conversations for linking display
  useEffect(() => {
    if (!token) return;
    fetch('/api/conversations', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((convs: ConversationInfo[]) => setConversations(convs))
      .catch(console.error);
  }, [token]);

  async function deleteUpload(id: string) {
    if (!token) return;
    await fetch(`/api/uploads/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    fetchUploads();
  }

  async function confirmDelete() {
    if (!token || !deleteTarget) return;
    await fetch(`/api/files/${deleteTarget.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setFiles(prev => prev.filter(f => f.id !== deleteTarget.id));
    if (previewFile?.id === deleteTarget.id) setPreviewFile(null);
    setDeleteTarget(null);
    fetchStorage();
  }

  const handleDownload = useCallback(async (fileId: string, filename: string) => {
    try {
      const res = await fetch(`/api/files/${fileId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download error:', err);
    }
  }, [token]);

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getTypeConfig(type: string) {
    return FILE_TYPE_CONFIG[type] || { icon: 'attach_file', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)' };
  }

  // Reset page when filter/search changes
  useEffect(() => { setPage(1); }, [filter, search]);

  // Filter by search keyword
  const filteredFiles = search.trim()
    ? files.filter(f => f.filename.toLowerCase().includes(search.trim().toLowerCase()))
    : files;

  // Calculate total storage + pagination
  const totalSize = files.reduce((sum, f) => sum + f.file_size, 0);
  const totalPages = Math.max(1, Math.ceil(filteredFiles.length / PAGE_SIZE));
  const pagedFiles = filteredFiles.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (isLoading || !user) return null;

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <DeleteConfirmModal
          filename={deleteTarget.filename}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {/* Preview Modal */}
      {previewFile && token && (
        <PreviewModal
          file={previewFile}
          token={token}
          onClose={() => setPreviewFile(null)}
          onDownload={handleDownload}
        />
      )}

      <main className={`${sidebarMargin} pt-8 pb-12 px-10 transition-all duration-300`}>
        {/* Header Section */}
        <div className="flex justify-between items-end mb-10">
          <div className="max-w-2xl">
            <div className="flex items-center gap-2 mb-2">
              <span className="text-tertiary text-xs font-bold tracking-[0.3em] uppercase">本地儲存</span>
              <div className="h-px w-12 bg-tertiary/30" />
            </div>
            <h2 className="text-4xl font-headline font-bold text-on-surface tracking-tight mb-2">檔案管理</h2>
            <p className="text-on-surface-variant leading-relaxed">
              所有 AI 代理生成的文件都安全存放在本地沙盒環境中。
            </p>
          </div>

          {/* Storage Widget */}
          <div className={`rounded-lg p-5 w-72 flex flex-col gap-3 relative overflow-hidden shrink-0 ${
            storageInfo?.warning ? 'bg-error/10 border border-error/30' : 'bg-surface-container'
          }`}>
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <span className={`material-symbols-outlined text-4xl ${storageInfo?.warning ? 'text-error' : ''}`}>
                {storageInfo?.warning ? 'warning' : 'database'}
              </span>
            </div>
            <div className="flex justify-between items-center text-xs font-bold tracking-widest uppercase text-on-surface-variant">
              <span>{user?.displayName || user?.email?.split('@')[0] || '我的'}儲存</span>
              <span className={storageInfo?.warning ? 'text-error' : 'text-primary'}>{files.length} 個檔案</span>
            </div>
            <div className="h-1.5 bg-surface-container-lowest rounded-full overflow-hidden">
              <div
                className={`h-full ${storageInfo?.warning ? 'bg-error' : 'cyber-gradient'}`}
                style={{ width: `${Math.min((storageInfo?.percentage ?? 0) * 100, 100)}%` }}
              />
            </div>
            <div className="flex justify-between items-baseline">
              <span className="font-headline text-lg font-bold">
                {storageInfo?.formatted.used ?? formatSize(totalSize)}
              </span>
              <span className="text-xs text-on-surface-variant uppercase tracking-tighter">
                / {storageInfo?.formatted.quota ?? '—'}
              </span>
            </div>
            {storageInfo?.warning && (
              <p className="text-[10px] text-error font-medium">
                儲存空間即將滿載，請整理不需要的檔案。
              </p>
            )}
          </div>
        </div>

        {/* Main Tab Switcher: Generated vs Uploads */}
        <div className="flex items-center gap-6 mb-8 border-b border-outline-variant/10">
          <button
            onClick={() => setActiveTab('generated')}
            className={`pb-3 text-sm font-bold tracking-widest uppercase transition-colors cursor-pointer border-b-2 ${
              activeTab === 'generated'
                ? 'text-primary border-primary'
                : 'text-on-surface-variant border-transparent hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-sm align-middle mr-1">auto_awesome</span>
            AI 生成檔案
          </button>
          <button
            onClick={() => setActiveTab('uploads')}
            className={`pb-3 text-sm font-bold tracking-widest uppercase transition-colors cursor-pointer border-b-2 ${
              activeTab === 'uploads'
                ? 'text-primary border-primary'
                : 'text-on-surface-variant border-transparent hover:text-on-surface'
            }`}
          >
            <span className="material-symbols-outlined text-sm align-middle mr-1">upload_file</span>
            我的上傳
            {uploads.length > 0 && (
              <span className="ml-2 px-1.5 py-0.5 bg-primary/10 text-primary rounded text-[10px] font-bold">{uploads.length}</span>
            )}
          </button>
        </div>

        {activeTab === 'generated' ? (
        <>
        {/* Filter Tabs + Search */}
        <div className="flex items-center justify-between gap-4 mb-8">
          <div className="flex items-center gap-3">
            {FILTER_TABS.map(tab => (
              <button
                key={tab.value}
                onClick={() => setFilter(tab.value)}
                className={`px-4 py-2 rounded text-xs font-bold tracking-widest uppercase transition-colors cursor-pointer ${
                  filter === tab.value
                    ? 'bg-surface-container text-on-surface border-b-2 border-primary'
                    : 'bg-transparent text-on-surface-variant hover:bg-surface-container'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <span className="material-symbols-outlined absolute left-3 top-1/2 -translate-y-1/2 text-on-surface-variant text-sm">search</span>
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="搜尋檔案名稱..."
              className="pl-9 pr-4 py-2 bg-surface-container border border-outline-variant/20 rounded text-sm text-on-surface placeholder:text-on-surface-variant/40 focus:outline-none focus:border-primary/40 w-64 transition-colors"
            />
            {search && (
              <button
                onClick={() => setSearch('')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface cursor-pointer"
              >
                <span className="material-symbols-outlined text-sm">close</span>
              </button>
            )}
          </div>
        </div>

        {/* File Grid */}
        {filteredFiles.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 border border-dashed border-outline-variant/20 rounded-lg">
            <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-on-surface-variant text-3xl">
                {search ? 'search_off' : 'upload_file'}
              </span>
            </div>
            <p className="text-on-surface-variant font-medium uppercase tracking-[0.2em] text-xs">
              {search ? '找不到符合的檔案' : '尚無檔案'}
            </p>
            <p className="text-xs text-on-surface-variant/40 mt-1">
              {search ? '請嘗試其他關鍵字' : '從儀表板開始生成文件'}
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {pagedFiles.map(file => {
              const config = getTypeConfig(file.file_type);
              return (
                <div
                  key={file.id}
                  className="bg-surface-container hover:bg-surface-container-high transition-colors p-5 flex flex-col gap-4 group cursor-pointer"
                  onClick={() => setPreviewFile(file)}
                >
                  {/* Top: Icon + Type badge */}
                  <div className="flex justify-between items-start">
                    <div
                      className="w-10 h-10 rounded flex items-center justify-center"
                      style={{ background: config.bgColor }}
                    >
                      <span className="material-symbols-outlined" style={{ color: config.color }}>
                        {config.icon}
                      </span>
                    </div>
                    <span className="text-xs font-bold tracking-widest uppercase" style={{ color: config.color }}>
                      {file.file_type.toUpperCase()}
                    </span>
                  </div>

                  {/* File name + date */}
                  <div>
                    <h3 className="font-headline font-bold text-base leading-tight mb-1 truncate text-on-surface">
                      {file.filename}
                    </h3>
                    <p className="text-xs text-on-surface-variant uppercase tracking-widest">
                      {new Date(file.created_at).toLocaleDateString('zh-TW')}
                    </p>
                  </div>

                  {/* Bottom: Size + Actions */}
                  <div className="mt-auto pt-3 flex items-center justify-between border-t border-outline-variant/10">
                    <span className="text-xs bg-surface-container-lowest px-2 py-0.5 rounded text-on-surface-variant uppercase tracking-widest">
                      {formatSize(file.file_size)}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={e => { e.stopPropagation(); setPreviewFile(file); }}
                        className="w-8 h-8 flex items-center justify-center rounded bg-transparent hover:bg-tertiary/10 text-on-surface-variant hover:text-tertiary cursor-pointer transition-colors"
                        title="預覽"
                      >
                        <span className="material-symbols-outlined text-sm">visibility</span>
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); handleDownload(file.id, file.filename); }}
                        className="w-8 h-8 flex items-center justify-center rounded bg-transparent hover:bg-primary/10 text-on-surface-variant hover:text-primary cursor-pointer transition-colors"
                        title="下載"
                      >
                        <span className="material-symbols-outlined text-sm">download</span>
                      </button>
                      <button
                        onClick={e => { e.stopPropagation(); setDeleteTarget(file); }}
                        className="w-8 h-8 flex items-center justify-center rounded bg-transparent hover:bg-error/10 text-on-surface-variant hover:text-error cursor-pointer transition-colors"
                        title="刪除"
                      >
                        <span className="material-symbols-outlined text-sm">delete</span>
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Pagination */}
        {filteredFiles.length > 0 && (
          <div className="mt-8 flex items-center justify-between">
            <p className="text-on-surface-variant/60 text-xs uppercase tracking-widest">
              共 {filteredFiles.length} 個檔案{search && ` (搜尋結果)`}
            </p>
            {totalPages > 1 && (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="w-8 h-8 flex items-center justify-center rounded bg-surface-container hover:bg-surface-container-high text-on-surface-variant disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <span className="material-symbols-outlined text-sm">chevron_left</span>
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1).map(p => (
                  <button
                    key={p}
                    onClick={() => setPage(p)}
                    className={`w-8 h-8 flex items-center justify-center rounded text-xs font-bold cursor-pointer transition-colors ${
                      p === page
                        ? 'bg-primary text-on-primary'
                        : 'bg-surface-container hover:bg-surface-container-high text-on-surface-variant'
                    }`}
                  >
                    {p}
                  </button>
                ))}
                <button
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="w-8 h-8 flex items-center justify-center rounded bg-surface-container hover:bg-surface-container-high text-on-surface-variant disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer transition-colors"
                >
                  <span className="material-symbols-outlined text-sm">chevron_right</span>
                </button>
              </div>
            )}
          </div>
        )}
        </>
        ) : (
        /* ============ Uploads Tab ============ */
        <>
          {/* Upload storage summary */}
          {uploadStorage && (
            <div className="flex items-center gap-6 mb-6 px-1 text-xs text-on-surface-variant">
              <span>共 {uploadStorage.count} 個檔案</span>
              <span>·</span>
              <span>{uploadStorage.formatted.used} / {uploadStorage.formatted.quota}</span>
              <div className="w-24 h-1.5 bg-surface-container-highest rounded-full overflow-hidden">
                <div className="h-full bg-primary/60 rounded-full" style={{ width: `${Math.min(uploadStorage.percentage * 100, 100)}%` }} />
              </div>
            </div>
          )}

          {/* Uploaded Files List (read-only view) */}
          {uploads.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-20 border border-dashed border-outline-variant/20 rounded-lg">
              <span className="material-symbols-outlined text-on-surface-variant text-3xl mb-3 opacity-30">upload_file</span>
              <p className="text-on-surface-variant font-medium uppercase tracking-[0.2em] text-xs">尚無上傳檔案</p>
              <p className="text-xs text-on-surface-variant/40 mt-1">在對話輸入框中附加檔案即可上傳</p>
            </div>
          ) : (
            <div className="space-y-2">
              {uploads.map(up => {
                const cfg = getTypeConfig(up.file_type) || { icon: 'attach_file', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)' };
                const scanColor = up.scan_status === 'clean' ? 'text-success' :
                  up.scan_status === 'suspicious' ? 'text-warning' : 'text-error';
                const scanIcon = up.scan_status === 'clean' ? 'verified_user' :
                  up.scan_status === 'suspicious' ? 'warning' : 'gpp_bad';
                const scanLabel = up.scan_status === 'clean' ? '安全' :
                  up.scan_status === 'suspicious' ? '可疑' : '已拒絕';
                const conv = up.conversation_id ? conversations.find(c => c.id === up.conversation_id) : null;
                const linkedFiles = up.conversation_id
                  ? files.filter(f => f.conversation_id === up.conversation_id)
                  : [];
                return (
                  <div key={up.id} className="bg-surface-container rounded-lg group hover:bg-surface-container-high transition-colors overflow-hidden">
                    <div className="p-4 flex items-center gap-4">
                      <div className="w-10 h-10 rounded flex items-center justify-center shrink-0" style={{ background: cfg.bgColor }}>
                        <span className="material-symbols-outlined" style={{ color: cfg.color }}>{cfg.icon}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-on-surface truncate">{up.original_name}</p>
                        <p className="text-xs text-on-surface-variant">
                          {formatSize(up.file_size)} · {new Date(up.created_at.endsWith('Z') ? up.created_at : up.created_at + 'Z').toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}
                        </p>
                      </div>
                      <div className={`flex items-center gap-1 ${scanColor} shrink-0`}>
                        <span className="material-symbols-outlined text-sm">{scanIcon}</span>
                        <span className="text-xs font-bold uppercase">{scanLabel}</span>
                      </div>
                      <button
                        onClick={() => deleteUpload(up.id)}
                        className="w-8 h-8 flex items-center justify-center rounded hover:bg-error/10 text-on-surface-variant hover:text-error cursor-pointer transition-colors opacity-0 group-hover:opacity-100"
                        title="刪除"
                      >
                        <span className="material-symbols-outlined text-sm">delete</span>
                      </button>
                    </div>
                    {/* Linked conversation + generated files */}
                    {(conv || linkedFiles.length > 0) && (
                      <div className="px-4 pb-3 pt-0 flex items-center gap-3 flex-wrap border-t border-outline-variant/5 mt-0">
                        {conv && (
                          <button
                            onClick={() => router.push(`/chat/${up.conversation_id}`)}
                            className="flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 cursor-pointer transition-colors mt-2"
                          >
                            <span className="material-symbols-outlined text-xs">chat</span>
                            <span className="truncate max-w-[200px]">{conv.title}</span>
                          </button>
                        )}
                        {linkedFiles.length > 0 && (
                          <div className="flex items-center gap-2 mt-2">
                            <span className="material-symbols-outlined text-xs text-on-surface-variant">arrow_forward</span>
                            {linkedFiles.map(lf => {
                              const lfCfg = getTypeConfig(lf.file_type);
                              return (
                                <span
                                  key={lf.id}
                                  className="flex items-center gap-1 text-xs px-2 py-0.5 bg-surface-container-lowest rounded cursor-pointer hover:bg-surface-container-highest transition-colors"
                                  onClick={() => setPreviewFile(lf)}
                                >
                                  <span className="material-symbols-outlined text-xs" style={{ color: lfCfg.color }}>{lfCfg.icon}</span>
                                  <span className="text-on-surface truncate max-w-[100px]">{lf.filename}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
        )}
      </main>
    </div>
  );
}

export default function FilesPage() {
  return (
    <AuthProvider>
      <FilesContent />
    </AuthProvider>
  );
}
