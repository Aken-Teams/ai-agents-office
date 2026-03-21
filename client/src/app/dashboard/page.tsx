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

const SKILLS = [
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

  async function createConversation(skillId: string) {
    if (!token) return;
    const skill = SKILLS.find(s => s.id === skillId);
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ title: `New ${skill?.label || ''} Document`, skillId }),
    });
    const conv = await res.json();
    router.push(`/chat/${conv.id}`);
  }

  if (isLoading || !user) return null;

  return (
    <div>
      <Navbar />
      <div className={styles.container}>
        <h2 className={styles.greeting}>Welcome back, {user.displayName || user.email}</h2>

        {/* Quick Start */}
        <section className={styles.section}>
          <h3>Create New Document</h3>
          <div className={styles.skillGrid}>
            {SKILLS.map(skill => (
              <button
                key={skill.id}
                className={styles.skillCard}
                onClick={() => createConversation(skill.id)}
                style={{ borderColor: skill.color }}
              >
                <span className={styles.skillIcon} style={{ background: skill.color }}>{skill.icon}</span>
                <span className={styles.skillLabel}>{skill.label}</span>
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
