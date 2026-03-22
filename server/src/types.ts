export interface User {
  id: string;
  email: string;
  password_hash: string;
  display_name: string | null;
  role: 'user' | 'admin';
  status: 'active' | 'pending' | 'suspended';
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
  type:
    | 'text' | 'thinking' | 'tool_activity' | 'file_generated' | 'usage'
    | 'done' | 'error' | 'session_id'
    // Multi-agent orchestration events
    | 'task_dispatched' | 'task_completed' | 'task_failed'
    | 'pipeline_started' | 'pipeline_completed'
    | 'agent_status' | 'agent_stream' | 'router_plan';
  data: unknown;
}

export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  fileType: string;
  systemPrompt: string;
  role?: 'router' | 'worker';
  order?: number;
  allowedTools?: string[];
  disallowedTools?: string[];
}

// --- Multi-agent orchestration types ---

export interface ParsedTask {
  skillId: string;
  description: string;
}

export interface ParsedPipeline {
  tasks: ParsedTask[];
  parallel: boolean;
}

export interface TaskExecution {
  taskId: string;
  skillId: string;
  description: string;
  status: 'pending' | 'dispatched' | 'running' | 'completed' | 'failed';
  result?: string;
  tokenUsage?: { inputTokens: number; outputTokens: number };
}

export interface AuthPayload {
  userId: string;
  email: string;
  role: 'user' | 'admin';
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthPayload;
    }
  }
}
