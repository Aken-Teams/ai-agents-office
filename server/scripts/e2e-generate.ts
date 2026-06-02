/**
 * End-to-end smoke test for the document-generation pipeline.
 *
 * Drives the real /api/generate SSE endpoint for each AI engine and asserts a
 * document file is actually produced on disk — the same flow a browser user
 * triggers. This exercises engine selection (claude | codex), the orchestrator,
 * the CLI sandbox, and file registration together.
 *
 * NOTE: this runs the real local CLIs and therefore consumes real quota and
 * takes a minute or two per engine. It is opt-in (not wired into any default
 * build/CI step). Run it manually after changing the generation pipeline.
 *
 * Usage:
 *   pnpm run e2e                       # test both engines (claude + codex)
 *   pnpm run e2e -- --engine codex     # one engine only
 *   pnpm run e2e -- --keep             # don't delete the test conversation/files
 *   E2E_BASE_URL=http://localhost:12054 pnpm run e2e   # target a running server
 *                                                      # (else a fresh one is spawned)
 *   E2E_USER_EMAIL=someone@example.com pnpm run e2e    # pick the test user
 *
 * Exit code: 0 if every engine produced a valid document, 1 otherwise.
 */
import { spawn, ChildProcess } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import mysql from 'mysql2/promise';
import jwt from 'jsonwebtoken';
import { config } from '../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.resolve(__dirname, '..');

const DOC_EXTENSIONS = ['.pptx', '.docx', '.xlsx', '.pdf'];
const MIN_DOC_BYTES = 1000;
const PER_ENGINE_TIMEOUT_MS = 240_000;

// A deliberately tiny task to keep quota cost low while still producing a file.
const TEST_MESSAGE =
  '請做一份非常簡單的 PPT，只要一張投影片，標題寫 E2E Test。不要研究、不要上網。';

type Engine = 'claude' | 'codex';

interface EngineResult {
  engine: Engine;
  pass: boolean;
  detail: string;
  docFile?: string;
}

function parseArgs(argv: string[]): { engines: Engine[]; keep: boolean } {
  let engines: Engine[] = ['claude', 'codex'];
  let keep = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--engine') {
      const v = (argv[++i] || '').toLowerCase();
      if (v === 'claude' || v === 'codex') engines = [v];
      else if (v === 'both') engines = ['claude', 'codex'];
      else throw new Error(`--engine must be claude|codex|both, got "${v}"`);
    } else if (argv[i] === '--keep') {
      keep = true;
    }
  }
  return { engines, keep };
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

/** Spawn a fresh dev server on the given port; resolve once it is listening. */
function startServer(port: number): Promise<ChildProcess> {
  const tsx = path.join(SERVER_DIR, 'node_modules', '.bin', 'tsx');
  const proc = spawn(tsx, ['src/index.ts'], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start within 30s')), 30_000);
    const onData = (buf: Buffer) => {
      const s = buf.toString();
      if (s.includes('running on http')) {
        clearTimeout(timer);
        proc.stdout?.off('data', onData);
        resolve(proc);
      }
    };
    proc.stdout?.on('data', onData);
    proc.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited early (code ${code})`)); });
  });
}

async function resolveTestUser(conn: mysql.Connection): Promise<{ id: string; email: string; role: string }> {
  const email = process.env.E2E_USER_EMAIL;
  const sql = email
    ? 'SELECT id, email, role FROM users WHERE email = ? LIMIT 1'
    : 'SELECT id, email, role FROM users ORDER BY created_at ASC LIMIT 1';
  const [rows] = await conn.query(sql, email ? [email] : []) as any[];
  if (!rows.length) throw new Error('no users in DB — create one before running e2e');
  return rows[0];
}

/** POST to /api/generate and consume the SSE stream until `done`. */
async function runGeneration(baseUrl: string, conversationId: string, token: string, engine: Engine) {
  const events: Array<{ type: string; data: unknown }> = [];
  const res = await fetch(`${baseUrl}/api/generate/${conversationId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message: TEST_MESSAGE, engine }),
    signal: AbortSignal.timeout(PER_ENGINE_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split('\n\n');
    buf = chunks.pop() || '';
    for (const chunk of chunks) {
      const line = chunk.split('\n').find(l => l.startsWith('data: '));
      if (!line) continue;
      try {
        events.push(JSON.parse(line.slice(6)));
      } catch { /* keepalive or partial */ }
    }
  }
  return events;
}

