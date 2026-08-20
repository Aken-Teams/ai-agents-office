'use client';

import { useState, useEffect } from 'react';
import { useAdminAuth } from '../components/AdminAuthProvider';
import { useTranslation } from '../../../i18n';
import type { TranslationKey } from '../../../i18n/types';

interface Skill {
  id: string;
  name: string;
  description: string;
  fileType: string | null;
  role: string;
}

/**
 * An MCP server this deployment can mount, as reported by /api/skills/mcp.
 * Which ones exist is a server-side question (does this box hold the key, is the
 * surface wired up) — the page used to guess from deployMode and consequently
 * never showed the Excel add-in's MCP at all.
 */
interface McpSource {
  id: string;
  kind: 'data-source' | 'live-workbook';
  surfaces: ('web' | 'excel')[];
  toolCount: number;
  activation: 'user-selected' | 'always-on';
}

/** Presentation per MCP: a glyph, and which i18n strings describe it. */
const MCP_CARDS: Record<string, { icon: string; color: string; bg: string; nameKey: TranslationKey; descKey: TranslationKey }> = {
  'email-mcp': {
    icon: 'mail', color: 'text-tertiary', bg: 'bg-tertiary/10',
    nameKey: 'admin.skills.mcp.email.name', descKey: 'admin.skills.mcp.email.description',
  },
  'km-mcp': {
    icon: 'menu_book', color: 'text-secondary', bg: 'bg-secondary/10',
    nameKey: 'admin.skills.mcp.km.name', descKey: 'admin.skills.mcp.km.description',
  },
  'excel-mcp': {
    icon: 'table_chart', color: 'text-success', bg: 'bg-success/10',
    nameKey: 'admin.skills.mcp.excel.name', descKey: 'admin.skills.mcp.excel.description',
  },
};

const FILE_TYPE_LABELS: Record<string, string> = {
  pptx: 'PowerPoint (.pptx)',
  docx: 'Word (.docx)',
  xlsx: 'Excel (.xlsx)',
  pdf: 'PDF (.pdf)',
  html: 'Web (.html)',
};

