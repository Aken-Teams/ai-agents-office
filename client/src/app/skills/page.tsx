'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';

interface Skill {
  id: string;
  name: string;
  description: string;
  fileType: string | null;
  role: string;
}

// Visual config per skill ID
const SKILL_META: Record<string, { icon: string; iconColor: string; bgColor: string; tag: string; tagColor: string }> = {
  'pptx-gen': { icon: 'present_to_all', iconColor: 'text-warning', bgColor: 'bg-warning/10', tag: '文件生成', tagColor: 'text-primary' },
  'docx-gen': { icon: 'description', iconColor: 'text-tertiary', bgColor: 'bg-tertiary/10', tag: '文件生成', tagColor: 'text-primary' },
  'xlsx-gen': { icon: 'table_chart', iconColor: 'text-success', bgColor: 'bg-success/10', tag: '文件生成', tagColor: 'text-primary' },
  'pdf-gen':  { icon: 'picture_as_pdf', iconColor: 'text-error', bgColor: 'bg-error/10', tag: '文件生成', tagColor: 'text-primary' },
  'router':   { icon: 'route', iconColor: 'text-primary', bgColor: 'bg-primary/10', tag: '系統核心', tagColor: 'text-tertiary' },
  'research': { icon: 'travel_explore', iconColor: 'text-tertiary', bgColor: 'bg-tertiary/10', tag: '輔助代理', tagColor: 'text-secondary' },
  'planner':  { icon: 'account_tree', iconColor: 'text-secondary', bgColor: 'bg-secondary/10', tag: '輔助代理', tagColor: 'text-secondary' },
  'reviewer': { icon: 'rate_review', iconColor: 'text-primary', bgColor: 'bg-primary/10', tag: '輔助代理', tagColor: 'text-secondary' },
};

const DEFAULT_META = { icon: 'smart_toy', iconColor: 'text-on-surface-variant', bgColor: 'bg-surface-container-highest', tag: 'Agent', tagColor: 'text-on-surface-variant' };

const FILE_TYPE_LABELS: Record<string, string> = {
  pptx: 'PowerPoint (.pptx)',
  docx: 'Word (.docx)',
  xlsx: 'Excel (.xlsx)',
  pdf: 'PDF (.pdf)',
};

const ROLE_LABELS: Record<string, string> = {
  router: '路由代理',
  worker: '工作代理',
};

