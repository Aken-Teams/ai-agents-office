'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dynamic from 'next/dynamic';
import { AuthProvider, useAuth } from '../../components/AuthProvider';
import Navbar from '../../components/Navbar';
import UploadAlertModal, { type UploadAlertItem } from '../../components/UploadAlertModal';
import { I18nProvider, useTranslation } from '../../../i18n';
import { useSidebarMargin } from '../../hooks/useSidebarCollapsed';

const ChatChart = dynamic(() => import('../../components/charts/ChatChart'), { ssr: false });
const ChatMermaid = dynamic(() => import('../../components/charts/ChatMermaid'), { ssr: false });
const ChatMindmap = dynamic(() => import('../../components/charts/ChatMindmap'), { ssr: false });

// Direct connection to Express for SSE streaming.
// Next.js rewrites proxy buffers the entire response, preventing real-time updates.
const SSE_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:12054';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

interface GeneratedFile {
  id: string;
  filename: string;
  file_path: string;
  file_type: string;
  file_size: number;
  version?: number;
  created_at?: string;
}

interface AttachedFile {
  id: string;
  originalName: string;
  fileType: string;
  fileSize: number;
  scanStatus: string;
  scanDetail?: string;
  uploading?: boolean;
}

interface ToolActivity {
  tool: string;
  id?: string;
  status?: string;
  input?: string;
}

interface AgentTask {
  taskId: string;
  skillId: string;
  description: string;
  status: 'dispatched' | 'running' | 'completed' | 'failed';
  error?: string;
}

const SKILL_LABELS: Record<string, string> = {
  'pptx-gen': 'PowerPoint',
  'docx-gen': 'Word',
  'xlsx-gen': 'Excel',
  'pdf-gen': 'PDF',
  'slides-gen': 'Slides',
  'research': 'Research',
  'data-analyst': 'Data Analyst',
  'rag-analyst': 'RAG Analyst',
  'planner': 'Planner',
  'reviewer': 'Reviewer',
  'router': 'Router',
};

const SKILL_ICONS: Record<string, string> = {
  'pptx-gen': 'present_to_all',
  'docx-gen': 'description',
  'xlsx-gen': 'table_chart',
  'pdf-gen': 'picture_as_pdf',
  'slides-gen': 'slideshow',
  'data-analyst': 'analytics',
  'rag-analyst': 'search_insights',
};

