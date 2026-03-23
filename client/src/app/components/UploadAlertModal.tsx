'use client';

import { useEffect, useRef } from 'react';
import { useTranslation } from '../../i18n';

export interface UploadAlertItem {
  fileName: string;
  status: 'rejected' | 'suspicious' | 'error' | 'quota';
  detail: string;
}

interface Props {
  items: UploadAlertItem[];
  onClose: () => void;
}

const STATUS_CONFIG: Record<string, { icon: string; color: string; labelKey: string }> = {
  rejected:   { icon: 'gpp_bad',         color: 'text-error',   labelKey: 'uploadAlert.statusRejected' },
  suspicious: { icon: 'warning',         color: 'text-warning', labelKey: 'uploadAlert.statusSuspicious' },
  error:      { icon: 'error',           color: 'text-error',   labelKey: 'uploadAlert.statusError' },
  quota:      { icon: 'cloud_off',       color: 'text-warning', labelKey: 'uploadAlert.statusQuota' },
};

export default function UploadAlertModal({ items, onClose }: Props) {
  const { t } = useTranslation();
  const backdropRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  if (items.length === 0) return null;

  const rejectedCount = items.filter(i => i.status === 'rejected').length;
  const suspiciousCount = items.filter(i => i.status === 'suspicious').length;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="bg-surface-container border border-outline-variant/20 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-6 py-4 bg-error/10 border-b border-outline-variant/10 flex items-center gap-3">
          <span className="material-symbols-outlined text-error text-2xl">shield</span>
          <div className="flex-1">
            <h3 className="text-base font-headline font-bold text-on-surface">
              {t('uploadAlert.title')}
            </h3>
            <p className="text-sm text-on-surface-variant">
              {rejectedCount > 0 && t('uploadAlert.rejectedSummary', { count: rejectedCount })}
              {rejectedCount > 0 && suspiciousCount > 0 && ' · '}
              {suspiciousCount > 0 && t('uploadAlert.suspiciousSummary', { count: suspiciousCount })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface-container-high transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined text-on-surface-variant text-xl">close</span>
          </button>
        </div>

        {/* File list */}
        <div className="px-6 py-4 max-h-[320px] overflow-y-auto space-y-3">
          {items.map((item, i) => {
            const cfg = STATUS_CONFIG[item.status] || STATUS_CONFIG.error;
            return (
              <div key={i} className="flex gap-3 p-3 bg-surface-container-highest/50 rounded-lg border border-outline-variant/10">
                <span className={`material-symbols-outlined ${cfg.color} text-xl shrink-0 mt-0.5`}>{cfg.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-sm font-medium text-on-surface truncate">{item.fileName}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded font-bold uppercase tracking-wider ${
                      item.status === 'rejected' ? 'bg-error/15 text-error' :
                      item.status === 'suspicious' ? 'bg-warning/15 text-warning' :
                      'bg-error/15 text-error'
                    }`}>
                      {t(cfg.labelKey as any)}
                    </span>
                  </div>
                  <p className="text-sm text-on-surface-variant leading-relaxed">{item.detail}</p>
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-outline-variant/10 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 bg-primary text-on-primary rounded-lg font-bold text-sm hover:bg-primary-hover transition-colors cursor-pointer"
          >
            {t('uploadAlert.close')}
          </button>
        </div>
      </div>
    </div>
  );
}
