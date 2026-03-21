'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AuthProvider, useAuth } from '../../components/AuthProvider';
import Navbar from '../../components/Navbar';
import styles from './chat.module.css';

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

interface ToolActivity {
  tool: string;
  id?: string;
  status?: string;
  input?: string;
}

/** Parse tool_use input JSON into a friendly one-liner */
function parseToolInput(tool: string, rawInput?: string): string {
  if (!rawInput) return '';
  try {
    const input = JSON.parse(rawInput);
    if (tool === 'Write' || tool === 'Read') {
      const fp = input.file_path || input.path || '';
      // Show just the filename
      const parts = fp.replace(/\\/g, '/').split('/');
      return parts[parts.length - 1] || fp;
    }
    if (tool === 'Bash') {
      const cmd = input.command || '';
      // Truncate long commands
      return cmd.length > 60 ? cmd.substring(0, 60) + '...' : cmd;
    }
    return rawInput.length > 60 ? rawInput.substring(0, 60) + '...' : rawInput;
  } catch {
    return rawInput.length > 60 ? rawInput.substring(0, 60) + '...' : rawInput;
  }
}

/** Get tool icon and label */
function getToolInfo(tool: string): { icon: string; label: string } {
  if (tool.startsWith('Bash')) return { icon: '\u25B6', label: 'Running command' };
  if (tool === 'Write') return { icon: '\u270E', label: 'Writing file' };
  if (tool === 'Read') return { icon: '\uD83D\uDCC4', label: 'Reading file' };
  if (tool === 'Edit') return { icon: '\u270F\uFE0F', label: 'Editing file' };
  if (tool === 'Glob') return { icon: '\uD83D\uDCC2', label: 'Finding files' };
  if (tool === 'Grep') return { icon: '\uD83D\uDD0E', label: 'Searching code' };
  if (tool === 'WebSearch') return { icon: '\uD83D\uDD0D', label: 'Searching web' };
  if (tool === 'WebFetch') return { icon: '\uD83C\uDF10', label: 'Fetching URL' };
  if (tool === 'TodoWrite') return { icon: '\uD83D\uDCDD', label: 'Updating tasks' };
  if (tool === 'tool_result') return { icon: '\u2705', label: 'Tool completed' };
  return { icon: '\u2699', label: `Using ${tool}` };
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
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

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
      })
      .catch(() => router.replace('/dashboard'));
  }, [token, conversationId, router]);

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

  // Auto-scroll — use scrollTo for reliability (scrollIntoView can misfire before layout)
  useEffect(() => {
    setTimeout(() => {
      const el = messagesEndRef.current?.parentElement;
      if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }, 50);
  }, [messages, streamText, thinkingText, tools, streaming]);

  // Elapsed time timer
  useEffect(() => {
    if (streaming) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [streaming]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || streaming || !token) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, {
      id: `temp-${Date.now()}`,
      role: 'user',
      content: userMessage,
      created_at: new Date().toISOString(),
    }]);

    setStreaming(true);
    setStreamText('');
    setThinkingText('');
    setTools([]);
    setLastUsage(null);
    setPanelCollapsed(false);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Connect directly to Express for real-time SSE streaming
      // (Next.js rewrite proxy buffers the entire response)
      const res = await fetch(`${SSE_BASE}/api/generate/${conversationId}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ message: userMessage }),
        signal: controller.signal,
      });

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
                // Mark all running tools as completed
                if (activity.tool === '_mark_completed') {
                  return prev.map(t => t.status !== 'completed' ? { ...t, status: 'completed' } : t);
                }
                // Skip tool_result entries without id (redundant)
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
              // Keep tools visible (don't clear) so user can see what was done
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
  }, [input, streaming, token, conversationId]);

  function handleAbort() {
    abortRef.current?.abort();
    fetch(`${SSE_BASE}/api/generate/${conversationId}/abort`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function getFileIcon(type: string): string {
    const icons: Record<string, string> = {
      docx: '\uD83D\uDCDD', doc: '\uD83D\uDCDD',
      xlsx: '\uD83D\uDCCA', xls: '\uD83D\uDCCA',
      pptx: '\uD83D\uDCCA', ppt: '\uD83D\uDCCA',
      pdf: '\uD83D\uDCC4',
    };
    return icons[type] || '\uD83D\uDCCE';
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
  // Show completed panel after streaming ends (with usage info)
  const showCompletedPanel = !streaming && tools.length > 0 && lastUsage;

  // Extract source URLs from AI response for display
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

  // Count completed and total tools for collapsed summary
  const completedTools = tools.filter(t => t.status === 'completed').length;
  const webSearchTools = tools.filter(t => t.tool === 'WebSearch' || t.tool === 'WebFetch');

  return (
    <div className={styles.page}>
      <Navbar />
      <div className={styles.container}>
        {/* Messages */}
        <div className={styles.messages}>
          <div className={styles.titleBar}>
            <h2>{title}</h2>
            {skillId && <span className={styles.skillBadge}>{skillId}</span>}
            {streaming && (
              <span className={styles.elapsedBadge}>{formatElapsed(elapsed)}</span>
            )}
          </div>

          <div className={styles.messageList}>
            {messages.map(msg => {
              const sources = msg.role === 'assistant' ? extractSources(msg.content) : [];
              return (
                <div key={msg.id} className={`${styles.message} ${styles[msg.role]}`}>
                  <div className={styles.messageRole}>
                    {msg.role === 'user' ? 'You' : 'AI Assistant'}
                  </div>
                  <div className={styles.messageContent}>
                    {msg.role === 'assistant' ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                    ) : (
                      msg.content
                    )}
                  </div>
                  {/* Source references */}
                  {sources.length > 0 && (
                    <details className={styles.sourcesSection}>
                      <summary className={styles.sourcesSummary}>
                        Sources ({sources.length})
                      </summary>
                      <div className={styles.sourcesList}>
                        {sources.map((src, i) => (
                          <a key={i} href={src.url} target="_blank" rel="noopener noreferrer" className={styles.sourceLink}>
                            <span className={styles.sourceFavicon}>&#x1F517;</span>
                            <span className={styles.sourceTitle}>{src.title}</span>
                            <span className={styles.sourceUrl}>{new URL(src.url).hostname}</span>
                          </a>
                        ))}
                      </div>
                    </details>
                  )}
                </div>
              );
            })}

            {/* === Active AI Processing Panel (Collapsible) === */}
            {(hasActivity || showCompletedPanel) && (
              <div className={styles.processingPanel}>
                <div
                  className={styles.processingHeader}
                  onClick={() => setPanelCollapsed(c => !c)}
                  role="button"
                  tabIndex={0}
                >
                  <span className={styles.processingIcon}>
                    {streaming
                      ? <span className={styles.pulsingDot} />
                      : <span className={styles.taskCheck} style={{ width: 8, height: 8 }} />
                    }
                  </span>
                  <span className={styles.processingTitle}>
                    {streaming ? 'AI Processing' : 'Completed'}
                    {panelCollapsed && tools.length > 0 && (
                      <span className={styles.toolCountBadge}>
                        {completedTools}/{tools.length} tools
                        {webSearchTools.length > 0 && ` \u00B7 ${webSearchTools.length} web`}
                      </span>
                    )}
                  </span>
                  <span className={styles.processingTime}>
                    {formatElapsed(elapsed)}
                  </span>
                  <span className={`${styles.collapseChevron} ${panelCollapsed ? styles.chevronCollapsed : ''}`}>
                    &#x25BC;
                  </span>
                </div>

                {!panelCollapsed && (
                  <>
                    {/* Task steps */}
                    <div className={styles.taskList}>
                      {/* Connected step */}
                      <div className={`${styles.taskItem} ${styles.taskDone}`}>
                        <span className={styles.taskCheck} />
                        <span className={styles.taskLabel}>Connected</span>
                      </div>

                      {/* Time-based progress while waiting */}
                      {isWaiting && (
                        <div className={`${styles.taskItem} ${styles.taskActive}`}>
                          <span className={styles.taskSpinner} />
                          <span className={styles.taskLabel}>
                            {elapsed < 3 ? 'Loading conversation context...'
                              : elapsed < 8 ? 'Analyzing your request...'
                              : elapsed < 15 ? 'Generating response...'
                              : 'Still working... (complex request)'}
                          </span>
                        </div>
                      )}

                      {/* Thinking step */}
                      {thinkingText && (
                        <div className={`${styles.taskItem} ${styles.taskActive}`}>
                          <span className={styles.taskSpinner} />
                          <span className={styles.taskLabel}>Deep thinking...</span>
                        </div>
                      )}

                      {/* Tool steps */}
                      {tools.map((tool, i) => {
                        const info = getToolInfo(tool.tool);
                        const detail = parseToolInput(tool.tool, tool.input);
                        const isDone = tool.status === 'completed';
                        return (
                          <div key={tool.id || i} className={`${styles.taskItem} ${isDone ? styles.taskDone : styles.taskActive}`}>
                            <span className={isDone ? styles.taskCheck : styles.taskSpinner} />
                            <span className={styles.taskIcon}>{info.icon}</span>
                            <span className={styles.taskLabel}>{info.label}</span>
                            {detail && <span className={styles.taskDetail}>{detail}</span>}
                          </div>
                        );
                      })}

                      {/* Writing response step */}
                      {streaming && streamText && (
                        <div className={`${styles.taskItem} ${styles.taskActive}`}>
                          <span className={styles.taskSpinner} />
                          <span className={styles.taskLabel}>Writing response...</span>
                        </div>
                      )}

                      {/* Response complete step */}
                      {!streaming && tools.length > 0 && (
                        <div className={`${styles.taskItem} ${styles.taskDone}`}>
                          <span className={styles.taskCheck} />
                          <span className={styles.taskLabel}>Response complete</span>
                        </div>
                      )}
                    </div>

                    {/* Token usage summary (shown after completion) */}
                    {lastUsage && !streaming && (
                      <div className={styles.usageSummary}>
                        <span>Tokens: {lastUsage.inputTokens.toLocaleString()} in / {lastUsage.outputTokens.toLocaleString()} out</span>
                        {lastUsage.model && <span className={styles.modelBadge}>{lastUsage.model.split('-').slice(0, 2).join('-')}</span>}
                      </div>
                    )}

                    {/* Extended thinking (collapsible) */}
                    {thinkingText && (
                      <details className={styles.thinkingDetails}>
                        <summary className={styles.thinkingSummary}>View AI thinking</summary>
                        <div className={styles.thinkingContent}>{thinkingText}</div>
                      </details>
                    )}
                  </>
                )}
              </div>
            )}

            {/* Streaming text preview */}
            {streamText && streamText.trim() && (
              <div className={`${styles.message} ${styles.assistant} ${styles.streaming}`}>
                <div className={styles.messageRole}>AI Assistant</div>
                <div className={styles.messageContent}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{streamText}</ReactMarkdown>
                  <span className={styles.cursor} />
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className={styles.inputBar}>
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Describe what document you want to create..."
              rows={2}
              disabled={streaming}
            />
            {streaming ? (
              <button className="btn-danger" onClick={handleAbort}>Stop</button>
            ) : (
              <button className="btn-primary" onClick={sendMessage} disabled={!input.trim()}>Send</button>
            )}
          </div>
        </div>

        {/* Sidebar: Generated Files */}
        <div className={styles.sidebar}>
          <h3>Generated Files</h3>
          {files.length === 0 ? (
            <p className={styles.noFiles}>No files generated yet. Ask the AI to create a document!</p>
          ) : (
            <div className={styles.fileList}>
              {files.map(file => (
                <div
                  key={file.id}
                  className={styles.fileItem}
                  onClick={() => handleDownload(file.id, file.filename)}
                  role="button"
                  tabIndex={0}
                >
                  <span className={styles.fileIcon}>{getFileIcon(file.file_type)}</span>
                  <div className={styles.fileInfo}>
                    <span className={styles.fileName}>{file.filename}</span>
                    <span className={styles.fileMeta}>
                      {file.file_type.toUpperCase()} &middot; {formatSize(file.file_size)}
                    </span>
                  </div>
                  <span className={styles.downloadIcon}>&#x2B07;</span>
                </div>
              ))}
            </div>
          )}
        </div>
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