function SkillsContent() {
  const { user, token, isLoading } = useAuth();
  const router = useRouter();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [filter, setFilter] = useState<'all' | 'generator' | 'agent'>('all');
  const sidebarMargin = useSidebarMargin();

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;
    fetch('/api/skills', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setSkills)
      .catch(console.error);
  }, [token]);

  if (isLoading || !user) return null;

  const generators = skills.filter(s => s.fileType && s.role !== 'router');
  const agents = skills.filter(s => !s.fileType || s.role === 'router');

  const filtered = filter === 'all' ? skills
    : filter === 'generator' ? generators
    : agents;

  return (
    <div className="min-h-screen bg-surface-container-lowest">
      <Navbar />

      <main className={`${sidebarMargin} pt-8 pb-12 px-10 transition-all duration-300`}>
        {/* Page Header */}
        <header className="mb-10">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-tertiary text-xs font-bold tracking-[0.3em] uppercase">AI 能力</span>
            <div className="h-px w-12 bg-tertiary/30" />
          </div>
          <h2 className="text-4xl font-headline font-bold text-on-surface tracking-tight mb-2">Skills 中心</h2>
          <p className="text-on-surface-variant leading-relaxed max-w-xl">
            探索系統中所有可用的 AI 代理與技能模組。每個 Skill 都是一個專門的 AI 代理，擁有特定的能力與工具。
          </p>
        </header>

        {/* Hero Banner */}
        <section className="relative overflow-hidden bg-surface-container p-8 mb-8 border border-outline-variant/10">
          <div className="absolute top-0 right-0 w-64 h-64 bg-primary/5 rounded-full -mr-20 -mt-20 blur-3xl pointer-events-none" />
          <div className="relative z-10 flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div>
              <h3 className="text-2xl font-headline font-bold text-on-surface mb-2">
                <span className="text-primary">{skills.length}</span> 個 Skills 已載入
              </h3>
              <p className="text-sm text-on-surface-variant">
                包含 {generators.length} 個文件生成器與 {agents.length} 個輔助代理
              </p>
            </div>
            <div className="flex gap-2">
              {(['all', 'generator', 'agent'] as const).map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-5 py-2.5 text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer ${
                    filter === f
                      ? 'bg-primary/15 text-primary border border-primary/30'
                      : 'bg-surface-container-highest text-on-surface-variant hover:text-on-surface border border-transparent'
                  }`}
                >
                  {f === 'all' ? '全部' : f === 'generator' ? '文件生成' : '輔助代理'}
                </button>
              ))}
            </div>
          </div>
        </section>

        {/* Skills Grid */}
        <section className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-6 mb-10">
          {filtered.map(skill => {
            const meta = SKILL_META[skill.id] || DEFAULT_META;
            return (
              <div
                key={skill.id}
                className="group bg-surface-container hover:bg-surface-container-high transition-all duration-300 p-6 border border-transparent hover:border-primary/10 flex flex-col justify-between"
              >
                <div>
                  {/* Top row: icon + tag */}
                  <div className="flex justify-between items-start mb-5">
                    <div className={`w-12 h-12 rounded flex items-center justify-center ${meta.bgColor}`}>
                      <span className={`material-symbols-outlined text-3xl ${meta.iconColor}`}>{meta.icon}</span>
                    </div>
                    <span className={`px-2 py-0.5 bg-surface-container-highest text-[10px] font-bold tracking-widest uppercase ${meta.tagColor}`}>
                      {meta.tag}
                    </span>
                  </div>

                  {/* Name + Description */}
                  <h3 className="text-xl font-headline font-semibold text-on-surface mb-1">{skill.name}</h3>
                  <p className="text-[11px] text-on-surface-variant mb-3 font-medium">
                    ID: <span className="font-mono text-primary/80">{skill.id}</span>
                  </p>
                  <p className="text-sm text-on-surface-variant/80 mb-6 leading-relaxed">{skill.description}</p>
                </div>

                {/* Bottom info bar */}
                <div className="flex items-center justify-between text-[11px] text-on-surface-variant bg-surface-container-low p-3 rounded">
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
                      內部處理
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </section>

        {/* Architecture Section */}
        <section className="bg-surface-container-low border border-outline-variant/5 p-8 overflow-hidden relative">
          <div className="absolute right-6 bottom-6 opacity-[0.06] pointer-events-none">
            <span className="material-symbols-outlined text-[10rem]">hub</span>
          </div>
          <div className="relative z-10">
            <h2 className="text-2xl font-headline font-bold text-on-surface mb-4">多代理協作架構</h2>
            <p className="text-on-surface-variant max-w-2xl mb-8">
              AI Agents Office 採用 Router → Worker 協作模式。Router Agent 分析需求後，自動將任務分派給最適合的 Skill Agent，並支援串連或並行管線處理。
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div className="bg-surface-container p-4 border-l-2 border-primary">
                <h4 className="text-on-surface font-bold text-sm mb-1">智慧路由</h4>
                <p className="text-xs text-on-surface-variant">Router Agent 自動分析需求，選擇最佳代理處理</p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-tertiary">
                <h4 className="text-on-surface font-bold text-sm mb-1">沙盒安全</h4>
                <p className="text-xs text-on-surface-variant">每個 Agent 在隔離環境中運行，確保系統安全</p>
              </div>
              <div className="bg-surface-container p-4 border-l-2 border-secondary">
                <h4 className="text-on-surface font-bold text-sm mb-1">管線處理</h4>
                <p className="text-xs text-on-surface-variant">支援多步驟串連與並行任務，自動彙整結果</p>
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default function SkillsPage() {
  return (
    <AuthProvider>
      <SkillsContent />
    </AuthProvider>
  );
}
