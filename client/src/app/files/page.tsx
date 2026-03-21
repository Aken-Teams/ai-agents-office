'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import Navbar from '../components/Navbar';

interface FileItem {
  id: string;
  filename: string;
  file_type: string;
  file_size: number;
  conversation_id: string | null;
  created_at: string;
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

const FILTER_TABS = [
  { value: '', label: '全部' },
  { value: 'pptx', label: 'PPT' },
  { value: 'docx', label: 'Word' },
  { value: 'xlsx', label: 'Excel' },
  { value: 'pdf', label: 'PDF' },
];

const PAGE_SIZE = 12;

function FilesContent() {
  const { user, token, isLoading } = useAuth();
  const router = useRouter();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filter, setFilter] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;
    const url = filter ? `/api/files?type=${filter}` : '/api/files';
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setFiles)
      .catch(console.error);
  }, [token, filter]);

  async function deleteFile(id: string) {
    if (!token || !confirm('確定要刪除這個檔案嗎？')) return;
    await fetch(`/api/files/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setFiles(prev => prev.filter(f => f.id !== id));
  }

  async function handleDownload(fileId: string, filename: string) {
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
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getTypeConfig(type: string) {
    return FILE_TYPE_CONFIG[type] || { icon: 'attach_file', color: '#8f9097', bgColor: 'rgba(143,144,151,0.1)' };
  }

  // Reset page when filter changes
  useEffect(() => { setPage(1); }, [filter]);

  // Calculate total storage + pagination
  const totalSize = files.reduce((sum, f) => sum + f.file_size, 0);
  const totalPages = Math.max(1, Math.ceil(files.length / PAGE_SIZE));
  const pagedFiles = files.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  if (isLoading || !user) return null;

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />

      <main className="ml-64 pt-8 pb-12 px-10">
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
          <div className="bg-surface-container rounded-lg p-5 w-72 flex flex-col gap-3 relative overflow-hidden shrink-0">
            <div className="absolute top-0 right-0 p-4 opacity-10">
              <span className="material-symbols-outlined text-4xl">database</span>
            </div>
            <div className="flex justify-between items-center text-xs font-bold tracking-widest uppercase text-on-surface-variant">
              <span>儲存空間</span>
              <span className="text-primary">{files.length} 個檔案</span>
            </div>
            <div className="h-1.5 bg-surface-container-lowest rounded-full overflow-hidden">
              <div className="h-full cyber-gradient" style={{ width: `${Math.min((totalSize / (2 * 1024 * 1024 * 1024)) * 100, 100)}%` }} />
            </div>
            <div className="flex justify-between items-baseline">
              <span className="font-headline text-lg font-bold">
                {formatSize(totalSize)}
              </span>
              <span className="text-xs text-on-surface-variant uppercase tracking-tighter">
                已使用
              </span>
            </div>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="flex items-center gap-3 mb-8">
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

        {/* File Grid */}
        {files.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 border border-dashed border-outline-variant/20 rounded-lg">
            <div className="w-16 h-16 rounded-full bg-surface-container flex items-center justify-center mb-4">
              <span className="material-symbols-outlined text-on-surface-variant text-3xl">upload_file</span>
            </div>
            <p className="text-on-surface-variant font-medium uppercase tracking-[0.2em] text-xs">尚無檔案</p>
            <p className="text-xs text-on-surface-variant/40 mt-1">從儀表板開始生成文件</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
            {pagedFiles.map(file => {
              const config = getTypeConfig(file.file_type);
              return (
                <div
                  key={file.id}
                  className="bg-surface-container hover:bg-surface-container-high transition-colors p-5 flex flex-col gap-4 group"
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
                        onClick={() => handleDownload(file.id, file.filename)}
                        className="w-8 h-8 flex items-center justify-center rounded bg-transparent hover:bg-primary/10 text-on-surface-variant hover:text-primary cursor-pointer transition-colors"
                        title="下載"
                      >
                        <span className="material-symbols-outlined text-sm">download</span>
                      </button>
                      <button
                        onClick={() => deleteFile(file.id)}
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
        {files.length > 0 && (
          <div className="mt-8 flex items-center justify-between">
            <p className="text-on-surface-variant/60 text-xs uppercase tracking-widest">
              共 {files.length} 個檔案
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
