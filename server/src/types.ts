export interface User {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  skill_id: string | null;
  session_id: string | null;
  status: 'active' | 'completed' | 'failed';
  created_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata: string | null;
  created_at: string;
}

export interface GeneratedFile {
  id: string;
  user_id: string;
  conversation_id: string | null;
  filename: string;
  file_path: string;
  file_type: string;
  file_size: number;
  created_at: string;
}

export interface TokenUsage {
  id: string;
  user_id: string;
  conversation_id: string | null;
  input_tokens: number;
  output_tokens: number;
  model: string | null;
  duration_ms: number | null;
  created_at: string;
}

export interface SSEEvent {
  type: 'text' | 'thinking' | 'tool_activity' | 'file_generated' | 'usage' | 'done' | 'error';
  data: unknown;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  fileType: string;
  systemPrompt: string;
}

export interface AuthPayload {
  userId: string;
  email: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}
