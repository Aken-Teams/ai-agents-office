'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from '../../i18n';

interface ShareModalProps {
  conversationId: string;
  onClose: () => void;
}

export default function ShareModal({ conversationId, onClose }: ShareModalProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [shared, setShared] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const getAuthHeaders = useCallback(() => {
    const stored = localStorage.getItem('token');
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${stored}` };
  }, []);

  // Check current share status
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/share/${conversationId}/status`, { headers: getAuthHeaders() });
        if (!res.ok) throw new Error('Failed to fetch share status');
        const data = await res.json();
        setShared(data.shared);
        setToken(data.token);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [conversationId, getAuthHeaders]);

  const handleCreate = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/share/${conversationId}`, { method: 'POST', headers: getAuthHeaders() });
      if (!res.ok) throw new Error('Failed to create share link');
      const data = await res.json();
      setShared(true);
      setToken(data.token);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const handleRemove = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/share/${conversationId}`, { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok) throw new Error('Failed to remove share link');
      setShared(false);
      setToken(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const shareUrl = token ? `${window.location.origin}/share/${token}` : '';

  const handleCopy = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fallback
      const input = document.createElement('input');
      input.value = shareUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-surface rounded-2xl shadow-2xl w-full max-w-md p-6 relative"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-bold text-on-surface flex items-center gap-2">
            <span className="material-symbols-outlined" style={{ fontSize: 20 }}>share</span>
            {t('share.title' as any)}
          </h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high text-on-surface-variant cursor-pointer transition-colors"
          >
            <span className="material-symbols-outlined text-sm">close</span>
          </button>
        </div>

        {/* Body */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <span className="text-sm opacity-50 animate-pulse">{t('common.loading' as any)}</span>
          </div>
        ) : shared && token ? (
          <div className="space-y-4">
            <p className="text-sm text-on-surface-variant">
              {t('share.description' as any)}
            </p>
            {/* URL display */}
            <div className="flex items-center gap-2">
              <input
                readOnly
                value={shareUrl}
                className="flex-1 bg-surface-container rounded-lg px-3 py-2 text-sm text-on-surface border border-outline-variant/30 outline-none"
              />
              <button
                onClick={handleCopy}
                className="px-3 py-2 text-sm font-bold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1 whitespace-nowrap"
              >
                <span className="material-symbols-outlined" style={{ fontSize: 16 }}>
                  {copied ? 'check' : 'content_copy'}
                </span>
                {copied ? t('share.copied' as any) : t('share.copyLink' as any)}
              </button>
            </div>
            {/* Remove share */}
            <button
              onClick={handleRemove}
              className="w-full px-3 py-2 text-sm text-error border border-error/30 rounded-lg hover:bg-error/10 transition-colors cursor-pointer flex items-center justify-center gap-1"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 16 }}>link_off</span>
              {t('share.removeLink' as any)}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-on-surface-variant">
              {t('share.createDescription' as any)}
            </p>
            <button
              onClick={handleCreate}
              className="w-full px-4 py-2.5 text-sm font-bold bg-primary text-on-primary rounded-lg hover:opacity-90 transition-opacity cursor-pointer flex items-center justify-center gap-2"
            >
              <span className="material-symbols-outlined" style={{ fontSize: 18 }}>link</span>
              {t('share.createLink' as any)}
            </button>
          </div>
        )}

        {error && (
          <div className="mt-3 text-sm text-error">{error}</div>
        )}
      </div>
    </div>
  );
}
