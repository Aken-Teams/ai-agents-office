import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import db from '../db.js';
import { adminMiddleware } from '../middleware/adminAuth.js';
import { loadSkills } from '../skills/loader.js';

const router = Router();
router.use(adminMiddleware);

// ==================== Overview ====================

// GET /api/admin/overview/stats
router.get('/overview/stats', (_req: Request, res: Response) => {
  const totalUsers = (db.prepare(
    "SELECT COUNT(*) as count FROM users WHERE role != 'admin'"
  ).get() as any).count;

  const activeSkills = loadSkills().length;

  const tokenRow = db.prepare(
    'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM token_usage'
  ).get() as any;

  const totalFiles = (db.prepare(
    'SELECT COUNT(*) as count FROM generated_files'
  ).get() as any).count;

  res.json({
    totalUsers,
    activeSkills,
    totalTokens: tokenRow.total,
    totalFiles,
    systemUptime: Math.floor(process.uptime()),
    systemHealth: 'operational',
  });
});

// GET /api/admin/overview/token-velocity?period=7d|30d
router.get('/overview/token-velocity', (req: Request, res: Response) => {
  const period = (req.query.period as string) || '7d';
  const days = period === '30d' ? 30 : 7;

  const rows = db.prepare(`
    SELECT
      date(created_at) as date,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as invocation_count
    FROM token_usage
    WHERE created_at >= datetime('now', '-${days} days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all() as { date: string; total_input: number; total_output: number; invocation_count: number }[];

  // Fill missing dates with zeros
  const dataMap = new Map(rows.map(r => [r.date, r]));
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const existing = dataMap.get(dateStr);
    result.push(existing || { date: dateStr, total_input: 0, total_output: 0, invocation_count: 0 });
  }

  res.json(result);
});

// GET /api/admin/overview/recent-activity?limit=20
router.get('/overview/recent-activity', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  const rows = db.prepare(`
    SELECT 'user_registered' as event_type, u.id as entity_id, u.email as description, u.created_at
    FROM users u WHERE u.role != 'admin'
    UNION ALL
    SELECT 'file_generated', gf.id, gf.filename, gf.created_at
    FROM generated_files gf
    UNION ALL
    SELECT 'conversation_created', c.id, c.title, c.created_at
    FROM conversations c
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit);

  res.json(rows);
});

// ==================== User Management ====================

// GET /api/admin/users?page=1&limit=20&search=&status=
router.get('/users', (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = (page - 1) * limit;
  const search = req.query.search as string || '';
  const status = req.query.status as string || '';

  let whereClause = "WHERE u.role != 'admin'";
  const params: any[] = [];

  if (search) {
    whereClause += ' AND (u.email LIKE ? OR u.id LIKE ? OR u.display_name LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }
  if (status && ['active', 'suspended'].includes(status)) {
    whereClause += ' AND u.status = ?';
    params.push(status);
  }

  const countRow = db.prepare(
    `SELECT COUNT(*) as total FROM users u ${whereClause}`
  ).get(...params) as any;

  const rows = db.prepare(`
    SELECT
      u.id, u.email, u.display_name, u.status, u.role, u.created_at,
      COALESCE(t.total_tokens, 0) as total_tokens,
      COALESCE(f.file_count, 0) as file_count,
      COALESCE(c.conv_count, 0) as conversation_count
    FROM users u
    LEFT JOIN (
      SELECT user_id, SUM(input_tokens + output_tokens) as total_tokens
      FROM token_usage GROUP BY user_id
    ) t ON t.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) as file_count
      FROM generated_files GROUP BY user_id
    ) f ON f.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COUNT(*) as conv_count
      FROM conversations GROUP BY user_id
    ) c ON c.user_id = u.id
    ${whereClause}
    ORDER BY u.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    users: rows,
    total: countRow.total,
    page,
    limit,
    totalPages: Math.ceil(countRow.total / limit),
  });
});

// GET /api/admin/users/:id
router.get('/users/:id', (req: Request, res: Response) => {
  const userId = req.params.id;

  const user = db.prepare(`
    SELECT id, email, display_name, status, role, created_at, updated_at
    FROM users WHERE id = ?
  `).get(userId) as any;

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const tokenStats = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as invocation_count
    FROM token_usage WHERE user_id = ?
  `).get(userId);

  const recentFiles = db.prepare(`
    SELECT id, filename, file_type, file_size, created_at
    FROM generated_files WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 5
  `).all(userId);

  const recentConversations = db.prepare(`
    SELECT id, title, skill_id, status, created_at
    FROM conversations WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 5
  `).all(userId);

  res.json({ ...user, tokenStats, recentFiles, recentConversations });
});

// PATCH /api/admin/users/:id/status
router.patch('/users/:id/status', (req: Request, res: Response) => {
  const userId = req.params.id;
  const { status } = req.body;

  if (!['active', 'suspended'].includes(status)) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }

  const user = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(userId) as any;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (user.role === 'admin') {
    res.status(403).json({ error: 'Cannot modify admin user' });
    return;
  }

  db.prepare('UPDATE users SET status = ?, updated_at = datetime(\'now\') WHERE id = ?').run(status, userId);

  // Audit log
  db.prepare(
    'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(uuidv4(), req.user!.userId, status === 'suspended' ? 'suspend_user' : 'activate_user', 'user', userId, JSON.stringify({ email: user.email }));

  res.json({ success: true, status });
});

// PATCH /api/admin/users/:id
router.patch('/users/:id', (req: Request, res: Response) => {
  const userId = req.params.id;
  const { displayName } = req.body;

  const user = db.prepare('SELECT id, role FROM users WHERE id = ?').get(userId) as any;
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (user.role === 'admin') {
    res.status(403).json({ error: 'Cannot modify admin user' });
    return;
  }

  if (displayName !== undefined) {
    db.prepare('UPDATE users SET display_name = ?, updated_at = datetime(\'now\') WHERE id = ?').run(displayName, userId);
  }

  res.json({ success: true });
});

// ==================== Token Ledger ====================

// GET /api/admin/tokens/summary
router.get('/tokens/summary', (_req: Request, res: Response) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as total_invocations
    FROM token_usage
  `).get() as any;

  // Claude Sonnet 4 pricing: $3/M input, $15/M output
  const estimatedCost = (row.total_input / 1_000_000) * 3 + (row.total_output / 1_000_000) * 15;

  res.json({
    totalInput: row.total_input,
    totalOutput: row.total_output,
    totalInvocations: row.total_invocations,
    estimatedCost: Math.round(estimatedCost * 10000) / 10000,
  });
});

// GET /api/admin/tokens/chart?period=7d|30d
router.get('/tokens/chart', (req: Request, res: Response) => {
  const period = (req.query.period as string) || '7d';
  const days = period === '30d' ? 30 : 7;

  const rows = db.prepare(`
    SELECT
      date(created_at) as date,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as invocation_count
    FROM token_usage
    WHERE created_at >= datetime('now', '-${days} days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all() as { date: string; total_input: number; total_output: number; invocation_count: number }[];

  const dataMap = new Map(rows.map(r => [r.date, r]));
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().slice(0, 10);
    const existing = dataMap.get(dateStr);
    result.push(existing || { date: dateStr, total_input: 0, total_output: 0, invocation_count: 0 });
  }

  res.json(result);
});

