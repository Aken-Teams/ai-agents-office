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
  const [toolActivity, setToolActivity] = useState('');
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [title, setTitle] = useState('');
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
  }, [messages, streamText]);

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
    setToolActivity('');

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
            if (event.type === 'tool_activity') {
              setToolActivity(`Running: ${event.data.tool}`);
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
              setToolActivity('');
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

  if (isLoading || !user) return null;

  return (
    <div className={styles.page}>
      <Navbar />
      <div className={styles.container}>
        {/* Messages */}
        <div className={styles.messages}>
          <div className={styles.titleBar}>
            <h2>{title}</h2>
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

            {streamText && (
              <div className={`${styles.message} ${styles.assistant}`}>
                <div className={styles.messageRole}>AI Assistant</div>
                <div className={styles.messageContent}>{streamText}</div>
              </div>
            )}

            {toolActivity && (
              <div className={styles.activity}>
                <span className={styles.spinner} /> {toolActivity}
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
            <p className={styles.noFiles}>No files generated yet</p>
          ) : (
            <div className={styles.fileList}>
              {files.map(file => (
                <a
                  key={file.id}
                  href={`/api/files/${file.id}/download`}
                  className={styles.fileItem}
                  download
                >
                  <span className={`badge badge-${file.file_type}`}>
                    {file.file_type.toUpperCase()}
                  </span>
                  <span className={styles.fileName}>{file.filename}</span>
                  <span className={styles.fileSize}>
                    {(file.file_size / 1024).toFixed(1)} KB
                  </span>
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
