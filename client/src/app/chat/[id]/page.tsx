'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter, useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import dynamic from 'next/dynamic';
import { AuthProvider, useAuth } from '../../components/AuthProvider';
import Navbar from '../../components/Navbar';
import UploadAlertModal, { type UploadAlertItem } from '../../components/UploadAlertModal';
import ShareModal from '../../components/ShareModal';
import { I18nProvider, useTranslation } from '../../../i18n';
import { useSidebarMargin } from '../../hooks/useSidebarCollapsed';
import { useDocumentMode, FILE_GEN_SKILLS, FILE_TYPE_TO_LAYOUT } from '../hooks/useDocumentMode';
import { useDocumentBlocks } from '../../editor/hooks/useDocumentBlocks';
import DocumentCanvas from '../components/DocumentCanvas';
import { calcCostUsd } from '../../../lib/pricing';

const ChatChart = dynamic(() => import('../../components/charts/ChatChart'), { ssr: false });
const ChatEChart = dynamic(() => import('../../components/charts/ChatEChart'), { ssr: false });
const ChatVisual = dynamic(() => import('../../components/charts/ChatVisual'), { ssr: false });
const ChatMermaid = dynamic(() => import('../../components/charts/ChatMermaid'), { ssr: false });
const ChatMindmap = dynamic(() => import('../../components/charts/ChatMindmap'), { ssr: false });
const ChatMap = dynamic(() => import('../../components/charts/ChatMap'), { ssr: false });

// Convert mermaid mindmap syntax to markdown headings for markmap
function convertMermaidMindmapToMarkdown(mermaidCode: string): string {
  const lines = mermaidCode.split('\n');
  const result: string[] = [];
  let baseIndent = -1;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || /^mindmap\b/i.test(trimmed)) continue;

    // Detect indentation level
    const match = line.match(/^(\s*)/);
    const indent = match ? match[1].length : 0;
    if (baseIndent < 0) baseIndent = indent;

    const level = Math.max(1, Math.floor((indent - baseIndent) / 2) + 1);

    // Clean node text: remove root((..)), ((..)),(..),[[..]],..[..] etc.
    let text = trimmed
      .replace(/^root\(\((.+?)\)\)$/, '$1')
      .replace(/^\(\((.+?)\)\)$/, '$1')
      .replace(/^\((.+?)\)$/, '$1')
      .replace(/^\[(.+?)\]$/, '$1')
      .replace(/^"(.+?)"$/, '$1');

    if (!text) continue;
    result.push(`${'#'.repeat(Math.min(level, 6))} ${text}`);
  }

  return result.join('\n');
}

// SSE streaming via Next.js API route proxy (relative path for production).
const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

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

interface BgTask {
  id: string;
  skill_id: string;
  description: string;
  status: string;
  result_summary: string | null;
}

interface RefConv {
  id: string;
  title: string;
  summary: string | null;
}

const SKILL_IDS = [
  'pptx-gen', 'docx-gen', 'xlsx-gen', 'pdf-gen', 'slides-gen', 'webapp-gen',
  'research', 'data-analyst', 'rag-analyst', 'planner', 'reviewer', 'router',
] as const;

