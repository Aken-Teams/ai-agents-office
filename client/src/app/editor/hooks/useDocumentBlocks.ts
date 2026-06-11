'use client';

import { useState, useCallback, useRef } from 'react';

const SSE_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

export interface DocumentBlock {
  id: string;
  type: string;
  order: number;
  data: Record<string, unknown>;
  status?: 'idle' | 'regenerating' | 'dirty';
}

export interface BlockRecord {
  id: string;
  fileId: string;
  docType: string;
  meta: Record<string, unknown>;
  blocks: DocumentBlock[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

interface UseDocumentBlocksReturn {
  record: BlockRecord | null;
  blocks: DocumentBlock[];
  loading: boolean;
  error: string | null;
  /** Fetch blocks for a file */
  fetchBlocks: (fileId: string) => Promise<void>;
  /** Fetch all blocks in a conversation */
  fetchConversationBlocks: (conversationId: string) => Promise<BlockRecord[]>;
  /** Update entire blocks array (reorder / batch) */
  updateBlocks: (fileId: string, blocks: DocumentBlock[]) => Promise<void>;
  /** Update a single block's data */
  updateBlock: (fileId: string, blockId: string, data: Record<string, unknown>) => Promise<void>;
  /** Delete a block */
  deleteBlock: (fileId: string, blockId: string) => Promise<void>;
  /** Add a new block */
  addBlock: (fileId: string, type: string, data: Record<string, unknown>, insertAfter?: string) => Promise<DocumentBlock | null>;
  /** Rebuild file using agent (SSE streaming). onEvent streams progress. */
  rebuild: (fileId: string, onEvent?: (event: { type: string; data?: any }) => void, instruction?: string) => Promise<{ success: boolean; file?: any; blocks?: DocumentBlock[] }>;
  /** Patch a single field in-place (preserves formatting) */
  patchField: (fileId: string, blockId: string, key: string, value: unknown) => Promise<{ success: boolean; file?: any }>;
  /** AI regenerate a single block (streams SSE events via onEvent callback) */
  regenerate: (fileId: string, blockId: string, instruction: string, onEvent?: (event: { type: string; data?: any }) => void) => Promise<{ success: boolean; block?: DocumentBlock; file?: any }>;
  askBlock: (fileId: string, blockId: string, instruction: string, onText?: (delta: string) => void) => Promise<string>;
  /** Set blocks locally (e.g. from SSE) */
  setBlocksFromSSE: (data: { fileId: string; blocks: DocumentBlock[] }) => void;
}

export function useDocumentBlocks(token: string | null): UseDocumentBlocksReturn {
  const [record, setRecord] = useState<BlockRecord | null>(null);
  const [blocks, setBlocks] = useState<DocumentBlock[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const headers = useCallback(() => ({
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }), [token]);

  const fetchBlocks = useCallback(async (fileId: string) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${SSE_BASE}/api/blocks/${fileId}`, { headers: headers() });
      if (!res.ok) {
        if (res.status === 404) {
          setRecord(null);
          setBlocks([]);
          return;
        }
        throw new Error(`Failed to fetch blocks: ${res.status}`);
      }
      const data: BlockRecord = await res.json();
      setRecord(data);
      setBlocks(data.blocks);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [token, headers]);

  const fetchConversationBlocks = useCallback(async (conversationId: string): Promise<BlockRecord[]> => {
    if (!token) return [];
    try {
      const res = await fetch(`${SSE_BASE}/api/blocks/conversation/${conversationId}`, { headers: headers() });
      if (!res.ok) return [];
      return await res.json();
    } catch {
      return [];
    }
  }, [token, headers]);

  const updateBlocks = useCallback(async (fileId: string, newBlocks: DocumentBlock[]) => {
    if (!token) return;
    setError(null);
    // Optimistic update
    setBlocks(newBlocks);
    try {
      const res = await fetch(`${SSE_BASE}/api/blocks/${fileId}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ blocks: newBlocks }),
      });
      if (!res.ok) throw new Error(`Update failed: ${res.status}`);
      const data = await res.json();
      setBlocks(data.blocks);
    } catch (err: any) {
      setError(err.message);
      // Revert on failure
      if (record) setBlocks(record.blocks);
    }
  }, [token, headers, record]);

  const updateBlock = useCallback(async (fileId: string, blockId: string, data: Record<string, unknown>) => {
    if (!token) return;
    setError(null);
    try {
      const res = await fetch(`${SSE_BASE}/api/blocks/${fileId}/block/${blockId}`, {
        method: 'PUT',
        headers: headers(),
        body: JSON.stringify({ data }),
      });
      if (!res.ok) throw new Error(`Update failed: ${res.status}`);
      const result = await res.json();
      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, data: result.block.data } : b));
    } catch (err: any) {
      setError(err.message);
    }
  }, [token, headers]);

  const deleteBlock = useCallback(async (fileId: string, blockId: string) => {
    if (!token) return;
    setError(null);
    const prevBlocks = blocks;
    // Optimistic
    setBlocks(prev => prev.filter(b => b.id !== blockId));
    try {
      const res = await fetch(`${SSE_BASE}/api/blocks/${fileId}/block/${blockId}`, {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      const data = await res.json();
      setBlocks(data.blocks);
    } catch (err: any) {
      setError(err.message);
      setBlocks(prevBlocks);
    }
  }, [token, headers, blocks]);

  const addBlock = useCallback(async (fileId: string, type: string, data: Record<string, unknown>, insertAfter?: string): Promise<DocumentBlock | null> => {
    if (!token) return null;
    setError(null);
    try {
      const res = await fetch(`${SSE_BASE}/api/blocks/${fileId}/block`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ type, data, insertAfter }),
      });
      if (!res.ok) throw new Error(`Add failed: ${res.status}`);
      const result = await res.json();
      setBlocks(result.blocks);
      return result.block;
    } catch (err: any) {
      setError(err.message);
      return null;
    }
  }, [token, headers]);

  const rebuild = useCallback(async (
    fileId: string,
    onEvent?: (event: { type: string; data?: any }) => void,
    instruction?: string,
  ): Promise<{ success: boolean; file?: any; blocks?: DocumentBlock[] }> => {
    if (!token) return { success: false };
    setError(null);
    try {
      const res = await fetch(`${SSE_BASE}/api/blocks/${fileId}/rebuild`, {
        method: 'POST',
        headers: { ...headers(), Accept: 'text/event-stream', 'Content-Type': 'application/json' },
        body: JSON.stringify(instruction ? { instruction } : {}),
      });
      if (!res.ok) throw new Error(`Rebuild failed: ${res.status}`);

      // Stream SSE events
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      const decoder = new TextDecoder();
      let buffer = '';
      let resultFile: any = null;
      let resultBlocks: DocumentBlock[] | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            onEvent?.(event);
            if (event.type === 'file_ready') resultFile = event.data?.file;
            if (event.type === 'blocks_updated') {
              resultBlocks = event.data?.blocks;
              if (resultBlocks) setBlocks(resultBlocks);
            }
            if (event.type === 'done') {
              resultFile = event.data?.file || resultFile;
              resultBlocks = event.data?.blocks || resultBlocks;
              if (resultBlocks) setBlocks(resultBlocks);
            }
          } catch { /* skip malformed SSE */ }
        }
      }

      return { success: !!resultFile, file: resultFile, blocks: resultBlocks };
    } catch (err: any) {
      setError(err.message);
      return { success: false };
    }
  }, [token, headers]);

  const patchField = useCallback(async (fileId: string, blockId: string, key: string, value: unknown) => {
    if (!token) return { success: false };
    setError(null);
    // Optimistic update
    setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, data: { ...b.data, [key]: value } } : b));
    try {
      const res = await fetch(`${SSE_BASE}/api/blocks/${fileId}/patch`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ blockId, key, value }),
      });
      if (!res.ok) throw new Error(`Patch failed: ${res.status}`);
      return await res.json();
    } catch (err: any) {
      setError(err.message);
      return { success: false };
    }
  }, [token, headers]);

  const regenerate = useCallback(async (
    fileId: string,
    blockId: string,
    instruction: string,
    onEvent?: (event: { type: string; data?: any }) => void,
  ) => {
    if (!token) return { success: false };
    setError(null);
    // Mark block as regenerating locally
    setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, status: 'regenerating' } : b));
    try {
      // SSE streaming — sends Accept: text/event-stream for real-time events
      const res = await fetch(`${SSE_BASE}/api/blocks/${fileId}/regenerate/${blockId}`, {
        method: 'POST',
        headers: { ...headers(), Accept: 'text/event-stream' },
        body: JSON.stringify({ instruction }),
      });
      if (!res.ok) throw new Error(`Regenerate failed: ${res.status}`);

      // Read SSE stream
      const reader = res.body?.getReader();
      if (!reader) throw new Error('No response body');
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Parse SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const event = JSON.parse(line.slice(6));
            onEvent?.(event);

            if (event.type === 'block_updated' && event.data) {
              // Immediately update canvas with new block content (before file patch)
              setBlocks(event.data.blocks);
            }
            if (event.type === 'done' && event.data) {
              // Final update with idle status
              setBlocks(event.data.blocks);
              const block = event.data.block;
              return { success: true, block, file: null };
            }
            if (event.type === 'error') {
              throw new Error(event.data || 'Regeneration failed');
            }
          } catch (parseErr: any) {
            if (parseErr.message === 'Regeneration failed' || parseErr.message?.startsWith('Regenerate')) throw parseErr;
            // Ignore JSON parse errors for partial data
          }
        }
      }

      // Stream ended without 'done' event — try fetching final state
      const pollRes = await fetch(`${SSE_BASE}/api/blocks/${fileId}`, { headers: headers() });
      if (pollRes.ok) {
        const data: BlockRecord = await pollRes.json();
        setRecord(data);
        setBlocks(data.blocks);
        const block = data.blocks.find(b => b.id === blockId);
        return { success: true, block: block || undefined, file: null };
      }

      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, status: 'idle' } : b));
      return { success: false };
    } catch (err: any) {
      setError(err.message);
      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, status: 'idle' } : b));
      return { success: false };
    }
  }, [token, headers]);

  // Ask a question about a block WITHOUT modifying it (read-only Q&A).
  // Streams the answer text via onText; never changes blocks/file/status.
  const askBlock = useCallback(async (
    fileId: string,
    blockId: string,
    instruction: string,
    onText?: (delta: string) => void,
  ): Promise<string> => {
    if (!token) return '';
    const res = await fetch(`${SSE_BASE}/api/blocks/${fileId}/regenerate/${blockId}`, {
      method: 'POST',
      headers: { ...headers(), Accept: 'text/event-stream' },
      body: JSON.stringify({ instruction, answerOnly: true }),
    });
    if (!res.ok) throw new Error(`Ask failed: ${res.status}`);
    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');
    const decoder = new TextDecoder();
    let buffer = '';
    let answer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === 'ai_text' && event.data) { answer += event.data; onText?.(event.data); }
          else if (event.type === 'answer' && typeof event.data === 'string') { answer = event.data; }
          else if (event.type === 'error') throw new Error(event.data || 'Ask failed');
        } catch (e: any) {
          if (e?.message === 'Ask failed' || e?.message?.startsWith('Ask')) throw e;
          // ignore partial-JSON parse errors
        }
      }
    }
    return answer;
  }, [token, headers]);

  const setBlocksFromSSE = useCallback((data: { fileId: string; blocks: DocumentBlock[] }) => {
    setBlocks(data.blocks);
  }, []);

  return {
    record,
    blocks,
    loading,
    error,
    fetchBlocks,
    fetchConversationBlocks,
    updateBlocks,
    updateBlock,
    deleteBlock,
    addBlock,
    rebuild,
    patchField,
    regenerate,
    askBlock,
    setBlocksFromSSE,
  };
}