/** Parse tool_use input JSON into a friendly, human-readable one-liner */
function parseToolInput(tool: string, rawInput: string | undefined, t: (key: any, params?: Record<string, string | number>) => string): string {
  if (!rawInput) return '';
  // Strip agent prefix (e.g. "pptx-gen:Bash" → "Bash")
  const baseTool = tool.includes(':') ? tool.split(':').pop()! : tool;

  // Try JSON.parse first; if truncated JSON fails, try regex extraction
  let input: Record<string, string> | null = null;
  try {
    input = JSON.parse(rawInput);
  } catch {
    // Truncated JSON — extract fields via regex
    input = {};
    const cmdMatch = rawInput.match(/"command"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
    if (cmdMatch) input.command = cmdMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const queryMatch = rawInput.match(/"query"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
    if (queryMatch) input.query = queryMatch[1];
    const urlMatch = rawInput.match(/"url"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
    if (urlMatch) input.url = urlMatch[1];
    const fpMatch = rawInput.match(/"file_path"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
    if (fpMatch) input.file_path = fpMatch[1].replace(/\\\\/g, '\\');
    const patMatch = rawInput.match(/"pattern"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
    if (patMatch) input.pattern = patMatch[1];
  }

  if (!input || Object.keys(input).length === 0) {
    return rawInput.length > 80 ? rawInput.substring(0, 80) + '…' : rawInput;
  }

  if (baseTool === 'Write') {
    const fp = input.file_path || input.path || '';
    const name = fp.replace(/\\/g, '/').split('/').pop() || fp;
    return name ? `${t('chat.toolInfo.writeFile')} ${name}` : t('chat.toolInfo.writeFile');
  }
  if (baseTool === 'Read') {
    const fp = input.file_path || input.path || '';
    const name = fp.replace(/\\/g, '/').split('/').pop() || fp;
    return name ? `${t('chat.toolInfo.readFile')} ${name}` : t('chat.toolInfo.readFile');
  }
  if (baseTool === 'WebSearch') {
    const q = input.query || '';
    return q ? (q.length > 80 ? q.substring(0, 80) + '…' : q) : t('chat.toolInfo.webSearch');
  }
  if (baseTool === 'WebFetch') {
    const url = input.url || '';
    try { return `${t('chat.toolInfo.fetchWeb')} ${new URL(url).hostname}`; } catch { return url ? `${t('chat.toolInfo.fetchWeb')} ${url.substring(0, 60)}` : t('chat.toolInfo.fetchWeb'); }
  }
  if (baseTool === 'Bash') {
    const cmd = input.command || '';
    if (!cmd) return t('chat.toolInfo.executeCommand');
    // Generator scripts
    if (cmd.includes('generate-pptx')) return t('chat.tool.generatePptx');
    if (cmd.includes('generate-docx')) return t('chat.tool.generateDocx');
    if (cmd.includes('generate-xlsx')) return t('chat.tool.generateXlsx');
    if (cmd.includes('generate-pdf')) return t('chat.tool.generatePdf');
    // Node/script execution
    if (cmd.includes('node ')) {
      const match = cmd.match(/([^\\/\s]+\.(?:mjs|js|ts))/);
      if (match) return `${t('chat.tool.runNode')} ${match[1]}`;
      return t('chat.tool.runNode');
    }
    // File operations
    if (cmd.includes('cat ') || cmd.includes('head ') || cmd.includes('tail ')) return t('chat.tool.readFile');
    if (cmd.includes('ls ') || cmd.includes('dir ')) return t('chat.tool.listDir');
    if (cmd.includes('mkdir ')) return t('chat.tool.createDir');
    if (cmd.includes('cp ') || cmd.includes('copy ')) return t('chat.tool.copyFile');
    if (cmd.includes('mv ') || cmd.includes('move ')) return t('chat.tool.moveFile');
    if (cmd.includes('pip ') || cmd.includes('npm ') || cmd.includes('npx ')) return t('chat.tool.installPackage');
    if (cmd.includes('python')) return t('chat.tool.runPython');
    // cd + subsequent command
    if (cmd.startsWith('cd ')) {
      // Extract the command after cd: "cd /path && actual_command"
      const afterCd = cmd.replace(/^cd\s+"?[^"&]+"?\s*&&\s*/, '').replace(/^cd\s+\S+\s*&&\s*/, '');
      if (afterCd !== cmd && afterCd.length > 0) {
        // Re-parse the command after cd
        if (afterCd.includes('generate-pptx')) return t('chat.tool.generatePptx');
        if (afterCd.includes('generate-docx')) return t('chat.tool.generateDocx');
        if (afterCd.includes('generate-xlsx')) return t('chat.tool.generateXlsx');
        if (afterCd.includes('generate-pdf')) return t('chat.tool.generatePdf');
        if (afterCd.includes('node ')) return t('chat.tool.runNode');
        if (afterCd.includes('python')) return t('chat.tool.runPython');
        if (afterCd.includes('cat ') || afterCd.includes('head ')) return t('chat.tool.readFile');
        const shortAfter = afterCd.length > 60 ? afterCd.substring(0, 60) + '…' : afterCd;
        return shortAfter;
      }
      return t('chat.tool.changeDir');
    }
    // Fallback: show simplified command
    const short = cmd.length > 80 ? cmd.substring(0, 80) + '…' : cmd;
    return short;
  }
  if (baseTool === 'Edit') {
    const fp = input.file_path || '';
    const name = fp.replace(/\\/g, '/').split('/').pop() || fp;
    return name ? `${t('chat.tool.editFile')} ${name}` : t('chat.tool.editFile');
  }
  if (baseTool === 'Glob') return `${t('chat.toolInfo.searchFiles')} ${input.pattern || ''}`.trim();
  if (baseTool === 'Grep') return `${t('chat.toolInfo.searchCode')} "${input.pattern || ''}"`;
  if (baseTool === 'Task') {
    // Show human-readable task description from Task tool input
    try {
      const parsed = JSON.parse(rawInput);
      const desc = parsed?.description || parsed?.prompt || '';
      if (desc) return desc.length > 80 ? desc.substring(0, 80) + '…' : desc;
    } catch {
      // Try regex extraction for truncated JSON
      const descMatch = rawInput.match(/"(?:description|prompt)"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
      if (descMatch) {
        const desc = descMatch[1].replace(/\\"/g, '"');
        return desc.length > 80 ? desc.substring(0, 80) + '…' : desc;
      }
    }
    return t('chat.toolInfo.executeCommand');
  }
  if (baseTool === 'TodoWrite') {
    // Parse the todos array and show human-readable task descriptions
    try {
      const parsed = JSON.parse(rawInput);
      const todos: Array<{ content?: string; status?: string; activeForm?: string }> = parsed?.todos || [];
      if (todos.length === 0) return t('chat.toolInfo.updateTask');
      const inProgress = todos.find(td => td.status === 'in_progress');
      if (inProgress) {
        const label = inProgress.activeForm || inProgress.content || '';
        return label.length > 80 ? label.substring(0, 80) + '…' : label;
      }
      // No in_progress: show count summary
      const completed = todos.filter(td => td.status === 'completed').length;
      const pending = todos.filter(td => td.status === 'pending').length;
      return `${completed}/${todos.length} ${t('chat.toolInfo.tasksCompleted')}${pending > 0 ? ` · ${pending} ${t('chat.toolInfo.tasksPending')}` : ''}`;
    } catch {
      return t('chat.toolInfo.updateTask');
    }
  }
  if (baseTool === 'Skill') {
    // Show which skill is being invoked
    const skillName = input.skill || '';
    if (skillName) return `${t('chat.toolInfo.invokeSkill')} ${skillName}`;
    return t('chat.toolInfo.invokeSkill');
  }
  if (baseTool === 'AskUserQuestion') {
    // Show the question being asked
    try {
      const parsed = JSON.parse(rawInput);
      const questions = parsed?.questions;
      if (Array.isArray(questions) && questions.length > 0) {
        const q = questions[0].question || '';
        return q.length > 80 ? q.substring(0, 80) + '…' : q;
      }
    } catch {
      const qMatch = rawInput.match(/"question"\s*:\s*"((?:[^"\\]|\\.)*)(?:"|$)/);
      if (qMatch) {
        const q = qMatch[1].replace(/\\"/g, '"');
        return q.length > 80 ? q.substring(0, 80) + '…' : q;
      }
    }
    return t('chat.toolInfo.askQuestion');
  }
  if (baseTool === 'EnterPlanMode' || baseTool === 'ExitPlanMode') {
    return t('chat.toolInfo.planMode');
  }
  // Fallback
  return rawInput.length > 80 ? rawInput.substring(0, 80) + '…' : rawInput;
}

/** Get tool icon (material symbol name) and label */
function getToolInfo(tool: string, t: (key: any, params?: Record<string, string | number>) => string): { icon: string; label: string } {
  if (tool.includes(':')) {
    const [agentId, baseTool] = tool.split(':');
    const agentLabel = SKILL_LABELS[agentId] || agentId;
    const baseInfo = getToolInfo(baseTool, t);
    return { icon: baseInfo.icon, label: `${agentLabel}: ${baseInfo.label}` };
  }
  if (tool === 'Router') return { icon: 'psychology', label: t('chat.toolInfo.routerAnalyzing') };
  if (tool.startsWith('Bash')) return { icon: 'terminal', label: t('chat.toolInfo.executeCommand') };
  if (tool === 'Write') return { icon: 'edit_document', label: t('chat.toolInfo.writeFile') };
  if (tool === 'Read') return { icon: 'description', label: t('chat.toolInfo.readFile') };
  if (tool === 'Edit') return { icon: 'edit', label: t('chat.toolInfo.editFile') };
  if (tool === 'Glob') return { icon: 'folder_open', label: t('chat.toolInfo.searchFiles') };
  if (tool === 'Grep') return { icon: 'search', label: t('chat.toolInfo.searchCode') };
  if (tool === 'WebSearch') return { icon: 'travel_explore', label: t('chat.toolInfo.webSearch') };
  if (tool === 'WebFetch') return { icon: 'language', label: t('chat.toolInfo.fetchWeb') };
  if (tool === 'Task') return { icon: 'account_tree', label: t('chat.toolInfo.delegateTask') };
  if (tool === 'TodoWrite') return { icon: 'checklist', label: t('chat.toolInfo.updateTask') };
  if (tool === 'Skill') return { icon: 'extension', label: t('chat.toolInfo.invokeSkill') };
  if (tool === 'AskUserQuestion') return { icon: 'help', label: t('chat.toolInfo.askQuestion') };
  if (tool === 'EnterPlanMode' || tool === 'ExitPlanMode') return { icon: 'architecture', label: t('chat.toolInfo.planMode') };
  if (tool === 'tool_result') return { icon: 'check_circle', label: t('chat.toolInfo.toolComplete') };
  return { icon: 'settings', label: tool };
}

function getFileIcon(type: string): string {
  const icons: Record<string, string> = {
    docx: 'description', doc: 'description',
    xlsx: 'table_chart', xls: 'table_chart', csv: 'table_chart',
    pptx: 'present_to_all', ppt: 'present_to_all',
    pdf: 'picture_as_pdf',
    html: 'slideshow', htm: 'slideshow',
    png: 'image', jpg: 'image', jpeg: 'image', gif: 'image',
    webp: 'image', bmp: 'image', svg: 'image', tiff: 'image', tif: 'image', ico: 'image',
    json: 'data_object', xml: 'code', yaml: 'code', yml: 'code',
    txt: 'text_snippet', md: 'text_snippet',
  };
  return icons[type] || 'attach_file';
}

function getFileColor(type: string): string {
  const colors: Record<string, string> = {
    docx: 'text-tertiary', doc: 'text-tertiary',
    xlsx: 'text-success', xls: 'text-success', csv: 'text-success',
    pptx: 'text-warning', ppt: 'text-warning',
    pdf: 'text-error',
    html: 'text-secondary', htm: 'text-secondary',
    png: 'text-purple-400', jpg: 'text-purple-400', jpeg: 'text-purple-400',
    gif: 'text-purple-400', webp: 'text-purple-400', bmp: 'text-purple-400',
    svg: 'text-purple-400', tiff: 'text-purple-400', tif: 'text-purple-400', ico: 'text-purple-400',
    json: 'text-amber-400', xml: 'text-amber-400', yaml: 'text-amber-400', yml: 'text-amber-400',
    txt: 'text-on-surface-variant', md: 'text-on-surface-variant',
  };
  return colors[type] || 'text-primary';
}

function InlineHtmlPreview({ file, token, onFullscreen }: { file: GeneratedFile; token: string; onFullscreen: () => void }) {
  const { t } = useTranslation();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    fetch(`/api/files/${file.id}/download`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.text() : Promise.reject('fetch failed'))
      .then(html => {
        url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
        setBlobUrl(url);
      })
      .catch(console.error);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file.id, token]);

  if (!blobUrl) return (
    <div className="h-[360px] flex items-center justify-center text-on-surface-variant text-sm">
      <span className="material-symbols-outlined animate-spin mr-2">progress_activity</span>
      {t('chart.preview.loading' as any)}
    </div>
  );

  return (
    <div className="relative group rounded-t-xl overflow-hidden">
      <iframe
        src={blobUrl}
        sandbox="allow-scripts allow-same-origin"
        scrolling="no"
        className="w-full h-[360px] border-b border-outline-variant/10 overflow-hidden"
        style={{ overflow: 'hidden' }}
        title={file.filename}
      />
      <button
        onClick={onFullscreen}
        className="absolute top-3 right-3 p-2 rounded-lg bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-black/70"
        title={t('chat.preview.fullscreen' as any)}
      >
        <span className="material-symbols-outlined text-lg">fullscreen</span>
      </button>
    </div>
  );
}

/** Inline preview for office/PDF files — shows first page via /preview endpoint */
const PREVIEWABLE_TYPES = new Set(['pdf', 'pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls']);

function InlineFilePreview({ file, token }: { file: GeneratedFile; token: string }) {
  const { t } = useTranslation();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [contentType, setContentType] = useState<string>('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    fetch(`/api/files/${file.id}/preview`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => {
        if (!r.ok) throw new Error('preview failed');
        const ct = r.headers.get('Content-Type') || '';
        setContentType(ct);
        return r.blob().then(blob => ({ blob, ct }));
      })
      .then(({ blob, ct }) => {
        const type = ct.includes('pdf') ? 'application/pdf' : ct.includes('html') ? 'text/html' : ct;
        url = URL.createObjectURL(new Blob([blob], { type }));
        setBlobUrl(url);
      })
      .catch(() => setFailed(true));
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file.id, token]);

  if (failed) return null; // Silently skip — file card still shows below
  if (!blobUrl) return (
    <div className="h-[360px] flex items-center justify-center text-on-surface-variant text-sm rounded-t-xl bg-surface-container-lowest">
      <span className="material-symbols-outlined animate-spin mr-2 text-base">progress_activity</span>
      {t('chart.preview.loading' as any)}
    </div>
  );

  const isPdf = contentType.includes('pdf');
  return (
    <div className="relative rounded-t-xl overflow-hidden bg-surface-container-lowest">
      <iframe
        src={isPdf ? `${blobUrl}#toolbar=0&navpanes=0&scrollbar=0` : blobUrl}
        className="w-full h-[360px] border-b border-outline-variant/10"
        scrolling="no"
        title={file.filename}
        sandbox={isPdf ? undefined : 'allow-same-origin'}
        style={{ overflow: 'hidden', pointerEvents: 'none' }}
      />
    </div>
  );
}

function ChatContent() {
  const { user, token, isLoading } = useAuth();
  const { t, locale } = useTranslation();
  const router = useRouter();
  const params = useParams();
  const conversationId = params.id as string;
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [title, setTitle] = useState('');
  const [skillId, setSkillId] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [lastUsage, setLastUsage] = useState<{ inputTokens: number; outputTokens: number; model: string } | null>(null);
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const [uploadAlerts, setUploadAlerts] = useState<UploadAlertItem[]>([]);
  const [pendingTemplate, setPendingTemplate] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<GeneratedFile | null>(null);
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const [totalUsage, setTotalUsage] = useState<{ inputTokens: number; outputTokens: number } | null>(null);
  const [versionDropdown, setVersionDropdown] = useState<string | null>(null); // file ID whose dropdown is open
  const [versionCache, setVersionCache] = useState<Record<string, GeneratedFile[]>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sidebarMargin = useSidebarMargin();
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Custom ReactMarkdown components — intercept ```chart and ```mermaid blocks
  const markdownComponents = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pre({ children, node, ...props }: any) {
      // Check if this <pre> contains a chart or mermaid code block — unwrap to avoid <pre> wrapper
      const codeEl = node?.children?.[0];
      const cls = codeEl?.properties?.className?.[0] || '';
      if (cls === 'language-chart' || cls === 'language-mermaid' || cls === 'language-mindmap') {
        return <>{children}</>;
      }
      return <pre {...props}>{children}</pre>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    code({ className, children, ...props }: any) {
      const text = String(children).trim();
      if (className === 'language-chart') {
        return <ChatChart rawJson={text} />;
      }
      if (className === 'language-mermaid') {
        return <ChatMermaid code={text} />;
      }
      if (className === 'language-mindmap') {
        return <ChatMindmap code={text} />;
      }
      return <code className={className} {...props}>{children}</code>;
    },
  };

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  const [conversationLoaded, setConversationLoaded] = useState(false);

  // Load conversation
  useEffect(() => {
    if (!token || !conversationId) return;
    fetch(`/api/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : Promise.reject('Not found'))
      .then(data => {
        setTitle(data.title);
        setSkillId(data.skill_id || '');
        setMessages(data.messages || []);
        setConversationLoaded(true);
      })
      .catch(() => router.replace('/dashboard'));
  }, [token, conversationId, router]);

  const pendingHandled = useRef(false);

  // Load files
  useEffect(() => {
    if (!token || !conversationId) return;
    fetch(`/api/files?conversationId=${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(setFiles)
      .catch(console.error);
  }, [token, conversationId]);

  // Load persisted token usage
  const fetchUsage = useCallback(() => {
    if (!token || !conversationId) return;
    fetch(`/api/conversations/${conversationId}/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => { if (data) setTotalUsage(data); })
      .catch(console.error);
  }, [token, conversationId]);

  useEffect(() => { fetchUsage(); }, [fetchUsage]);

  // Refresh usage when streaming completes
  useEffect(() => {
    if (!streaming && lastUsage) fetchUsage();
  }, [streaming, lastUsage, fetchUsage]);

  // Load conversation's uploaded files for the right sidebar display
  const [conversationUploads, setConversationUploads] = useState<AttachedFile[]>([]);
  const reloadConversationUploads = useCallback(() => {
    if (!token || !conversationId) return;
    fetch(`/api/uploads?conversationId=${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.ok ? r.json() : [])
      .then((uploads: Array<{ id: string; original_name: string; file_type: string; file_size: number; scan_status: string }>) => {
        setConversationUploads(uploads.map(u => ({
          id: u.id,
          originalName: u.original_name,
          fileType: u.file_type,
          fileSize: u.file_size,
          scanStatus: u.scan_status,
          uploading: false,
        })));
      })
      .catch(console.error);
  }, [token, conversationId]);
  useEffect(() => { reloadConversationUploads(); }, [reloadConversationUploads]);

  // Close version dropdown on outside click
  useEffect(() => {
    if (!versionDropdown) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('[data-version-dropdown]')) {
        setVersionDropdown(null);
      }
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [versionDropdown]);

  // Auto-scroll
  useEffect(() => {
    setTimeout(() => {
      const el = messagesEndRef.current?.parentElement;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, 50);
  }, [messages, streamText, thinkingText, tools, streaming]);

  // Elapsed time timer + auto-collapse panel when done
  useEffect(() => {
    if (streaming) {
      setElapsed(0);
      setPanelCollapsed(false);
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
      if (tools.length > 0) {
        setPanelCollapsed(true);
      }
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  const sendMessage = useCallback(async (directMessage?: string, extraUploadIds?: string[]) => {
    const messageToSend = directMessage || input.trim();
    if (!messageToSend || streaming || !token) return;

    // Inject template instruction if a template was selected
    const userMessage = pendingTemplate
      ? `[${t('templates.instruction' as any)}：${pendingTemplate}]\n\n${messageToSend}`
      : messageToSend;
    if (pendingTemplate) setPendingTemplate(null);
    // Capture attached file names for display in the message
    const currentAttached = attachedFiles.filter(f => !f.uploading && f.scanStatus !== 'rejected');
    const currentUploadIds = extraUploadIds && extraUploadIds.length > 0
      ? extraUploadIds
      : currentAttached.map(f => f.id);
    const attachmentNote = currentAttached.length > 0
      ? `\n\n📎 ${currentAttached.map(f => f.originalName).join(', ')}`
      : '';
    if (!directMessage) setInput('');
    setMessages(prev => [...prev, {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: userMessage + attachmentNote,
      created_at: new Date().toISOString(),
    }]);

    setStreaming(true);
    setStreamText('');
    setThinkingText('');
    setTools([]);
    setLastUsage(null);
    setPanelCollapsed(false);
    setAgentTasks([]);
    setAttachedFiles([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`${SSE_BASE}/api/generate/${conversationId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: userMessage,
          ...(skillId && { skillId }),
          ...(currentUploadIds.length > 0 && { uploadIds: currentUploadIds }),
        }),
        signal: controller.signal,
      });

      // Handle non-SSE error responses (e.g. storage quota exceeded)
      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: t('chat.error.unknown') }));
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}`,
          conversation_id: conversationId,
          role: 'assistant',
          content: `⚠️ ${err.error || t('chat.error.unknown')}`,
          created_at: new Date().toISOString(),
        }]);
        setStreaming(false);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullText = '';
      let fullThinking = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.substring(6));

            if (event.type === 'text') {
              fullText += event.data;
              setStreamText(fullText);
            }
            if (event.type === 'thinking') {
              fullThinking += event.data;
              setThinkingText(fullThinking);
            }
            if (event.type === 'tool_activity') {
              const activity = event.data as ToolActivity;
              setTools(prev => {
                if (activity.tool === '_mark_completed') {
                  return prev.map(t => t.status !== 'completed' ? { ...t, status: 'completed' } : t);
                }
                if (activity.tool === 'tool_result' && !activity.id) return prev;
                const existing = prev.findIndex(t => t.id === activity.id);
                if (existing >= 0) {
                  const updated = [...prev];
                  updated[existing] = { ...updated[existing], ...activity };
                  return updated;
                }
                return [...prev, activity];
              });
            }
            if (event.type === 'usage') {
              const usage = event.data as { inputTokens: number; outputTokens: number; model: string };
              if (usage.inputTokens > 0 || usage.outputTokens > 0) {
                setLastUsage(usage);
              }
            }
            if (event.type === 'file_generated') {
              const newFiles = event.data as GeneratedFile[];
              // Deduplicate: replace older versions of same file_path, keep latest
              setFiles(prev => {
                const updated = [...prev];
                for (const nf of newFiles) {
                  const existingIdx = updated.findIndex(f => f.file_path === nf.file_path);
                  if (existingIdx >= 0) {
                    // Replace old version with new version
                    updated[existingIdx] = nf;
                  } else {
                    updated.push(nf);
                  }
                }
                return updated;
              });
            }
            if (event.type === 'task_dispatched') {
              const task = event.data as { taskId: string; skillId: string; description: string };
              setAgentTasks(prev => [...prev, {
                taskId: task.taskId,
                skillId: task.skillId,
                description: task.description,
                status: 'dispatched',
              }]);
            }
            if (event.type === 'task_completed') {
              const task = event.data as { taskId: string; skillId: string };
              setAgentTasks(prev => prev.map(t =>
                t.taskId === task.taskId ? { ...t, status: 'completed' as const } : t
              ));
            }
            if (event.type === 'task_failed') {
              const task = event.data as { taskId: string; skillId: string; error: string };
              setAgentTasks(prev => prev.map(t =>
                t.taskId === task.taskId ? { ...t, status: 'failed' as const, error: task.error } : t
              ));
            }
            if (event.type === 'agent_stream') {
              const agentData = event.data as { taskId: string; skillId: string; type: string; content: unknown };
              if (agentData.type === 'tool_activity') {
                const activity = agentData.content as ToolActivity;
                setTools(prev => {
                  if (activity.tool === '_mark_completed') {
                    return prev.map(t => t.status !== 'completed' ? { ...t, status: 'completed' } : t);
                  }
                  if (activity.tool === 'tool_result' && !activity.id) return prev;
                  const existing = prev.findIndex(t => t.id === activity.id);
                  if (existing >= 0) {
                    const updated = [...prev];
                    updated[existing] = { ...updated[existing], ...activity };
                    return updated;
                  }
                  return [...prev, { ...activity, tool: `${agentData.skillId}:${activity.tool}` }];
                });
              }
              if (agentData.type === 'text') {
                setAgentTasks(prev => prev.map(t =>
                  t.taskId === agentData.taskId && t.status === 'dispatched'
                    ? { ...t, status: 'running' as const }
                    : t
                ));
              }
            }
            if (event.type === 'agent_status') {
              const status = event.data as { agent: string; status: string };
              if (status.agent === 'router' && status.status === 'thinking') {
                setTools(prev => [...prev, {
                  tool: 'Router',
                  id: `router-${Date.now()}`,
                  status: 'running',
                }]);
              }
            }
            if (event.type === 'error') {
              const errMsg = typeof event.data === 'string' ? event.data : 'Unknown error';
              fullText += `\n\n> **Error:** ${errMsg}`;
              setStreamText(fullText);
            }
            if (event.type === 'done') {
              if (fullText) {
                setMessages(prev => [...prev, {
                  id: `assistant-${Date.now()}`,
                  role: 'assistant',
                  content: fullText,
                  created_at: new Date().toISOString(),
                }]);
              }
              setStreamText('');
              setThinkingText('');
            }
          } catch { /* skip parse errors */ }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        console.error('Stream error:', err);
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
      // Reload sidebar uploads — dashboard uploads now linked to this conversation
      reloadConversationUploads();
    }
  }, [input, streaming, token, conversationId, skillId, attachedFiles, pendingTemplate, t, reloadConversationUploads]);

  // Load pending template from sessionStorage (set by Navbar modal)
  useEffect(() => {
    if (!conversationLoaded) return;
    const tplKey = `pending_template_${conversationId}`;
    const tpl = sessionStorage.getItem(tplKey);
    if (tpl) {
      sessionStorage.removeItem(tplKey);
      setPendingTemplate(tpl);
    }
  }, [conversationLoaded, conversationId]);

  // Auto-send pending message from dashboard smart input
  useEffect(() => {
    if (!conversationLoaded || !token || pendingHandled.current || streaming) return;
    const key = `pending_message_${conversationId}`;
    const pending = sessionStorage.getItem(key);
    if (pending) {
      sessionStorage.removeItem(key);
      pendingHandled.current = true;

      // Restore uploaded files from dashboard smart input
      const uploadsKey = `pending_uploads_${conversationId}`;
      const pendingUploads = sessionStorage.getItem(uploadsKey);
      if (pendingUploads) {
        sessionStorage.removeItem(uploadsKey);
        try {
          const files = JSON.parse(pendingUploads) as Array<{ id: string; name: string }>;
          const uploadIds = files.map(f => f.id);
          sendMessage(pending, uploadIds);
          return;
        } catch { /* ignore parse errors */ }
      }
      sendMessage(pending);
    }
  }, [conversationLoaded, token, conversationId, streaming, sendMessage]);

  function handleAbort() {
    abortRef.current?.abort();
    fetch(`${SSE_BASE}/api/generate/${conversationId}/abort`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  async function handleFileAttach(fileList: FileList | null) {
    if (!fileList || fileList.length === 0 || !token) return;
    const filesArr = Array.from(fileList);

    // Add placeholder chips
    const placeholders: AttachedFile[] = filesArr.map(f => ({
      id: `tmp-${Date.now()}-${f.name}`,
      originalName: f.name,
      fileType: f.name.split('.').pop() || '',
      fileSize: f.size,
      scanStatus: 'pending',
      uploading: true,
    }));
    setAttachedFiles(prev => [...prev, ...placeholders]);

    try {
      const formData = new FormData();
      for (const f of filesArr) formData.append('files', f);
      formData.append('conversationId', conversationId);

      const resp = await fetch('/api/uploads', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });
      const data = await resp.json();

      if (!resp.ok) {
        setUploadAlerts([{
          fileName: '',
          status: data.code === 'UPLOAD_QUOTA_EXCEEDED' ? 'quota' : 'error',
          detail: data.error || t('chat.error.uploadFailed'),
        }]);
        setAttachedFiles(prev => prev.filter(f => !f.uploading));
        return;
      }

      // Replace placeholders with real results
      const uploaded: AttachedFile[] = (data.uploads || []).map((u: any) => ({
        id: u.id,
        originalName: u.originalName,
        fileType: u.fileType,
        fileSize: u.fileSize,
        scanStatus: u.scanStatus,
        scanDetail: u.scanDetail,
        uploading: false,
      }));

      // Remove placeholders, add real ones
      setAttachedFiles(prev => [
        ...prev.filter(f => !f.uploading),
        ...uploaded,
      ]);

      // Refresh sidebar upload list
      reloadConversationUploads();

      // Show modal for rejected/suspicious files with details
      const alertItems: UploadAlertItem[] = uploaded
        .filter(u => u.scanStatus === 'rejected' || u.scanStatus === 'suspicious')
        .map(u => ({
          fileName: u.originalName,
          status: u.scanStatus as 'rejected' | 'suspicious',
          detail: u.scanDetail || '',
        }));
      if (alertItems.length > 0) {
        setUploadAlerts(alertItems);
      }
    } catch (err) {
      console.error('Upload error:', err);
      setAttachedFiles(prev => prev.filter(f => !f.uploading));
      setUploadAlerts([{ fileName: '', status: 'error', detail: t('chat.error.uploadRetry') }]);
    }
  }

  function removeAttachedFile(fileId: string) {
    setAttachedFiles(prev => prev.filter(f => f.id !== fileId));
    // Optionally delete from server — but keep it since user may want it later
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function handleDownload(fileId: string, filename: string) {
    try {
      const res = await fetch(`/api/files/${fileId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download error:', err);
    }
  }

  async function openPreview(file: GeneratedFile) {
    try {
      const res = await fetch(`/api/files/${file.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Preview fetch failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(
        file.file_type === 'html' ? new Blob([await blob.text()], { type: 'text/html' }) : blob
      );
      setPreviewBlobUrl(url);
      setPreviewFile(file);
    } catch (err) {
      console.error('Preview error:', err);
    }
  }

  function closePreview() {
    if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
    setPreviewBlobUrl(null);
    setPreviewFile(null);
  }

  async function toggleVersionDropdown(dropdownKey: string) {
    if (versionDropdown === dropdownKey) {
      setVersionDropdown(null);
      return;
    }
    setVersionDropdown(dropdownKey);
    // Extract real file ID (strip "preview-" or "sidebar-" prefix if present)
    const realFileId = dropdownKey.replace(/^(preview|sidebar)-/, '');
    if (!versionCache[realFileId]) {
      try {
        const res = await fetch(`/api/files/${realFileId}/versions`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok) {
          const versions = await res.json() as GeneratedFile[];
          setVersionCache(prev => ({ ...prev, [realFileId]: versions }));
        }
      } catch (err) {
        console.error('Fetch versions error:', err);
      }
    }
  }

  function switchToVersion(versionFile: GeneratedFile) {
    // Replace the file in our files list with this version
    setFiles(prev => prev.map(f =>
      f.filename === versionFile.filename ? versionFile : f
    ));
    setVersionDropdown(null);
    // If previewing, switch preview too
    if (previewFile && previewFile.filename === versionFile.filename) {
      openPreview(versionFile);
    }
  }

  function formatElapsed(s: number): string {
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  if (isLoading || !user) return null;

  const isWaiting = streaming && !streamText && !thinkingText && tools.length === 0;
  const hasActivity = streaming && (tools.length > 0 || thinkingText || isWaiting);
  const showCompletedPanel = !streaming && tools.length > 0 && lastUsage;

  const extractSources = (text: string): { title: string; url: string }[] => {
    const urlRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    const sources: { title: string; url: string }[] = [];
    const seen = new Set<string>();
    let match;
    while ((match = urlRegex.exec(text)) !== null) {
      const url = match[2];
      if (!seen.has(url)) {
        seen.add(url);
        sources.push({ title: match[1], url });
      }
    }
    return sources;
  };

  const completedTools = tools.filter(t => t.status === 'completed').length;
  const webSearchTools = tools.filter(t => t.tool === 'WebSearch' || t.tool === 'WebFetch');

  return (
    <div className="h-screen bg-surface-container-lowest overflow-hidden">
      <Navbar />

      {/* Upload Security Alert Modal */}
      {uploadAlerts.length > 0 && (
        <UploadAlertModal items={uploadAlerts} onClose={() => setUploadAlerts([])} />
      )}

      <div className={`${sidebarMargin} h-screen flex overflow-hidden transition-all duration-300`}>
        {/* === Central Chat Area === */}
        <section className="flex flex-col flex-1 min-h-0">
          {/* Title Bar */}
          <header className="flex items-center gap-4 px-8 h-14 bg-surface/80 backdrop-blur-xl shrink-0 border-b border-outline-variant/10">
            <button
              onClick={() => router.push('/conversations')}
              className="text-on-surface-variant hover:text-on-surface transition-colors bg-transparent cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">arrow_back</span>
            </button>
            <h2 className="text-sm font-headline font-bold text-on-surface truncate">{title}</h2>
            {skillId && (
              <span className="text-sm px-2 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-wider uppercase shrink-0">
                {skillId.replace('-gen', '')}
              </span>
            )}
            {streaming && (
              <span className="ml-auto text-sm px-2 py-0.5 bg-surface-container-high text-primary rounded font-mono shrink-0">
                {formatElapsed(elapsed)}
              </span>
            )}
          </header>

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-8 py-8 space-y-8">
            {messages.map(msg => {
              const sources = msg.role === 'assistant' ? extractSources(msg.content) : [];
              return (
                <div key={msg.id} className={msg.role === 'user' ? 'flex flex-col items-end' : 'flex gap-4'}>
                  {msg.role === 'assistant' && (
                    <div className="w-9 h-9 shrink-0 bg-primary-container border border-primary/20 flex items-center justify-center rounded-lg">
                      <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>smart_toy</span>
                    </div>
                  )}
                  <div className={
                    msg.role === 'user'
                      ? 'max-w-[70%] bg-surface-container px-5 py-4 rounded-xl rounded-tr-sm text-on-surface shadow-lg'
                      : 'max-w-[85%]'
                  }>
                    {msg.role === 'user' ? (
                      <>
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                        <span className="block mt-2 text-sm text-outline">
                          {new Date(msg.created_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </>
                    ) : (
                      <div className="bg-surface-container-low px-5 py-4 rounded-xl rounded-tl-sm border border-outline-variant/10">
                        <div className="chat-markdown text-sm leading-relaxed text-on-surface-variant">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{msg.content}</ReactMarkdown>
                        </div>
                        {sources.length > 0 && (
                          <details className="mt-3 border-t border-outline-variant/10 pt-2">
                            <summary className="text-sm text-primary cursor-pointer font-bold uppercase tracking-wider">
                              {t('chat.sources', { count: sources.length })}
                            </summary>
                            <div className="flex flex-col gap-1.5 mt-2">
                              {sources.map((src, i) => (
                                <a key={i} href={src.url} target="_blank" rel="noopener noreferrer"
                                  className="flex items-center gap-2 px-3 py-2 bg-surface-container rounded text-sm hover:bg-surface-container-high transition-colors no-underline">
                                  <span className="material-symbols-outlined text-primary text-sm">link</span>
                                  <span className="text-on-surface truncate flex-1">{src.title}</span>
                                  <span className="text-outline text-sm shrink-0">{new URL(src.url).hostname}</span>
                                </a>
                              ))}
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Streaming text preview */}
            {streamText && streamText.trim() && (
              <div className="flex gap-4">
                <div className="w-9 h-9 shrink-0 bg-primary-container border border-primary/20 flex items-center justify-center rounded-lg">
                  <span className="material-symbols-outlined text-primary text-sm" style={{ fontVariationSettings: "'FILL' 1" }}>smart_toy</span>
                </div>
                <div className="max-w-[85%]">
                  <div className="bg-surface-container-low px-5 py-4 rounded-xl rounded-tl-sm border border-primary/20 border-dashed">
                    <div className="chat-markdown text-sm leading-relaxed text-on-surface-variant">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{streamText}</ReactMarkdown>
                      <span className="inline-block w-0.5 h-4 bg-primary ml-0.5 align-text-bottom animate-pulse" />
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Processing Panel */}
            {(hasActivity || showCompletedPanel) && (
              <div className="bg-surface-container-low rounded-lg border-l-2 border-primary/40 max-w-[85%] overflow-hidden">
                <div
                  className="flex items-center gap-3 px-4 py-3 bg-surface-container cursor-pointer select-none hover:bg-surface-container-high transition-colors"
                  onClick={() => setPanelCollapsed(c => !c)}
                  role="button"
                  tabIndex={0}
                >
                  {streaming
                    ? <span className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
                    : <span className="material-symbols-outlined text-sm text-green-400">check_circle</span>
                  }
                  <span className="text-sm font-headline font-bold text-on-surface uppercase tracking-wider flex-1">
                    {streaming ? t('chat.processing.title') : t('chat.processing.completed')}
                    {panelCollapsed && tools.length > 0 && (
                      <span className="font-normal text-on-surface-variant ml-2">
                        {completedTools}/{tools.length}
                        {webSearchTools.length > 0 && ` · ${webSearchTools.length}`}
                      </span>
                    )}
                  </span>
                  <span className="text-sm font-mono text-primary">{formatElapsed(elapsed)}</span>
                  <span className={`material-symbols-outlined text-sm text-on-surface-variant transition-transform ${panelCollapsed ? '-rotate-90' : ''}`}>
                    expand_more
                  </span>
                </div>

                {!panelCollapsed && (
                  <>
                    <div className="px-4 py-2 space-y-1 font-mono text-sm">
                      {/* Connected */}
                      <div className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant">
                        <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
                        <span>{t('chat.processing.connected')}</span>
                      </div>

                      {/* Waiting */}
                      {isWaiting && (
                        <div className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant bg-surface-container/50 rounded">
                          <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                          <span>
                            {elapsed < 3 ? t('chat.processing.loadingConversation')
                              : elapsed < 8 ? t('chat.processing.analyzingRequest')
                              : elapsed < 15 ? t('chat.processing.generatingResponse')
                              : t('chat.processing.complexTask')}
                          </span>
                        </div>
                      )}

                      {/* Thinking */}
                      {thinkingText && (
                        <div className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant bg-surface-container/50 rounded">
                          <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                          <span>{t('chat.processing.deepThinking')}</span>
                        </div>
                      )}

                      {/* Tool steps */}
                      {tools.map((tool, i) => {
                        const info = getToolInfo(tool.tool, t);
                        const detail = parseToolInput(tool.tool, tool.input, t);
                        const isDone = tool.status === 'completed';
                        return (
                          <div key={tool.id || i} className={`flex items-center gap-2 px-2 py-1.5 rounded ${isDone ? 'text-outline' : 'text-on-surface-variant bg-surface-container/50'}`}>
                            {isDone
                              ? <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
                              : <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                            }
                            <span className="material-symbols-outlined text-sm">{info.icon}</span>
                            <span className={isDone ? 'line-through opacity-60' : ''}>{info.label}</span>
                            {detail && (
                              <span className="text-primary bg-surface-container px-1.5 py-0.5 rounded text-sm truncate max-w-[400px]">
                                {detail}
                              </span>
                            )}
                          </div>
                        );
                      })}

                      {/* Agent tasks */}
                      {agentTasks.map(task => (
                        <div
                          key={task.taskId}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded ${
                            task.status === 'completed' ? 'text-outline'
                            : task.status === 'failed' ? 'text-warning bg-warning/5'
                            : 'text-on-surface-variant bg-surface-container/50'
                          }`}
                        >
                          {task.status === 'completed'
                            ? <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
                            : task.status === 'failed'
                            ? <span className="material-symbols-outlined text-warning text-sm">warning</span>
                            : <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                          }
                          <span className="material-symbols-outlined text-sm">smart_toy</span>
                          <span>{SKILL_LABELS[task.skillId] || task.skillId}</span>
                          <span className="text-primary bg-surface-container px-1.5 py-0.5 rounded text-sm truncate max-w-[400px]">
                            {task.status === 'failed'
                              ? (task.error || 'Timed out').substring(0, 50)
                              : task.description.substring(0, 60)}
                          </span>
                        </div>
                      ))}

                      {/* Writing response */}
                      {streaming && streamText && (
                        <div className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant bg-surface-container/50 rounded">
                          <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                          <span>{t('chat.processing.writingResponse')}</span>
                        </div>
                      )}

                      {/* Response complete */}
                      {!streaming && tools.length > 0 && (
                        <div className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant">
                          <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
                          <span>{t('chat.processing.responseComplete')}</span>
                        </div>
                      )}
                    </div>

                    {/* Token usage */}
                    {lastUsage && !streaming && (
                      <div className="flex items-center justify-between px-4 py-2 border-t border-outline-variant/10 text-sm text-outline">
                        <span>Tokens: {lastUsage.inputTokens.toLocaleString()} in / {lastUsage.outputTokens.toLocaleString()} out
                          <span className="ml-2 text-primary/70">${(((lastUsage.inputTokens / 1_000_000) * 3 + (lastUsage.outputTokens / 1_000_000) * 15) * 10).toFixed(4)}</span>
                        </span>
                        {lastUsage.model && (
                          <span className="px-2 py-0.5 bg-primary/10 text-primary rounded text-sm">
                            {lastUsage.model.split('-').slice(0, 2).join('-')}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Extended thinking */}
                    {thinkingText && (
                      <details className="mx-4 mb-3 border-t border-outline-variant/10">
                        <summary className="text-sm text-primary cursor-pointer py-2 font-bold uppercase tracking-wider">
                          {t('chat.processing.viewThinking')}
                        </summary>
                        <div className="text-sm text-on-surface-variant leading-relaxed whitespace-pre-wrap max-h-36 overflow-y-auto pb-2">
                          {thinkingText}
                        </div>
                      </details>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Inline File Preview */}
            {files.length > 0 && !streaming && (
              <div className="max-w-[85%] space-y-3 ml-13">
                {files.map(file => (
                  <div key={file.id} className="bg-surface-container-low rounded-xl border border-outline-variant/10 overflow-visible">
                    {/* HTML slides — iframe preview */}
                    {file.file_type === 'html' && (
                      <InlineHtmlPreview file={file} token={token!} onFullscreen={() => openPreview(file)} />
                    )}
                    {/* Office/PDF — first page preview */}
                    {PREVIEWABLE_TYPES.has(file.file_type) && (
                      <InlineFilePreview file={file} token={token!} />
                    )}
                    {/* Other file types — card only */}
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className={`w-10 h-10 rounded-lg flex items-center justify-center ${
                        file.file_type === 'html' ? 'bg-secondary/10' :
                        file.file_type === 'pdf' ? 'bg-error/10' :
                        file.file_type === 'pptx' ? 'bg-warning/10' :
                        file.file_type === 'xlsx' ? 'bg-success/10' :
                        'bg-tertiary/10'
                      }`}>
                        <span className={`material-symbols-outlined ${getFileColor(file.file_type)} text-xl`}>
                          {getFileIcon(file.file_type)}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium text-on-surface block truncate">{file.filename}</span>
                        <span className="text-sm text-outline">
                          {file.file_type.toUpperCase()} · {formatSize(file.file_size)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        {/* Version selector */}
                        <div className="relative" data-version-dropdown>
                          <button
                            onClick={() => toggleVersionDropdown(file.id)}
                            className={`flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                              versionDropdown === file.id
                                ? 'bg-primary/20 text-primary'
                                : 'bg-primary/10 text-primary hover:bg-primary/20'
                            }`}
                            title={t('chat.preview.versions' as any)}
                          >
                            <span>v{file.version || 1}</span>
                            <span className="material-symbols-outlined text-xs">expand_more</span>
                          </button>
                          {versionDropdown === file.id && versionCache[file.id] && (
                            <div className="absolute right-0 top-full mt-1 z-50 bg-surface-container border border-outline-variant/20 rounded-lg shadow-xl min-w-[260px] py-1 max-h-48 overflow-y-auto">
                              {versionCache[file.id].map((ver, idx) => (
                                <button
                                  key={ver.id}
                                  onClick={() => switchToVersion(ver)}
                                  className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-surface-container-high transition-colors cursor-pointer ${
                                    ver.id === file.id ? 'bg-primary/10' : ''
                                  }`}
                                >
                                  <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                                    ver.id === file.id ? 'bg-primary text-on-primary' : 'bg-surface-container-highest text-on-surface-variant'
                                  }`}>
                                    v{ver.version || 1}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <span className="text-xs text-on-surface-variant block">
                                      {formatSize(ver.file_size)}
                                      {idx === 0 && <span className="ml-1 text-primary font-bold">{t('chat.preview.latestVersion' as any)}</span>}
                                    </span>
                                    <span className="text-xs text-outline block">
                                      {new Date(ver.created_at || '').toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                  </div>
                                  {ver.id === file.id && (
                                    <span className="material-symbols-outlined text-primary text-sm">check</span>
                                  )}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {file.file_type === 'html' && (
                          <button
                            onClick={() => openPreview(file)}
                            className="p-2 rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                            title={t('chat.preview.fullscreen' as any)}
                          >
                            <span className="material-symbols-outlined text-lg">fullscreen</span>
                          </button>
                        )}
                        <button
                          onClick={() => handleDownload(file.id, file.filename)}
                          className="p-2 rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors cursor-pointer"
                          title={t('chat.preview.download' as any)}
                        >
                          <span className="material-symbols-outlined text-lg">download</span>
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Fullscreen Preview Modal */}
          {previewFile && previewBlobUrl && (
            <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col">
              <div className="flex items-center justify-between px-6 py-3 bg-surface/90 border-b border-outline-variant/20">
                <div className="flex items-center gap-3">
                  <span className={`material-symbols-outlined ${getFileColor(previewFile.file_type)} text-xl`}>
                    {getFileIcon(previewFile.file_type)}
                  </span>
                  <span className="text-on-surface font-medium">{previewFile.filename}</span>
                  <span className="text-sm text-outline">{formatSize(previewFile.file_size)}</span>
                  {/* Version selector in fullscreen */}
                  <div className="relative" data-version-dropdown>
                    <button
                      onClick={() => toggleVersionDropdown(`preview-${previewFile.id}`)}
                      className={`flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-bold transition-colors cursor-pointer ${
                        versionDropdown === `preview-${previewFile.id}`
                          ? 'bg-primary/30 text-primary'
                          : 'bg-primary/15 text-primary hover:bg-primary/25'
                      }`}
                    >
                      <span>v{previewFile.version || 1}</span>
                      <span className="material-symbols-outlined text-xs">expand_more</span>
                    </button>
                    {versionDropdown === `preview-${previewFile.id}` && (versionCache[previewFile.id] || versionCache[`preview-${previewFile.id}`]) && (
                      <div className="absolute left-0 top-full mt-1 z-50 bg-surface-container border border-outline-variant/20 rounded-lg shadow-xl min-w-[220px] py-1 max-h-48 overflow-y-auto">
                        {(versionCache[previewFile.id] || []).map((ver, idx) => (
                          <button
                            key={ver.id}
                            onClick={() => { switchToVersion(ver); openPreview(ver); }}
                            className={`w-full flex items-center gap-3 px-3 py-2 text-left hover:bg-surface-container-high transition-colors cursor-pointer ${
                              ver.id === previewFile.id ? 'bg-primary/10' : ''
                            }`}
                          >
                            <span className={`text-xs font-bold px-1.5 py-0.5 rounded ${
                              ver.id === previewFile.id ? 'bg-primary text-on-primary' : 'bg-surface-container-highest text-on-surface-variant'
                            }`}>
                              v{ver.version || 1}
                            </span>
                            <div className="flex-1 min-w-0">
                              <span className="text-xs text-on-surface-variant block">
                                {formatSize(ver.file_size)}
                                {idx === 0 && <span className="ml-1 text-primary font-bold">{t('chat.preview.latestVersion' as any)}</span>}
                              </span>
                              <span className="text-xs text-outline block">
                                {new Date(ver.created_at || '').toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            {ver.id === previewFile.id && (
                              <span className="material-symbols-outlined text-primary text-sm">check</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleDownload(previewFile.id, previewFile.filename)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer text-sm font-bold"
                  >
                    <span className="material-symbols-outlined text-sm">download</span>
                    {t('chat.preview.download' as any)}
                  </button>
                  <button
                    onClick={closePreview}
                    className="p-2 rounded-lg hover:bg-surface-container-high text-on-surface-variant hover:text-on-surface transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined">close</span>
                  </button>
                </div>
              </div>
              <div className="flex-1 p-4">
                {previewFile.file_type === 'html' ? (
                  <iframe
                    src={previewBlobUrl}
                    sandbox="allow-scripts allow-same-origin"
                    scrolling="no"
                    className="w-full h-full rounded-lg border border-outline-variant/20"
                    style={{ overflow: 'hidden' }}
                    title={previewFile.filename}
                  />
                ) : (
                  <iframe
                    src={previewBlobUrl}
                    className="w-full h-full rounded-lg border border-outline-variant/20 bg-surface-container-lowest"
                    title={previewFile.filename}
                  />
                )}
              </div>
            </div>
          )}

          {/* Input Area */}
          <div className="p-6 pt-0">
            {/* Template banner */}
            {pendingTemplate && (
              <div className="mb-2 flex items-center gap-2 px-3 py-2 bg-primary/10 border border-primary/20 rounded-lg text-sm text-primary">
                <span className="material-symbols-outlined text-sm">style</span>
                <span className="font-bold">{t('templates.active' as any)}:</span>
                <span className="flex-1 truncate">{pendingTemplate}</span>
                <button
                  onClick={() => setPendingTemplate(null)}
                  className="hover:text-error transition-colors cursor-pointer shrink-0"
                >
                  <span className="material-symbols-outlined text-sm">close</span>
                </button>
              </div>
            )}
            <div className="bg-surface-container rounded-lg border border-outline-variant/20 focus-within:border-primary/40 transition-all p-2">
              {/* Attached files chips */}
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 px-2 pt-2 pb-1">
                  {attachedFiles.map(file => (
                    <div
                      key={file.id}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-sm border ${
                        file.uploading ? 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant' :
                        file.scanStatus === 'rejected' ? 'bg-error/10 border-error/30 text-error' :
                        file.scanStatus === 'suspicious' ? 'bg-warning/10 border-warning/30 text-warning' :
                        'bg-primary/10 border-primary/20 text-primary'
                      }`}
                    >
                      {file.uploading ? (
                        <span className="material-symbols-outlined text-sm animate-spin">progress_activity</span>
                      ) : file.scanStatus === 'rejected' ? (
                        <span className="material-symbols-outlined text-sm">gpp_bad</span>
                      ) : (
                        <span className="material-symbols-outlined text-sm">attach_file</span>
                      )}
                      <span className="max-w-[120px] truncate">{file.originalName}</span>
                      {!file.uploading && (
                        <button
                          onClick={() => removeAttachedFile(file.id)}
                          className="hover:text-error transition-colors cursor-pointer ml-0.5"
                        >
                          <span className="material-symbols-outlined text-sm">close</span>
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-3 px-2 py-1">
                {/* Attach file button */}
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept=".csv,.xlsx,.xls,.pdf,.txt,.md,.json,.docx,.doc,.pptx,.ppt,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.tiff,.tif,.ico,.xml,.yaml,.yml,.html,.htm"
                  className="hidden"
                  onChange={e => { handleFileAttach(e.target.files); e.target.value = ''; }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={streaming}
                  className="w-9 h-9 flex items-center justify-center rounded hover:bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  title={t('chat.input.uploadFile')}
                >
                  <span className="material-symbols-outlined text-lg">attach_file</span>
                </button>
                <textarea
                  className="bg-transparent border-none focus:ring-0 text-sm flex-1 text-on-surface placeholder:text-outline/50 font-body resize-none min-h-[40px] max-h-[120px]"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder={t('chat.input.placeholder')}
                  rows={1}
                  disabled={streaming}
                />
                {streaming ? (
                  <button
                    className="bg-error/20 text-error font-headline font-bold text-sm uppercase px-5 py-2.5 rounded tracking-widest hover:bg-error/30 active:scale-95 transition-all cursor-pointer"
                    onClick={handleAbort}
                  >
                    {t('chat.input.stop')}
                  </button>
                ) : (
                  <button
                    className="cyber-gradient text-on-primary font-headline font-bold text-sm uppercase px-5 py-2.5 rounded tracking-widest shadow-lg active:scale-95 transition-transform disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    onClick={() => sendMessage()}
                    disabled={!input.trim()}
                  >
                    {t('chat.input.send')}
                  </button>
                )}
              </div>
            </div>
            {/* Input footer info */}
            <div className="mt-2 flex justify-between items-center px-2">
              <div className="flex gap-4">
                <span className="text-sm text-outline uppercase tracking-widest">
                  {skillId ? `${SKILL_LABELS[skillId] || skillId}` : t('chat.input.autoDetect')}
                </span>
              </div>
              {(totalUsage || lastUsage) && (
                <div className="text-sm font-mono text-on-secondary-container/60 bg-surface-container-low px-3 py-1 rounded-full">
                  {totalUsage ? (
                    <>
                      <span className="text-primary">{((totalUsage.inputTokens + totalUsage.outputTokens) / 1000).toFixed(1)}k</span>
                      <span className="text-primary/60 ml-1">(${(((totalUsage.inputTokens / 1_000_000) * 3 + (totalUsage.outputTokens / 1_000_000) * 15) * 10).toFixed(4)})</span>
                    </>
                  ) : lastUsage ? (
                    <>
                      <span className="text-primary">{((lastUsage.inputTokens + lastUsage.outputTokens) / 1000).toFixed(1)}k</span>
                      <span className="text-primary/60 ml-1">(${(((lastUsage.inputTokens / 1_000_000) * 3 + (lastUsage.outputTokens / 1_000_000) * 15) * 10).toFixed(4)})</span>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* === Right Sidebar === */}
        <aside className="w-72 bg-surface-container-low border-l border-outline-variant/10 overflow-y-auto p-5 hidden lg:flex flex-col gap-6 shrink-0">
          {/* System Status */}
          <div className="space-y-3">
            <h4 className="text-sm font-headline font-bold text-outline tracking-widest uppercase">{t('chat.sidebar.systemStatus')}</h4>
            <div className="bg-surface-container-highest p-4 rounded-sm border-l-2 border-primary">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-primary text-sm">security</span>
                <span className="text-sm font-headline font-bold text-on-surface uppercase tracking-tight">{t('chat.sidebar.sandboxMode')}</span>
              </div>
              <p className="text-sm text-on-surface-variant leading-relaxed">
                {t('chat.sidebar.sandboxDescription')}
              </p>
            </div>
          </div>

          {/* Generated Files */}
          <div className="space-y-3 flex-1">
            <h4 className="text-sm font-headline font-bold text-outline tracking-widest uppercase">
              {t('chat.sidebar.generatedFiles')}
            </h4>
            {files.length === 0 ? (
              <p className="text-sm text-on-surface-variant text-center py-6 leading-relaxed">
                {t('chat.sidebar.noFiles')}<br />{t('chat.sidebar.noFilesHint')}
              </p>
            ) : (
              <div className="space-y-1.5">
                {files.map(file => (
                  <div key={file.id} className="group">
                    <div
                      className="flex items-center justify-between p-3 hover:bg-surface-container rounded-lg cursor-pointer transition-colors border border-transparent hover:border-primary/20"
                      onClick={() => handleDownload(file.id, file.filename)}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <span className={`material-symbols-outlined ${getFileColor(file.file_type)} text-lg`}>
                          {getFileIcon(file.file_type)}
                        </span>
                        <div className="min-w-0">
                          <span className="text-sm text-on-surface font-medium block truncate">{file.filename}</span>
                          <span className="text-sm text-outline">
                            {file.file_type.toUpperCase()} · {formatSize(file.file_size)}
                          </span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1 shrink-0" data-version-dropdown>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleVersionDropdown(`sidebar-${file.id}`); }}
                          className="px-1.5 py-0.5 text-xs font-bold bg-primary/10 text-primary rounded hover:bg-primary/20 transition-colors cursor-pointer"
                          title={t('chat.preview.versions' as any)}
                        >
                          v{file.version || 1}
                        </button>
                        <span className="material-symbols-outlined text-sm text-outline group-hover:text-primary transition-colors">
                          download
                        </span>
                      </div>
                    </div>
                    {/* Sidebar version dropdown */}
                    {versionDropdown === `sidebar-${file.id}` && versionCache[file.id] && (
                      <div className="mx-3 mb-2 bg-surface-container border border-outline-variant/20 rounded-lg shadow-lg py-1 max-h-40 overflow-y-auto">
                        {versionCache[file.id].map((ver, idx) => (
                          <button
                            key={ver.id}
                            onClick={() => switchToVersion(ver)}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-container-high transition-colors cursor-pointer text-xs ${
                              ver.id === file.id ? 'bg-primary/10' : ''
                            }`}
                          >
                            <span className={`font-bold px-1 py-0.5 rounded ${
                              ver.id === file.id ? 'bg-primary text-on-primary' : 'bg-surface-container-highest text-on-surface-variant'
                            }`}>
                              v{ver.version || 1}
                            </span>
                            <span className="text-on-surface-variant flex-1">
                              {formatSize(ver.file_size)}
                              {idx === 0 && <span className="ml-1 text-primary font-bold">{t('chat.preview.latestVersion' as any)}</span>}
                            </span>
                            {ver.id === file.id && (
                              <span className="material-symbols-outlined text-primary text-xs">check</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Uploaded Files (conversation history) — show latest 3 */}
          {conversationUploads.length > 0 && (
            <div className="space-y-3 border-t border-outline-variant/10 pt-4">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-headline font-bold text-outline tracking-widest uppercase">
                  {t('chat.sidebar.uploadedFiles')}
                </h4>
                <span className="text-sm font-mono text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                  {conversationUploads.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {conversationUploads.slice(0, 3).map(file => (
                  <div
                    key={file.id}
                    className="flex items-center gap-3 p-3 hover:bg-surface-container rounded-lg group transition-colors border border-transparent hover:border-outline-variant/20"
                  >
                    <span className={`material-symbols-outlined ${getFileColor(file.fileType)} text-lg`}>
                      {getFileIcon(file.fileType)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-sm text-on-surface font-medium block truncate">{file.originalName}</span>
                      <span className="text-sm text-outline">
                        {file.fileType.toUpperCase()} · {formatSize(file.fileSize)}
                      </span>
                    </div>
                    {file.scanStatus === 'clean' && (
                      <span className="material-symbols-outlined text-green-400 text-sm shrink-0" title={t('chat.sidebar.safe')}>verified_user</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Agent Tasks Summary */}
          {agentTasks.length > 0 && (
            <div className="space-y-3 border-t border-outline-variant/10 pt-4">
              <h4 className="text-sm font-headline font-bold text-outline tracking-widest uppercase">{t('chat.sidebar.agentTasks')}</h4>
              <div className="space-y-1.5">
                {agentTasks.map(task => (
                  <div key={task.taskId} className="flex items-center gap-2 p-2 bg-surface-container/50 rounded">
                    {task.status === 'completed'
                      ? <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
                      : task.status === 'failed'
                      ? <span className="material-symbols-outlined text-warning text-sm">warning</span>
                      : <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                    }
                    <span className="text-sm text-on-surface-variant truncate">
                      {SKILL_LABELS[task.skillId] || task.skillId}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function ChatWithI18n() {
  const { user } = useAuth();
  return (
    <I18nProvider initialLocale={user?.locale} initialTheme={user?.theme}>
      <ChatContent />
    </I18nProvider>
  );
}

export default function ChatPage() {
  return (
    <AuthProvider>
      <ChatWithI18n />
    </AuthProvider>
  );
}