// GET /api/admin/tokens/by-user?limit=10
router.get('/tokens/by-user', (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

  const rows = db.prepare(`
    SELECT
      u.id, u.email, u.display_name,
      SUM(tu.input_tokens) as total_input,
      SUM(tu.output_tokens) as total_output,
      COUNT(*) as invocation_count
    FROM token_usage tu
    JOIN users u ON u.id = tu.user_id
    WHERE u.role != 'admin'
    GROUP BY tu.user_id
    ORDER BY (SUM(tu.input_tokens) + SUM(tu.output_tokens)) DESC
    LIMIT ?
  `).all(limit);

  res.json(rows);
});

// GET /api/admin/tokens/ledger?page=1&limit=20
router.get('/tokens/ledger', (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = (page - 1) * limit;

  const countRow = db.prepare('SELECT COUNT(*) as total FROM token_usage').get() as any;

  const rows = db.prepare(`
    SELECT
      tu.id, tu.user_id, u.email, u.display_name,
      tu.conversation_id, c.title as conversation_title,
      tu.input_tokens, tu.output_tokens, tu.model, tu.duration_ms, tu.created_at
    FROM token_usage tu
    LEFT JOIN users u ON u.id = tu.user_id
    LEFT JOIN conversations c ON c.id = tu.conversation_id
    ORDER BY tu.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({
    entries: rows,
    total: countRow.total,
    page,
    limit,
    totalPages: Math.ceil(countRow.total / limit),
  });
});

// ==================== Security & Audit ====================

// GET /api/admin/security/audit-log?page=1&limit=50
router.get('/security/audit-log', (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = (page - 1) * limit;

  const countRow = db.prepare('SELECT COUNT(*) as total FROM admin_audit_log').get() as any;

  const rows = db.prepare(`
    SELECT al.*, u.email as admin_email
    FROM admin_audit_log al
    LEFT JOIN users u ON u.id = al.admin_id
    ORDER BY al.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  res.json({
    entries: rows,
    total: countRow.total,
    page,
    limit,
    totalPages: Math.ceil(countRow.total / limit),
  });
});

// GET /api/admin/security/sandbox-status
router.get('/security/sandbox-status', (_req: Request, res: Response) => {
  const rows = db.prepare(`
    SELECT
      u.id, u.email, u.display_name, u.status,
      COALESCE(s.active_sessions, 0) as active_sessions,
      COALESCE(f.storage_used, 0) as storage_used,
      COALESCE(f.file_count, 0) as file_count
    FROM users u
    LEFT JOIN (
      SELECT user_id, COUNT(*) as active_sessions
      FROM conversations WHERE status = 'active'
      GROUP BY user_id
    ) s ON s.user_id = u.id
    LEFT JOIN (
      SELECT user_id, COALESCE(SUM(file_size), 0) as storage_used, COUNT(*) as file_count
      FROM generated_files GROUP BY user_id
    ) f ON f.user_id = u.id
    WHERE u.role != 'admin'
    ORDER BY active_sessions DESC
  `).all();

  res.json(rows);
});

// GET /api/admin/security/stats
router.get('/security/stats', (_req: Request, res: Response) => {
  const auditCount = (db.prepare('SELECT COUNT(*) as count FROM admin_audit_log').get() as any).count;
  const userCount = (db.prepare("SELECT COUNT(*) as count FROM users WHERE role != 'admin'").get() as any).count;
  const suspendedCount = (db.prepare("SELECT COUNT(*) as count FROM users WHERE status = 'suspended'").get() as any).count;

  res.json({
    totalAuditEntries: auditCount,
    totalUsers: userCount,
    suspendedUsers: suspendedCount,
    systemUptime: Math.floor(process.uptime()),
    isolationLevel: 'LEVEL_5',
  });
});

export default router;
