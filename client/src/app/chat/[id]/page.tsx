'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AuthProvider, useAuth } from '../../components/AuthProvider';
import Navbar from '../../components/Navbar';
import { useSidebarMargin } from '../../hooks/useSidebarCollapsed';

// Direct connection to Express for SSE streaming.
// Next.js rewrites proxy buffers the entire response, preventing real-time updates.
const SSE_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

interface GeneratedFile {
  id: string;
  filename: string;
  file_type: string;
  file_size: number;
}

interface AttachedFile {
  id: string;
  originalName: string;
  fileType: string;
  fileSize: number;
  scanStatus: string;
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
  'research': 'Research',
  'planner': 'Planner',
  'reviewer': 'Reviewer',
  'router': 'Router',
};

const SKILL_ICONS: Record<string, string> = {
  'pptx-gen': 'present_to_all',
  'docx-gen': 'description',
  'xlsx-gen': 'table_chart',
  'pdf-gen': 'picture_as_pdf',
};

/** Parse tool_use input JSON into a friendly, human-readable one-liner */
function parseToolInput(tool: string, rawInput?: string): string {
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
    return name ? `寫入 ${name}` : '寫入檔案';
  }
  if (baseTool === 'Read') {
    const fp = input.file_path || input.path || '';
    const name = fp.replace(/\\/g, '/').split('/').pop() || fp;
    return name ? `讀取 ${name}` : '讀取檔案';
  }
  if (baseTool === 'WebSearch') {
    const q = input.query || '';
    return q ? (q.length > 80 ? q.substring(0, 80) + '…' : q) : '搜尋中';
  }
  if (baseTool === 'WebFetch') {
    const url = input.url || '';
    try { return `瀏覽 ${new URL(url).hostname}`; } catch { return url ? `瀏覽 ${url.substring(0, 60)}` : '瀏覽網頁'; }
  }
  if (baseTool === 'Bash') {
    const cmd = input.command || '';
    if (!cmd) return '執行指令';
    // Generator scripts
    if (cmd.includes('generate-pptx')) return '生成簡報檔案';
    if (cmd.includes('generate-docx')) return '生成文件檔案';
    if (cmd.includes('generate-xlsx')) return '生成試算表';
    if (cmd.includes('generate-pdf')) return '生成 PDF';
    // Node/script execution
    if (cmd.includes('node ')) {
      const match = cmd.match(/([^\\/\s]+\.(?:mjs|js|ts))/);
      if (match) return `執行 ${match[1]}`;
      return '執行 Node 腳本';
    }
    // File operations
    if (cmd.includes('cat ') || cmd.includes('head ') || cmd.includes('tail ')) return '讀取檔案內容';
    if (cmd.includes('ls ') || cmd.includes('dir ')) return '檢視目錄';
    if (cmd.includes('mkdir ')) return '建立目錄';
    if (cmd.includes('cp ') || cmd.includes('copy ')) return '複製檔案';
    if (cmd.includes('mv ') || cmd.includes('move ')) return '移動檔案';
    if (cmd.includes('pip ') || cmd.includes('npm ') || cmd.includes('npx ')) return '安裝套件';
    if (cmd.includes('python')) return '執行 Python 腳本';
    // cd + subsequent command
    if (cmd.startsWith('cd ')) {
      // Extract the command after cd: "cd /path && actual_command"
      const afterCd = cmd.replace(/^cd\s+"?[^"&]+"?\s*&&\s*/, '').replace(/^cd\s+\S+\s*&&\s*/, '');
      if (afterCd !== cmd && afterCd.length > 0) {
        // Re-parse the command after cd
        if (afterCd.includes('generate-pptx')) return '生成簡報檔案';
        if (afterCd.includes('generate-docx')) return '生成文件檔案';
        if (afterCd.includes('generate-xlsx')) return '生成試算表';
        if (afterCd.includes('generate-pdf')) return '生成 PDF';
        if (afterCd.includes('node ')) return '執行 Node 腳本';
        if (afterCd.includes('python')) return '執行 Python 腳本';
        if (afterCd.includes('cat ') || afterCd.includes('head ')) return '讀取檔案內容';
        const shortAfter = afterCd.length > 60 ? afterCd.substring(0, 60) + '…' : afterCd;
        return shortAfter;
      }
      return '切換目錄';
    }
    // Fallback: show simplified command
    const short = cmd.length > 80 ? cmd.substring(0, 80) + '…' : cmd;
    return short;
  }
  if (baseTool === 'Edit') {
    const fp = input.file_path || '';
    const name = fp.replace(/\\/g, '/').split('/').pop() || fp;
    return name ? `編輯 ${name}` : '編輯檔案';
  }
  if (baseTool === 'Glob') return `搜尋 ${input.pattern || '檔案'}`;
  if (baseTool === 'Grep') return `搜尋 "${input.pattern || '內容'}"`;
  // Fallback
  return rawInput.length > 80 ? rawInput.substring(0, 80) + '…' : rawInput;
}

