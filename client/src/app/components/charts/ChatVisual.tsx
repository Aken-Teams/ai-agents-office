'use client';

import { useMemo, useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from '../../../i18n/index';

function isIncompleteHtml(s: string): boolean {
  const t = s.trim();
  if (!t) return true;
  const lower = t.toLowerCase();
  // If it starts with <!doctype or <html but doesn't have closing tags yet
  if ((lower.startsWith('<!doctype') || lower.startsWith('<html')) && !lower.includes('</html>') && !lower.includes('</script>')) {
    return true;
  }
  return false;
}

interface ChatVisualProps {
  rawHtml: string;
}

export default function ChatVisual({ rawHtml }: ChatVisualProps) {
  const { t } = useTranslation();
  const [fullscreen, setFullscreen] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [iframeHeight, setIframeHeight] = useState(400);
  const [themeKey, setThemeKey] = useState(0);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Theme change detection
  useEffect(() => {
    const observer = new MutationObserver(() => setThemeKey(k => k + 1));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  const isStreaming = useMemo(() => isIncompleteHtml(rawHtml), [rawHtml]);

  // Inject height reporter + dark mode hint
  const enhancedHtml = useMemo(() => {
    if (isStreaming) return '';
    void themeKey; // re-compute on theme change

    const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

    const heightScript = `<script>
function _reportHeight(){
  var h=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,300);
  window.parent.postMessage({type:'visual-height',height:Math.min(h,800)},'*');
}
window.addEventListener('load',function(){setTimeout(_reportHeight,200)});
if(typeof ResizeObserver!=='undefined')new ResizeObserver(_reportHeight).observe(document.body);
<\/script>`;

    let html = rawHtml;

    // Inject dark mode hint
    if (isDark) {
      html = html.replace(/<html/i, '<html data-theme="dark" class="dark"');
    }

    // Inject height script before </body> or at end
    if (html.toLowerCase().includes('</body>')) {
      html = html.replace(/<\/body>/i, heightScript + '</body>');
    } else {
      html += heightScript;
    }

    return html;
  }, [rawHtml, isStreaming, themeKey]);

  // Listen for height messages from iframe
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      if (e.data?.type === 'visual-height') {
        setIframeHeight(Math.max(300, Math.min(e.data.height, 800)));
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  // HTML download
  const handleDownloadHtml = useCallback(() => {
    const blob = new Blob([rawHtml], { type: 'text/html' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'visualization.html';
    a.click();
    URL.revokeObjectURL(url);
  }, [rawHtml]);

  // Streaming state
  if (isStreaming) {
    return (
      <div className="chat-chart-container">
        <div className="chat-visual-body" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200 }}>
          <span className="text-sm opacity-50 animate-pulse">{t('chart.status.rendering' as any)}</span>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="chat-chart-container">
        <div className="chat-visual-body">
          <iframe
            ref={iframeRef}
            srcDoc={enhancedHtml}
            sandbox="allow-scripts"
            className="chat-visual-iframe"
            title="Interactive Visualization"
            style={{ height: iframeHeight }}
          />
        </div>
        {/* Toolbar */}
        <div className="flex items-center flex-wrap gap-1 px-2 md:px-3 py-1.5 border-t border-[var(--chart-border)]">
          <button className="chat-chart-toggle flex items-center gap-1" onClick={() => setFullscreen(true)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>fullscreen</span>
            <span>{t('chart.action.expand' as any)}</span>
          </button>
          <button className="chat-chart-toggle flex items-center gap-1" onClick={handleDownloadHtml}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>code</span>
            <span>{t('chart.action.downloadHtml' as any)}</span>
          </button>
          <button className="chat-chart-toggle flex items-center gap-1" onClick={() => setShowSource(!showSource)}>
            <span className="material-symbols-outlined" style={{ fontSize: 14 }}>{showSource ? 'visibility_off' : 'code_blocks'}</span>
            <span>{showSource ? t('chart.action.hide' as any) : t('chart.action.data' as any)}</span>
          </button>
        </div>
        {showSource && (
          <pre className="chat-chart-raw"><code>{rawHtml}</code></pre>
        )}
      </div>

      {/* Fullscreen modal */}
      {fullscreen && (
        <div
          className="fixed inset-0 z-[100] bg-black/80 backdrop-blur-sm flex items-center justify-center"
          onClick={() => setFullscreen(false)}
        >
          <div
            className="bg-surface rounded-xl shadow-2xl w-[95vw] md:w-[90vw] h-[90vh] overflow-hidden p-3 md:p-4 relative flex flex-col"
            onClick={e => e.stopPropagation()}
          >
            <button
              onClick={() => setFullscreen(false)}
              className="absolute top-3 right-3 w-8 h-8 flex items-center justify-center rounded-lg bg-surface-container-high hover:bg-surface-container-highest text-on-surface-variant cursor-pointer transition-colors z-10"
            >
              <span className="material-symbols-outlined text-sm">close</span>
            </button>
            <iframe
              srcDoc={enhancedHtml}
              sandbox="allow-scripts"
              className="flex-1 w-full border-none rounded-lg"
              title="Interactive Visualization (Fullscreen)"
            />
            <div className="flex items-center flex-wrap gap-2 pt-3 border-t border-outline-variant/20">
              <button onClick={handleDownloadHtml} className="px-3 py-1.5 text-xs font-bold bg-primary/10 text-primary rounded-lg hover:bg-primary/20 transition-colors cursor-pointer flex items-center gap-1">
                <span className="material-symbols-outlined" style={{ fontSize: 14 }}>code</span> {t('chart.action.downloadHtml' as any)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
