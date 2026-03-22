'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from './AuthProvider';

const SIDEBAR_KEY = 'sidebar-collapsed';

const NAV_LINKS = [
  { href: '/dashboard', label: '儀表板', icon: 'dashboard' },
  { href: '/conversations', label: '對話記錄', icon: 'chat' },
  { href: '/files', label: '檔案管理', icon: 'folder_open' },
  { href: '/usage', label: '用量統計', icon: 'bar_chart' },
];

const DOC_TYPES = [
  { id: 'pptx-gen', label: '簡報', desc: '投影片製作', icon: 'present_to_all', colorClass: 'text-warning' },
  { id: 'docx-gen', label: '文件', desc: '文書撰寫', icon: 'description', colorClass: 'text-tertiary' },
  { id: 'xlsx-gen', label: '試算表', desc: '數據分析', icon: 'table_chart', colorClass: 'text-success' },
  { id: 'pdf-gen', label: 'PDF', desc: '文件輸出', icon: 'picture_as_pdf', colorClass: 'text-error' },
  { id: 'data-analyst', label: '數據分析', desc: '上傳資料分析', icon: 'analytics', colorClass: 'text-primary' },
  { id: 'research', label: '網路研究', desc: '搜尋與彙整', icon: 'travel_explore', colorClass: 'text-on-surface-variant' },
];

