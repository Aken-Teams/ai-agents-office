# AI Agents Office

AI-powered document generation service. Users describe requirements via web UI, the system calls local Claude CLI agents to generate PPT, Word, Excel, PDF files.

## Tech Stack
- **Backend**: Express 5 + TypeScript + MySQL (mysql2)
- **Frontend**: Next.js 15 (App Router) + TypeScript
- **Auth**: Simple email/password + bcrypt + JWT
- **AI Engine**: Local CLI agents only — no Claude API. Orchestrator engine is pluggable: `claude` (Claude CLI) or `codex` (Codex CLI), which share the same spawn signature and SSE protocol. Engine is resolved per request: explicit `engine` in the generate request body wins, then the conversation's sticky choice (`conversations.agent_engine`), then the global default `AGENTS_OFFICE_AGENT_ENGINE` (default `claude`). A new explicit choice is persisted to the conversation so it sticks across turns and the UI restores it (engine toggle in the chat composer). Codex requires `codex login` (or `CODEX_HOME`/`AGENTS_OFFICE_CODEX_HOME`) on the host. Lightweight text (greeting/memory) always runs through the Claude CLI (`runClaudeText`), regardless of engine.
- **Streaming**: SSE (Server-Sent Events)
- **Doc Generation**: Hybrid (pre-built scripts + Claude flexibility)

## Project Structure
- `server/` — Express API server
- `client/` — Next.js frontend
- `workspace/` — Sandboxed output directory (per-user isolation)

## Security
- 5-layer sandbox defense model
- All generated files restricted to `workspace/{userId}/{conversationId}/`
- Claude CLI tool restrictions via --allowedTools/--disallowedTools
- Input sanitization against prompt injection

## Commands
- `pnpm run dev` — Start both server and client
- `pnpm run dev:server` — Start server only
- `pnpm run dev:client` — Start client only
- `pnpm run init-db` — Initialize database
