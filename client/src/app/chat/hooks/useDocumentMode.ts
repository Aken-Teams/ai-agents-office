'use client';

import { useState, useCallback, useRef } from 'react';
import type { DocumentBlock, BlockRecord } from '../../editor/hooks/useDocumentBlocks';

export type DocLayoutType = 'slides' | 'doc' | 'sheet' | 'webapp' | 'image';
export type ViewMode = 'chat' | 'document';

export const FILE_GEN_SKILLS = new Set([
  'pptx-gen', 'docx-gen', 'xlsx-gen', 'pdf-gen', 'slides-gen', 'webapp-gen', 'infographic-gen',
]);

export const SKILL_TO_LAYOUT: Record<string, DocLayoutType> = {
  'pptx-gen': 'slides',
  'slides-gen': 'slides',
  'docx-gen': 'doc',
  'pdf-gen': 'doc',
  'xlsx-gen': 'sheet',
  'webapp-gen': 'webapp',
  // Infographic default output is a Gemini-drawn PNG — show it in the image viewer.
  'infographic-gen': 'image',
};

export const FILE_TYPE_TO_LAYOUT: Record<string, DocLayoutType> = {
  pptx: 'slides',
  ppt: 'slides',
  html: 'slides',
  htm: 'slides',
  docx: 'doc',
  doc: 'doc',
  pdf: 'doc',
  xlsx: 'sheet',
  xls: 'sheet',
  csv: 'sheet',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
};

interface SSEEvent {
  type: string;
  data: unknown;
}

export interface UseDocumentModeReturn {
  viewMode: ViewMode;
  docLayoutType: DocLayoutType | null;
  documentFileId: string | null;
  blocks: DocumentBlock[];
  selectedBlockId: string | null;
  setSelectedBlockId: (id: string | null) => void;
  setBlocks: (blocks: DocumentBlock[]) => void;
  setDocumentFileId: (id: string | null) => void;
  enterDocumentMode: (skillId: string, fileId?: string) => void;
  exitDocumentMode: () => void;
  handleSSEEvent: (event: SSEEvent) => void;
  manualToggle: (fileId?: string, fileType?: string) => void;
  isManualOverride: boolean;
  /** Call when a generation round completes. If no file was generated, auto-exit. */
  onGenerationDone: (hadFileGenerated: boolean) => void;
}

export function useDocumentMode(conversationId: string): UseDocumentModeReturn {
  const [viewMode, setViewMode] = useState<ViewMode>('chat');
  const [docLayoutType, setDocLayoutType] = useState<DocLayoutType | null>(null);
  const [documentFileId, setDocumentFileId] = useState<string | null>(null);
  const [blocks, setBlocks] = useState<DocumentBlock[]>([]);
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [isManualOverride, setIsManualOverride] = useState(false);

  // Track whether we auto-entered this round (vs manual)
  const autoEnteredRef = useRef(false);

  const enterDocumentMode = useCallback((skillId: string, fileId?: string) => {
    const layout = SKILL_TO_LAYOUT[skillId];
    if (!layout) return;
    setDocLayoutType(layout);
    setViewMode('document');
    if (fileId) setDocumentFileId(fileId);
    autoEnteredRef.current = true;
    setIsManualOverride(false);
  }, []);

  const exitDocumentMode = useCallback(() => {
    setViewMode('chat');
    setSelectedBlockId(null);
    autoEnteredRef.current = false;
  }, []);

  const manualToggle = useCallback((fileId?: string, fileType?: string) => {
    if (viewMode === 'document') {
      exitDocumentMode();
      setIsManualOverride(false);
    } else {
      // Enter document mode manually
      const layout = fileType ? (FILE_TYPE_TO_LAYOUT[fileType] || 'doc') : (docLayoutType || 'slides');
      setDocLayoutType(layout);
      setViewMode('document');
      if (fileId) setDocumentFileId(fileId);
      setIsManualOverride(true);
      autoEnteredRef.current = false;
    }
  }, [viewMode, exitDocumentMode, docLayoutType]);

  const handleSSEEvent = useCallback((event: SSEEvent) => {
    // router_plan → detect file-gen skill in orchestrated mode
    if (event.type === 'router_plan') {
      const plan = event.data as { pipelines?: any[]; bareTasks?: any[] };
      const allSkills = [
        ...(plan.bareTasks || []).map((t: any) => t.skillId),
        ...(plan.pipelines || []).flatMap((p: any) => (p.tasks || []).map((t: any) => t.skillId)),
      ];
      const fileGenSkill = allSkills.find(s => FILE_GEN_SKILLS.has(s));
      if (fileGenSkill && viewMode === 'chat') {
        enterDocumentMode(fileGenSkill);
      }
    }

    // task_dispatched → fallback detection
    if (event.type === 'task_dispatched') {
      const task = event.data as { taskId: string; skillId: string };
      if (FILE_GEN_SKILLS.has(task.skillId) && viewMode === 'chat') {
        enterDocumentMode(task.skillId);
      }
    }

    // skill_started → direct mode detection
    if (event.type === 'skill_started') {
      const { skillId } = event.data as { skillId: string };
      if (FILE_GEN_SKILLS.has(skillId) && viewMode === 'chat') {
        enterDocumentMode(skillId);
      }
    }

    // blocks_ready → populate blocks
    if (event.type === 'blocks_ready') {
      const data = event.data as { fileId: string; blocks: DocumentBlock[] };
      setDocumentFileId(data.fileId);
      setBlocks(data.blocks);
    }

    // file_generated → fallback: if still in chat mode, enter document mode
    if (event.type === 'file_generated') {
      const files = event.data as { id: string; file_type: string }[];
      if (files.length > 0 && viewMode === 'chat') {
        const file = files[0];
        const layout = FILE_TYPE_TO_LAYOUT[file.file_type];
        if (layout) {
          setDocLayoutType(layout);
          setViewMode('document');
          setDocumentFileId(file.id);
          autoEnteredRef.current = true;
        }
      } else if (viewMode === 'document' && files.length > 0) {
        // Update fileId if in document mode already
        setDocumentFileId(files[0].id);
      }
    }
  }, [viewMode, enterDocumentMode]);

  const onGenerationDone = useCallback((hadFileGenerated: boolean) => {
    // If auto-entered and no file was generated this round, exit
    if (autoEnteredRef.current && !hadFileGenerated && !isManualOverride) {
      exitDocumentMode();
    }
  }, [isManualOverride, exitDocumentMode]);

  return {
    viewMode,
    docLayoutType,
    documentFileId,
    blocks,
    selectedBlockId,
    setSelectedBlockId,
    setBlocks,
    setDocumentFileId,
    enterDocumentMode,
    exitDocumentMode,
    handleSSEEvent,
    manualToggle,
    isManualOverride,
    onGenerationDone,
  };
}