export default function Navbar() {
  const { user, token, logout } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [showModal, setShowModal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(SIDEBAR_KEY) === '1';
    return false;
  });

  // Sync to localStorage + dispatch event for other components
  useEffect(() => {
    localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    window.dispatchEvent(new CustomEvent('sidebar-toggle', { detail: collapsed }));
  }, [collapsed]);

  if (!user) return null;

  async function handleCreate(skillId: string) {
    if (!token || creating) return;
    setCreating(true);
    try {
      const docType = DOC_TYPES.find(s => s.id === skillId);
      const title = docType?.label ? `New ${docType.label}` : 'New Conversation';
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, skillId }),
      });
      const conv = await res.json();
      setShowModal(false);
      router.push(`/chat/${conv.id}`);
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <aside className={`h-screen fixed left-0 top-0 bg-surface-dim flex flex-col py-6 font-headline text-sm tracking-tight z-50 border-r border-outline-variant/10 transition-all duration-300 ${collapsed ? 'w-[68px]' : 'w-64'}`}>
        {/* Logo */}
        <div className={`mb-8 ${collapsed ? 'px-3' : 'px-6'}`}>
          <Link href="/dashboard" className="flex items-center gap-3 no-underline">
            <div className="w-8 h-8 bg-primary/20 flex items-center justify-center rounded-lg shrink-0">
              <span className="material-symbols-outlined text-primary">terminal</span>
            </div>
            {!collapsed && (
              <div>
                <h1 className="text-xl font-bold tracking-tighter text-on-surface">AI Agents</h1>
                <p className="text-sm uppercase tracking-[0.2em] text-primary">Office</p>
              </div>
            )}
          </Link>
        </div>

        {/* Navigation */}
        <nav className={`flex-1 space-y-1 ${collapsed ? 'px-2' : 'px-4'}`}>
          {NAV_LINKS.map(link => {
            const isActive = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`relative group flex items-center gap-3 py-2.5 no-underline transition-all duration-200 ${collapsed ? 'justify-center px-0' : 'px-3'} ${
                  isActive
                    ? 'text-primary bg-surface-container border-l-2 border-primary'
                    : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container/50'
                }`}
              >
                <span className="material-symbols-outlined">{link.icon}</span>
                {!collapsed && <span>{link.label}</span>}
                {collapsed && (
                  <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                    {link.label}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>

        {/* New Document Button */}
        <div className={`mt-6 ${collapsed ? 'px-2' : 'px-6'}`}>
          <div className="relative group">
            <button
              onClick={() => setShowModal(true)}
              className={`w-full cyber-gradient py-3 text-on-primary font-bold rounded flex items-center justify-center gap-2 text-sm uppercase tracking-widest active:scale-[0.99] transition-all cursor-pointer ${collapsed ? 'px-0' : ''}`}
            >
              <span className="material-symbols-outlined text-sm">add</span>
              {!collapsed && '新建文件'}
            </button>
            {collapsed && (
              <span className="absolute left-full ml-3 top-1/2 -translate-y-1/2 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                新建文件
              </span>
            )}
          </div>
        </div>

        {/* Bottom */}
        <div className={`mt-auto pt-6 space-y-1 ${collapsed ? 'px-2' : 'px-4'}`}>
          {/* Collapse Toggle */}
          <button
            onClick={() => setCollapsed(v => !v)}
            className={`relative group flex items-center gap-3 py-2 text-on-surface-variant hover:text-on-surface transition-all w-full bg-transparent cursor-pointer ${collapsed ? 'justify-center px-0' : 'px-3'}`}
          >
            <span className={`material-symbols-outlined text-sm transition-transform duration-300 ${collapsed ? 'rotate-180' : ''}`}>
              chevron_left
            </span>
            {!collapsed && <span className="text-sm">收合</span>}
            {collapsed && (
              <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                展開側邊欄
              </span>
            )}
          </button>

          <div className={`relative group flex items-center gap-3 py-2 text-on-surface-variant ${collapsed ? 'justify-center px-0' : 'px-3'}`}>
            <span className="material-symbols-outlined text-sm">person</span>
            {!collapsed && <span className="text-sm truncate">{user.displayName || user.email}</span>}
            {collapsed && (
              <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                {user.displayName || user.email}
              </span>
            )}
          </div>
          <button
            onClick={logout}
            className={`relative group flex items-center gap-3 py-2 text-on-surface-variant hover:text-on-surface transition-all w-full text-left bg-transparent ${collapsed ? 'justify-center px-0' : 'px-3'}`}
          >
            <span className="material-symbols-outlined">logout</span>
            {!collapsed && <span>登出</span>}
            {collapsed && (
              <span className="absolute left-full ml-3 px-3 py-1.5 bg-surface-container-highest text-on-surface text-sm font-bold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-[60] shadow-lg border border-outline-variant/10">
                登出
              </span>
            )}
          </button>

          {/* Footer */}
          <div className="mt-3 pt-3 border-t border-outline-variant/10 px-3">
            <a href="https://www.zh-aoi.com/" target="_blank" rel="noopener noreferrer" className={`text-outline hover:text-on-surface-variant transition-colors no-underline block text-center ${collapsed ? 'text-sm' : 'text-[11px]'}`}>
              {collapsed ? '©' : <>Powered by 智合科技 &copy; 2026</>}
            </a>
          </div>
        </div>
      </aside>

      {/* Agent Tool Picker Modal */}
      {showModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          onClick={() => setShowModal(false)}
        >
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />

          {/* Modal */}
          <div
            className="relative bg-surface-container rounded-xl shadow-2xl border border-outline-variant/10 w-full max-w-lg mx-4 overflow-hidden animate-in"
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="px-6 py-5 flex items-center justify-between border-b border-outline-variant/10">
              <div className="flex items-center gap-3">
                <span className="material-symbols-outlined text-primary">add_circle</span>
                <h2 className="text-sm font-headline font-bold">選擇代理工具</h2>
              </div>
              <button
                onClick={() => setShowModal(false)}
                className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-surface-container-high transition-colors bg-transparent cursor-pointer"
              >
                <span className="material-symbols-outlined text-on-surface-variant text-sm">close</span>
              </button>
            </div>

            {/* Agent Options Grid */}
            <div className="p-6 grid grid-cols-3 gap-3">
              {DOC_TYPES.map(doc => (
                <button
                  key={doc.id}
                  onClick={() => handleCreate(doc.id)}
                  disabled={creating}
                  className="bg-surface-container-high p-5 rounded-lg flex flex-col gap-3 hover:bg-surface-variant transition-all text-left disabled:opacity-50 cursor-pointer group border border-transparent hover:border-primary/20"
                >
                  <span className={`material-symbols-outlined text-2xl ${doc.colorClass} group-hover:scale-110 transition-transform`}>
                    {doc.icon}
                  </span>
                  <span className="text-sm font-bold text-on-surface">{doc.label}</span>
                  <span className="text-sm text-on-surface-variant">{doc.desc}</span>
                </button>
              ))}
            </div>

            {/* Footer hint */}
            <div className="px-6 pb-5">
              <p className="text-sm text-on-surface-variant text-center">
                選擇工具後將建立新對話，或使用儀表板的智能指令讓 AI 自動判斷
              </p>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
