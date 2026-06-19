'use client';

import { ReactNode } from 'react';

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Lightweight custom confirmation modal — replaces window.confirm so dialogs
 * match the app's look instead of the browser's native chrome.
 */
export default function ConfirmDialog({
  open, title, message, confirmText = '確定', cancelText = '取消', danger, busy, onConfirm, onCancel,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4" onClick={busy ? undefined : onCancel}>
      <div className="bg-surface-container-lowest rounded-2xl shadow-2xl w-full max-w-sm p-6" onClick={e => e.stopPropagation()}>
        {title && (
          <h3 className="text-base font-bold text-on-surface flex items-center gap-2 mb-2">
            <span className={`material-symbols-outlined text-[20px] ${danger ? 'text-error' : 'text-primary'}`}>{danger ? 'warning' : 'help'}</span>
            {title}
          </h3>
        )}
        <div className="text-sm text-on-surface-variant leading-relaxed mb-6">{message}</div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} disabled={busy}
            className="px-4 py-2 rounded-xl text-sm font-medium text-on-surface-variant hover:bg-surface-container transition-colors cursor-pointer disabled:opacity-50">
            {cancelText}
          </button>
          <button onClick={onConfirm} disabled={busy}
            className={`px-4 py-2 rounded-xl text-sm font-bold text-on-primary transition-all cursor-pointer disabled:opacity-50 ${danger ? 'bg-error hover:bg-error/90' : 'cyber-gradient'}`}>
            {busy ? '處理中…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
