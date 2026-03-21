'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import Navbar from '../components/Navbar';
import styles from './usage.module.css';

interface DailyUsage {
  date: string;
  total_input: number;
  total_output: number;
  invocation_count: number;
}

interface UsageTotal {
  totalInput: number;
  totalOutput: number;
  totalInvocations: number;
}

function UsageContent() {
  const { user, token, isLoading } = useAuth();
  const router = useRouter();
  const [daily, setDaily] = useState<DailyUsage[]>([]);
  const [total, setTotal] = useState<UsageTotal | null>(null);

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;

    fetch('/api/usage', { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        setDaily(data.summary);
        setTotal(data.total);
      })
      .catch(console.error);
  }, [token]);

  if (isLoading || !user) return null;

  const maxTokens = Math.max(...daily.map(d => d.total_input + d.total_output), 1);

  return (
    <div>
      <Navbar />
      <div className={styles.container}>
        <h2>Token Usage</h2>

        {/* Summary Cards */}
        {total && (
          <div className={styles.summaryGrid}>
            <div className={styles.summaryCard}>
              <span className={styles.summaryValue}>{total.totalInvocations}</span>
              <span className={styles.summaryLabel}>Total Generations</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryValue}>{(total.totalInput + total.totalOutput).toLocaleString()}</span>
              <span className={styles.summaryLabel}>Total Tokens</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryValue}>{total.totalInput.toLocaleString()}</span>
              <span className={styles.summaryLabel}>Input Tokens</span>
            </div>
            <div className={styles.summaryCard}>
              <span className={styles.summaryValue}>{total.totalOutput.toLocaleString()}</span>
              <span className={styles.summaryLabel}>Output Tokens</span>
            </div>
          </div>
        )}

        {/* Bar Chart */}
        <div className={styles.chartCard}>
          <h3>Daily Usage</h3>
          {daily.length === 0 ? (
            <p className={styles.noData}>No usage data yet</p>
          ) : (
            <div className={styles.chart}>
              {daily.slice(0, 30).reverse().map(day => {
                const total = day.total_input + day.total_output;
                const pct = (total / maxTokens) * 100;
                return (
                  <div key={day.date} className={styles.bar} title={`${day.date}: ${total.toLocaleString()} tokens`}>
                    <div className={styles.barFill} style={{ height: `${Math.max(pct, 2)}%` }}>
                      <div className={styles.barInput} style={{ height: `${(day.total_input / total) * 100}%` }} />
                    </div>
                    <span className={styles.barLabel}>{day.date.slice(5)}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div className={styles.legend}>
            <span><span className={styles.legendDot} style={{ background: 'var(--primary)' }} /> Input</span>
            <span><span className={styles.legendDot} style={{ background: '#a5b4fc' }} /> Output</span>
          </div>
        </div>

        {/* Detail Table */}
        <div className={styles.tableCard}>
          <h3>Usage Details</h3>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Generations</th>
                <th>Input Tokens</th>
                <th>Output Tokens</th>
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {daily.map(day => (
                <tr key={day.date}>
                  <td>{day.date}</td>
                  <td>{day.invocation_count}</td>
                  <td>{day.total_input.toLocaleString()}</td>
                  <td>{day.total_output.toLocaleString()}</td>
                  <td><strong>{(day.total_input + day.total_output).toLocaleString()}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

export default function UsagePage() {
  return (
    <AuthProvider>
      <UsageContent />
    </AuthProvider>
  );
}