/** Get tool icon (material symbol name) and label */
function getToolInfo(tool: string): { icon: string; label: string } {
  if (tool.includes(':')) {
    const [agentId, baseTool] = tool.split(':');
    const agentLabel = SKILL_LABELS[agentId] || agentId;
    const baseInfo = getToolInfo(baseTool);
    return { icon: baseInfo.icon, label: `${agentLabel}: ${baseInfo.label}` };
  }
  if (tool === 'Router') return { icon: 'psychology', label: 'Router 分析中' };
  if (tool.startsWith('Bash')) return { icon: 'terminal', label: '執行指令' };
  if (tool === 'Write') return { icon: 'edit_document', label: '寫入檔案' };
  if (tool === 'Read') return { icon: 'description', label: '讀取檔案' };
  if (tool === 'Edit') return { icon: 'edit', label: '編輯檔案' };
  if (tool === 'Glob') return { icon: 'folder_open', label: '搜尋檔案' };
  if (tool === 'Grep') return { icon: 'search', label: '搜尋程式碼' };
  if (tool === 'WebSearch') return { icon: 'travel_explore', label: '網路搜尋' };
  if (tool === 'WebFetch') return { icon: 'language', label: '擷取網頁' };
  if (tool === 'TodoWrite') return { icon: 'checklist', label: '更新任務' };
  if (tool === 'tool_result') return { icon: 'check_circle', label: '工具完成' };
  return { icon: 'settings', label: `使用 ${tool}` };
}

function getFileIcon(type: string): string {
  const icons: Record<string, string> = {
    docx: 'description', doc: 'description',
    xlsx: 'table_chart', xls: 'table_chart',
    pptx: 'present_to_all', ppt: 'present_to_all',
    pdf: 'picture_as_pdf',
  };
  return icons[type] || 'attach_file';
}

function getFileColor(type: string): string {
  const colors: Record<string, string> = {
    docx: 'text-tertiary', doc: 'text-tertiary',
    xlsx: 'text-success', xls: 'text-success',
    pptx: 'text-warning', ppt: 'text-warning',
    pdf: 'text-error',
  };
  return colors[type] || 'text-primary';
}

