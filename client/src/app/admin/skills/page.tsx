'use client';

import { useState, useEffect } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';

interface Skill {
  id: string;
  name: string;
  description: string;
  fileType: string | null;
  role: string;
}

const FILE_TYPE_LABELS: Record<string, string> = {
  pptx: 'PowerPoint (.pptx)',
  docx: 'Word (.docx)',
  xlsx: 'Excel (.xlsx)',
  pdf: 'PDF (.pdf)',
};

export default function AdminSkillsPage() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [filter, setFilter] = useState<'all' | 'generator' | 'agent'>('all');

  const SKILL_META: Record<string, { icon: string; iconColor: string; bgColor: string; tag: string; tagColor: string }> = {
    'pptx-gen': { icon: 'present_to_all', iconColor: 'text-warning', bgColor: 'bg-warning/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'docx-gen': { icon: 'description', iconColor: 'text-tertiary', bgColor: 'bg-tertiary/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'xlsx-gen': { icon: 'table_chart', iconColor: 'text-success', bgColor: 'bg-success/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'pdf-gen':  { icon: 'picture_as_pdf', iconColor: 'text-error', bgColor: 'bg-error/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'router':   { icon: 'route', iconColor: 'text-primary', bgColor: 'bg-primary/10', tag: t('admin.skills.tag.systemCore'), tagColor: 'text-tertiary' },
    'research': { icon: 'travel_explore', iconColor: 'text-tertiary', bgColor: 'bg-tertiary/10', tag: t('admin.skills.tag.assistantAgent'), tagColor: 'text-secondary' },
    'planner':  { icon: 'account_tree', iconColor: 'text-secondary', bgColor: 'bg-secondary/10', tag: t('admin.skills.tag.assistantAgent'), tagColor: 'text-secondary' },
    'reviewer': { icon: 'rate_review', iconColor: 'text-primary', bgColor: 'bg-primary/10', tag: t('admin.skills.tag.assistantAgent'), tagColor: 'text-secondary' },
  };

  const DEFAULT_META = { icon: 'smart_toy', iconColor: 'text-on-surface-variant', bgColor: 'bg-surface-container-highest', tag: 'Agent', tagColor: 'text-on-surface-variant' };

  const ROLE_LABELS: Record<string, string> = {
    router: t('admin.skills.role.router'),
    worker: t('admin.skills.role.worker'),
  };

  useEffect(() => {
    if (!token) return;
    fetch('/api/skills', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setSkills)
      .catch(console.error);
  }, [token]);

  const generators = skills.filter(s => s.fileType && s.role !== 'router');
  const agents = skills.filter(s => !s.fileType || s.role === 'router');

  const filtered = filter === 'all' ? skills
    : filter === 'generator' ? generators
    : agents;

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <div className="flex items-center gap-4">
          <span className="text-lg font-black text-on-surface font-headline">{t('admin.skills.title')}</span>
        </div>
        <div className="flex gap-1 rounded overflow-hidden border border-outline-variant/15">
          {(['all', 'generator', 'agent'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-4 py-2 text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                filter === f
                  ? 'bg-primary/15 text-primary'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
              }`}
            >
              {f === 'all' ? t('admin.skills.filter.all') : f === 'generator' ? t('admin.skills.filter.generator') : t('admin.skills.filter.agent')}
            </button>
          ))}
        </div>
      </header>

      {/* Content */}
      <div className="p-8 flex-1 space-y-8">
        {/* Hero Banner */}
        <section className="relative overflow-hidden bg-surface-container p-8 rounded-lg border border-outline-variant/10">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -mr-20 -mt-20 blur-3xl pointer-events-none" />
          <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <h3 className="text-2xl font-headline font-bold text-on-surface mb-2">
                {t('admin.skills.hero.loaded', { count: skills.length }).split(String(skills.length)).map((part, i, arr) =>
                  i < arr.length - 1 ? (
                    <span key={i}>{part}<span className="text-primary">{skills.length}</span></span>
                  ) : (
                    <span key={i}>{part}</span>
                  )
                )}
              </h3>
              <p className="text-sm text-on-surface-variant">
                {t('admin.skills.hero.summary', { generatorCount: generators.length, agentCount: agents.length })}
              </p>
            </div>
          </div>
        </section>

        {/* Skills Grid */}
        <section className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-6">
          {filtered.map(skill => {
            const meta = SKILL_META[skill.id] || DEFAULT_META;
            return (
              <div
                key={skill.id}
                className="group bg-surface-container hover:bg-surface-container-high transition-all duration-300 p-6 rounded-lg border border-transparent hover:border-primary/10 flex flex-col justify-between"
              >
                <div>
                  <div className="flex justify-between items-start mb-5">
                    <div className={`w-12 h-12 rounded flex items-center justify-center ${meta.bgColor}`}>
                      <span className={`material-symbols-outlined text-3xl ${meta.iconColor}`}>{meta.icon}</span>
                    </div>
                    <span className={`px-2 py-0.5 bg-surface-container-highest text-sm font-bold tracking-widest uppercase ${meta.tagColor}`}>
                      {meta.tag}
                    </span>
                  </div>

                  <h3 className="text-xl font-headline font-semibold text-on-surface mb-1">{skill.name}</h3>
                  <p className="text-sm text-on-surface-variant mb-3 font-medium">
                    ID: <span className="font-mono text-primary/80">{skill.id}</span>
                  </p>
                  <p className="text-sm text-on-surface-variant/80 mb-6 leading-relaxed">{skill.description}</p>
                </div>

                <div className="flex items-center justify-between text-sm text-on-surface-variant bg-surface-container-low p-3 rounded">
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-sm">smart_toy</span>
                    {ROLE_LABELS[skill.role] || skill.role}
                  </span>
                  {skill.fileType ? (
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">output</span>
                      {FILE_TYPE_LABELS[skill.fileType] || `.${skill.fileType}`}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-sm">psychology</span>
                      {t('admin.skills.noFileType')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {filtered.length === 0 && (
            <div className="col-span-full py-12 text-center text-on-surface-variant">{t('admin.skills.empty')}</div>
          )}
        </section>

        {/* Architecture Info */}
        <section className="bg-surface-container-low border border-outline-variant/5 p-8 relative overflow-hidden rounded-lg">
          <div className="absolute right-6 bottom-6 opacity-[0.04] pointer-events-none">
            <span className="material-symbols-outlined text-[8rem]">hub</span>
          </div>
          <div className="relative z-10">
            <h2 className="text-2xl font-headline font-bold text-on-surface mb-4">{t('admin.skills.architecture.title')}</h2>
            <p className="text-on-surface-variant max-w-2xl mb-6">
              {t('admin.skills.architecture.description')}
            </p>
            <div className="grid grid-cols-3 gap-4">
              <div className="bg-surface-container p-4 border-l-2 border-primary">
                <h4 className="text-on-surface font-bold text-sm mb-1">{t('admin.skills.architecture.routingTitle')}</h4>
                <p className="text-sm text-on-surface-variant">{t('admin.skills.architecture.routingDesc')}</p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-tertiary">
                <h4 className="text-on-surface font-bold text-sm mb-1">{t('admin.skills.architecture.sandboxTitle')}</h4>
                <p className="text-sm text-on-surface-variant">{t('admin.skills.architecture.sandboxDesc')}</p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-secondary">
                <h4 className="text-on-surface font-bold text-sm mb-1">{t('admin.skills.architecture.pipelineTitle')}</h4>
                <p className="text-sm text-on-surface-variant">{t('admin.skills.architecture.pipelineDesc')}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
