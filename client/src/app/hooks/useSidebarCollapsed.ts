import { useState, useEffect } from 'react';

const SIDEBAR_KEY = 'sidebar-collapsed';

export function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window !== 'undefined') return localStorage.getItem(SIDEBAR_KEY) === '1';
    return false;
  });

  useEffect(() => {
    function onToggle(e: Event) {
      setCollapsed((e as CustomEvent).detail as boolean);
    }
    window.addEventListener('sidebar-toggle', onToggle);
    return () => window.removeEventListener('sidebar-toggle', onToggle);
  }, []);

  return collapsed;
}

/** Tailwind class for main content margin (hidden on mobile, top bar offset) */
export function useSidebarMargin() {
  const collapsed = useSidebarCollapsed();
  return collapsed ? 'ml-0 md:ml-[68px] pt-14 md:pt-0' : 'ml-0 md:ml-64 pt-14 md:pt-0';
}