function ChatContent() {
  const { user, token, isLoading } = useAuth();
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
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sidebarMargin = useSidebarMargin();
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

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

  const sendMessage = useCallback(async (directMessage?: string) => {
    const messageToSend = directMessage || input.trim();
    if (!messageToSend || streaming || !token) return;

    const userMessage = messageToSend;
    // Capture attached file names for display in the message
    const currentAttached = attachedFiles.filter(f => !f.uploading && f.scanStatus !== 'rejected');
    const currentUploadIds = currentAttached.map(f => f.id);
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
        const err = await res.json().catch(() => ({ error: '發生未知錯誤' }));
        setMessages(prev => [...prev, {
          id: `err-${Date.now()}`,
          conversation_id: conversationId,
          role: 'assistant',
          content: `⚠️ ${err.error || '請求失敗'}`,
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
              setFiles(prev => [...prev, ...newFiles]);
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
    }
  }, [input, streaming, token, conversationId, skillId, attachedFiles]);

  // Auto-send pending message from dashboard smart input
  useEffect(() => {
    if (!conversationLoaded || !token || pendingHandled.current || streaming) return;
    const key = `pending_message_${conversationId}`;
    const pending = sessionStorage.getItem(key);
    if (pending) {
      sessionStorage.removeItem(key);
      pendingHandled.current = true;
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
        alert(data.error || '上傳失敗');
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
        uploading: false,
      }));

      // Remove placeholders, add real ones
      setAttachedFiles(prev => [
        ...prev.filter(f => !f.uploading),
        ...uploaded,
      ]);

      // Refresh sidebar upload list
      reloadConversationUploads();

      // Notify about rejected files
      const rejected = uploaded.filter(u => u.scanStatus === 'rejected');
      if (rejected.length > 0) {
        alert(`安全掃描攔截了 ${rejected.length} 個檔案`);
      }
    } catch (err) {
      console.error('Upload error:', err);
      setAttachedFiles(prev => prev.filter(f => !f.uploading));
      alert('上傳失敗，請稍後重試');
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

      <div className={`${sidebarMargin} h-screen flex overflow-hidden transition-all duration-300`}>
        {/* === Central Chat Area === */}
        <section className="flex flex-col flex-1 min-h-0">
          {/* Title Bar */}
          <header className="flex items-center gap-4 px-8 h-14 bg-surface/80 backdrop-blur-xl shrink-0 border-b border-outline-variant/10">
            <button
              onClick={() => router.push('/dashboard')}
              className="text-on-surface-variant hover:text-on-surface transition-colors bg-transparent cursor-pointer"
            >
              <span className="material-symbols-outlined text-sm">arrow_back</span>
            </button>
            <h2 className="text-sm font-headline font-bold text-on-surface truncate">{title}</h2>
            {skillId && (
              <span className="text-xs px-2 py-0.5 bg-primary/10 text-primary rounded font-bold tracking-wider uppercase shrink-0">
                {skillId.replace('-gen', '')}
              </span>
            )}
            {streaming && (
              <span className="ml-auto text-xs px-2 py-0.5 bg-surface-container-high text-primary rounded font-mono shrink-0">
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
                        <span className="block mt-2 text-xs text-outline">
                          {new Date(msg.created_at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </>
                    ) : (
                      <div className="bg-surface-container-low px-5 py-4 rounded-xl rounded-tl-sm border border-outline-variant/10">
                        <div className="chat-markdown text-sm leading-relaxed text-on-surface-variant">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                        </div>
                        {sources.length > 0 && (
                          <details className="mt-3 border-t border-outline-variant/10 pt-2">
                            <summary className="text-xs text-primary cursor-pointer font-bold uppercase tracking-wider">
                              來源 ({sources.length})
                            </summary>
                            <div className="flex flex-col gap-1.5 mt-2">
                              {sources.map((src, i) => (
                                <a key={i} href={src.url} target="_blank" rel="noopener noreferrer"
                                  className="flex items-center gap-2 px-3 py-2 bg-surface-container rounded text-xs hover:bg-surface-container-high transition-colors no-underline">
                                  <span className="material-symbols-outlined text-primary text-sm">link</span>
                                  <span className="text-on-surface truncate flex-1">{src.title}</span>
                                  <span className="text-outline text-xs shrink-0">{new URL(src.url).hostname}</span>
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
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamText}</ReactMarkdown>
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
                  <span className="text-xs font-headline font-bold text-on-surface uppercase tracking-wider flex-1">
                    {streaming ? 'AI 處理中' : '已完成'}
                    {panelCollapsed && tools.length > 0 && (
                      <span className="font-normal text-on-surface-variant ml-2">
                        {completedTools}/{tools.length} 工具
                        {webSearchTools.length > 0 && ` · ${webSearchTools.length} 搜尋`}
                      </span>
                    )}
                  </span>
                  <span className="text-xs font-mono text-primary">{formatElapsed(elapsed)}</span>
                  <span className={`material-symbols-outlined text-sm text-on-surface-variant transition-transform ${panelCollapsed ? '-rotate-90' : ''}`}>
                    expand_more
                  </span>
                </div>

                {!panelCollapsed && (
                  <>
                    <div className="px-4 py-2 space-y-1 font-mono text-xs">
                      {/* Connected */}
                      <div className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant">
                        <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
                        <span>已連線</span>
                      </div>

                      {/* Waiting */}
                      {isWaiting && (
                        <div className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant bg-surface-container/50 rounded">
                          <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                          <span>
                            {elapsed < 3 ? '載入對話...'
                              : elapsed < 8 ? '分析需求...'
                              : elapsed < 15 ? '生成回應...'
                              : '處理中... (複雜任務)'}
                          </span>
                        </div>
                      )}

                      {/* Thinking */}
                      {thinkingText && (
                        <div className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant bg-surface-container/50 rounded">
                          <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                          <span>深度思考中...</span>
                        </div>
                      )}

                      {/* Tool steps */}
                      {tools.map((tool, i) => {
                        const info = getToolInfo(tool.tool);
                        const detail = parseToolInput(tool.tool, tool.input);
                        const isDone = tool.status === 'completed';
                        return (
                          <div key={tool.id || i} className={`flex items-center gap-2 px-2 py-1.5 rounded ${isDone ? 'text-outline' : 'text-on-surface-variant bg-surface-container/50'}`}>
                            {isDone
                              ? <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
                              : <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                            }
                            <span className="material-symbols-outlined text-xs">{info.icon}</span>
                            <span className={isDone ? 'line-through opacity-60' : ''}>{info.label}</span>
                            {detail && (
                              <span className="text-primary bg-surface-container px-1.5 py-0.5 rounded text-xs truncate max-w-[400px]">
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
                          <span className="material-symbols-outlined text-xs">smart_toy</span>
                          <span>{SKILL_LABELS[task.skillId] || task.skillId}</span>
                          <span className="text-primary bg-surface-container px-1.5 py-0.5 rounded text-xs truncate max-w-[400px]">
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
                          <span>撰寫回應中...</span>
                        </div>
                      )}

                      {/* Response complete */}
                      {!streaming && tools.length > 0 && (
                        <div className="flex items-center gap-2 px-2 py-1.5 text-on-surface-variant">
                          <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
                          <span>回應完成</span>
                        </div>
                      )}
                    </div>

                    {/* Token usage */}
                    {lastUsage && !streaming && (
                      <div className="flex items-center justify-between px-4 py-2 border-t border-outline-variant/10 text-xs text-outline">
                        <span>Tokens: {lastUsage.inputTokens.toLocaleString()} in / {lastUsage.outputTokens.toLocaleString()} out</span>
                        {lastUsage.model && (
                          <span className="px-2 py-0.5 bg-primary/10 text-primary rounded text-xs">
                            {lastUsage.model.split('-').slice(0, 2).join('-')}
                          </span>
                        )}
                      </div>
                    )}

                    {/* Extended thinking */}
                    {thinkingText && (
                      <details className="mx-4 mb-3 border-t border-outline-variant/10">
                        <summary className="text-xs text-primary cursor-pointer py-2 font-bold uppercase tracking-wider">
                          查看 AI 思考過程
                        </summary>
                        <div className="text-xs text-on-surface-variant leading-relaxed whitespace-pre-wrap max-h-36 overflow-y-auto pb-2">
                          {thinkingText}
                        </div>
                      </details>
                    )}
                  </>
                )}
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <div className="p-6 pt-0">
            <div className="bg-surface-container rounded-lg border border-outline-variant/20 focus-within:border-primary/40 transition-all p-2">
              {/* Attached files chips */}
              {attachedFiles.length > 0 && (
                <div className="flex flex-wrap gap-2 px-2 pt-2 pb-1">
                  {attachedFiles.map(file => (
                    <div
                      key={file.id}
                      className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs border ${
                        file.uploading ? 'bg-surface-container-high border-outline-variant/20 text-on-surface-variant' :
                        file.scanStatus === 'rejected' ? 'bg-error/10 border-error/30 text-error' :
                        file.scanStatus === 'suspicious' ? 'bg-warning/10 border-warning/30 text-warning' :
                        'bg-primary/10 border-primary/20 text-primary'
                      }`}
                    >
                      {file.uploading ? (
                        <span className="material-symbols-outlined text-xs animate-spin">progress_activity</span>
                      ) : file.scanStatus === 'rejected' ? (
                        <span className="material-symbols-outlined text-xs">gpp_bad</span>
                      ) : (
                        <span className="material-symbols-outlined text-xs">attach_file</span>
                      )}
                      <span className="max-w-[120px] truncate">{file.originalName}</span>
                      {!file.uploading && (
                        <button
                          onClick={() => removeAttachedFile(file.id)}
                          className="hover:text-error transition-colors cursor-pointer ml-0.5"
                        >
                          <span className="material-symbols-outlined text-xs">close</span>
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
                  accept=".csv,.xlsx,.xls,.pdf,.txt,.md,.json,.docx,.doc"
                  className="hidden"
                  onChange={e => { handleFileAttach(e.target.files); e.target.value = ''; }}
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  disabled={streaming}
                  className="w-9 h-9 flex items-center justify-center rounded hover:bg-surface-container-high text-on-surface-variant hover:text-primary transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                  title="上傳檔案"
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
                  placeholder="輸入你的指令..."
                  rows={1}
                  disabled={streaming}
                />
                {streaming ? (
                  <button
                    className="bg-error/20 text-error font-headline font-bold text-xs uppercase px-5 py-2.5 rounded tracking-widest hover:bg-error/30 active:scale-95 transition-all cursor-pointer"
                    onClick={handleAbort}
                  >
                    停止
                  </button>
                ) : (
                  <button
                    className="cyber-gradient text-on-primary font-headline font-bold text-xs uppercase px-5 py-2.5 rounded tracking-widest shadow-lg active:scale-95 transition-transform disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                    onClick={() => sendMessage()}
                    disabled={!input.trim()}
                  >
                    發送
                  </button>
                )}
              </div>
            </div>
            {/* Input footer info */}
            <div className="mt-2 flex justify-between items-center px-2">
              <div className="flex gap-4">
                <span className="text-xs text-outline uppercase tracking-widest">
                  {skillId ? `技能: ${SKILL_LABELS[skillId] || skillId}` : 'AI 自動判斷'}
                </span>
              </div>
              {lastUsage && (
                <div className="text-xs font-mono text-on-secondary-container/60 bg-surface-container-low px-3 py-1 rounded-full">
                  Session: <span className="text-primary">{((lastUsage.inputTokens + lastUsage.outputTokens) / 1000).toFixed(1)}k Tokens</span>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* === Right Sidebar === */}
        <aside className="w-72 bg-surface-container-low border-l border-outline-variant/10 overflow-y-auto p-5 hidden lg:flex flex-col gap-6 shrink-0">
          {/* System Status */}
          <div className="space-y-3">
            <h4 className="text-xs font-headline font-bold text-outline tracking-widest uppercase">系統狀態</h4>
            <div className="bg-surface-container-highest p-4 rounded-sm border-l-2 border-primary">
              <div className="flex items-center gap-2 mb-1">
                <span className="material-symbols-outlined text-primary text-sm">security</span>
                <span className="text-xs font-headline font-bold text-on-surface uppercase tracking-tight">沙盒隔離模式</span>
              </div>
              <p className="text-xs text-on-surface-variant leading-relaxed">
                所有執行操作皆在隔離環境中運行，確保系統安全。
              </p>
            </div>
          </div>

          {/* Generated Files */}
          <div className="space-y-3 flex-1">
            <h4 className="text-xs font-headline font-bold text-outline tracking-widest uppercase">
              生成的檔案
            </h4>
            {files.length === 0 ? (
              <p className="text-xs text-on-surface-variant text-center py-6 leading-relaxed">
                尚未生成任何檔案。<br />向 AI 描述需求即可開始。
              </p>
            ) : (
              <div className="space-y-1.5">
                {files.map(file => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between p-3 hover:bg-surface-container rounded-lg group cursor-pointer transition-colors border border-transparent hover:border-primary/20"
                    onClick={() => handleDownload(file.id, file.filename)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`material-symbols-outlined ${getFileColor(file.file_type)} text-lg`}>
                        {getFileIcon(file.file_type)}
                      </span>
                      <div className="min-w-0">
                        <span className="text-xs text-on-surface font-medium block truncate">{file.filename}</span>
                        <span className="text-xs text-outline">
                          {file.file_type.toUpperCase()} · {formatSize(file.file_size)}
                        </span>
                      </div>
                    </div>
                    <span className="material-symbols-outlined text-sm text-outline group-hover:text-primary transition-colors shrink-0">
                      download
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Uploaded Files (conversation history) */}
          {conversationUploads.length > 0 && (
            <div className="space-y-3 border-t border-outline-variant/10 pt-4">
              <h4 className="text-xs font-headline font-bold text-outline tracking-widest uppercase">
                上傳的檔案
              </h4>
              <div className="space-y-1.5">
                {conversationUploads.map(file => (
                  <div
                    key={file.id}
                    className="flex items-center gap-3 p-3 hover:bg-surface-container rounded-lg group transition-colors border border-transparent hover:border-outline-variant/20"
                  >
                    <span className={`material-symbols-outlined ${getFileColor(file.fileType)} text-lg`}>
                      {getFileIcon(file.fileType)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="text-xs text-on-surface font-medium block truncate">{file.originalName}</span>
                      <span className="text-xs text-outline">
                        {file.fileType.toUpperCase()} · {formatSize(file.fileSize)}
                      </span>
                    </div>
                    {file.scanStatus === 'clean' && (
                      <span className="material-symbols-outlined text-green-400 text-sm shrink-0" title="安全">verified_user</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Agent Tasks Summary */}
          {agentTasks.length > 0 && (
            <div className="space-y-3 border-t border-outline-variant/10 pt-4">
              <h4 className="text-xs font-headline font-bold text-outline tracking-widest uppercase">代理任務</h4>
              <div className="space-y-1.5">
                {agentTasks.map(task => (
                  <div key={task.taskId} className="flex items-center gap-2 p-2 bg-surface-container/50 rounded">
                    {task.status === 'completed'
                      ? <span className="material-symbols-outlined text-green-400 text-sm">check_circle</span>
                      : task.status === 'failed'
                      ? <span className="material-symbols-outlined text-warning text-sm">warning</span>
                      : <span className="material-symbols-outlined text-primary text-sm animate-spin">refresh</span>
                    }
                    <span className="text-xs text-on-surface-variant truncate">
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

export default function ChatPage() {
  return (
    <AuthProvider>
      <ChatContent />
    </AuthProvider>
  );
}
