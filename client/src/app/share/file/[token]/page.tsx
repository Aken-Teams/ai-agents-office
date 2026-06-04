'use client';

/**
 * Public, no-auth file viewer. Opened from the LINE file card's "開啟報告"
 * button (and forwardable to anyone). Embeds the right viewer per type:
 * Office → Microsoft online viewer, PDF → inline iframe, image → <img>.
 * Everything resolves the file via the opaque share token (no session).
 */

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';

interface FileInfo { filename: string; fileType: string; fileSize: number | null }

const OFFICE = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt']);
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg']);

function fmtSize(b: number | null): string {
  if (!b || b <= 0) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function FileSharePage() {
  const params = useParams();
  const token = String(params.token);
  const [info, setInfo] = useState<FileInfo | null>(null);
  const [error, setError] = useState(false);
  const [origin, setOrigin] = useState('');

  useEffect(() => {
    setOrigin(window.location.origin);
    fetch(`/api/files/share/${token}/info`)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(setInfo)
      .catch(() => setError(true));
  }, [token]);

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-3 bg-surface-container-lowest text-on-surface-variant px-6 text-center">
        <span className="material-symbols-outlined text-5xl text-outline">link_off</span>
        <p className="text-sm">這個檔案連結無效或已過期。</p>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-surface-container-lowest">
        <span className="material-symbols-outlined animate-spin text-primary text-4xl">progress_activity</span>
      </div>
    );
  }

  const rawUrl = `${origin}/api/files/share/${token}`;
  const ext = (info.fileType || '').toLowerCase();
  const isOffice = OFFICE.has(ext);
  const isPdf = ext === 'pdf';
  const isImage = IMAGE.has(ext);
  const canEmbed = isOffice || isPdf || isImage;

  return (
    <div className="h-screen flex flex-col bg-surface-container-lowest">
      {/* Header */}
      <header className="shrink-0 flex items-center gap-3 px-4 md:px-6 py-3 border-b border-outline-variant/10 bg-surface">
        <div className="w-9 h-9 rounded-lg cyber-gradient flex items-center justify-center shrink-0">
          <span className="material-symbols-outlined text-on-primary text-lg">description</span>
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm md:text-base font-headline font-bold text-on-surface truncate">{info.filename}</h1>
          <p className="text-[11px] text-on-surface-variant">{ext.toUpperCase()}{fmtSize(info.fileSize) ? ` · ${fmtSize(info.fileSize)}` : ''}</p>
        </div>
        <a href={`${rawUrl}?dl=1`}
          className="shrink-0 flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-sm font-bold text-on-primary cyber-gradient hover:brightness-110 active:scale-95 transition-all no-underline">
          <span className="material-symbols-outlined text-[18px]">download</span>
          <span className="hidden sm:inline">下載</span>
        </a>
      </header>

      {/* Viewer */}
      <div className="flex-1 min-h-0 bg-surface-container">
        {!origin ? null
          : isImage ? (
            <div className="h-full overflow-auto flex items-center justify-center p-4">
              <img src={rawUrl} alt={info.filename} className="max-w-full max-h-full object-contain rounded-lg shadow" />
            </div>
          ) : isPdf ? (
            <iframe src={rawUrl} title={info.filename} className="w-full h-full border-0" />
          ) : isOffice ? (
            <iframe src={`https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(rawUrl)}`} title={info.filename} className="w-full h-full border-0" />
          ) : (
            <div className="h-full flex flex-col items-center justify-center gap-4 text-center px-6">
              <span className="material-symbols-outlined text-5xl text-outline">draft</span>
              <p className="text-sm text-on-surface-variant">此檔案類型無法線上預覽，請直接下載查看。</p>
              <a href={`${rawUrl}?dl=1`} className="flex items-center gap-1.5 px-5 py-2.5 rounded-xl text-sm font-bold text-on-primary cyber-gradient no-underline">
                <span className="material-symbols-outlined text-[18px]">download</span>下載檔案
              </a>
            </div>
          )}
      </div>

      <footer className="shrink-0 text-center py-2 text-[11px] text-outline border-t border-outline-variant/10">
        由 AI Agents Office 產生 · 此連結為公開分享{canEmbed ? '' : ''}
      </footer>
    </div>
  );
}
