'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import Navbar from '../components/Navbar';
import styles from './dashboard.module.css';

interface Conversation {
  id: string;
  title: string;
  skill_id: string | null;
  status: string;
  created_at: string;
}

interface UsageTotal {
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
}

const DOC_TYPES = [
  { id: 'pptx-gen', label: 'PowerPoint', icon: '\u{1F4CA}', color: '#f59e0b' },
  { id: 'docx-gen', label: 'Word', icon: '\u{1F4DD}', color: '#3b82f6' },
  { id: 'xlsx-gen', label: 'Excel', icon: '\u{1F4C8}', color: '#10b981' },
  { id: 'pdf-gen', label: 'PDF', icon: '\u{1F4C4}', color: '#ec4899' },
];

function DashboardContent() {
  const { user, token, isLoading } = useAuth();
  const router = useRouter();
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [usage, setUsage] = useState<UsageTotal | null>(null);
  const [smartInput, setSmartInput] = useState('');
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) {
      router.replace('/login');
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;

    fetch('/api/conversations', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(setConversations)
      .catch(console.error);

    fetch('/api/usage', {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => r.json())
      .then(data => setUsage(data.total))
      .catch(console.error);
  }, [token]);

  async function createConversation(skillId?: string, initialMessage?: string) {
    if (!token || creating) return;
    setCreating(true);
    try {
      const docType = DOC_TYPES.find(s => s.id === skillId);
      const title = skillId
        ? `New ${docType?.label || ''} Document`
        : (initialMessage || 'New Conversation').substring(0, 60);
      const res = await fetch('/api/conversations', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ title, skillId: skillId || undefined }),
      });
      const conv = await res.json();
      // If there's an initial message, store it in sessionStorage for the chat page to pick up
      if (initialMessage) {
        sessionStorage.setItem(`pending_message_${conv.id}`, initialMessage);
      }
      router.push(`/chat/${conv.id}`);
    } finally {
      setCreating(false);
    }
  }

  async function handleSmartSubmit() {
    if (!smartInput.trim()) return;
    await createConversation(undefined, smartInput.trim());
  }

  if (isLoading || !user) return null;

  return (
    <div>
      <Navbar />
      <div className={styles.container}>
        <h2 className={styles.greeting}>Welcome back, {user.displayName || user.email}</h2>

        {/* Smart Input — describe anything, AI figures out the rest */}
        <section className={styles.section}>
          <div className={styles.smartBox}>
            <h3 className={styles.smartTitle}>What do you need?</h3>
            <p className={styles.smartHint}>Describe your request and AI will create the right document for you</p>
            <div className={styles.smartInputRow}>
              <textarea
                className={styles.smartInput}
                value={smartInput}
                onChange={e => setSmartInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSmartSubmit();
                  }
                }}
                placeholder="e.g. Make a 10-slide presentation about AI trends in 2025..."
                rows={2}
                disabled={creating}
              />
              <button
                className={styles.smartButton}
                onClick={handleSmartSubmit}
                disabled={!smartInput.trim() || creating}
              >
                {creating ? '...' : 'Go'}
              </button>
            </div>
          </div>
        </section>

        {/* Quick Create — pick a specific document type */}
        <section className={styles.section}>
          <h3>Quick Create</h3>
          <div className={styles.skillGrid}>
            {DOC_TYPES.map(doc => (
              <button
                key={doc.id}
                className={styles.skillCard}
                onClick={() => createConversation(doc.id)}
                style={{ borderColor: doc.color }}
                disabled={creating}
              >
                <span className={styles.skillIcon} style={{ background: doc.color }}>{doc.icon}</span>
                <span className={styles.skillLabel}>{doc.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/* Usage Summary */}
        {usage && (
          <section className={styles.section}>
            <h3>This Month&apos;s Usage</h3>
            <div className={styles.usageGrid}>
              <div className={styles.usageCard}>
                <span className={styles.usageValue}>{usage.totalInvocations}</span>
                <span className={styles.usageLabel}>Generations</span>
              </div>
              <div className={styles.usageCard}>
                <span className={styles.usageValue}>{(usage.totalInput + usage.totalOutput).toLocaleString()}</span>
                <span className={styles.usageLabel}>Total Tokens</span>
              </div>
              <div className={styles.usageCard}>
                <span className={styles.usageValue}>{usage.totalInput.toLocaleString()}</span>
                <span className={styles.usageLabel}>Input Tokens</span>
              </div>
              <div className={styles.usageCard}>
                <span className={styles.usageValue}>{usage.totalOutput.toLocaleString()}</span>
                <span className={styles.usageLabel}>Output Tokens</span>
              </div>
            </div>
          </section>
        )}

        {/* Recent Conversations */}
        <section className={styles.section}>
          <h3>Recent Conversations</h3>
          {conversations.length === 0 ? (
            <p className={styles.empty}>No conversations yet. Create a new document to get started!</p>
          ) : (
            <div className={styles.convList}>
              {conversations.slice(0, 10).map(conv => (
                <div
                  key={conv.id}
                  className={styles.convItem}
                  onClick={() => router.push(`/chat/${conv.id}`)}
                >
                  <div className={styles.convInfo}>
                    <span className={styles.convTitle}>{conv.title}</span>
                    <span className={styles.convDate}>
                      {new Date(conv.created_at).toLocaleDateString('zh-TW')}
                    </span>
                  </div>
                  {conv.skill_id && (
                    <span className={`badge badge-${conv.skill_id.replace('-gen', '')}`}>
                      {conv.skill_id.replace('-gen', '').toUpperCase()}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  return (
    <AuthProvider>
      <DashboardContent />
    </AuthProvider>
  );
}