export default function AdminSkillsPage() {
  const { token } = useAdminAuth();
  const { t } = useTranslation();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [mcpSources, setMcpSources] = useState<McpSource[]>([]);
  const [filter, setFilter] = useState<'all' | 'generator' | 'agent' | 'mcp'>('all');

  const SKILL_META: Record<string, { icon: string; iconColor: string; bgColor: string; tag: string; tagColor: string }> = {
    'pptx-gen': { icon: 'present_to_all', iconColor: 'text-warning', bgColor: 'bg-warning/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'docx-gen': { icon: 'description', iconColor: 'text-tertiary', bgColor: 'bg-tertiary/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'xlsx-gen': { icon: 'table_chart', iconColor: 'text-success', bgColor: 'bg-success/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'pdf-gen':  { icon: 'picture_as_pdf', iconColor: 'text-error', bgColor: 'bg-error/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'router':   { icon: 'route', iconColor: 'text-primary', bgColor: 'bg-primary/10', tag: t('admin.skills.tag.systemCore'), tagColor: 'text-tertiary' },
    'research': { icon: 'travel_explore', iconColor: 'text-tertiary', bgColor: 'bg-tertiary/10', tag: t('admin.skills.tag.assistantAgent'), tagColor: 'text-secondary' },
    'planner':  { icon: 'account_tree', iconColor: 'text-secondary', bgColor: 'bg-secondary/10', tag: t('admin.skills.tag.assistantAgent'), tagColor: 'text-secondary' },
    'reviewer':     { icon: 'rate_review', iconColor: 'text-primary', bgColor: 'bg-primary/10', tag: t('admin.skills.tag.assistantAgent'), tagColor: 'text-secondary' },
    'data-analyst': { icon: 'query_stats', iconColor: 'text-tertiary', bgColor: 'bg-tertiary/10', tag: t('admin.skills.tag.assistantAgent'), tagColor: 'text-secondary' },
    'slides-gen':   { icon: 'slideshow', iconColor: 'text-secondary', bgColor: 'bg-secondary/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'webapp-gen':   { icon: 'dashboard', iconColor: 'text-primary', bgColor: 'bg-primary/10', tag: t('admin.skills.tag.docGen'), tagColor: 'text-primary' },
    'rag-analyst':  { icon: 'hub', iconColor: 'text-tertiary', bgColor: 'bg-tertiary/10', tag: t('admin.skills.tag.assistantAgent'), tagColor: 'text-secondary' },
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

    fetch('/api/skills/mcp', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => setMcpSources(Array.isArray(d) ? d : []))
      .catch(console.error);
  }, [token]);

  const generators = skills.filter(s => s.fileType && s.role !== 'router');
  const agents = skills.filter(s => !s.fileType || s.role === 'router');

  const filtered = filter === 'all' ? skills
    : filter === 'generator' ? generators
    : filter === 'agent' ? agents
    : []; // 'mcp' — MCP cards come from mcpSources, not from `skills`
  const shownMcp = filter === 'all' || filter === 'mcp' ? mcpSources : [];

  return (
    <>
      {/* Header */}
      <header className="sticky top-0 h-14 md:h-16 bg-surface/80 backdrop-blur-xl flex justify-between items-center px-4 md:px-8 z-40 shadow-[0_1px_0_0_rgba(255,255,255,0.05)]">
        <span className="text-base md:text-lg font-black text-on-surface font-headline shrink-0">{t('admin.skills.title')}</span>
        <div className="flex gap-px md:gap-1 rounded overflow-hidden border border-outline-variant/15 shrink-0">
          {(['all', 'generator', 'agent', 'mcp'] as const).map(f => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`px-2.5 md:px-4 py-1.5 md:py-2 text-xs md:text-sm font-bold uppercase tracking-wider cursor-pointer transition-colors ${
                filter === f
                  ? 'bg-primary/15 text-primary'
                  : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
              }`}
            >
              {f === 'all' ? t('admin.skills.filter.all') : f === 'generator' ? t('admin.skills.filter.generator') : f === 'agent' ? t('admin.skills.filter.agent') : t('admin.skills.filter.mcp')}
            </button>
          ))}
        </div>
      </header>

      {/* Content */}
      <div className="p-4 md:p-8 flex-1 space-y-4 md:space-y-8">
        {/* Hero Banner */}
        <section className="relative overflow-hidden bg-surface-container p-4 md:p-8 rounded-lg border border-outline-variant/10">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -mr-20 -mt-20 blur-3xl pointer-events-none" />
          <div className="relative z-10">
            {(() => {
              const totalCount = skills.length + mcpSources.length;
              return (
                <>
                  <h3 className="text-lg md:text-2xl font-headline font-bold text-on-surface mb-1 md:mb-2">
                    {t('admin.skills.hero.loaded', { count: totalCount }).split(String(totalCount)).map((part, i, arr) =>
                      i < arr.length - 1 ? (
                        <span key={i}>{part}<span className="text-primary">{totalCount}</span></span>
                      ) : (
                        <span key={i}>{part}</span>
                      )
                    )}
                  </h3>
                  <p className="text-xs md:text-sm text-on-surface-variant">
                    {t('admin.skills.hero.summary', { generatorCount: generators.length, agentCount: agents.length, mcpCount: mcpSources.length })}
                  </p>
                </>
              );
            })()}
          </div>
        </section>

        {/* Skills Grid */}
        <section className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-3 md:gap-6">
          {filtered.map(skill => {
            const meta = SKILL_META[skill.id] || DEFAULT_META;
            return (
              <div
                key={skill.id}
                className="group bg-surface-container hover:bg-surface-container-high transition-all duration-300 p-4 md:p-6 rounded-lg border border-transparent hover:border-primary/10 flex flex-col justify-between"
              >
                <div>
                  <div className="flex justify-between items-start mb-3 md:mb-5">
                    <div className={`w-10 h-10 md:w-12 md:h-12 rounded flex items-center justify-center ${meta.bgColor}`}>
                      <span className={`material-symbols-outlined text-2xl md:text-3xl ${meta.iconColor}`}>{meta.icon}</span>
                    </div>
                    <span className={`px-2 py-0.5 bg-surface-container-highest text-xs md:text-sm font-bold tracking-widest uppercase ${meta.tagColor}`}>
                      {meta.tag}
                    </span>
                  </div>

                  <h3 className="text-base md:text-xl font-headline font-semibold text-on-surface mb-1">{skill.name}</h3>
                  <p className="text-xs md:text-sm text-on-surface-variant mb-2 md:mb-3 font-medium">
                    ID: <span className="font-mono text-primary/80">{skill.id}</span>
                  </p>
                  <p className="text-xs md:text-sm text-on-surface-variant/80 mb-4 md:mb-6 leading-relaxed">{skill.description}</p>
                </div>

                <div className="flex items-center justify-between text-xs md:text-sm text-on-surface-variant bg-surface-container-low p-2.5 md:p-3 rounded">
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-xs md:text-sm">smart_toy</span>
                    {ROLE_LABELS[skill.role] || skill.role}
                  </span>
                  {skill.fileType ? (
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-xs md:text-sm">output</span>
                      <span className="hidden md:inline">{FILE_TYPE_LABELS[skill.fileType] || `.${skill.fileType}`}</span>
                      <span className="md:hidden">.{skill.fileType}</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="material-symbols-outlined text-xs md:text-sm">psychology</span>
                      {t('admin.skills.noFileType')}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
          {/* MCP servers — display-only cards, driven by what the server reports */}
          {shownMcp.map(mcp => {
            // An MCP this build has no copy for still gets a card (bare id, no
            // blurb) rather than vanishing — a silently missing one is exactly
            // how the Excel MCP went unnoticed here for months.
            const card = MCP_CARDS[mcp.id];
            const glyph = card || { icon: 'hub', color: 'text-primary', bg: 'bg-primary/10' };
            return (
              <div
                key={mcp.id}
                className="group bg-surface-container hover:bg-surface-container-high transition-all duration-300 p-4 md:p-6 rounded-lg border border-transparent hover:border-primary/10 flex flex-col justify-between"
              >
                <div>
                  <div className="flex justify-between items-start mb-3 md:mb-5">
                    <div className={`w-10 h-10 md:w-12 md:h-12 rounded flex items-center justify-center ${glyph.bg}`}>
                      <span className={`material-symbols-outlined text-2xl md:text-3xl ${glyph.color}`}>{glyph.icon}</span>
                    </div>
                    <span className={`px-2 py-0.5 bg-surface-container-highest text-xs md:text-sm font-bold tracking-widest uppercase ${glyph.color}`}>
                      {t(mcp.kind === 'live-workbook' ? 'admin.skills.mcp.kind.liveWorkbook' : 'admin.skills.mcp.kind.dataSource')}
                    </span>
                  </div>
                  <h3 className="text-base md:text-xl font-headline font-semibold text-on-surface mb-1">
                    {card ? t(card.nameKey) : mcp.id}
                  </h3>
                  <p className="text-xs md:text-sm text-on-surface-variant mb-2 md:mb-3 font-medium">
                    ID: <span className="font-mono text-primary/80">{mcp.id}</span>
                  </p>
                  {card && (
                    <p className="text-xs md:text-sm text-on-surface-variant/80 mb-3 md:mb-4 leading-relaxed">
                      {t(card.descKey)}
                    </p>
                  )}
                  {/* Where it can be switched on — the same MCP is not offered on
                      every surface (KM is Excel-only by customer decision). */}
                  <div className="flex flex-wrap gap-1.5 mb-4 md:mb-6">
                    {mcp.surfaces.map(s => (
                      <span key={s} className="px-2 py-0.5 rounded-full bg-surface-container-highest text-[11px] md:text-xs text-on-surface-variant">
                        {t(s === 'web' ? 'admin.skills.mcp.surface.web' : 'admin.skills.mcp.surface.excel')}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="flex items-center justify-between text-xs md:text-sm text-on-surface-variant bg-surface-container-low p-2.5 md:p-3 rounded">
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-xs md:text-sm">hub</span>
                    {t('admin.skills.mcp.tools', { count: mcp.toolCount })}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="material-symbols-outlined text-xs md:text-sm">check_circle</span>
                    {t(mcp.activation === 'always-on' ? 'admin.skills.mcp.activation.alwaysOn' : 'admin.skills.mcp.activation.userSelected')}
                  </span>
                </div>
              </div>
            );
          })}

          {filtered.length === 0 && shownMcp.length === 0 && (
            <div className="col-span-full py-12 text-center text-on-surface-variant">{t('admin.skills.empty')}</div>
          )}
        </section>

        {/* Architecture Info */}
        <section className="bg-surface-container-low border border-outline-variant/5 p-4 md:p-8 relative overflow-hidden rounded-lg">
          <div className="absolute right-6 bottom-6 opacity-[0.04] pointer-events-none">
            <span className="material-symbols-outlined text-[8rem]">hub</span>
          </div>
          <div className="relative z-10">
            <h2 className="text-lg md:text-2xl font-headline font-bold text-on-surface mb-2 md:mb-4">{t('admin.skills.architecture.title')}</h2>
            <p className="text-xs md:text-base text-on-surface-variant max-w-2xl mb-4 md:mb-6">
              {t('admin.skills.architecture.description')}
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
              <div className="bg-surface-container p-3 md:p-4 border-l-2 border-primary">
                <h4 className="text-on-surface font-bold text-xs md:text-sm mb-0.5 md:mb-1">{t('admin.skills.architecture.routingTitle')}</h4>
                <p className="text-xs md:text-sm text-on-surface-variant">{t('admin.skills.architecture.routingDesc')}</p>
              </div>
              <div className="bg-surface-container p-3 md:p-4 border-l-2 border-tertiary">
                <h4 className="text-on-surface font-bold text-xs md:text-sm mb-0.5 md:mb-1">{t('admin.skills.architecture.sandboxTitle')}</h4>
                <p className="text-xs md:text-sm text-on-surface-variant">{t('admin.skills.architecture.sandboxDesc')}</p>
              </div>
              <div className="bg-surface-container p-3 md:p-4 border-l-2 border-secondary">
                <h4 className="text-on-surface font-bold text-xs md:text-sm mb-0.5 md:mb-1">{t('admin.skills.architecture.pipelineTitle')}</h4>
                <p className="text-xs md:text-sm text-on-surface-variant">{t('admin.skills.architecture.pipelineDesc')}</p>
              </div>
            </div>
          </div>
        </section>
      </div>
    </>
  );
}
