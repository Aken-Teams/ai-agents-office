'use client';

/**
 * Dedicated, focused "import files into the knowledge base" page.
 *
 * This is the target of the LINE rich-menu「上傳檔案」tile — a single clean
 * screen with just the import dropzone + a list of what's already imported,
 * so users (often on mobile via LIFF) don't have to hunt through tabs.
 */
import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider } from '../../i18n';

interface UploadItem {
  id: string;
  original_name: string;
  file_type: string;
  file_size: number;
  scan_status: 'pending' | 'clean' | 'suspicious' | 'rejected';
  created_at: string;
}

interface UploadStorageInfo {
  count: number;
  percentage: number;
  formatted: { used: string; quota: string };
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function ImportContent() {
  const { user, token, isLoading } = useAuth();
  const router = useRouter();
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [storage, setStorage] = useState<UploadStorageInfo | null>(null);
  const [kbChunks, setKbChunks] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  const refresh = useCallback(() => {
    if (!token) return;
    fetch('/api/uploads', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setUploads).catch(() => {});
    fetch('/api/uploads/storage', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then(setStorage).catch(() => {});
    fetch('/api/local-rag/docs', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json()).then((d: { chunks?: number }) => setKbChunks(d.chunks ?? null)).catch(() => {});
  }, [token]);

  useEffect(() => { refresh(); }, [refresh]);

  const importFiles = useCallback(async (fileList: FileList | null) => {
    if (!token || uploading || !fileList || fileList.length === 0) return;
    setUploading(true);
    try {
      const fd = new FormData();
      Array.from(fileList).forEach(f => fd.append('files', f));
      fd.append('index', 'true');
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const all = (data.uploads || []) as Array<{ scanStatus: string }>;
        const rejected = all.filter(u => u.scanStatus === 'rejected').length;
        const ok = all.length - rejected;
        setToast(rejected > 0
          ? `已上傳 ${ok} 個檔案（${rejected} 個被安全攔截），正在加入知識庫…`
          : `已上傳 ${ok} 個檔案，正在分析並加入知識庫…`);
        refresh();
      } else {
        setToast(data.error || '上傳失敗');
      }
    } catch {
      setToast('上傳失敗（網路錯誤）');
    } finally {
      setUploading(false);
    }
  }, [token, uploading, refresh]);

  async function deleteUpload(id: string) {
    if (!token) return;
    await fetch(`/api/uploads/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    refresh();
  }

  if (isLoading || !user) return null;

  return (
    <div className="min-h-screen bg-surface-container-lowest text-on-surface">
      {/* Minimal header */}
      <header className="sticky top-0 z-30 flex items-center justify-between px-4 h-14 bg-surface/85 backdrop-blur-xl border-b border-outline-variant/10">
        <div className="flex items-center gap-2">
          <span className="material-symbols-outlined text-primary">upload_file</span>
          <span className="font-headline font-bold text-base">匯入檔案到知識庫</span>
        </div>
        <Link href="/files" className="text-xs text-on-surface-variant hover:text-primary no-underline flex items-center gap-1">
          <span className="material-symbols-outlined text-sm">folder</span>我的檔案
        </Link>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-6 space-y-5">
        {toast && (
          <div className="bg-primary/10 border border-primary/30 text-primary text-sm rounded-lg px-4 py-2.5">{toast}</div>
        )}

        {/* Import dropzone */}
        <label
          onDragOver={e => { e.preventDefault(); }}
          onDrop={e => { e.preventDefault(); importFiles(e.dataTransfer.files); }}
          className={`flex flex-col items-center justify-center gap-2 py-10 px-4 border-2 border-dashed rounded-xl text-center transition-colors ${
            uploading
              ? 'opacity-70 cursor-wait border-primary/40 bg-primary/5'
              : 'cursor-pointer border-primary/40 bg-primary/[0.03] hover:border-primary/70 hover:bg-primary/[0.07]'
          }`}
        >
          <input type="file" multiple className="hidden" disabled={uploading}
            onChange={e => { importFiles(e.target.files); e.currentTarget.value = ''; }} />
          <span className={`material-symbols-outlined text-4xl text-primary ${uploading ? 'animate-spin' : ''}`}>
            {uploading ? 'progress_activity' : 'cloud_upload'}
          </span>
          <span className="text-base font-bold font-headline">{uploading ? '上傳中…' : '點此選擇檔案，或拖曳到這裡'}</span>
          <span className="text-xs text-on-surface-variant/70 max-w-md leading-relaxed">
            可多選。支援 PDF、Word、Excel、PPT、文字等。上傳後會自動分析並加入你的個人知識庫，之後在對話（含 LINE）中會被優先參考。
          </span>
        </label>

        {/* Knowledge base + storage summary */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs md:text-sm text-on-surface-variant">
          {kbChunks !== null && (
            <span className="flex items-center gap-1.5 text-tertiary">
              <span className="material-symbols-outlined text-sm">psychology</span>
              知識庫：{kbChunks} 段
            </span>
          )}
          {storage && (
            <>
              <span>已上傳 {storage.count} 個檔案</span>
              <span className="flex items-center gap-2">
                {storage.formatted.used} / {storage.formatted.quota}
                <span className="inline-block w-20 h-1.5 bg-surface-container-highest rounded-full overflow-hidden align-middle">
                  <span className="block h-full bg-primary/60" style={{ width: `${Math.min(storage.percentage * 100, 100)}%` }} />
                </span>
              </span>
            </>
          )}
        </div>

        {/* Imported files list */}
        <div>
          <h2 className="text-xs font-bold uppercase tracking-widest text-on-surface-variant mb-2">已匯入的檔案</h2>
          {uploads.length === 0 ? (
            <p className="text-sm text-on-surface-variant/60 py-6 text-center border border-dashed border-outline-variant/20 rounded-lg">
              尚未匯入任何檔案。
            </p>
          ) : (
            <ul className="space-y-1.5">
              {uploads.map(u => (
                <li key={u.id} className="flex items-center gap-3 bg-surface-container rounded-lg px-3 py-2.5">
                  <span className="material-symbols-outlined text-on-surface-variant shrink-0">description</span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{u.original_name}</p>
                    <p className="text-[11px] text-on-surface-variant/60">
                      {u.file_type.toUpperCase()} · {fmtSize(u.file_size)}
                      {u.scan_status === 'rejected' && <span className="text-error"> · 已攔截</span>}
                    </p>
                  </div>
                  <button
                    onClick={() => deleteUpload(u.id)}
                    className="w-8 h-8 flex items-center justify-center rounded-lg text-on-surface-variant hover:text-error hover:bg-error/10 transition-colors cursor-pointer shrink-0"
                    title="刪除"
                  >
                    <span className="material-symbols-outlined text-[18px]">delete</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  );
}

function ImportWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <ImportContent />
    </I18nProvider>
  );
}

export default function ImportPage() {
  return (
    <AuthProvider>
      <ImportWithI18n />
    </AuthProvider>
  );
}