const SKILL_ICONS: Record<string, string> = {
  'pptx-gen': 'present_to_all',
  'docx-gen': 'description',
  'xlsx-gen': 'table_chart',
  'pdf-gen': 'picture_as_pdf',
  'slides-gen': 'slideshow',
  'webapp-gen': 'dashboard',
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

/** Parse AskUserQuestion options from tool input JSON */
function parseAskUserOptions(rawInput: string | undefined): { question: string; options: { label: string; description?: string }[] }[] | null {
  if (!rawInput) return null;
  try {
    const parsed = JSON.parse(rawInput);
    const questions = parsed?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return null;
    return questions.map((q: any) => ({
      question: q.question || '',
      options: Array.isArray(q.options) ? q.options.map((o: any) => ({
        label: o.label || '',
        description: o.description || '',
      })) : [],
    })).filter((q: any) => q.options.length > 0);
  } catch {
    return null;
  }
}

/** Parse [refs:...] metadata tag from user messages for displaying referenced assistants */
function parseMessageRefs(content: string): { text: string; refs: Array<{id: string; title: string}> } {
  const match = content.match(/\n\n\[refs:(\[[\s\S]*\])\]$/);
  if (!match) return { text: content, refs: [] };
  try {
    const refs = JSON.parse(match[1]) as Array<{id: string; title: string}>;
    return { text: content.slice(0, content.length - match[0].length), refs };
  } catch {
    return { text: content, refs: [] };
  }
}

/** Parse [CHOICES]...[/CHOICES] blocks from assistant messages */
function parseChoices(content: string): { text: string; choices: string[] } {
  const match = content.match(/\[CHOICES\]\s*([\s\S]*?)\s*\[\/CHOICES\]/);
  if (!match) return { text: content, choices: [] };
  const choices = match[1]
    .split('\n')
    .map(line => line.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);
  const text = content.replace(/\[CHOICES\][\s\S]*?\[\/CHOICES\]/, '').trim();
  return { text, choices };
}

/** Get tool icon (material symbol name) and label */
function getToolInfo(tool: string, t: (key: any, params?: Record<string, string | number>) => string): { icon: string; label: string } {
  if (tool.includes(':')) {
    const [agentId, baseTool] = tool.split(':');
    const agentLabel = t(`skill.${agentId}` as any) || agentId;
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

/** Types that can render a live iframe preview (PDF natively, HTML directly) */
const IFRAME_PREVIEWABLE = new Set(['pdf', 'html', 'htm']);
/** Types that show a styled file-type cover card */
const CARD_PREVIEWABLE = new Set(['pptx', 'ppt', 'docx', 'doc', 'xlsx', 'xls']);

// Data sources the agent can be granted (explicit multi-select, Gemini-style).
// Selecting one sends it in `dataSources`; the backend attaches the matching MCP.
// (KM will be added here once km-mcp lands.)
const DATA_SOURCES: { id: string; label: string; desc: string; icon: string }[] = [
  { id: 'email', label: '我的信件', desc: 'Outlook 信箱（只讀自己的）', icon: 'mail' },
];
const PREVIEWABLE_TYPES = new Set([...IFRAME_PREVIEWABLE, ...CARD_PREVIEWABLE]);

/** Simple cover card for Office files — light bg + icon */
function FileTypeCover({ file, onClick }: { file: GeneratedFile; onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      onClick={onClick}
      className="relative w-full rounded-t-xl overflow-hidden cursor-pointer group block bg-surface-container-lowest"
      title={t('chat.preview.fullscreen' as any)}
    >
      <div className="h-[100px] md:h-[120px] flex flex-col items-center justify-center gap-1.5">
        <span className={`material-symbols-outlined text-3xl md:text-4xl ${getFileColor(file.file_type)}`}>
          {getFileIcon(file.file_type)}
        </span>
        <span className="text-[11px] text-on-surface-variant/50 font-medium uppercase tracking-wider">
          {file.file_type}
        </span>
      </div>
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/5 transition-colors flex items-center justify-center">
        <span className="material-symbols-outlined text-on-surface-variant text-xl opacity-0 group-hover:opacity-70 transition-opacity">
          open_in_full
        </span>
      </div>
    </button>
  );
}

/** Live iframe thumbnail for PDF and HTML files */
function FileThumbnail({ file, token, onClick }: { file: GeneratedFile; token: string; onClick: () => void }) {
  const { t } = useTranslation();
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [isPdf, setIsPdf] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    const endpoint = file.file_type === 'html'
      ? `${SSE_BASE}/api/files/${file.id}/download`
      : `${SSE_BASE}/api/files/${file.id}/preview?editing=1`;
    fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => {
        if (!r.ok) throw new Error(`preview ${r.status}`);
        const ct = r.headers.get('Content-Type') || '';
        return r.blob().then(blob => ({ blob, ct }));
      })
      .then(({ blob, ct }) => {
        const pdf = ct.includes('pdf');
        const type = pdf ? 'application/pdf' : ct.includes('html') ? 'text/html' : ct;
        url = URL.createObjectURL(new Blob([blob], { type }));
        setIsPdf(pdf);
        setBlobUrl(url);
      })
      .catch((err) => {
        console.warn(`[FileThumbnail] Preview failed for ${file.filename}:`, err);
        setFailed(true);
      });
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file.id, file.file_type, file.filename, token]);

  // Failed: show file type cover card as fallback
  if (failed) return <FileTypeCover file={file} onClick={onClick} />;

  if (!blobUrl) return (
    <div className="h-[160px] md:h-[200px] flex items-center justify-center text-on-surface-variant text-sm rounded-t-xl bg-surface-container-lowest">
      <span className="material-symbols-outlined animate-spin mr-2 text-base">progress_activity</span>
      {t('chart.preview.loading' as any)}
    </div>
  );

  return (
    <button
      onClick={onClick}
      className="relative w-full rounded-t-xl overflow-hidden bg-surface-container-lowest cursor-pointer group block"
      title={t('chat.preview.fullscreen' as any)}
    >
      <div className="h-[160px] md:h-[200px] overflow-hidden">
        <iframe
          src={isPdf ? `${blobUrl}#toolbar=0&navpanes=0&scrollbar=0&page=1` : blobUrl}
          className="w-full h-[400px] border-0 scale-[0.5] origin-top-left"
          style={{ width: '200%', pointerEvents: 'none' }}
          scrolling="no"
          tabIndex={-1}
          title={file.filename}
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
      <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-surface-container-low to-transparent" />
      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/10 transition-colors flex items-center justify-center">
        <span className="material-symbols-outlined text-white text-2xl opacity-0 group-hover:opacity-100 transition-opacity drop-shadow-lg">
          open_in_full
        </span>
      </div>
    </button>
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
  const [isDragging, setIsDragging] = useState(false);
  const dragCounter = useRef(0);
  const [tools, setTools] = useState<ToolActivity[]>([]);
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [latestFiles, setLatestFiles] = useState<GeneratedFile[]>([]);
  const [title, setTitle] = useState('');
  const [skillId, setSkillId] = useState('');
  const [convCategory, setConvCategory] = useState('');
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
  // Infographic brush region brought over from the image viewer for chat Q&A/edit
  const [pendingRegion, setPendingRegion] = useState<{ mask: string; fileId: string } | null>(null);
  const [versionDropdown, setVersionDropdown] = useState<string | null>(null); // file ID whose dropdown is open
  const [versionCache, setVersionCache] = useState<Record<string, GeneratedFile[]>>({});
  const [mobileFilesOpen, setMobileFilesOpen] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  // Cross-assistant reference (@mention) state — only active for assistant conversations
  const [refAssistants, setRefAssistants] = useState<RefConv[]>([]);
  const [selectedRefs, setSelectedRefs] = useState<RefConv[]>([]);
  // Data-source selector (Gemini-style, explicit opt-in): which internal sources
  // the agent may pull from to build the document. Sent as `dataSources` in the
  // request; the backend attaches the matching MCP (e.g. 'email' → email-mcp).
  const [selectedDataSources, setSelectedDataSources] = useState<string[]>([]);
  const [dataSourceMenuOpen, setDataSourceMenuOpen] = useState(false);
  const [showRefPicker, setShowRefPicker] = useState(false);
  const refPickerRef = useRef<HTMLDivElement>(null);
  const dataSourceMenuRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sidebarMargin = useSidebarMargin();
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);

  // Document mode (split view for file-generation tasks)
  const docMode = useDocumentMode(conversationId);
  const docBlocks = useDocumentBlocks(token);

  // One-time coachmark nudging users toward edit mode (low discoverability of the
  // inline edit button). Shown once per browser, then remembered in localStorage.
  const [showEditHint, setShowEditHint] = useState(false);
  useEffect(() => {
    if (typeof window !== 'undefined' && localStorage.getItem('aio_edit_hint_seen') !== '1') {
      setShowEditHint(true);
    }
  }, []);
  const dismissEditHint = useCallback(() => {
    setShowEditHint(false);
    try { localStorage.setItem('aio_edit_hint_seen', '1'); } catch { /* ignore */ }
  }, []);

  // Auto-collapse the left sidebar in document/slides edit mode for more room;
  // restore the prior state when leaving the mode (or the page).
  useEffect(() => {
    if (typeof window === 'undefined' || docMode.viewMode !== 'document') return;
    const prior = localStorage.getItem('sidebar-collapsed') === '1';
    window.dispatchEvent(new CustomEvent('sidebar-toggle', { detail: true }));
    return () => { window.dispatchEvent(new CustomEvent('sidebar-toggle', { detail: prior })); };
  }, [docMode.viewMode]);
  const [docRebuilding, setDocRebuilding] = useState(false);
  const [docRegenBlockId, setDocRegenBlockId] = useState<string | null>(null);
  const [docRegenContext, setDocRegenContext] = useState<string>('');
  const [docRegenInstruction, setDocRegenInstruction] = useState<string>(''); // shown in canvas while regenerating
  const [docRegenPhase, setDocRegenPhase] = useState<string>(''); // 'ai_thinking' | 'rebuilding' | ''
  const docRegenInFlight = useRef(false); // prevent duplicate regenerate calls
  const [docSelectedElement, setDocSelectedElement] = useState<string | null>(null); // selected sub-element (chart, field, etc.)
  const [docSlideShapes, setDocSlideShapes] = useState<Array<{ name: string; type: string }>>([]); // shapes on current slide
  const [docChatCollapsed, setDocChatCollapsed] = useState(false); // collapse left chat in doc mode
  const [docChatWidth, setDocChatWidth] = useState(33); // chat panel width % in doc mode
  const [mobileDocView, setMobileDocView] = useState<'preview' | 'chat'>('preview'); // mobile: toggle chat vs preview
  const docDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const fileGenInRoundRef = useRef(false); // track if file was generated this round

  /** Submit regeneration: close modal immediately, stream SSE events, show real-time status */
  const submitDocRegen = useCallback(() => {
    const input = (document.getElementById('doc-regen-input') as HTMLTextAreaElement)?.value?.trim();
    if (!input || !docMode.documentFileId || !docRegenBlockId || docRegenInFlight.current) return;
    docRegenInFlight.current = true;
    const blockId = docRegenBlockId;
    const fullInstruction = docRegenContext ? `${docRegenContext} ${input}` : input;
    // Close modal immediately & show instruction in canvas
    setDocRegenInstruction(fullInstruction);
    setDocRegenPhase('ai_thinking');
    setDocRegenBlockId(null);
    setDocRegenContext('');
    // Fire regeneration with SSE streaming
    docBlocks.regenerate(docMode.documentFileId, blockId, fullInstruction, (event) => {
      // Handle real-time SSE events
      if (event.type === 'started') setDocRegenPhase('ai_thinking');
      else if (event.type === 'ai_text') setDocRegenPhase('ai_thinking');
      else if (event.type === 'block_updated') {
        // Immediately show new content in canvas (before file patch)
        setDocRegenPhase('patching');
      }
      else if (event.type === 'patching') setDocRegenPhase('patching');
    }).then(() => {
      docRegenInFlight.current = false;
      setDocRegenInstruction('');
      setDocRegenPhase('');
      // Preview refresh is triggered by regenInstruction→'' transition in DocumentCanvas
    }).catch(() => {
      docRegenInFlight.current = false;
      setDocRegenInstruction('');
      setDocRegenPhase('');
    });
  }, [docRegenBlockId, docRegenContext, docMode.documentFileId, docBlocks]);

  // Custom ReactMarkdown components — intercept ```chart and ```mermaid blocks
  // Memoized to prevent chart/map components from re-mounting on every render
  const markdownComponents = useMemo(() => ({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    pre({ children, node, ...props }: any) {
      // Check if this <pre> contains a chart or mermaid code block — unwrap to avoid <pre> wrapper
      const codeEl = node?.children?.[0];
      const cls = codeEl?.properties?.className?.[0] || '';
      if (cls === 'language-chart' || cls === 'language-echart' || cls === 'language-visual' || cls === 'language-mermaid' || cls === 'language-mindmap' || cls === 'language-map' || cls === 'language-gemini-infographic') {
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
      if (className === 'language-echart') {
        return <ChatEChart rawJson={text} />;
      }
      if (className === 'language-visual') {
        return <ChatVisual rawHtml={text} />;
      }
      if (className === 'language-mermaid') {
        // Auto-detect mermaid mindmap → convert to interactive markmap
        if (/^\s*mindmap\b/i.test(text)) {
          return <ChatMindmap code={convertMermaidMindmapToMarkdown(text)} />;
        }
        return <ChatMermaid code={text} />;
      }
      if (className === 'language-mindmap') {
        return <ChatMindmap code={text} />;
      }
      if (className === 'language-map') {
        return <ChatMap rawJson={text} />;
      }
      // Internal infographic directive — don't show the raw JSON to the user.
      if (className === 'language-gemini-infographic') {
        return (
          <span className="inline-flex items-center gap-1.5 text-xs text-on-surface-variant bg-surface-container rounded-full px-3 py-1 my-1">
            <span className="material-symbols-outlined text-[14px] text-primary">image</span>資訊圖表
          </span>
        );
      }
      return <code className={className} {...props}>{children}</code>;
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    table({ children, ...props }: any) {
      return <div className="table-wrapper"><table {...props}>{children}</table></div>;
    },
  }), []);

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
        setConvCategory(data.category || '');
        setMessages(data.messages || []);
        setConversationLoaded(true);
      })
      .catch(() => router.replace('/dashboard'));
  }, [token, conversationId, router]);

  // Load other assistant conversations for @mention picker
  useEffect(() => {
    if (!token || !conversationId || convCategory !== 'assistant') return;
    fetch('/api/conversations?category=assistant', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then((convs: RefConv[]) => setRefAssistants(convs.filter(c => c.id !== conversationId)))
      .catch(() => {});
  }, [token, conversationId, convCategory]);

  // Close ref picker on outside click
  useEffect(() => {
    if (!showRefPicker) return;
    const handler = (e: MouseEvent) => {
      if (!refPickerRef.current?.contains(e.target as Node)) setShowRefPicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showRefPicker]);

  useEffect(() => {
    if (!dataSourceMenuOpen) return;
    const handler = (e: MouseEvent) => {
      if (!dataSourceMenuRef.current?.contains(e.target as Node)) setDataSourceMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dataSourceMenuOpen]);

  const pendingHandled = useRef(false);
  const [backgroundProcessing, setBackgroundProcessing] = useState(false);
  const [bgTasks, setBgTasks] = useState<BgTask[]>([]);

  // Poll status + tasks when user returns to a conversation that's running in background
  useEffect(() => {
    if (!token || !conversationId || !conversationLoaded || streaming) return;
    let cancelled = false;
    let pollInterval: ReturnType<typeof setInterval> | null = null;

    const fetchTasks = () => {
      fetch(`/api/generate/${conversationId}/tasks`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(({ tasks }: { tasks: BgTask[] }) => {
          if (!cancelled) setBgTasks(tasks || []);
        })
        .catch(() => {});
    };

    const stopPolling = (done: boolean) => {
      if (pollInterval) clearInterval(pollInterval);
      clearTimeout(maxTimeout);
      if (cancelled) return;
      setBackgroundProcessing(false);
      setBgTasks([]);
      if (done) {
        fetch(`/api/conversations/${conversationId}`, { headers: { Authorization: `Bearer ${token}` } })
          .then(r => r.json()).then(data => { setMessages(data.messages || []); }).catch(() => {});
        fetch(`/api/files?conversationId=${conversationId}`, { headers: { Authorization: `Bearer ${token}` } })
          .then(r => r.json()).then((f: GeneratedFile[]) => setFiles(f)).catch(() => {});
      }
    };

    // Safety net: auto-clear banner after 20 minutes regardless
    let maxTimeout: ReturnType<typeof setTimeout> = setTimeout(() => stopPolling(false), 20 * 60 * 1000);
    let errorCount = 0;

    fetch(`/api/generate/${conversationId}/status`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(({ processing }: { processing: boolean }) => {
        if (cancelled || !processing) return;
        setBackgroundProcessing(true);
        fetchTasks();
        pollInterval = setInterval(() => {
          fetchTasks();
          fetch(`/api/generate/${conversationId}/status`, { headers: { Authorization: `Bearer ${token}` } })
            .then(r => r.json())
            .then(({ processing: still }: { processing: boolean }) => {
              errorCount = 0;
              if (cancelled) return;
              if (!still) stopPolling(true);
            })
            .catch(() => {
              if (++errorCount >= 3) stopPolling(false); // server unreachable → clear banner
            });
        }, 3000);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (pollInterval) clearInterval(pollInterval);
      clearTimeout(maxTimeout);
    };
  }, [token, conversationId, conversationLoaded, streaming]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load files
  useEffect(() => {
    if (!token || !conversationId) return;
    fetch(`/api/files?conversationId=${conversationId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then((allFiles: GeneratedFile[]) => {
        setFiles(allFiles);
        // Restore latestFiles: only the latest version of each filename from the most recent batch
        if (allFiles.length > 0) {
          const sorted = [...allFiles].sort((a, b) =>
            new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime()
          );
          const latestTime = new Date(sorted[0].created_at || 0).getTime();
          const recentFiles = sorted.filter(f =>
            latestTime - new Date(f.created_at || 0).getTime() < 60000
          );
          // Deduplicate by filename, keep highest version
          const byName = new Map<string, GeneratedFile>();
          for (const f of recentFiles) {
            const existing = byName.get(f.filename);
            if (!existing || (f.version || 1) > (existing.version || 1)) {
              byName.set(f.filename, f);
            }
          }
          setLatestFiles(Array.from(byName.values()));
        }
      })
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

  // Warn user before navigating away while AI is running
  useEffect(() => {
    if (!streaming) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [streaming]);

  const sendMessage = useCallback(async (directMessage?: string, extraUploadIds?: string[], extraDataSources?: string[]) => {
    const messageToSend = directMessage || input.trim();
    if (!messageToSend || streaming || !token) return;

    // Pre-create AudioContext on user gesture (required by browser autoplay policy)
    if (!audioCtxRef.current) {
      try { audioCtxRef.current = new AudioContext(); } catch { /* unsupported */ }
    } else if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume().catch(() => {});
    }

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
    const region = pendingRegion;
    if (region) setPendingRegion(null);
    const refsTag = selectedRefs.length > 0
      ? '\n\n[refs:' + JSON.stringify(selectedRefs.map(r => ({ id: r.id, title: r.title }))) + ']'
      : '';
    // Build a short, human-readable doc context tag for display
    let docTag = '';
    if (docMode.viewMode === 'document' && docMode.documentFileId && docMode.selectedBlockId) {
      const block = docBlocks.blocks.find(b => b.id === docMode.selectedBlockId);
      const pageNum = docBlocks.blocks.findIndex(b => b.id === docMode.selectedBlockId) + 1;
      const title = (block?.data as any)?.title || '';
      const elLabel = docSelectedElement ? ` · ${docSelectedElement}` : '';
      docTag = `[doc:p${pageNum}/${docBlocks.blocks.length}:${block?.type || ''}:${title}${elLabel}]`;
    }
    setMessages(prev => [...prev, {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: (docTag ? docTag + '\n' : '') + userMessage + attachmentNote + refsTag,
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
    setLatestFiles([]);
    setSelectedRefs([]);
    fileGenInRoundRef.current = false;

    // If this conversation uses a file-gen skill, enter document mode immediately
    if (skillId && FILE_GEN_SKILLS.has(skillId)) {
      docMode.enterDocumentMode(skillId);
      setMobileDocView('preview'); // mobile: show preview when entering doc mode
    }

    // Document mode: detect whether message is a QUESTION (→ chat) or EDIT request (→ regeneration)
    const isDocEditMode = docMode.viewMode === 'document' && docMode.documentFileId;

    if (isDocEditMode && docMode.selectedBlockId) {
      // Heuristic: is this a question/inquiry, or an edit request?
      const isQuestion = /[?？]/.test(userMessage.trim()) ||
        /(?:什麼|甚麼|是什麼|是甚麼|嗎|呢|是否|能不能|可不可以|有沒有|怎麼|如何|為什麼|為何|哪個|哪些|誰|幾|看到|看看|描述|解釋|告訴|說明|內容是|寫了|寫什麼|寫甚麼)/.test(userMessage);
      const hasEditIntent = /(?:改|修改|換|更新|調整|變|設定|加入|加上|刪|移除|增加|替換|修正|優化|重做|改成|換成|變成|新增|把.*改|把.*換|把.*變|將.*改|將.*換)/.test(userMessage);

      // Edit request (or not a question) → fast single-block regeneration
      if (!isQuestion || hasEditIntent) {
        const blockId = docMode.selectedBlockId;
        const pageNum = docBlocks.blocks.findIndex(b => b.id === blockId) + 1;
        const elementHint = docSelectedElement ? `[目標元素: ${docSelectedElement}] ` : '';
        // Include shapes context in instruction so AI knows what's on the slide
        const shapesHint = docSlideShapes.length > 0
          ? `[投影片元素: ${docSlideShapes.map(s => `${s.name}(${s.type})`).join(', ')}] `
          : '';
        const instruction = `${shapesHint}${elementHint}${userMessage}`;
        setDocRegenInstruction(userMessage);
        setDocRegenPhase('ai_thinking');
        docBlocks.regenerate(docMode.documentFileId!, blockId, instruction, (event) => {
          if (event.type === 'started') setDocRegenPhase('ai_thinking');
          else if (event.type === 'ai_text') setDocRegenPhase('ai_thinking');
          else if (event.type === 'block_updated') setDocRegenPhase('patching');
          else if (event.type === 'patching') setDocRegenPhase('patching');
        }).then(() => {
          setMessages(prev => [...prev, {
            id: `regen-${Date.now()}`,
            conversation_id: conversationId,
            role: 'assistant',
            content: t('chat.docMode.blockUpdated') + ` (第 ${pageNum} 頁)`,
            created_at: new Date().toISOString(),
          }]);
        }).catch(() => {
          setMessages(prev => [...prev, {
            id: `err-${Date.now()}`,
            conversation_id: conversationId,
            role: 'assistant',
            content: `⚠️ ${t('chat.error.unknown')}`,
            created_at: new Date().toISOString(),
          }]);
        }).finally(() => {
          setDocRegenInstruction('');
          setDocRegenPhase('');
          setStreaming(false);
        });
        return; // Skip normal generate flow
      }

      // Question (no edit intent) → answer about THIS block only, WITHOUT touching
      // the file. Routing to /api/generate would re-run the file-gen agent and
      // could regenerate/shrink the whole document — so we use a read-only Q&A.
      {
        const blockId = docMode.selectedBlockId;
        const elementHint = docSelectedElement ? `[目標元素: ${docSelectedElement}] ` : '';
        const shapesHint = docSlideShapes.length > 0
          ? `[投影片元素: ${docSlideShapes.map(s => `${s.name}(${s.type})`).join(', ')}] `
          : '';
        const instruction = `${shapesHint}${elementHint}${userMessage}`;
        let acc = '';
        setStreamText('');
        try {
          await docBlocks.askBlock(docMode.documentFileId!, blockId, instruction, (delta) => {
            acc += delta;
            setStreamText(acc);
          });
        } catch {
          acc = acc || `⚠️ ${t('chat.error.unknown')}`;
        }
        setMessages(prev => [...prev, {
          id: `ans-${Date.now()}`,
          conversation_id: conversationId,
          role: 'assistant',
          content: acc || '（沒有內容）',
          created_at: new Date().toISOString(),
        }]);
        setStreamText('');
        setStreaming(false);
        return; // Skip normal generate flow — questions never regenerate the file
      }
    }

    // Document mode context: send as separate field (not embedded in message text)
    let docContext = '';
    if (isDocEditMode) {
      if (docMode.selectedBlockId) {
        const block = docBlocks.blocks.find(b => b.id === docMode.selectedBlockId);
        const pageNum = docBlocks.blocks.findIndex(b => b.id === docMode.selectedBlockId) + 1;
        const elementInfo = docSelectedElement ? `，使用者選取了元素「${docSelectedElement}」` : '';
        const shapesInfo = docSlideShapes.length > 0
          ? `\n投影片上的視覺元素: ${docSlideShapes.map(s => `${s.name}(${s.type})`).join(', ')}`
          : '';
        docContext = `使用者正在查看第 ${pageNum}/${docBlocks.blocks.length} 頁 (${block?.type || 'unknown'})${elementInfo}。該頁數據: ${JSON.stringify(block?.data)}${shapesInfo}`;
      } else {
        const blockSummary = docBlocks.blocks.map((b, i) => `#${i + 1} ${b.type}: ${(b.data as any).title || ''}`).join(', ');
        docContext = `正在編輯 ${docMode.docLayoutType || 'document'} 文件，共 ${docBlocks.blocks.length} 頁: ${blockSummary}`;
      }
    }

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
          ...(docContext && { docContext }),
          ...(skillId && { skillId }),
          ...(currentUploadIds.length > 0 && { uploadIds: currentUploadIds }),
          ...(selectedRefs.length > 0 && { referencedConvIds: selectedRefs.map(r => r.id) }),
          ...(region && { regionMask: region.mask, regionFileId: region.fileId }),
          ...((extraDataSources && extraDataSources.length > 0 ? extraDataSources : selectedDataSources).length > 0 && {
            dataSources: extraDataSources && extraDataSources.length > 0 ? extraDataSources : selectedDataSources,
          }),
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
              // Track latest generation for inline preview (deduplicate by filename, keep latest version)
              setLatestFiles(prev => {
                const updated = [...prev];
                for (const nf of newFiles) {
                  const existingIdx = updated.findIndex(f => f.filename === nf.filename);
                  if (existingIdx >= 0) {
                    updated[existingIdx] = nf;
                  } else {
                    updated.push(nf);
                  }
                }
                return updated;
              });
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
            // Document mode SSE events
            if (event.type === 'router_plan' || event.type === 'task_dispatched' || event.type === 'skill_started' || event.type === 'blocks_ready' || event.type === 'file_generated') {
              docMode.handleSSEEvent(event);
            }
            // Track if file was generated this round
            if (event.type === 'file_generated') {
              fileGenInRoundRef.current = true;
            }
            // When blocks_ready arrives, set blocks immediately from SSE data
            if (event.type === 'blocks_ready') {
              const bData = event.data as { fileId: string; blocks: any[] };
              if (bData.fileId && bData.blocks) {
                docBlocks.setBlocksFromSSE({ fileId: bData.fileId, blocks: bData.blocks });
                // SSE only carries blocks, not the full record (docType, etc.).
                // Load it too so toolbar features keyed on docType (e.g. the 播報
                // button) appear immediately instead of only after a refresh.
                docBlocks.fetchBlocks(bData.fileId);
              } else if (bData.fileId) {
                docBlocks.fetchBlocks(bData.fileId);
              }
            }

            if (event.type === 'error') {
              const errMsg = typeof event.data === 'string' ? event.data : 'Unknown error';
              fullText += `\n\n> **${t('chat.error.prefix')}:** ${errMsg}`;
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
              // Auto-exit document mode if no file was generated this round
              docMode.onGenerationDone(fileGenInRoundRef.current);
              fileGenInRoundRef.current = false;
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
      // Play notification sound when task completes (uses pre-created AudioContext)
      try {
        const ctx = audioCtxRef.current;
        if (ctx && ctx.state === 'running') {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          osc.connect(gain);
          gain.connect(ctx.destination);
          osc.frequency.setValueAtTime(880, ctx.currentTime);
          osc.frequency.setValueAtTime(1047, ctx.currentTime + 0.1);
          gain.gain.setValueAtTime(0.15, ctx.currentTime);
          gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
          osc.start(ctx.currentTime);
          osc.stop(ctx.currentTime + 0.3);
        }
      } catch { /* audio not available */ }
      // Reload sidebar uploads — dashboard uploads now linked to this conversation
      reloadConversationUploads();
    }
  }, [input, streaming, token, conversationId, skillId, attachedFiles, pendingTemplate, pendingRegion, t, reloadConversationUploads]);

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

      // Restore the data sources picked on the dashboard so the first run uses them
      // (and reflect them in the selector chip). Passed explicitly to sendMessage to
      // avoid a stale-closure read of the just-set state.
      let pendingDs: string[] = [];
      const dsKey = `pending_datasources_${conversationId}`;
      const pendingDsRaw = sessionStorage.getItem(dsKey);
      if (pendingDsRaw) {
        sessionStorage.removeItem(dsKey);
        try {
          pendingDs = JSON.parse(pendingDsRaw) as string[];
          if (pendingDs.length > 0) setSelectedDataSources(pendingDs);
        } catch { /* ignore parse errors */ }
      }

      // Restore uploaded files from dashboard smart input
      const uploadsKey = `pending_uploads_${conversationId}`;
      const pendingUploads = sessionStorage.getItem(uploadsKey);
      if (pendingUploads) {
        sessionStorage.removeItem(uploadsKey);
        try {
          const files = JSON.parse(pendingUploads) as Array<{ id: string; name: string }>;
          const uploadIds = files.map(f => f.id);
          sendMessage(pending, uploadIds, pendingDs);
          return;
        } catch { /* ignore parse errors */ }
      }
      sendMessage(pending, undefined, pendingDs);
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
      const res = await fetch(`${SSE_BASE}/api/files/${fileId}/download`, {
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
      // Use /preview for all types — it converts Office files to PDF/HTML
      const res = await fetch(`${SSE_BASE}/api/files/${file.id}/preview?editing=1`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('Preview fetch failed');
      const contentType = res.headers.get('Content-Type') || 'application/octet-stream';
      const blob = await res.blob();
      const url = URL.createObjectURL(new Blob([blob], { type: contentType }));
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
    const realFileId = dropdownKey.replace(/^(preview|sidebar|mobile)-/, '');
    if (!versionCache[realFileId]) {
      try {
        const res = await fetch(`${SSE_BASE}/api/files/${realFileId}/versions`, {
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
    if (s < 60) return t('chat.time.seconds', { n: s } as any);
    return t('chat.time.minutes', { m: Math.floor(s / 60), s: s % 60 } as any);
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

      {/* Share Modal */}
      {showShareModal && conversationId && (
        <ShareModal conversationId={conversationId} onClose={() => setShowShareModal(false)} />
      )}

      <div className={`${sidebarMargin} h-[100svh] md:h-screen flex overflow-hidden transition-all duration-300`}>
        {/* === Central Chat Area === */}
        <section
          className={`flex flex-col min-h-0 min-w-0 transition-all duration-300 ${
            docMode.viewMode === 'document'
              ? docChatCollapsed
                ? 'w-0 overflow-hidden'
                : mobileDocView === 'preview'
                  ? 'hidden sm:flex min-w-[280px]'
                  : 'flex-1 sm:flex min-w-[280px]'
              : 'flex-1'
          }`}
          style={docMode.viewMode === 'document' && !docChatCollapsed ? { width: `${docChatWidth}%` } : undefined}
        >
          {/* Title Bar */}
          <header className={`flex items-center gap-2 px-3 h-11 bg-surface/80 backdrop-blur-xl shrink-0 border-b border-outline-variant/10 ${docMode.viewMode === 'chat' ? 'md:gap-4 md:px-8 md:h-14' : ''}`}>
            <button
              onClick={() => router.push(convCategory === 'assistant' ? '/assistant' : '/conversations')}
              className="text-on-surface-variant hover:text-on-surface active:text-on-surface transition-colors bg-transparent cursor-pointer p-1"
            >
              <span className="material-symbols-outlined text-sm">arrow_back</span>
            </button>
            <h2 className="text-xs md:text-sm font-headline font-bold text-on-surface truncate">{title}</h2>
            {skillId && (
              <span className="text-[10px] md:text-sm px-1.5 md:px-2 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-wider uppercase shrink-0">
                {skillId.replace('-gen', '')}
              </span>
            )}
            <span className="flex-1" />
            {/* Mobile: switch to preview in doc mode */}
            {docMode.viewMode === 'document' && mobileDocView === 'chat' && (
              <button
                onClick={() => setMobileDocView('preview')}
                className="sm:hidden p-1 text-on-surface-variant active:text-primary transition-colors bg-transparent cursor-pointer shrink-0"
                title="切換至預覽"
              >
                <span className="material-symbols-outlined text-sm">visibility</span>
              </button>
            )}
            {/* Document mode toggle */}
            {files.length > 0 && docMode.viewMode === 'chat' && (
              <button
                onClick={() => {
                  const latestFile = files[files.length - 1];
                  docMode.manualToggle(latestFile?.id, latestFile?.file_type);
                  if (latestFile) docBlocks.fetchBlocks(latestFile.id);
                }}
                className="hidden md:flex items-center gap-1 px-2 py-1 text-on-surface-variant hover:text-primary hover:bg-primary/5 active:text-primary transition-colors bg-transparent cursor-pointer shrink-0 rounded-lg text-xs"
                title={t('chat.docMode.enter')}
              >
                <span className="material-symbols-outlined text-sm">vertical_split</span>
                <span className="hidden lg:inline">{t('chat.docMode.enter')}</span>
              </button>
            )}
            {/* Share button */}
            <button
              onClick={() => setShowShareModal(true)}
              className="p-1 text-on-surface-variant hover:text-primary active:text-primary transition-colors bg-transparent cursor-pointer shrink-0"
              title={t('share.button' as any)}
            >
              <span className="material-symbols-outlined text-base">share</span>
            </button>
            {/* Mobile: file drawer toggle */}
            {(files.length > 0 || conversationUploads.length > 0) && (
              <button
                onClick={() => setMobileFilesOpen(true)}
                className="lg:hidden relative p-1 text-on-surface-variant active:text-primary transition-colors bg-transparent cursor-pointer shrink-0"
              >
                <span className="material-symbols-outlined text-base">folder_open</span>
                {files.length > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-primary text-on-primary text-[9px] font-bold rounded-full flex items-center justify-center">
                    {files.length}
                  </span>
                )}
              </button>
            )}
            {streaming && (
              <span className="text-xs md:text-sm px-1.5 md:px-2 py-0.5 bg-surface-container-high text-primary rounded font-mono shrink-0">
                {formatElapsed(elapsed)}
              </span>
            )}
          </header>

          {/* Background processing indicator */}
          {backgroundProcessing && !streaming && (
            <div className={`mx-3 mt-2 px-3 py-2 bg-primary/8 border border-primary/15 rounded-lg ${docMode.viewMode === 'chat' ? 'md:mx-8' : ''}`}>
              <div className="flex items-center gap-1.5 flex-wrap overflow-hidden">
                <span className="material-symbols-outlined text-sm animate-spin text-primary/60 shrink-0">progress_activity</span>
                <span className="text-xs text-primary/60 mr-1">{t('chat.backgroundProcessing' as any)}</span>
                {bgTasks.map(task => {
                  const isDone = task.status === 'completed';
                  const isFail = task.status === 'failed';
                  const skillIcon = SKILL_ICONS[task.skill_id] || 'smart_toy';
                  const skillName = (t(`skill.${task.skill_id}` as any) as string) || task.skill_id;
                  return (
                    <span key={task.id} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[11px] font-medium whitespace-nowrap max-w-[140px] ${
                      isDone ? 'bg-success/10 text-success' :
                      isFail ? 'bg-error/10 text-error' :
                      'bg-primary/10 text-primary'
                    }`}>
                      <span className={`material-symbols-outlined shrink-0 ${!isDone && !isFail ? 'animate-spin' : ''}`} style={{ fontSize: '11px' }}>
                        {isDone ? 'check_circle' : isFail ? 'error' : skillIcon}
                      </span>
                      <span className="truncate">{skillName}</span>
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Messages */}
          <div className={`flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 space-y-4 ${docMode.viewMode === 'chat' ? 'md:px-8 md:py-8 md:space-y-8' : 'space-y-3'}`}>
            {messages.map((msg, idx) => {
              const sources = msg.role === 'assistant' ? extractSources(msg.content) : [];
              // Parse doc context tag [doc:p3/9:stats:Title · Element] and legacy [DOC_CONTEXT:...]
              let docChip: { page: string; type: string; title: string; element?: string } | null = null;
              let cleanedContent = msg.content;
              if (msg.role === 'user') {
                // New format: [doc:p3/9:stats:Title · Element]
                const docTagMatch = cleanedContent.match(/^\[doc:p(\d+\/\d+):([^:]*):([^\]]*)\]\n?/);
                if (docTagMatch) {
                  const [, page, type, rest] = docTagMatch;
                  const parts = rest.split(' · ');
                  docChip = { page, type, title: parts[0] || '', element: parts[1] };
                  cleanedContent = cleanedContent.slice(docTagMatch[0].length);
                }
                // Legacy format: [DOC_CONTEXT: ...]
                const legacyMatch = cleanedContent.match(/^\[DOC_CONTEXT:[\s\S]*?\]\n\n/);
                if (legacyMatch) {
                  cleanedContent = cleanedContent.slice(legacyMatch[0].length);
                }
              }
              const { text: userMsgText, refs: userMsgRefs } = msg.role === 'user'
                ? parseMessageRefs(cleanedContent)
                : { text: msg.content, refs: [] };
              return (
                <div key={msg.id} className={msg.role === 'user' ? 'flex flex-col items-end' : `flex gap-2 ${docMode.viewMode === 'chat' ? 'md:gap-4' : ''}`}>
                  {msg.role === 'assistant' && (
                    <div className={`w-7 h-7 shrink-0 bg-primary-container border border-primary/20 flex items-center justify-center rounded-lg ${docMode.viewMode === 'chat' ? 'md:w-9 md:h-9' : ''}`}>
                      <span className={`material-symbols-outlined text-primary text-xs ${docMode.viewMode === 'chat' ? 'md:text-sm' : ''}`} style={{ fontVariationSettings: "'FILL' 1" }}>smart_toy</span>
                    </div>
                  )}
                  <div className={
                    msg.role === 'user'
                      ? `max-w-[85%] bg-surface-container px-3.5 py-3 rounded-xl rounded-tr-sm text-on-surface shadow-lg ${docMode.viewMode === 'chat' ? 'md:max-w-[70%] md:px-5 md:py-4' : ''}`
                      : `max-w-[90%] min-w-0 ${docMode.viewMode === 'chat' ? 'md:max-w-[85%]' : ''}`
                  }>
                    {msg.role === 'user' ? (
                      <>
                        {docChip && (
                          <div className="flex items-center gap-1 mb-1.5 text-[11px] text-on-surface-variant/70">
                            <span className="material-symbols-outlined text-xs" style={{ fontVariationSettings: "'FILL' 1" }}>description</span>
                            <span>第 {docChip.page} 頁</span>
                            {docChip.title && <span className="truncate max-w-[120px]">· {docChip.title}</span>}
                            {docChip.element && <span className="text-primary/70">· {docChip.element}</span>}
                          </div>
                        )}
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{userMsgText}</p>
                        {userMsgRefs.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {userMsgRefs.map(ref => (
                              <div key={ref.id} className="flex items-center gap-1 px-2 py-0.5 rounded text-xs border bg-secondary/10 border-secondary/20 text-secondary">
                                <span className="material-symbols-outlined text-xs" style={{ fontVariationSettings: "'FILL' 1" }}>psychology</span>
                                <span className="max-w-[120px] truncate">{ref.title}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        <span className="block mt-1.5 md:mt-2 text-xs md:text-sm text-outline">
                          {new Date(msg.created_at).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </>
                    ) : (
                      <div className={`bg-surface-container-low px-3.5 py-3 rounded-xl rounded-tl-sm border border-outline-variant/10 overflow-hidden ${docMode.viewMode === 'chat' ? 'md:px-5 md:py-4' : ''}`}>
                        {(() => {
                          const { text: msgText, choices } = parseChoices(msg.content);
                          const isLatestMsg = idx === messages.length - 1;
                          return (
                            <>
                              <div className="chat-markdown text-sm leading-relaxed text-on-surface-variant">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{msgText}</ReactMarkdown>
                              </div>
                              {choices.length > 0 && isLatestMsg && !streaming && (
                                <div className="flex flex-wrap gap-2 mt-3 pt-3 border-t border-outline-variant/10">
                                  {choices.map((choice, ci) => (
                                    <button
                                      key={ci}
                                      onClick={() => sendMessage(choice)}
                                      className="px-3.5 py-2 text-sm rounded-lg border border-primary/30 bg-primary/5 text-primary hover:bg-primary/15 hover:border-primary/50 active:bg-primary/20 transition-colors cursor-pointer"
                                    >
                                      {choice}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </>
                          );
                        })()}
                        {sources.length > 0 && (
                          <details className="mt-2 md:mt-3 border-t border-outline-variant/10 pt-2">
                            <summary className="text-xs md:text-sm text-primary cursor-pointer font-bold uppercase tracking-wider">
                              {t('chat.sources', { count: sources.length })}
                            </summary>
                            <div className="flex flex-col gap-1.5 mt-2">
                              {sources.map((src, i) => (
                                <a key={i} href={src.url} target="_blank" rel="noopener noreferrer"
                                  className="flex items-center gap-2 px-2 md:px-3 py-1.5 md:py-2 bg-surface-container rounded text-xs md:text-sm active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors no-underline">
                                  <span className="material-symbols-outlined text-primary text-xs md:text-sm">link</span>
                                  <span className="text-on-surface truncate flex-1">{src.title}</span>
                                  <span className="text-outline text-xs md:text-sm shrink-0 hidden md:inline">{new URL(src.url).hostname}</span>
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
              <div className={`flex gap-2 ${docMode.viewMode === 'chat' ? 'md:gap-4' : ''}`}>
                <div className={`w-7 h-7 shrink-0 bg-primary-container border border-primary/20 flex items-center justify-center rounded-lg ${docMode.viewMode === 'chat' ? 'md:w-9 md:h-9' : ''}`}>
                  <span className={`material-symbols-outlined text-primary text-xs ${docMode.viewMode === 'chat' ? 'md:text-sm' : ''}`} style={{ fontVariationSettings: "'FILL' 1" }}>smart_toy</span>
                </div>
                <div className={`max-w-[90%] min-w-0 ${docMode.viewMode === 'chat' ? 'md:max-w-[85%]' : ''}`}>
                  <div className={`bg-surface-container-low px-3.5 py-3 rounded-xl rounded-tl-sm border border-primary/20 border-dashed overflow-hidden ${docMode.viewMode === 'chat' ? 'md:px-5 md:py-4' : ''}`}>
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
              <div className={`bg-surface-container-low rounded-lg border-l-2 border-primary/40 max-w-full overflow-hidden ${docMode.viewMode === 'chat' ? 'md:max-w-[85%]' : ''}`}>
                <div
                  className={`flex items-center gap-2 px-3 py-2.5 bg-surface-container cursor-pointer select-none active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors ${docMode.viewMode === 'chat' ? 'md:gap-3 md:px-4 md:py-3' : ''}`}
                  onClick={() => setPanelCollapsed(c => !c)}
                  role="button"
                  tabIndex={0}
                >
                  {streaming
                    ? <span className="w-2 h-2 rounded-full bg-primary animate-pulse shrink-0" />
                    : <span className="material-symbols-outlined text-sm text-green-400">check_circle</span>
                  }
                  <span className="text-xs md:text-sm font-headline font-bold text-on-surface uppercase tracking-wider flex-1 truncate">
                    {streaming ? t('chat.processing.title') : t('chat.processing.completed')}
                    {panelCollapsed && tools.length > 0 && (
                      <span className="font-normal text-on-surface-variant ml-1.5 md:ml-2">
                        {completedTools}/{tools.length}
                        {webSearchTools.length > 0 && ` · ${webSearchTools.length}`}
                      </span>
                    )}
                  </span>
                  <span className="text-xs md:text-sm font-mono text-primary shrink-0">{formatElapsed(elapsed)}</span>
                  <span className={`material-symbols-outlined text-sm text-on-surface-variant transition-transform ${panelCollapsed ? '-rotate-90' : ''}`}>
                    expand_more
                  </span>
                </div>

                {!panelCollapsed && (
                  <>
                    <div className={`px-3 py-2 space-y-1 font-mono text-xs ${docMode.viewMode === 'chat' ? 'md:px-4 md:text-sm' : ''}`}>
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
                        const baseTool = tool.tool.includes(':') ? tool.tool.split(':')[1] : tool.tool;
                        const askOptions = baseTool === 'AskUserQuestion' ? parseAskUserOptions(tool.input) : null;
                        return (
                          <div key={tool.id || i}>
                            <div className={`flex items-center gap-2 px-2 py-1.5 rounded whitespace-nowrap overflow-hidden ${isDone ? 'text-outline' : 'text-on-surface-variant bg-surface-container/50'}`}>
                              {isDone
                                ? <span className="material-symbols-outlined text-green-400 text-sm shrink-0">check_circle</span>
                                : <span className="material-symbols-outlined text-primary text-sm animate-spin shrink-0">refresh</span>
                              }
                              <span className="material-symbols-outlined text-sm shrink-0">{info.icon}</span>
                              <span className={`shrink-0 ${isDone ? 'line-through opacity-60' : ''}`}>{info.label}</span>
                              {detail && (
                                <span className="text-primary bg-surface-container px-1.5 py-0.5 rounded text-sm truncate min-w-0">
                                  {detail}
                                </span>
                              )}
                            </div>
                            {/* AskUserQuestion interactive options */}
                            {askOptions && !streaming && (
                              <div className="mt-2 ml-6 space-y-3">
                                {askOptions.map((q, qi) => (
                                  <div key={qi} className="space-y-2">
                                    <p className="text-sm text-on-surface-variant font-medium">{q.question}</p>
                                    <div className="flex flex-wrap gap-2">
                                      {q.options.map((opt, oi) => (
                                        <button
                                          key={oi}
                                          onClick={() => sendMessage(opt.label)}
                                          className="px-3 py-1.5 text-sm rounded-lg border border-primary/30 bg-primary/5 text-primary hover:bg-primary/15 hover:border-primary/50 transition-colors cursor-pointer"
                                          title={opt.description}
                                        >
                                          {opt.label}
                                        </button>
                                      ))}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}

                      {/* Agent tasks */}
                      {agentTasks.map(task => (
                        <div
                          key={task.taskId}
                          className={`flex items-center gap-2 px-2 py-1.5 rounded whitespace-nowrap overflow-hidden ${
                            task.status === 'completed' ? 'text-outline'
                            : task.status === 'failed' ? 'text-warning bg-warning/5'
                            : 'text-on-surface-variant bg-surface-container/50'
                          }`}
                        >
                          {task.status === 'completed'
                            ? <span className="material-symbols-outlined text-green-400 text-sm shrink-0">check_circle</span>
                            : task.status === 'failed'
                            ? <span className="material-symbols-outlined text-warning text-sm shrink-0">warning</span>
                            : <span className="material-symbols-outlined text-primary text-sm animate-spin shrink-0">refresh</span>
                          }
                          <span className="material-symbols-outlined text-sm shrink-0">smart_toy</span>
                          <span className="shrink-0">{t(`skill.${task.skillId}` as any) || task.skillId}</span>
                          <span className="text-primary bg-surface-container px-1.5 py-0.5 rounded text-sm truncate min-w-0">
                            {task.status === 'failed'
                              ? (task.error || t('chat.error.timedOut')).substring(0, 50)
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
                      <div className="flex items-center justify-between px-3 md:px-4 py-2 border-t border-outline-variant/10 text-xs md:text-sm text-outline gap-2">
                        <span className="truncate">{t('chat.token.usage', { input: lastUsage.inputTokens.toLocaleString(), output: lastUsage.outputTokens.toLocaleString() } as any)}
                          <span className="ml-1 md:ml-2 text-primary/70">${calcCostUsd(lastUsage.inputTokens, lastUsage.outputTokens).toFixed(4)}</span>
                        </span>
                        {lastUsage.model && (
                          <span className="px-1.5 md:px-2 py-0.5 bg-primary/10 text-primary rounded text-xs md:text-sm shrink-0">
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

            {/* Inline File Preview — only show files from latest generation (hidden in document mode) */}
            {latestFiles.length > 0 && !streaming && docMode.viewMode !== 'document' && (
              <div className="max-w-full md:max-w-[85%] space-y-3 ml-0 md:ml-13">
                {latestFiles.map(file => (
                  <div key={file.id} className="bg-surface-container-low rounded-xl border border-outline-variant/10 overflow-visible">
                    {/* File cover: iframe preview for PDF/HTML, styled card for Office */}
                    {IFRAME_PREVIEWABLE.has(file.file_type) || file.file_type === 'html' ? (
                      <FileThumbnail file={file} token={token!} onClick={() => openPreview(file)} />
                    ) : CARD_PREVIEWABLE.has(file.file_type) ? (
                      <FileTypeCover file={file} onClick={() => openPreview(file)} />
                    ) : null}
                    {/* Other file types — card only */}
                    <div className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2.5 md:py-3">
                      <div className={`w-8 h-8 md:w-10 md:h-10 rounded-lg flex items-center justify-center shrink-0 ${
                        file.file_type === 'html' ? 'bg-secondary/10' :
                        file.file_type === 'pdf' ? 'bg-error/10' :
                        file.file_type === 'pptx' ? 'bg-warning/10' :
                        file.file_type === 'xlsx' ? 'bg-success/10' :
                        'bg-tertiary/10'
                      }`}>
                        <span className={`material-symbols-outlined ${getFileColor(file.file_type)} text-base md:text-xl`}>
                          {getFileIcon(file.file_type)}
                        </span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs md:text-sm font-medium text-on-surface block truncate">{file.filename}</span>
                        <span className="text-xs md:text-sm text-outline">
                          {file.file_type.toUpperCase()} · {formatSize(file.file_size)}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 md:gap-1">
                        {/* Version selector */}
                        <div className="relative" data-version-dropdown>
                          <button
                            onClick={() => toggleVersionDropdown(file.id)}
                            className={`flex items-center gap-0.5 md:gap-1 px-1.5 md:px-2 py-1 rounded-lg text-[10px] md:text-xs font-bold transition-colors cursor-pointer ${
                              versionDropdown === file.id
                                ? 'bg-primary/20 text-primary'
                                : 'bg-primary/10 text-primary active:bg-primary/20 md:hover:bg-primary/20'
                            }`}
                            title={t('chat.preview.versions' as any)}
                          >
                            <span>v{file.version || 1}</span>
                            <span className="material-symbols-outlined text-[10px] md:text-xs">expand_more</span>
                          </button>
                          {versionDropdown === file.id && versionCache[file.id] && (
                            <div className="absolute right-0 top-full mt-2 z-50 bg-surface-container border border-outline-variant/20 rounded-xl shadow-xl min-w-[200px] md:min-w-[260px] py-1.5 max-h-[7.5rem] overflow-y-auto">
                              {versionCache[file.id].map((ver, idx) => (
                                <button
                                  key={ver.id}
                                  onClick={() => switchToVersion(ver)}
                                  className={`w-full flex items-center gap-2 md:gap-3 px-2.5 md:px-3 py-1.5 md:py-2 text-left active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors cursor-pointer ${
                                    ver.id === file.id ? 'bg-primary/10' : ''
                                  }`}
                                >
                                  <span className={`text-[10px] md:text-xs font-bold px-1 md:px-1.5 py-0.5 rounded ${
                                    ver.id === file.id ? 'bg-primary text-on-primary' : 'bg-surface-container-highest text-on-surface-variant'
                                  }`}>
                                    v{ver.version || 1}
                                  </span>
                                  <div className="flex-1 min-w-0">
                                    <span className="text-[10px] md:text-xs text-on-surface-variant block">
                                      {formatSize(ver.file_size)}
                                      {idx === 0 && <span className="ml-1 text-primary font-bold">{t('chat.preview.latestVersion' as any)}</span>}
                                    </span>
                                    <span className="text-[10px] md:text-xs text-outline block">
                                      {new Date(ver.created_at || '').toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                    </span>
                                  </div>
                                  {ver.id === file.id && (
                                    <span className="material-symbols-outlined text-primary text-xs md:text-sm">check</span>
                                  )}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        {file.file_type === 'html' && (
                          <button
                            onClick={() => openPreview(file)}
                            className="p-1.5 md:p-2 rounded-lg active:bg-surface-container-high md:hover:bg-surface-container-high text-on-surface-variant active:text-primary md:hover:text-primary transition-colors cursor-pointer"
                            title={t('chat.preview.fullscreen' as any)}
                          >
                            <span className="material-symbols-outlined text-base md:text-lg">fullscreen</span>
                          </button>
                        )}
                        {FILE_TYPE_TO_LAYOUT[file.file_type] && (
                          <div className="relative">
                            <button
                              onClick={() => {
                                dismissEditHint();
                                docMode.manualToggle(file.id, file.file_type);
                                docBlocks.fetchBlocks(file.id);
                              }}
                              className="flex items-center gap-1 pl-1.5 pr-2 md:pl-2 md:pr-2.5 py-1.5 rounded-lg text-xs md:text-sm font-bold bg-primary/10 text-primary active:bg-primary/20 md:hover:bg-primary/20 transition-colors cursor-pointer"
                              title={t('editor.openEditor' as any)}
                            >
                              <span className="material-symbols-outlined text-base md:text-lg">edit_note</span>
                              <span>{t('editor.editButton' as any)}</span>
                            </button>
                            {/* One-time coachmark — only on the newest editable file */}
                            {showEditHint && file.id === latestFiles.find(f => FILE_TYPE_TO_LAYOUT[f.file_type])?.id && (
                              <div className="absolute right-0 top-full mt-2 z-50 w-56 md:w-64 bg-primary text-on-primary rounded-lg shadow-xl p-3 animate-in">
                                <div className="absolute -top-1.5 right-5 w-3 h-3 bg-primary rotate-45" />
                                <div className="flex items-start gap-2">
                                  <span className="material-symbols-outlined text-base shrink-0">tips_and_updates</span>
                                  <p className="text-xs leading-relaxed flex-1">{t('editor.editHint' as any)}</p>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); dismissEditHint(); }}
                                    className="shrink-0 -mt-0.5 -mr-1 p-0.5 rounded hover:bg-white/20 cursor-pointer"
                                    aria-label="close"
                                  >
                                    <span className="material-symbols-outlined text-sm">close</span>
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                        <button
                          onClick={() => handleDownload(file.id, file.filename)}
                          className="p-1.5 md:p-2 rounded-lg active:bg-surface-container-high md:hover:bg-surface-container-high text-on-surface-variant active:text-primary md:hover:text-primary transition-colors cursor-pointer"
                          title={t('chat.preview.download' as any)}
                        >
                          <span className="material-symbols-outlined text-base md:text-lg">download</span>
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
              <div className="flex items-center justify-between px-3 md:px-6 py-2 md:py-3 bg-surface/90 border-b border-outline-variant/20 gap-2">
                <div className="flex items-center gap-2 md:gap-3 min-w-0 flex-1">
                  <span className={`material-symbols-outlined ${getFileColor(previewFile.file_type)} text-base md:text-xl shrink-0`}>
                    {getFileIcon(previewFile.file_type)}
                  </span>
                  <span className="text-xs md:text-base text-on-surface font-medium truncate">{previewFile.filename}</span>
                  <span className="text-xs md:text-sm text-outline shrink-0 hidden md:inline">{formatSize(previewFile.file_size)}</span>
                  {/* Version selector in fullscreen */}
                  <div className="relative" data-version-dropdown>
                    <button
                      onClick={() => toggleVersionDropdown(`preview-${previewFile.id}`)}
                      className={`flex items-center gap-0.5 md:gap-1 px-1.5 md:px-2.5 py-1 rounded-lg text-[10px] md:text-xs font-bold transition-colors cursor-pointer ${
                        versionDropdown === `preview-${previewFile.id}`
                          ? 'bg-primary/30 text-primary'
                          : 'bg-primary/15 text-primary active:bg-primary/25 md:hover:bg-primary/25'
                      }`}
                    >
                      <span>v{previewFile.version || 1}</span>
                      <span className="material-symbols-outlined text-[10px] md:text-xs">expand_more</span>
                    </button>
                    {versionDropdown === `preview-${previewFile.id}` && (versionCache[previewFile.id] || versionCache[`preview-${previewFile.id}`]) && (
                      <div className="absolute left-0 top-full mt-2 z-50 bg-surface-container border border-outline-variant/20 rounded-xl shadow-xl min-w-[180px] md:min-w-[220px] py-1.5 max-h-[7.5rem] overflow-y-auto">
                        {(versionCache[previewFile.id] || []).map((ver, idx) => (
                          <button
                            key={ver.id}
                            onClick={() => { switchToVersion(ver); openPreview(ver); }}
                            className={`w-full flex items-center gap-2 md:gap-3 px-2.5 md:px-3 py-1.5 md:py-2 text-left active:bg-surface-container-high md:hover:bg-surface-container-high transition-colors cursor-pointer ${
                              ver.id === previewFile.id ? 'bg-primary/10' : ''
                            }`}
                          >
                            <span className={`text-[10px] md:text-xs font-bold px-1 md:px-1.5 py-0.5 rounded ${
                              ver.id === previewFile.id ? 'bg-primary text-on-primary' : 'bg-surface-container-highest text-on-surface-variant'
                            }`}>
                              v{ver.version || 1}
                            </span>
                            <div className="flex-1 min-w-0">
                              <span className="text-[10px] md:text-xs text-on-surface-variant block">
                                {formatSize(ver.file_size)}
                                {idx === 0 && <span className="ml-1 text-primary font-bold">{t('chat.preview.latestVersion' as any)}</span>}
                              </span>
                              <span className="text-[10px] md:text-xs text-outline block">
                                {new Date(ver.created_at || '').toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                            {ver.id === previewFile.id && (
                              <span className="material-symbols-outlined text-primary text-xs md:text-sm">check</span>
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 md:gap-2 shrink-0">
                  <button
                    onClick={() => handleDownload(previewFile.id, previewFile.filename)}
                    className="flex items-center gap-1 md:gap-1.5 px-2 md:px-3 py-1.5 rounded-lg bg-primary/10 text-primary active:bg-primary/20 md:hover:bg-primary/20 transition-colors cursor-pointer text-xs md:text-sm font-bold"
                  >
                    <span className="material-symbols-outlined text-xs md:text-sm">download</span>
                    <span className="hidden md:inline">{t('chat.preview.download' as any)}</span>
                  </button>
                  <button
                    onClick={closePreview}
                    className="p-1.5 md:p-2 rounded-lg active:bg-surface-container-high md:hover:bg-surface-container-high text-on-surface-variant active:text-on-surface md:hover:text-on-surface transition-colors cursor-pointer"
                  >
                    <span className="material-symbols-outlined text-lg md:text-2xl">close</span>
                  </button>
                </div>
              </div>
              <div className="flex-1 p-2 md:p-4">
                {previewFile.file_type === 'html' ? (
                  <iframe
                    src={previewBlobUrl}
                    sandbox="allow-scripts allow-same-origin"
                    className="w-full h-full rounded-lg border border-outline-variant/20"
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
          <div className={`p-2 ${docMode.viewMode === 'chat' ? 'md:p-6 md:pt-0' : ''}`}>
            {/* Block viewing indicator — purely informational, chat still works normally */}
            {docMode.viewMode === 'document' && docMode.selectedBlockId && (
              <div className="mb-2 flex items-center gap-2 px-2.5 py-1 bg-surface-container border border-outline-variant/15 rounded-lg">
                <span className="material-symbols-outlined text-on-surface-variant text-sm">visibility</span>
                <span className="text-[11px] text-on-surface-variant flex-1 truncate">
                  {t('chat.docMode.viewingBlock')}: #{docBlocks.blocks.findIndex(b => b.id === docMode.selectedBlockId) + 1} {docBlocks.blocks.find(b => b.id === docMode.selectedBlockId)?.type.replace(/_/g, ' ') || ''}
                  {docSelectedElement && <span className="text-primary ml-1">· {docSelectedElement}</span>}
                </span>
                <button
                  onClick={() => docMode.setSelectedBlockId(null)}
                  className="text-on-surface-variant hover:text-error transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-xs">close</span>
                </button>
              </div>
            )}
            {/* Template banner */}
            {pendingTemplate && (
              <div className="mb-2 flex items-center gap-2 px-2.5 md:px-3 py-1.5 md:py-2 bg-primary/10 border border-primary/20 rounded-lg text-xs md:text-sm text-primary">
                <span className="material-symbols-outlined text-xs md:text-sm">style</span>
                <span className="font-bold">{t('templates.active' as any)}:</span>
                <span className="flex-1 truncate">{pendingTemplate}</span>
                <button
                  onClick={() => setPendingTemplate(null)}
                  className="hover:text-error transition-colors cursor-pointer shrink-0"
                >
                  <span className="material-symbols-outlined text-xs md:text-sm">close</span>
                </button>
              </div>
            )}
            <div
              className={`bg-surface-container rounded-lg border transition-all p-1.5 md:p-2 ${
                isDragging
                  ? 'border-primary border-dashed bg-primary/5'
                  : 'border-outline-variant/20 focus-within:border-primary/40'
              }`}
              onDragEnter={e => { e.preventDefault(); e.stopPropagation(); dragCounter.current++; setIsDragging(true); }}
              onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
              onDragLeave={e => { e.preventDefault(); e.stopPropagation(); dragCounter.current--; if (dragCounter.current <= 0) { dragCounter.current = 0; setIsDragging(false); } }}
              onDrop={e => { e.preventDefault(); e.stopPropagation(); dragCounter.current = 0; setIsDragging(false); if (!streaming && e.dataTransfer.files.length > 0) handleFileAttach(e.dataTransfer.files); }}
            >
              {isDragging && (
                <div className="flex items-center justify-center gap-2 py-3 text-primary pointer-events-none">
                  <span className="material-symbols-outlined text-xl">upload_file</span>
                  <span className="text-sm font-medium">{t('chat.input.dropHint' as any) || '放開以上傳檔案'}</span>
                </div>
              )}
              {/* Attached files chips + reference chips + brushed region chip */}
              {(attachedFiles.length > 0 || selectedRefs.length > 0 || pendingRegion) && (
                <div className="flex flex-wrap gap-1.5 md:gap-2 px-1.5 md:px-2 pt-1.5 md:pt-2 pb-0.5 md:pb-1">
                  {pendingRegion && (
                    <div className="flex items-center gap-1 md:gap-1.5 px-2 md:px-2.5 py-0.5 md:py-1 rounded text-xs md:text-sm border bg-primary/10 border-primary/20 text-primary">
                      <span className="material-symbols-outlined text-[14px] md:text-[15px]">brush</span>
                      已圈選區域
                      <button onClick={() => setPendingRegion(null)} className="hover:bg-primary/20 rounded p-0.5 -mr-1" title="移除圈選">
                        <span className="material-symbols-outlined text-[13px]">close</span>
                      </button>
                    </div>
                  )}
                  {attachedFiles.map(file => (
                    <div
                      key={file.id}
                      className={`flex items-center gap-1 md:gap-1.5 px-2 md:px-2.5 py-0.5 md:py-1 rounded text-xs md:text-sm border ${
                        file.uploading ? 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant' :
                        file.scanStatus === 'rejected' ? 'bg-error/10 border-error/30 text-error' :
                        file.scanStatus === 'suspicious' ? 'bg-warning/10 border-warning/30 text-warning' :
                        'bg-primary/10 border-primary/20 text-primary'
                      }`}
                    >
                      {file.uploading ? (
                        <span className="material-symbols-outlined text-xs md:text-sm animate-spin">progress_activity</span>
                      ) : file.scanStatus === 'rejected' ? (
                        <span className="material-symbols-outlined text-xs md:text-sm">gpp_bad</span>
                      ) : (
                        <span className="material-symbols-outlined text-xs md:text-sm">attach_file</span>
                      )}
                      <span className="max-w-[80px] md:max-w-[120px] truncate">{file.originalName}</span>
                      {!file.uploading && (
                        <button
                          onClick={() => removeAttachedFile(file.id)}
                          className="hover:text-error transition-colors cursor-pointer ml-0.5"
                        >
                          <span className="material-symbols-outlined text-xs md:text-sm">close</span>
                        </button>
                      )}
                    </div>
                  ))}
                  {/* Reference assistant chips */}
                  {selectedRefs.map(ref => (
                    <div key={ref.id} className="flex items-center gap-1 md:gap-1.5 px-2 md:px-2.5 py-0.5 md:py-1 rounded text-xs md:text-sm border bg-secondary/10 border-secondary/20 text-secondary">
                      <span className="material-symbols-outlined text-xs md:text-sm">psychology</span>
                      <span className="max-w-[80px] md:max-w-[120px] truncate">{ref.title}</span>
                      <button onClick={() => setSelectedRefs(prev => prev.filter(r => r.id !== ref.id))} className="hover:text-error transition-colors cursor-pointer ml-0.5">
                        <span className="material-symbols-outlined text-xs md:text-sm">close</span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1.5 md:gap-3 px-1 md:px-2 py-0.5 md:py-1">
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
                  className="w-8 h-8 md:w-9 md:h-9 flex items-center justify-center rounded active:bg-surface-container-high md:hover:bg-surface-container-high text-on-surface-variant active:text-primary md:hover:text-primary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  title={t('chat.input.uploadFile')}
                >
                  <span className="material-symbols-outlined text-base md:text-lg">attach_file</span>
                </button>
                {/* Data-source selector (Gemini-style multi-select) — grant the agent
                    read access to internal sources (email / KM …) for this message. */}
                <div className="relative shrink-0" ref={dataSourceMenuRef}>
                  <button
                    onClick={() => setDataSourceMenuOpen(o => !o)}
                    disabled={streaming}
                    className={`w-8 h-8 md:w-9 md:h-9 flex items-center justify-center rounded transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${dataSourceMenuOpen || selectedDataSources.length > 0 ? 'bg-primary/15 text-primary' : 'active:bg-surface-container-high md:hover:bg-surface-container-high text-on-surface-variant active:text-primary md:hover:text-primary'}`}
                    title="資料源"
                  >
                    <span className="material-symbols-outlined text-base md:text-lg">database</span>
                  </button>
                  {dataSourceMenuOpen && (
                    <div className="absolute bottom-full left-0 mb-1 w-60 bg-surface-container border border-outline-variant/20 rounded-xl shadow-xl overflow-hidden z-50">
                      <div className="px-3 py-2 border-b border-outline-variant/10">
                        <p className="text-xs font-medium text-on-surface-variant">資料源（可多選）</p>
                        <p className="text-[10px] text-on-surface-variant/60 mt-0.5">勾選後，AI 產文件時可讀取這些來源</p>
                      </div>
                      <div className="max-h-48 overflow-y-auto">
                        {DATA_SOURCES.map(ds => {
                          const isSel = selectedDataSources.includes(ds.id);
                          return (
                            <button
                              key={ds.id}
                              onClick={() => setSelectedDataSources(prev => isSel ? prev.filter(x => x !== ds.id) : [...prev, ds.id])}
                              className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors cursor-pointer ${isSel ? 'bg-primary/10' : 'md:hover:bg-surface-container-high active:bg-surface-container-high'}`}
                            >
                              <span className={`material-symbols-outlined text-sm shrink-0 ${isSel ? 'text-primary' : 'text-on-surface-variant'}`}>{ds.icon}</span>
                              <div className="min-w-0 flex-1">
                                <p className={`text-xs font-medium ${isSel ? 'text-primary' : 'text-on-surface'}`}>{ds.label}</p>
                                <p className="text-[10px] text-on-surface-variant/60 truncate">{ds.desc}</p>
                              </div>
                              {isSel && <span className="material-symbols-outlined text-sm text-primary shrink-0">check</span>}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
                {/* @ Reference button — only for assistant conversations */}
                {convCategory === 'assistant' && refAssistants.length > 0 && (
                  <div className="relative shrink-0" ref={refPickerRef}>
                    <button
                      onClick={() => setShowRefPicker(p => !p)}
                      disabled={streaming}
                      className={`w-8 h-8 md:w-9 md:h-9 flex items-center justify-center rounded transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${showRefPicker || selectedRefs.length > 0 ? 'bg-secondary/15 text-secondary' : 'active:bg-surface-container-high md:hover:bg-surface-container-high text-on-surface-variant active:text-secondary md:hover:text-secondary'}`}
                      title={t('chat.input.referenceAssistant' as any)}
                    >
                      <span className="material-symbols-outlined text-base md:text-lg">alternate_email</span>
                    </button>
                    {showRefPicker && (
                      <div className="absolute bottom-full left-0 mb-1 w-64 bg-surface-container border border-outline-variant/20 rounded-xl shadow-xl overflow-hidden z-50">
                        <div className="px-3 py-2 border-b border-outline-variant/10">
                          <p className="text-xs font-medium text-on-surface-variant">{t('chat.input.referenceAssistant' as any)}</p>
                        </div>
                        <div className="max-h-48 overflow-y-auto">
                          {refAssistants.map(ref => {
                            const isSelected = selectedRefs.some(r => r.id === ref.id);
                            return (
                              <button
                                key={ref.id}
                                onClick={() => {
                                  setSelectedRefs(prev =>
                                    isSelected ? prev.filter(r => r.id !== ref.id) : [...prev, ref]
                                  );
                                  setShowRefPicker(false);
                                }}
                                className={`w-full flex items-start gap-2.5 px-3 py-2.5 text-left transition-colors cursor-pointer ${isSelected ? 'bg-secondary/10' : 'md:hover:bg-surface-container-high active:bg-surface-container-high'}`}
                              >
                                <span className={`material-symbols-outlined text-sm shrink-0 mt-0.5 ${isSelected ? 'text-secondary' : 'text-on-surface-variant'}`} style={{ fontVariationSettings: "'FILL' 1" }}>smart_toy</span>
                                <div className="min-w-0 flex-1">
                                  <p className={`text-xs font-medium truncate ${isSelected ? 'text-secondary' : 'text-on-surface'}`}>{ref.title}</p>
                                  {ref.summary && <p className="text-[11px] text-on-surface-variant/70 truncate mt-0.5">{ref.summary}</p>}
                                </div>
                                {isSelected && <span className="material-symbols-outlined text-sm text-secondary shrink-0">check</span>}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                )}
                <textarea
                  className="bg-transparent border-none focus:ring-0 text-base md:text-sm flex-1 text-on-surface placeholder:text-outline/50 font-body resize-none min-h-[36px] md:min-h-[40px] max-h-[100px] md:max-h-[120px]"
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      sendMessage();
                    }
                  }}
                  placeholder={
                    docMode.viewMode === 'document' && docSelectedElement
                      ? `輸入對「${docSelectedElement}」的修改需求...`
                      : docMode.viewMode === 'document' && docMode.selectedBlockId
                        ? `輸入對第 ${docBlocks.blocks.findIndex(b => b.id === docMode.selectedBlockId) + 1} 頁的修改需求...`
                        : t('chat.input.placeholder')
                  }
                  rows={1}
                  disabled={streaming}
                />
                {streaming ? (
                  <button
                    className="bg-error/20 text-error font-headline font-bold text-xs md:text-sm uppercase px-3 md:px-5 py-2 md:py-2.5 rounded tracking-widest active:bg-error/30 md:hover:bg-error/30 active:scale-95 transition-all cursor-pointer shrink-0"
                    onClick={handleAbort}
                  >
                    {t('chat.input.stop')}
                  </button>
                ) : (
                  <button
                    className="cyber-gradient text-on-primary font-headline font-bold text-xs md:text-sm uppercase px-3 md:px-5 py-2 md:py-2.5 rounded tracking-widest shadow-lg active:scale-95 transition-transform disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer shrink-0"
                    onClick={() => sendMessage()}
                    disabled={!input.trim()}
                  >
                    {t('chat.input.send')}
                  </button>
                )}
              </div>
            </div>
            {/* Input footer info */}
            <div className="mt-1.5 md:mt-2 flex justify-between items-center px-1 md:px-2">
              <span className="text-[10px] md:text-sm text-outline uppercase tracking-widest truncate">
                {skillId ? (t(`skill.${skillId}` as any) || skillId) : t('chat.input.autoDetect')}
              </span>
              {(totalUsage || lastUsage) && (
                <div className="text-[10px] md:text-sm font-mono text-on-secondary-container/60 bg-surface-container-low px-2 md:px-3 py-0.5 md:py-1 rounded-full shrink-0">
                  {totalUsage ? (
                    <>
                      <span className="text-primary">{((totalUsage.inputTokens + totalUsage.outputTokens) / 1000).toFixed(1)}k</span>
                      <span className="text-primary/60 ml-1 hidden md:inline">(${calcCostUsd(totalUsage.inputTokens, totalUsage.outputTokens).toFixed(4)})</span>
                    </>
                  ) : lastUsage ? (
                    <>
                      <span className="text-primary">{((lastUsage.inputTokens + lastUsage.outputTokens) / 1000).toFixed(1)}k</span>
                      <span className="text-primary/60 ml-1 hidden md:inline">(${calcCostUsd(lastUsage.inputTokens, lastUsage.outputTokens).toFixed(4)})</span>
                    </>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </section>

        {/* === Mobile Files Drawer === */}
        {mobileFilesOpen && (
          <div className="fixed inset-0 z-50 lg:hidden" onClick={() => setMobileFilesOpen(false)}>
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/50" />
            {/* Drawer */}
            <div
              className="absolute bottom-0 left-0 right-0 bg-surface-container rounded-t-2xl max-h-[70vh] flex flex-col animate-in slide-in-from-bottom duration-200"
              onClick={e => e.stopPropagation()}
            >
              {/* Handle bar */}
              <div className="flex justify-center pt-3 pb-1">
                <div className="w-10 h-1 bg-outline-variant/30 rounded-full" />
              </div>
              {/* Header */}
              <div className="flex items-center justify-between px-4 pb-3 border-b border-outline-variant/10">
                <h3 className="text-sm font-headline font-bold text-on-surface">{t('chat.sidebar.generatedFiles')}</h3>
                <button onClick={() => setMobileFilesOpen(false)} className="p-1 text-on-surface-variant active:text-on-surface bg-transparent cursor-pointer">
                  <span className="material-symbols-outlined text-lg">close</span>
                </button>
              </div>
              {/* Content */}
              <div className="overflow-y-auto p-4 space-y-4">
                {/* Generated files */}
                {files.length === 0 ? (
                  <p className="text-xs text-on-surface-variant text-center py-4">{t('chat.sidebar.noFiles')}</p>
                ) : (
                  <div className="space-y-1">
                    {files.map(file => {
                      const fc = getFileColor(file.file_type);
                      return (
                        <div key={file.id} className="group">
                          <div
                            className="flex items-center justify-between p-3 active:bg-surface-container-high rounded-lg cursor-pointer transition-colors"
                            onClick={() => { handleDownload(file.id, file.filename); setMobileFilesOpen(false); }}
                          >
                            <div className="flex items-center gap-3 min-w-0">
                              <span className={`material-symbols-outlined ${fc} text-base`}>
                                {getFileIcon(file.file_type)}
                              </span>
                              <div className="min-w-0">
                                <span className="text-sm text-on-surface font-medium block truncate">{file.filename}</span>
                                <span className="text-xs text-outline">
                                  {file.file_type.toUpperCase()} · {formatSize(file.file_size)}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0 relative" data-version-dropdown>
                              <button
                                onClick={(e) => { e.stopPropagation(); toggleVersionDropdown(`mobile-${file.id}`); }}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 text-xs font-bold bg-primary/10 text-primary rounded active:bg-primary/20 transition-colors cursor-pointer"
                              >
                                v{file.version || 1}
                                <span className="material-symbols-outlined text-[10px]">expand_more</span>
                              </button>
                              <span className="material-symbols-outlined text-sm text-outline">download</span>
                              {/* Mobile version dropdown — absolute overlay */}
                              {versionDropdown === `mobile-${file.id}` && versionCache[file.id] && (
                                <div className="absolute right-0 top-full mt-2 z-50 bg-surface-container border border-outline-variant/20 rounded-xl shadow-xl min-w-[230px] py-1.5 max-h-[7.5rem] overflow-y-auto">
                                  {versionCache[file.id].map((ver, idx) => (
                                    <button
                                      key={ver.id}
                                      onClick={() => { switchToVersion(ver); setMobileFilesOpen(false); }}
                                      className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left active:bg-surface-container-high transition-colors cursor-pointer ${
                                        ver.id === file.id ? 'bg-primary/10' : ''
                                      }`}
                                    >
                                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                                        ver.id === file.id ? 'bg-primary text-on-primary' : 'bg-surface-container-highest text-on-surface-variant'
                                      }`}>
                                        v{ver.version || 1}
                                      </span>
                                      <div className="flex-1 min-w-0">
                                        <span className="text-xs text-on-surface-variant block">
                                          {formatSize(ver.file_size)}
                                          {idx === 0 && <span className="ml-1 text-primary font-bold">{t('chat.preview.latestVersion' as any)}</span>}
                                        </span>
                                        <span className="text-[10px] text-outline block">
                                          {new Date(ver.created_at || '').toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                      </div>
                                      {ver.id === file.id && (
                                        <span className="material-symbols-outlined text-primary text-xs shrink-0">check</span>
                                      )}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Uploaded files */}
                {conversationUploads.length > 0 && (
                  <div className="border-t border-outline-variant/10 pt-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <h4 className="text-xs font-headline font-bold text-outline tracking-widest uppercase">{t('chat.sidebar.uploadedFiles')}</h4>
                      <span className="text-xs font-mono text-primary bg-primary/10 px-1.5 py-0.5 rounded-full">{conversationUploads.length}</span>
                    </div>
                    <div className="space-y-1">
                      {conversationUploads.map(file => (
                        <div key={file.id} className="flex items-center gap-3 p-3 rounded-lg">
                          <span className={`material-symbols-outlined ${getFileColor(file.fileType)} text-base`}>
                            {getFileIcon(file.fileType)}
                          </span>
                          <div className="min-w-0 flex-1">
                            <span className="text-sm text-on-surface font-medium block truncate">{file.originalName}</span>
                            <span className="text-xs text-outline">{file.fileType.toUpperCase()} · {formatSize(file.fileSize)}</span>
                          </div>
                          {file.scanStatus === 'clean' && (
                            <span className="material-symbols-outlined text-green-400 text-sm shrink-0">verified_user</span>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* === Resizable Divider (between chat & canvas in doc mode) — desktop only === */}
        {docMode.viewMode === 'document' && (
          <div className="relative flex-shrink-0 group z-10 hidden sm:block">
            {/* Drag handle */}
            <div
              className="w-1 h-full cursor-col-resize hover:bg-primary/30 active:bg-primary/50 transition-colors"
              onMouseDown={(e) => {
                e.preventDefault();
                const container = (e.target as HTMLElement).closest('[class*="h-[100svh]"]') as HTMLElement;
                if (!container) return;
                const containerWidth = container.offsetWidth;
                docDragRef.current = { startX: e.clientX, startWidth: docChatWidth };
                const onMove = (ev: MouseEvent) => {
                  if (!docDragRef.current) return;
                  const delta = ev.clientX - docDragRef.current.startX;
                  const newPct = docDragRef.current.startWidth + (delta / containerWidth) * 100;
                  setDocChatWidth(Math.max(15, Math.min(60, newPct)));
                  if (newPct < 10) setDocChatCollapsed(true);
                  else setDocChatCollapsed(false);
                };
                const onUp = () => {
                  docDragRef.current = null;
                  document.removeEventListener('mousemove', onMove);
                  document.removeEventListener('mouseup', onUp);
                  document.body.style.cursor = '';
                  document.body.style.userSelect = '';
                };
                document.body.style.cursor = 'col-resize';
                document.body.style.userSelect = 'none';
                document.addEventListener('mousemove', onMove);
                document.addEventListener('mouseup', onUp);
              }}
            />
            {/* Collapse / expand toggle — always visible, brightens on hover */}
            <button
              onClick={() => { setDocChatCollapsed(prev => !prev); if (docChatCollapsed) setDocChatWidth(w => w < 15 ? 33 : w); }}
              className="absolute top-1/2 -translate-y-1/2 -left-3.5 w-7 h-12 bg-surface-container-high border border-outline-variant/40 rounded-full flex items-center justify-center text-on-surface-variant opacity-90 hover:opacity-100 hover:bg-primary hover:text-on-primary hover:border-primary transition-all cursor-pointer shadow-md z-20"
              title={docChatCollapsed ? '展開對話' : '收合對話'}
              aria-label={docChatCollapsed ? '展開對話' : '收合對話'}
            >
              <span className="material-symbols-outlined text-lg leading-none">
                {docChatCollapsed ? 'chevron_right' : 'chevron_left'}
              </span>
            </button>
          </div>
        )}

        {/* === Document Canvas (right side in document mode) === */}
        {docMode.viewMode === 'document' && (
          <div className={`flex-1 flex min-w-0 ${mobileDocView === 'chat' ? 'hidden sm:flex' : 'flex'}`}>
          <DocumentCanvas
            layoutType={docMode.docLayoutType || 'slides'}
            fileId={docMode.documentFileId}
            blocks={docBlocks.blocks}
            record={docBlocks.record}
            selectedBlockId={docMode.selectedBlockId}
            onSelectBlock={docMode.setSelectedBlockId}
            onClose={() => docMode.exitDocumentMode()}
            onFileReplaced={(newId: string) => {
              docMode.setDocumentFileId(newId);
              fetch(`/api/files?conversationId=${conversationId}`, { headers: { Authorization: `Bearer ${token}` } })
                .then(r => r.json()).then((f: GeneratedFile[]) => setFiles(f)).catch(() => {});
              // Region-edit recorded its Gemini cost server-side — refresh the
              // conversation total so the displayed cost reflects it.
              fetchUsage();
            }}
            onRegionChange={(mask: string | null) => {
              if (mask && docMode.documentFileId) setPendingRegion({ mask, fileId: docMode.documentFileId });
              else setPendingRegion(null);
            }}
            onRebuild={async (instruction?: string) => {
              if (!docMode.documentFileId) return;
              setDocRebuilding(true);
              setDocRegenPhase('rebuilding');
              setDocRegenInstruction(instruction ? `套用新風格：${instruction}` : '重新產生整份簡報…');
              const result = await docBlocks.rebuild(docMode.documentFileId, (event) => {
                // Surface live agent activity so the wait isn't a blank spinner.
                if (event.type === 'agent_tool' && typeof event.data === 'string') {
                  setDocRegenPhase('rebuilding');
                  setDocRegenInstruction(event.data.slice(0, 60));
                } else if (event.type === 'agent_text' && typeof event.data === 'string' && event.data.trim()) {
                  setDocRegenInstruction(event.data.replace(/\s+/g, ' ').trim().slice(-60));
                }
              }, instruction);
              setDocRebuilding(false);
              setDocRegenPhase('');
              setDocRegenInstruction('');
              if (result.success && result.file) {
                setFiles(prev => prev.map(f => f.id === docMode.documentFileId ? { ...f, ...(result.file as any) } : f));
              } else {
                // Make failure visible — a silent no-op reads as "nothing changed".
                setMessages(prev => [...prev, {
                  id: `rebuild-err-${Date.now()}`,
                  conversation_id: conversationId,
                  role: 'assistant',
                  content: '⚠️ 重新產生失敗（可能逾時或服務忙碌，未扣用量）。原檔未變動。請稍後再按一次「重建」；若持續失敗，建議改用單一區塊的就地修改（文字／顏色／圖表）。',
                  created_at: new Date().toISOString(),
                }]);
              }
            }}
            onRegenerate={(blockId, elementContext) => {
              setDocRegenBlockId(blockId);
              setDocRegenContext(elementContext || '');
            }}
            onUpdateBlock={async (blockId, key, value) => {
              if (!docMode.documentFileId || !token) return;
              // Use in-place patch (modifies PPTX XML directly, preserves formatting)
              setDocRebuilding(true);
              const result = await docBlocks.patchField(docMode.documentFileId, blockId, key, value);
              setDocRebuilding(false);
              if (result.success && result.file) {
                setFiles(prev => prev.map(f => f.id === docMode.documentFileId ? { ...f, ...(result.file as any) } : f));
              }
            }}
            onDownload={() => {
              if (!docMode.documentFileId || !token) return;
              const file = files.find(f => f.id === docMode.documentFileId);
              if (file) handleDownload(file.id, file.filename);
            }}
            streaming={streaming}
            rebuilding={docRebuilding}
            regenInstruction={docRegenInstruction}
            regenPhase={docRegenPhase}
            token={token}
            agentActivity={tools}
            onElementSelect={setDocSelectedElement}
            onShapesAvailable={setDocSlideShapes}
            onMobileSwitchToChat={() => setMobileDocView('chat')}
            t={t}
          />
          </div>
        )}

        {/* === Right Sidebar (only in chat mode) === */}
        <aside className={`w-72 bg-surface-container-low border-l border-outline-variant/10 overflow-y-auto p-5 flex-col gap-6 shrink-0 ${
          docMode.viewMode === 'chat' ? 'hidden lg:flex' : 'hidden'
        }`}>
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
                  <div key={file.id} className="group relative">
                    <div
                      className="flex items-center gap-2 p-2.5 hover:bg-surface-container rounded-lg cursor-pointer transition-colors border border-transparent hover:border-primary/20"
                      onClick={() => handleDownload(file.id, file.filename)}
                      role="button"
                      tabIndex={0}
                    >
                      <span className={`material-symbols-outlined ${getFileColor(file.file_type)} text-lg shrink-0`}>
                        {getFileIcon(file.file_type)}
                      </span>
                      <div className="flex-1 min-w-0">
                        <span className="text-sm text-on-surface font-medium block truncate">{file.filename}</span>
                        <span className="text-xs text-outline">
                          {file.file_type.toUpperCase()} · {formatSize(file.file_size)}
                        </span>
                      </div>
                      <div className="flex items-center gap-0.5 shrink-0 relative" data-version-dropdown>
                        <button
                          onClick={(e) => { e.stopPropagation(); toggleVersionDropdown(`sidebar-${file.id}`); }}
                          className="px-1 py-0.5 text-[10px] font-bold text-primary/70 hover:bg-primary/10 rounded transition-colors cursor-pointer"
                          title={t('chat.preview.versions' as any)}
                        >
                          v{file.version || 1}
                        </button>
                        {FILE_TYPE_TO_LAYOUT[file.file_type] ? (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              dismissEditHint();
                              docMode.manualToggle(file.id, file.file_type);
                              docBlocks.fetchBlocks(file.id);
                            }}
                            className="flex items-center gap-0.5 pl-1 pr-1.5 py-0.5 rounded text-[11px] font-bold bg-primary/10 text-primary hover:bg-primary/20 transition-colors cursor-pointer"
                            title={t('editor.openEditor' as any)}
                          >
                            <span className="material-symbols-outlined text-sm">edit_note</span>
                            <span>{t('editor.editButton' as any)}</span>
                          </button>
                        ) : null}
                        {/* Sidebar version dropdown — absolute overlay */}
                        {versionDropdown === `sidebar-${file.id}` && versionCache[file.id] && (
                          <div className="absolute right-0 top-full mt-2 z-50 bg-surface-container border border-outline-variant/20 rounded-xl shadow-xl min-w-[220px] py-1.5 max-h-[7.5rem] overflow-y-auto">
                            {versionCache[file.id].map((ver, idx) => (
                              <button
                                key={ver.id}
                                onClick={() => switchToVersion(ver)}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-container-high transition-colors cursor-pointer ${
                                  ver.id === file.id ? 'bg-primary/10' : ''
                                }`}
                              >
                                <span className={`text-xs font-bold px-1.5 py-0.5 rounded shrink-0 ${
                                  ver.id === file.id ? 'bg-primary text-on-primary' : 'bg-surface-container-highest text-on-surface-variant'
                                }`}>
                                  v{ver.version || 1}
                                </span>
                                <div className="flex-1 min-w-0">
                                  <span className="text-xs text-on-surface-variant block">
                                    {formatSize(ver.file_size)}
                                    {idx === 0 && <span className="ml-1 text-primary font-bold">{t('chat.preview.latestVersion' as any)}</span>}
                                  </span>
                                  <span className="text-[10px] text-outline block">
                                    {new Date(ver.created_at || '').toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                                  </span>
                                </div>
                                {ver.id === file.id && (
                                  <span className="material-symbols-outlined text-primary text-xs">check</span>
                                )}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
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
                      {t(`skill.${task.skillId}` as any) || task.skillId}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>

      {/* Block regeneration modal (document mode) */}
      {docRegenBlockId && (
        <div className="fixed inset-0 z-[100] bg-black/50 backdrop-blur-sm flex items-end md:items-center justify-center p-0 md:p-4"
             onClick={() => { setDocRegenBlockId(null); setDocRegenContext(''); }}>
          <div className="bg-surface rounded-t-2xl md:rounded-2xl shadow-2xl w-full max-w-lg p-5 relative border border-outline-variant/10"
               onClick={e => e.stopPropagation()}>
            <div className="flex items-center gap-2 mb-4">
              <span className="material-symbols-outlined text-primary text-xl">auto_fix_high</span>
              <h3 className="text-base font-bold text-on-surface">{t('editor.regenerate.title')}</h3>
            </div>
            {docRegenContext && (
              <div className="flex items-center gap-1.5 px-2.5 py-1.5 mb-2 bg-primary/8 border border-primary/15 rounded-lg text-xs text-primary">
                <span className="material-symbols-outlined text-sm">target</span>
                {docRegenContext}
              </div>
            )}
            <p className="text-xs text-on-surface-variant mb-3">{t('editor.regenerate.hint')}</p>
            <textarea
              id="doc-regen-input"
              placeholder={t('editor.regenerate.placeholder')}
              rows={3}
              className="w-full bg-surface-container-highest border border-outline-variant/20 rounded-lg py-2.5 px-3.5 text-sm text-on-surface placeholder:text-outline focus:ring-1 focus:ring-primary/40 focus:border-primary/40 outline-none resize-none"
              autoFocus
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  submitDocRegen();
                }
              }}
            />
            <div className="flex items-center justify-end gap-2 mt-3">
              <button
                onClick={() => { setDocRegenBlockId(null); setDocRegenContext(''); }}
                className="px-4 py-2 text-sm text-on-surface-variant hover:bg-surface-container rounded-lg transition-colors cursor-pointer"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={submitDocRegen}
                className="flex items-center gap-1.5 px-4 py-2 bg-primary text-on-primary rounded-lg text-sm font-bold hover:bg-primary-hover transition-colors cursor-pointer"
              >
                {t('editor.regenerate.submit')}
              </button>
            </div>
          </div>
        </div>
      )}
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