function findDocFile(events: Array<{ type: string; data: unknown }>): string | undefined {
  for (const ev of events) {
    if (ev.type !== 'file_generated') continue;
    const files = ev.data as Array<{ filename: string; file_path: string }>;
    const doc = files.find(f => DOC_EXTENSIONS.some(ext => f.filename.toLowerCase().endsWith(ext)));
    if (doc) return doc.file_path;
  }
  return undefined;
}

async function testEngine(
  baseUrl: string, conn: mysql.Connection,
  user: { id: string; email: string; role: string }, engine: Engine, keep: boolean,
): Promise<EngineResult> {
  const conversationId = crypto.randomUUID();
  await conn.query(
    "INSERT INTO conversations (id, user_id, title, category, status) VALUES (?, ?, ?, 'document', 'active')",
    [conversationId, user.id, `e2e-${engine}`],
  );
  const token = jwt.sign({ userId: user.id, email: user.email, role: user.role || 'user' }, config.jwtSecret, { expiresIn: '1h' });

  try {
    const events = await runGeneration(baseUrl, conversationId, token, engine);

    // Assertion 1: the engine choice was persisted to the conversation (sticky).
    const [rows] = await conn.query('SELECT agent_engine FROM conversations WHERE id = ?', [conversationId]) as any[];
    const persisted = rows[0]?.agent_engine;
    if (persisted !== engine) {
      return { engine, pass: false, detail: `agent_engine not persisted (got "${persisted}", want "${engine}")` };
    }

    // Assertion 2: a document file event was emitted.
    const docRel = findDocFile(events);
    if (!docRel) {
      const lastText = [...events].reverse().find(e => e.type === 'text')?.data;
      const err = events.find(e => e.type === 'error')?.data;
      return { engine, pass: false, detail: `no document file produced. error=${err ?? 'none'} lastText=${String(lastText ?? '').slice(0, 200)}` };
    }

    // Assertion 3: the file exists on disk and is non-trivial.
    const fullPath = path.join(config.workspaceRoot, docRel);
    if (!fs.existsSync(fullPath)) {
      return { engine, pass: false, detail: `event reported ${docRel} but file is missing on disk` };
    }
    const size = fs.statSync(fullPath).size;
    if (size < MIN_DOC_BYTES) {
      return { engine, pass: false, detail: `file too small (${size} bytes) — likely corrupt` };
    }

    return { engine, pass: true, detail: `produced ${path.basename(docRel)} (${size} bytes)`, docFile: fullPath };
  } finally {
    if (!keep) {
      await conn.query('DELETE FROM generated_files WHERE conversation_id = ?', [conversationId]);
      await conn.query('DELETE FROM messages WHERE conversation_id = ?', [conversationId]);
      await conn.query('DELETE FROM conversations WHERE id = ?', [conversationId]);
      try { fs.rmSync(path.join(config.workspaceRoot, user.id, conversationId), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
}

async function main() {
  const { engines, keep } = parseArgs(process.argv.slice(2));

  let server: ChildProcess | undefined;
  let baseUrl = process.env.E2E_BASE_URL;
  if (!baseUrl) {
    const port = await getFreePort();
    console.log(`[e2e] starting a fresh server on port ${port} …`);
    server = await startServer(port);
    baseUrl = `http://localhost:${port}`;
    console.log(`[e2e] server up at ${baseUrl}`);
  } else {
    console.log(`[e2e] targeting running server at ${baseUrl}`);
  }

  const conn = await mysql.createConnection({
    host: config.mysqlHost, port: config.mysqlPort, user: config.mysqlUser,
    password: config.mysqlPassword, database: config.mysqlDb,
  });

  const results: EngineResult[] = [];
  try {
    const user = await resolveTestUser(conn);
    console.log(`[e2e] test user: ${user.email}`);
    for (const engine of engines) {
      console.log(`\n[e2e] === engine: ${engine} === (this calls the real CLI, ~1-2 min)`);
      try {
        const r = await testEngine(baseUrl, conn, user, engine, keep);
        results.push(r);
        console.log(`[e2e] ${engine}: ${r.pass ? 'PASS' : 'FAIL'} — ${r.detail}`);
      } catch (err) {
        results.push({ engine, pass: false, detail: err instanceof Error ? err.message : String(err) });
        console.log(`[e2e] ${engine}: FAIL — ${results[results.length - 1].detail}`);
      }
    }
  } finally {
    await conn.end();
    if (server) { server.kill('SIGTERM'); }
  }

  console.log('\n[e2e] ===== summary =====');
  for (const r of results) console.log(`  ${r.pass ? '✅' : '❌'} ${r.engine}: ${r.detail}`);
  const failed = results.filter(r => !r.pass).length;
  console.log(`[e2e] ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('[e2e] fatal:', err); process.exit(1); });
