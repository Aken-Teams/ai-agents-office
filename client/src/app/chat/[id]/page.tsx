'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { AuthProvider, useAuth } from '../../components/AuthProvider';
import Navbar from '../../components/Navbar';
import styles from './chat.module.css';

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
  const abortRef = useRef<AbortController | null>(null);

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

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamText, thinkingText, tools]);

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

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch(`/api/generate/${conversationId}`, {
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
                // Update existing tool or add new
                const existing = prev.findIndex(t => t.id === activity.id);
                if (existing >= 0) {
                  const updated = [...prev];
                  updated[existing] = { ...updated[existing], ...activity };
                  return updated;
                }
                return [...prev, activity];
              });
            }
            if (event.type === 'file_generated') {
              const newFiles = event.data as GeneratedFile[];
              setFiles(prev => [...prev, ...newFiles]);
            }
            if (event.type === 'error') {
              const errMsg = typeof event.data === 'string' ? event.data : 'Unknown error';
              fullText += `\n\n[Error] ${errMsg}`;
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
              setTools([]);
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
    fetch(`/api/generate/${conversationId}/abort`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  // Map tool names to friendly labels
  function getToolLabel(tool: string): string {
    const labels: Record<string, string> = {
      'Bash': 'Running command',
      'Write': 'Writing file',
      'Read': 'Reading file',
      'tool_result': 'Tool completed',
    };
    // Check prefix match (e.g., "Bash" matches "Bash(node:*)")
    for (const [key, label] of Object.entries(labels)) {
      if (tool.startsWith(key)) return label;
    }
    return `Using ${tool}`;
  }

  // Format file size
  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  // Get file icon
  function getFileIcon(type: string): string {
    const icons: Record<string, string> = {
      docx: '\u{1F4DD}', doc: '\u{1F4DD}',
      xlsx: '\u{1F4CA}', xls: '\u{1F4CA}',
      pptx: '\u{1F4CA}', ppt: '\u{1F4CA}',
      pdf: '\u{1F4C4}',
    };
    return icons[type] || '\u{1F4CE}';
  }

  if (isLoading || !user) return null;

  const isWaiting = streaming && !streamText && !thinkingText && tools.length === 0;

  return (
    <div className={styles.page}>
      <Navbar />
      <div className={styles.container}>
        {/* Messages */}
        <div className={styles.messages}>
          <div className={styles.titleBar}>
            <h2>{title}</h2>
            {skillId && <span className={styles.skillBadge}>{skillId}</span>}
          </div>

          <div className={styles.messageList}>
            {messages.map(msg => (
              <div key={msg.id} className={`${styles.message} ${styles[msg.role]}`}>
                <div className={styles.messageRole}>
                  {msg.role === 'user' ? 'You' : 'AI Assistant'}
                </div>
                <div className={styles.messageContent}>{msg.content}</div>
              </div>
            ))}

            {/* Thinking indicator */}
            {isWaiting && (
              <div className={styles.thinkingBar}>
                <span className={styles.thinkingDots}>
                  <span /><span /><span />
                </span>
                AI is thinking...
              </div>
            )}

            {/* Extended thinking text */}
            {thinkingText && (
              <div className={styles.thinkingBlock}>
                <div className={styles.thinkingLabel}>Thinking</div>
                <div className={styles.thinkingContent}>{thinkingText}</div>
              </div>
            )}

            {/* Tool activity list */}
            {tools.length > 0 && (
              <div className={styles.toolList}>
                {tools.map((tool, i) => (
                  <div key={tool.id || i} className={styles.toolItem}>
                    <span className={tool.status === 'completed' ? styles.toolDone : styles.toolSpinner} />
                    <span className={styles.toolName}>{getToolLabel(tool.tool)}</span>
                    {tool.input && <span className={styles.toolInput}>{tool.input}</span>}
                  </div>
                ))}
              </div>
            )}

            {/* Streaming text */}
            {streamText && (
              <div className={`${styles.message} ${styles.assistant}`}>
                <div className={styles.messageRole}>AI Assistant</div>
                <div className={styles.messageContent}>{streamText}</div>
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
                <a
                  key={file.id}
                  href={`/api/files/${file.id}/download`}
                  className={styles.fileItem}
                  download
                >
                  <span className={styles.fileIcon}>{getFileIcon(file.file_type)}</span>
                  <div className={styles.fileInfo}>
                    <span className={styles.fileName}>{file.filename}</span>
                    <span className={styles.fileMeta}>
                      {file.file_type.toUpperCase()} &middot; {formatSize(file.file_size)}
                    </span>
                  </div>
                  <span className={styles.downloadIcon}>&#x2B07;</span>
                </a>
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
