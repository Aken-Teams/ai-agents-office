'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AuthProvider, useAuth } from '../components/AuthProvider';

function LoginForm() {
  const { login } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await login(email, password);
      router.push('/dashboard');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="bg-surface-container-lowest text-on-surface font-body min-h-screen flex flex-col items-center justify-center p-6 overflow-hidden relative selection:bg-primary/30">
      {/* Background Decoration */}
      <div className="absolute inset-0 bg-pattern pointer-events-none opacity-40" />
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-5%] left-[-5%] w-[30%] h-[30%] bg-tertiary/5 rounded-full blur-[100px] pointer-events-none" />

      {/* Main Container */}
      <main className="w-full max-w-6xl flex flex-col md:flex-row gap-0 shadow-2xl z-10">
        {/* Left Side: Branding */}
        <section className="hidden md:flex flex-col justify-between p-12 w-1/2 bg-surface-container-low relative overflow-hidden">
          <div className="space-y-8">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 cyber-gradient flex items-center justify-center rounded">
                <span className="material-symbols-outlined text-on-primary">terminal</span>
              </div>
              <div>
                <h1 className="font-headline text-2xl font-bold tracking-tighter text-on-surface">
                  AI Agents Office
                </h1>
                <p className="font-label text-[10px] uppercase tracking-[0.2em] text-primary">
                  智能文件平台
                </p>
              </div>
            </div>

            <div className="space-y-6 mt-16">
              <h2 className="font-headline text-4xl font-light leading-tight">
                以 <span className="text-primary font-medium">AI 智能代理</span>
                <br />驅動企業級文件生成
              </h2>
              <p className="text-on-surface-variant font-body leading-relaxed max-w-md">
                自動化的文件生成工作流程 — 從簡報、報告到試算表，讓 AI 代理團隊為你協作完成高品質文件。
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center gap-4 p-4 bg-surface-container rounded-lg">
              <div className="w-2 h-2 rounded-full bg-primary animate-pulse" />
              <span className="font-label text-xs uppercase tracking-widest text-on-surface-variant">
                系統狀態：運行中
              </span>
            </div>
            <div className="flex gap-2">
              <div className="h-1 w-8 bg-primary" />
              <div className="h-1 w-4 bg-surface-variant" />
              <div className="h-1 w-4 bg-surface-variant" />
            </div>
          </div>

          {/* Technical Decor */}
          <div className="absolute bottom-12 right-12 opacity-10 pointer-events-none">
            <span className="material-symbols-outlined text-[120px]">smart_toy</span>
          </div>
        </section>

        {/* Right Side: Login Form */}
        <section className="flex-1 bg-surface-container-high p-8 md:p-16 flex flex-col justify-center">
          <div className="max-w-md mx-auto w-full">
            {/* Mobile Logo */}
            <div className="md:hidden flex items-center gap-3 mb-10">
              <div className="w-8 h-8 cyber-gradient flex items-center justify-center rounded">
                <span className="material-symbols-outlined text-on-primary text-sm">terminal</span>
              </div>
              <span className="font-headline text-xl font-bold tracking-tighter">AI Agents Office</span>
            </div>

            <div className="mb-10">
              <h3 className="font-headline text-2xl font-bold mb-2">登入系統</h3>
              <p className="text-on-surface-variant text-sm">連線至 AI 智能文件生成平台</p>
            </div>

            {/* Form */}
            <form onSubmit={handleSubmit} className="space-y-6">
              {error && (
                <div className="bg-error-container/30 border border-error/20 text-on-error-container px-4 py-3 rounded text-sm">
                  {error}
                </div>
              )}

              <div className="space-y-1.5">
                <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant ml-1">
                  電子信箱
                </label>
                <input
                  className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-sm font-body rounded placeholder:text-outline"
                  type="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="your@email.com"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="font-label text-[10px] uppercase tracking-widest text-on-surface-variant ml-1">
                  密碼
                </label>
                <input
                  className="w-full bg-surface-container-highest border-none focus:ring-1 focus:ring-primary/40 text-on-surface py-3 px-4 text-sm font-body rounded placeholder:text-outline"
                  type="password"
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  placeholder="••••••••••••"
                  required
                />
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full cyber-gradient text-on-primary font-headline font-bold uppercase tracking-widest text-xs py-4 rounded-sm shadow-lg shadow-primary/10 hover:brightness-110 active:scale-[0.98] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? '連線中...' : '建立連線'}
              </button>
            </form>

            {/* Toggle to Register */}
            <div className="mt-12 flex flex-col items-center gap-6">
              <div className="w-full h-px bg-outline-variant/20 relative">
                <span className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-surface-container-high px-4 text-[10px] uppercase tracking-widest text-outline">
                  還沒有帳號？
                </span>
              </div>
              <Link
                href="/register"
                className="text-xs font-label text-on-surface-variant hover:text-primary transition-colors flex items-center gap-2 group"
              >
                建立新帳號
                <span className="material-symbols-outlined text-sm group-hover:translate-x-1 transition-transform">
                  arrow_forward
                </span>
              </Link>
            </div>
          </div>
        </section>
      </main>

      {/* Footer Stats */}
      <footer className="mt-8 hidden md:flex gap-8 z-10">
        <div className="flex flex-col gap-1">
          <span className="text-[9px] uppercase tracking-widest text-outline">支援格式</span>
          <span className="font-headline font-bold text-tertiary">PPTX / DOCX / XLSX / PDF</span>
        </div>
        <div className="flex flex-col gap-1 border-l border-outline-variant/20 pl-8">
          <span className="text-[9px] uppercase tracking-widest text-outline">AI 引擎</span>
          <span className="font-headline font-bold text-on-surface">Claude Sonnet 4</span>
        </div>
        <div className="flex flex-col gap-1 border-l border-outline-variant/20 pl-8">
          <span className="text-[9px] uppercase tracking-widest text-outline">多代理協作</span>
          <span className="font-headline font-bold text-on-surface">Router + Workers</span>
        </div>
      </footer>
    </div>
  );
}

export default function LoginPage() {
  return (
    <AuthProvider>
      <LoginForm />
    </AuthProvider>
  );
}
