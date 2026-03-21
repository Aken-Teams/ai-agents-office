'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { AuthProvider, useAuth } from '../components/AuthProvider';
import Navbar from '../components/Navbar';
import styles from './files.module.css';

interface FileItem {
  id: string;
  filename: string;
  file_type: string;
  file_size: number;
  conversation_id: string | null;
  created_at: string;
}

function FilesContent() {
  const { user, token, isLoading } = useAuth();
  const router = useRouter();
  const [files, setFiles] = useState<FileItem[]>([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!isLoading && !user) router.replace('/login');
  }, [user, isLoading, router]);

  useEffect(() => {
    if (!token) return;
    const url = filter ? `/api/files?type=${filter}` : '/api/files';
    fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(setFiles)
      .catch(console.error);
  }, [token, filter]);

  async function deleteFile(id: string) {
    if (!token || !confirm('Are you sure you want to delete this file?')) return;
    await fetch(`/api/files/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    setFiles(prev => prev.filter(f => f.id !== id));
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  if (isLoading || !user) return null;

  return (
    <div>
      <Navbar />
      <div className={styles.container}>
        <div className={styles.header}>
          <h2>My Files</h2>
          <div className={styles.filters}>
            {['', 'pptx', 'docx', 'xlsx', 'pdf'].map(f => (
              <button
                key={f}
                className={`${styles.filterBtn} ${filter === f ? styles.active : ''}`}
                onClick={() => setFilter(f)}
              >
                {f ? f.toUpperCase() : 'All'}
              </button>
            ))}
          </div>
        </div>

        {files.length === 0 ? (
          <div className={styles.empty}>
            <p>No files found. Generate documents from the Dashboard to see them here.</p>
          </div>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>File Name</th>
                <th>Type</th>
                <th>Size</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {files.map(file => (
                <tr key={file.id}>
                  <td className={styles.fileName}>{file.filename}</td>
                  <td>
                    <span className={`badge badge-${file.file_type}`}>
                      {file.file_type.toUpperCase()}
                    </span>
                  </td>
                  <td>{formatSize(file.file_size)}</td>
                  <td>{new Date(file.created_at).toLocaleDateString('zh-TW')}</td>
                  <td className={styles.actions}>
                    <a
                      href={`/api/files/${file.id}/download`}
                      className="btn-primary"
                      style={{ padding: '6px 12px', fontSize: '12px', display: 'inline-block' }}
                      download
                    >
                      Download
                    </a>
                    <button
                      className="btn-danger"
                      style={{ padding: '6px 12px', fontSize: '12px' }}
                      onClick={() => deleteFile(file.id)}
                    >
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export default function FilesPage() {
  return (
    <AuthProvider>
      <FilesContent />
    </AuthProvider>
  );
}
