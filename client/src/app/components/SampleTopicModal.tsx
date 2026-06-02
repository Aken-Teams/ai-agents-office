'use client';

import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../../i18n';

export interface SampleRef {
  /** i18n key for the card label, e.g. 'dashboard.samples.pptx' */
  labelKey: string;
  /** i18n key for the prompt template, e.g. 'dashboard.samples.pptx.template' */
  templateKey: string;
  /** Optional icon + colour for the modal header. */
  icon?: string;
  color?: string;
}

interface Props {
  sample: SampleRef | null;
  onClose: () => void;
  onApply: (finalPrompt: string) => void;
}

/**
 * Lets the user enter an optional topic before applying a sample-prompt
 * template. Leaves blank → original template. Otherwise prepends a directive
 * that tells the downstream orchestrator to swap the topic.
 */
export default function SampleTopicModal({ sample, onClose, onApply }: Props) {
  const { t } = useTranslation();
  const backdropRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [topic, setTopic] = useState('');

  // Reset state + focus input each time a new sample is opened.
  useEffect(() => {
    if (sample) {
      setTopic('');
      const tm = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(tm);
    }
  }, [sample]);

  // Close on Escape.
  useEffect(() => {
    if (!sample) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [sample, onClose]);

  if (!sample) return null;

  const template = t(sample.templateKey as Parameters<typeof t>[0]);
  const cardLabel = t(sample.labelKey as Parameters<typeof t>[0]);
  // Convention: dashboard.samples.<slug>.template ↔ dashboard.samples.<slug>.defaultTopic
  const defaultTopicKey = sample.templateKey.replace(/\.template$/, '.defaultTopic');
  const defaultTopic = t(defaultTopicKey as Parameters<typeof t>[0]);

  function handleApply() {
    const trimmed = topic.trim();
    // Substitute every {{TOPIC}} placeholder. Empty input falls back to the
    // template's defaultTopic so visiting users still get the original example.
    const effectiveTopic = trimmed || defaultTopic;
    const finalPrompt = template.split('{{TOPIC}}').join(effectiveTopic);
    onApply(finalPrompt);
    onClose();
  }

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="bg-surface-container border border-outline-variant/20 rounded-2xl shadow-2xl w-full max-w-lg mx-4 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="px-5 md:px-6 py-4 bg-primary/10 border-b border-outline-variant/10 flex items-center gap-3">
          <span className={`material-symbols-outlined text-2xl ${sample.color ?? 'text-primary'}`}>
            {sample.icon ?? 'auto_fix_high'}
          </span>
          <div className="flex-1 min-w-0">
            <h3 className="font-headline font-bold text-on-surface truncate">{cardLabel}</h3>
            <p className="text-xs text-on-surface-variant mt-0.5">
              {t('dashboard.samples.modal.subtitle' as any)}
            </p>
          </div>
          <button
            onClick={onClose}
            className="shrink-0 text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {/* Body */}
        <div className="px-5 md:px-6 py-5 space-y-3">
          <label className="block text-sm font-medium text-on-surface">
            {t('dashboard.samples.modal.label' as any)}
          </label>
          <input
            ref={inputRef}
            type="text"
            value={topic}
            onChange={e => setTopic(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleApply(); } }}
            placeholder={t('dashboard.samples.modal.placeholder' as any)}
            className="w-full px-4 py-2.5 bg-surface-container-highest text-on-surface text-sm rounded-lg border border-outline-variant/20 focus:border-primary focus:outline-none"
            maxLength={200}
          />
          <p className="text-xs text-on-surface-variant leading-relaxed">
            {t('dashboard.samples.modal.hint' as any)}
          </p>
        </div>

        {/* Footer */}
        <div className="px-5 md:px-6 py-4 bg-surface-container-low border-t border-outline-variant/10 flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-on-surface-variant text-sm rounded-lg hover:bg-surface-variant transition-colors cursor-pointer"
          >
            {t('dashboard.samples.modal.cancel' as any)}
          </button>
          <button
            onClick={handleApply}
            className="px-4 py-2 bg-primary text-on-primary text-sm font-bold rounded-lg hover:bg-primary/90 transition-colors cursor-pointer"
          >
            {t('dashboard.samples.modal.apply' as any)}
          </button>
        </div>
      </div>
    </div>
  );
}
