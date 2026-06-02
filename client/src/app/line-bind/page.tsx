'use client';

import { AuthProvider, useAuth } from '../components/AuthProvider';
import { I18nProvider } from '../../i18n';
import Navbar from '../components/Navbar';
import { useSidebarMargin } from '../hooks/useSidebarCollapsed';
import { LineQrPanel } from '../components/LineQrPanel';

function LineBindContent() {
  const sidebarMargin = useSidebarMargin();
  return (
    <>
      <Navbar />
      <main className={`${sidebarMargin} pt-16 md:pt-10 pb-12 px-4 md:px-10 transition-all duration-300`}>
        <div className="max-w-md mx-auto">
          <div className="bg-surface-container rounded-2xl border border-outline-variant/20 p-8 md:p-10">
            <LineQrPanel title="綁定 LINE" caption="連結你的帳號" />
          </div>
          <p className="text-center text-xs text-on-surface-variant mt-4">
            綁定後即可在 LINE 直接使用 AI 助理，與網頁共用同一份額度與記憶。
          </p>
        </div>
      </main>
    </>
  );
}

export default function LineBindPage() {
  return (
    <AuthProvider>
      <LineBindWithI18n />
    </AuthProvider>
  );
}

function LineBindWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <LineBindContent />
    </I18nProvider>
  );
}
