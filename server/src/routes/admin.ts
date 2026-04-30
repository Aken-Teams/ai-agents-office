import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { dbGet, dbAll, dbRun } from '../db.js';
import { adminMiddleware } from '../middleware/adminAuth.js';
import { loadSkills } from '../skills/loader.js';
import { config } from '../config.js';
import { applyWatermark } from '../services/watermark.js';
import { getUserUsageLimitUsd, setUserUsageLimitUsd, getUserDisplayCost, getEffectiveUserLimit, getStorageQuotaGb, setStorageQuotaGb, getUploadQuotaMb, setUploadQuotaMb } from '../services/usageLimit.js';

const router = Router();
router.use(adminMiddleware);

// ==================== Overview ====================

// GET /api/admin/overview/stats
router.get('/overview/stats', async (_req: Request, res: Response) => {
  const totalUsersRow = await dbGet<{ count: number }>(
    'SELECT COUNT(*) as count FROM users'
  );

  const activeSkills = loadSkills().length;

  const tokenRow = await dbGet<{ total: number }>(
    'SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM token_usage'
  );

  const totalFilesRow = await dbGet<{ count: number }>(
    'SELECT COUNT(*) as count FROM generated_files'
  );

  res.json({
    totalUsers: totalUsersRow?.count ?? 0,
    activeSkills,
    totalTokens: tokenRow?.total ?? 0,
    totalFiles: totalFilesRow?.count ?? 0,
    systemUptime: Math.floor(process.uptime()),
    systemHealth: 'operational',
  });
});

// GET /api/admin/overview/token-velocity?period=7d|30d
router.get('/overview/token-velocity', async (req: Request, res: Response) => {
  const period = (req.query.period as string) || '7d';
  const days = period === '30d' ? 30 : 7;

  const rows = await dbAll<{ date: string; total_input: number; total_output: number; invocation_count: number }>(`
    SELECT
      DATE_FORMAT(created_at, '%Y-%m-%d') as date,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as invocation_count
    FROM token_usage
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
    ORDER BY date ASC
  `);

  // Fill missing dates with zeros
  const dataMap = new Map(rows.map(r => [r.date, r]));
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const existing = dataMap.get(dateStr);
    result.push(existing || { date: dateStr, total_input: 0, total_output: 0, invocation_count: 0 });
  }

  res.json(result);
});

// GET /api/admin/overview/recent-activity?limit=20
router.get('/overview/recent-activity', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

  const rows = await dbAll(`
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
  `, limit);

  res.json(rows);
});

// ==================== User Management ====================

// GET /api/admin/users?page=1&limit=20&search=&status=
router.get('/users', async (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = (page - 1) * limit;
  const search = req.query.search as string || '';
  const status = req.query.status as string || '';
  const sortBy = req.query.sortBy as string || '';
  const sortDir = (req.query.sortDir as string || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let whereClause = "WHERE 1=1";
  const params: any[] = [];

  if (search) {
    whereClause += ' AND (u.email LIKE ? OR u.id LIKE ? OR u.display_name LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }
  if (status && ['active', 'pending', 'pending_verification', 'suspended'].includes(status)) {
    whereClause += ' AND u.status = ?';
    params.push(status);
  }

  const countRow = await dbGet<{ total: number }>(
    `SELECT COUNT(*) as total FROM users u ${whereClause}`,
    ...params
  );

  const rows = await dbAll(`
    SELECT
      u.id, u.email, u.display_name, u.status, u.role, u.created_at, u.last_login_at,
      u.quota_group_id, qg.name as quota_group_name,
      u.invite_code_id, ic.code as invite_code, ic.label as invite_code_label,
      COALESCE(t.total_tokens, 0) as total_tokens,
      COALESCE(t.total_input, 0) as total_input_tokens,
      COALESCE(t.total_output, 0) as total_output_tokens,
      COALESCE(f.file_count, 0) as file_count,
      COALESCE(c.conv_count, 0) as conversation_count
    FROM users u
    LEFT JOIN quota_groups qg ON qg.id = u.quota_group_id
    LEFT JOIN invite_codes ic ON ic.id = u.invite_code_id
    LEFT JOIN (
      SELECT user_id, SUM(input_tokens + output_tokens) as total_tokens,
        SUM(input_tokens) as total_input, SUM(output_tokens) as total_output
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
    ORDER BY ${
      sortBy === 'tokens' ? `total_tokens ${sortDir}` :
      sortBy === 'conversations' ? `conversation_count ${sortDir}` :
      sortBy === 'files' ? `file_count ${sortDir}` :
      'u.created_at DESC'
    }
    LIMIT ? OFFSET ?
  `, ...params, limit, offset);

  res.json({
    users: rows,
    total: countRow?.total ?? 0,
    page,
    limit,
    totalPages: Math.ceil((countRow?.total ?? 0) / limit),
  });
});

// GET /api/admin/users/:id
router.get('/users/:id', async (req: Request, res: Response) => {
  const userId = req.params.id as string;

  const user = await dbGet<any>(`
    SELECT u.id, u.email, u.display_name, u.status, u.role, u.quota_override, u.quota_group_id, u.created_at, u.updated_at,
      qg.name as quota_group_name,
      u.invite_code_id, ic.code as invite_code, ic.label as invite_code_label
    FROM users u
    LEFT JOIN quota_groups qg ON qg.id = u.quota_group_id
    LEFT JOIN invite_codes ic ON ic.id = u.invite_code_id
    WHERE u.id = ?
  `, userId);

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const tokenStats = await dbGet(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as invocation_count
    FROM token_usage WHERE user_id = ?
  `, userId);

  const recentFiles = await dbAll(`
    SELECT id, filename, file_type, file_size, created_at
    FROM generated_files WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 5
  `, userId);

  const recentConversations = await dbAll(`
    SELECT id, title, skill_id, status, created_at
    FROM conversations WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 5
  `, userId);

  const convCount = await dbGet<{ count: number }>(
    'SELECT COUNT(*) as count FROM conversations WHERE user_id = ?', userId
  );

  const fileCount = await dbGet<{ count: number }>(
    'SELECT COUNT(*) as count FROM generated_files WHERE user_id = ?', userId
  );

  const memoryCount = await dbGet<{ count: number }>(
    'SELECT COUNT(*) as count FROM user_memories WHERE user_id = ?', userId
  );

  const effectiveLimit = await getEffectiveUserLimit(userId);
  const displayCost = await getUserDisplayCost(userId);

  res.json({
    ...user,
    tokenStats,
    recentFiles,
    recentConversations,
    conversation_count: convCount?.count ?? 0,
    file_count: fileCount?.count ?? 0,
    memory_count: memoryCount?.count ?? 0,
    effective_limit: effectiveLimit,
    display_cost: displayCost,
    deploy_mode: config.deployMode,
  });
});

// GET /api/admin/users/:id/memories
router.get('/users/:id/memories', async (req: Request, res: Response) => {
  const userId = req.params.id as string;
  const user = await dbGet('SELECT id FROM users WHERE id = ?', userId);
  if (!user) { res.status(404).json({ error: 'User not found' }); return; }

  const memories = await dbAll(
    'SELECT id, content, category, source_conversation_id, created_at FROM user_memories WHERE user_id = ? ORDER BY created_at DESC',
    userId
  );
  res.json(memories);
});

// PATCH /api/admin/users/:id/status
router.patch('/users/:id/status', async (req: Request, res: Response) => {
  const userId = req.params.id;
  const { status } = req.body;

  if (!['active', 'suspended'].includes(status)) {
    res.status(400).json({ error: 'Invalid status' });
    return;
  }

  const user = await dbGet<any>('SELECT id, email, role FROM users WHERE id = ?', userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (user.role === 'admin') {
    res.status(403).json({ error: 'Cannot modify admin user' });
    return;
  }

  await dbRun('UPDATE users SET status = ?, updated_at = NOW() WHERE id = ?', status, userId);

  // Audit log
  await dbRun(
    'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
    uuidv4(), req.user!.userId, status === 'suspended' ? 'suspend_user' : 'activate_user', 'user', userId, JSON.stringify({ email: user.email })
  );

  res.json({ success: true, status });
});

// PATCH /api/admin/users/:id/role
router.patch('/users/:id/role', async (req: Request, res: Response) => {
  const userId = req.params.id;
  const { role } = req.body;

  if (!['user', 'admin'].includes(role)) {
    res.status(400).json({ error: 'Invalid role. Must be "user" or "admin"' });
    return;
  }

  const user = await dbGet<any>('SELECT id, email, role FROM users WHERE id = ?', userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // Prevent demoting yourself
  if (userId === req.user!.userId && role !== 'admin') {
    res.status(403).json({ error: '無法降級自己的管理者權限' });
    return;
  }

  const oldRole = user.role;
  await dbRun("UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?", role, userId);

  // Audit log
  await dbRun(
    'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
    uuidv4(), req.user!.userId, 'change_role', 'user', userId, JSON.stringify({ email: user.email, from: oldRole, to: role })
  );

  res.json({ success: true, role });
});

// PATCH /api/admin/users/:id
router.patch('/users/:id', async (req: Request, res: Response) => {
  const userId = req.params.id;
  const { displayName } = req.body;

  const user = await dbGet<any>('SELECT id, role FROM users WHERE id = ?', userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (user.role === 'admin') {
    res.status(403).json({ error: 'Cannot modify admin user' });
    return;
  }

  if (displayName !== undefined) {
    await dbRun('UPDATE users SET display_name = ?, updated_at = NOW() WHERE id = ?', displayName, userId);
  }

  res.json({ success: true });
});

// PATCH /api/admin/users/:id/quota — Set per-user quota override (all deploy modes)
router.patch('/users/:id/quota', async (req: Request, res: Response) => {
  const userId = req.params.id as string;
  const { quota_override } = req.body;

  const user = await dbGet<any>('SELECT id, email, role FROM users WHERE id = ?', userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  // null means "use global default", number means custom override
  const value = quota_override === null || quota_override === '' ? null : parseFloat(quota_override);
  if (value !== null && (isNaN(value) || value < 0)) {
    res.status(400).json({ error: 'Invalid quota value' });
    return;
  }

  await dbRun('UPDATE users SET quota_override = ?, updated_at = NOW() WHERE id = ?', value, userId);

  // Audit log
  await dbRun(
    'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
    uuidv4(), req.user!.userId, 'set_quota_override', 'user', userId,
    JSON.stringify({ email: user.email, quota_override: value })
  );

  const effectiveLimit = await getEffectiveUserLimit(userId);
  res.json({ success: true, quota_override: value, effective_limit: effectiveLimit });
});

// DELETE /api/admin/users/:id — Permanently delete user + workspace
router.delete('/users/:id', async (req: Request, res: Response) => {
  const userId = req.params.id as string;

  const user = await dbGet<any>('SELECT id, email, role FROM users WHERE id = ?', userId);
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }
  if (user.role === 'admin') {
    res.status(403).json({ error: 'Cannot delete admin user' });
    return;
  }

  // Delete workspace directory
  const workspacePath = path.join(config.workspaceRoot, userId);
  try {
    if (fs.existsSync(workspacePath)) {
      fs.rmSync(workspacePath, { recursive: true, force: true });
    }
  } catch (err) {
    console.error(`[Admin] Failed to delete workspace for ${userId}:`, err);
  }

  // Delete uploads directory
  const uploadsPath = path.join(config.workspaceRoot, '_tmp_uploads', userId);
  try {
    if (fs.existsSync(uploadsPath)) {
      fs.rmSync(uploadsPath, { recursive: true, force: true });
    }
  } catch { /* ignore */ }

  // Delete from DB (cascading: conversations, messages, files, token_usage, etc.)
  await dbRun('DELETE FROM generated_files WHERE user_id = ?', userId);
  await dbRun('DELETE FROM token_usage WHERE user_id = ?', userId);
  await dbRun('DELETE FROM user_uploads WHERE user_id = ?', userId);
  await dbRun('DELETE FROM security_events WHERE user_id = ?', userId);
  await dbRun('DELETE FROM conversations WHERE user_id = ?', userId);
  await dbRun('DELETE FROM users WHERE id = ?', userId);

  // Audit log
  await dbRun(
    'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
    uuidv4(), req.user!.userId, 'delete_user', 'user', userId, JSON.stringify({ email: user.email })
  );

  res.json({ success: true });
});

// ==================== Token Ledger ====================

// GET /api/admin/tokens/summary
router.get('/tokens/summary', async (_req: Request, res: Response) => {
  const row = await dbGet<{ total_input: number; total_output: number; total_invocations: number }>(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as total_invocations
    FROM token_usage
  `);

  // Claude Sonnet 4 pricing: $3/M input, $15/M output (×10 billing markup)
  const totalInput = row?.total_input ?? 0;
  const totalOutput = row?.total_output ?? 0;
  const estimatedCost = ((totalInput / 1_000_000) * 3 + (totalOutput / 1_000_000) * 15) * 10;

  res.json({
    totalInput,
    totalOutput,
    totalInvocations: row?.total_invocations ?? 0,
    estimatedCost: Math.round(estimatedCost * 10000) / 10000,
  });
});

// GET /api/admin/tokens/chart?period=7d|30d
router.get('/tokens/chart', async (req: Request, res: Response) => {
  const period = (req.query.period as string) || '7d';
  const days = period === '30d' ? 30 : 7;

  const rows = await dbAll<{ date: string; total_input: number; total_output: number; invocation_count: number }>(`
    SELECT
      DATE_FORMAT(created_at, '%Y-%m-%d') as date,
      SUM(input_tokens) as total_input,
      SUM(output_tokens) as total_output,
      COUNT(*) as invocation_count
    FROM token_usage
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
    ORDER BY date ASC
  `);

  const dataMap = new Map(rows.map(r => [r.date, r]));
  const result = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const existing = dataMap.get(dateStr);
    result.push(existing || { date: dateStr, total_input: 0, total_output: 0, invocation_count: 0 });
  }

  res.json(result);
});

// GET /api/admin/tokens/by-user?limit=10
router.get('/tokens/by-user', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

  const rows = await dbAll(`
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
  `, limit);

  res.json(rows);
});

// GET /api/admin/tokens/ledger?page=1&limit=20
router.get('/tokens/ledger', async (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = (page - 1) * limit;

  const countRow = await dbGet<{ total: number }>('SELECT COUNT(*) as total FROM token_usage');

  const rows = await dbAll(`
    SELECT
      tu.id, tu.user_id, u.email, u.display_name,
      tu.conversation_id, c.title as conversation_title,
      (SELECT content FROM messages
       WHERE conversation_id = tu.conversation_id
         AND role = 'user'
         AND created_at <= tu.created_at
       ORDER BY created_at DESC
       LIMIT 1) as user_prompt,
      tu.input_tokens, tu.output_tokens, tu.model, tu.duration_ms, tu.created_at
    FROM token_usage tu
    LEFT JOIN users u ON u.id = tu.user_id
    LEFT JOIN conversations c ON c.id = tu.conversation_id
    ORDER BY tu.created_at DESC
    LIMIT ? OFFSET ?
  `, limit, offset);

  res.json({
    entries: rows,
    total: countRow?.total ?? 0,
    page,
    limit,
    totalPages: Math.ceil((countRow?.total ?? 0) / limit),
  });
});

// ==================== Security & Audit ====================

// GET /api/admin/security/audit-log?page=1&limit=10
// Unified system activity log: user registrations, conversations, file generations, admin actions
router.get('/security/audit-log', async (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 100);
  const offset = (page - 1) * limit;

  // Count total across all sources
  const counts = await dbGet<{ total: number }>(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role != 'admin') +
      (SELECT COUNT(*) FROM conversations) +
      (SELECT COUNT(*) FROM generated_files) +
      (SELECT COUNT(*) FROM admin_audit_log)
    as total
  `);

  // Unified query across all activity sources
  const rows = await dbAll(`
    SELECT
      'user_registered' as event_type,
      u.id as event_id,
      u.email as actor,
      u.display_name as actor_name,
      NULL as detail,
      u.created_at
    FROM users u WHERE u.role != 'admin'
    UNION ALL
    SELECT
      'conversation_created',
      c.id,
      u.email,
      u.display_name,
      c.title,
      c.created_at
    FROM conversations c
    LEFT JOIN users u ON u.id = c.user_id
    UNION ALL
    SELECT
      'file_generated',
      gf.id,
      u.email,
      u.display_name,
      gf.filename,
      gf.created_at
    FROM generated_files gf
    LEFT JOIN users u ON u.id = gf.user_id
    UNION ALL
    SELECT
      CONCAT('admin_', al.action),
      al.id,
      adm.email,
      adm.display_name,
      al.details,
      al.created_at
    FROM admin_audit_log al
    LEFT JOIN users adm ON adm.id = al.admin_id
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `, limit, offset);

  res.json({
    entries: rows,
    total: counts?.total ?? 0,
    page,
    limit,
    totalPages: Math.ceil((counts?.total ?? 0) / limit),
  });
});

// GET /api/admin/security/sandbox-status
router.get('/security/sandbox-status', async (_req: Request, res: Response) => {
  const rows = await dbAll(`
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
  `);

  res.json(rows);
});

// GET /api/admin/security/stats
router.get('/security/stats', async (_req: Request, res: Response) => {
  const auditCount = (await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM admin_audit_log'))?.count ?? 0;
  const userCount = (await dbGet<{ count: number }>("SELECT COUNT(*) as count FROM users WHERE role != 'admin'"))?.count ?? 0;
  const suspendedCount = (await dbGet<{ count: number }>("SELECT COUNT(*) as count FROM users WHERE status = 'suspended'"))?.count ?? 0;
  const totalConversations = (await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM conversations'))?.count ?? 0;
  const totalFiles = (await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM generated_files'))?.count ?? 0;
  const securityEventsCount = (await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM security_events'))?.count ?? 0;
  const blockedThreats = (await dbGet<{ count: number }>("SELECT COUNT(*) as count FROM security_events WHERE severity IN ('high','critical')"))?.count ?? 0;

  res.json({
    totalAuditEntries: auditCount,
    totalUsers: userCount,
    suspendedUsers: suspendedCount,
    totalConversations,
    totalFiles,
    securityEventsCount,
    blockedThreats,
    systemUptime: Math.floor(process.uptime()),
  });
});

// GET /api/admin/security/workspace-scan — real filesystem scan
router.get('/security/workspace-scan', async (_req: Request, res: Response) => {
  const workspaceRoot = config.workspaceRoot;
  const results: { userId: string; email: string; displayName: string | null; dirCount: number; fileCount: number; totalSize: number }[] = [];

  try {
    if (!fs.existsSync(workspaceRoot)) {
      return res.json([]);
    }

    const userDirs = fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('_'));

    // Map user IDs to user info (include all users so admin dirs also resolve)
    const users = await dbAll<any>("SELECT id, email, display_name FROM users");
    const userMap = new Map(users.map((u: any) => [u.id, u]));

    for (const dir of userDirs) {
      const userPath = path.join(workspaceRoot, dir.name);
      let fileCount = 0;
      let dirCount = 0;
      let totalSize = 0;

      // Recursively scan
      function scan(dirPath: string) {
        try {
          const entries = fs.readdirSync(dirPath, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
              dirCount++;
              scan(fullPath);
            } else if (entry.isFile()) {
              fileCount++;
              try {
                const stat = fs.statSync(fullPath);
                totalSize += stat.size;
              } catch { /* skip unreadable */ }
            }
          }
        } catch { /* skip unreadable dirs */ }
      }

      scan(userPath);

      const userInfo = userMap.get(dir.name);
      results.push({
        userId: dir.name,
        email: userInfo?.email || dir.name,
        displayName: userInfo?.display_name || null,
        dirCount,
        fileCount,
        totalSize,
      });
    }

    // Sort by totalSize descending
    results.sort((a, b) => b.totalSize - a.totalSize);
    res.json(results);
  } catch (err) {
    res.json([]);
  }
});

// GET /api/admin/security/events — security events from inputGuard
router.get('/security/events', async (req: Request, res: Response) => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  const severity = req.query.severity as string;

  let where = '';
  const params: unknown[] = [];
  if (severity && ['low', 'medium', 'high', 'critical'].includes(severity)) {
    where = 'WHERE se.severity = ?';
    params.push(severity);
  }

  const totalRow = await dbGet<{ count: number }>(
    `SELECT COUNT(*) as count FROM security_events se ${where}`,
    ...params
  );

  const rows = await dbAll(`
    SELECT se.*, u.email as user_email, u.display_name as user_name
    FROM security_events se
    LEFT JOIN users u ON u.id = se.user_id
    ${where}
    ORDER BY se.created_at DESC
    LIMIT ? OFFSET ?
  `, ...params, limit, offset);

  res.json({
    events: rows,
    total: totalRow?.count ?? 0,
    page,
    limit,
    totalPages: Math.ceil((totalRow?.count ?? 0) / limit),
  });
});

// GET /api/admin/security/events/stats — security events summary
router.get('/security/events/stats', async (_req: Request, res: Response) => {
  const total = (await dbGet<{ count: number }>('SELECT COUNT(*) as count FROM security_events'))?.count ?? 0;
  const blocked = (await dbGet<{ count: number }>("SELECT COUNT(*) as count FROM security_events WHERE severity IN ('high','critical')"))?.count ?? 0;
  const last24h = (await dbGet<{ count: number }>("SELECT COUNT(*) as count FROM security_events WHERE created_at >= DATE_SUB(NOW(), INTERVAL 1 DAY)"))?.count ?? 0;

  res.json({ total, blocked, last24h });
});

// ==================== Settings ====================

// GET /api/admin/settings — All system settings
router.get('/settings', async (_req: Request, res: Response) => {
  res.json({
    usageLimitUsd: await getUserUsageLimitUsd(),
    storageQuotaGb: await getStorageQuotaGb(),
    uploadQuotaMb: await getUploadQuotaMb(),
  });
});

// PATCH /api/admin/settings — Update system settings
router.patch('/settings', async (req: Request, res: Response) => {
  const { usageLimitUsd, storageQuotaGb, uploadQuotaMb } = req.body;
  const changes: string[] = [];

  if (typeof usageLimitUsd === 'number' && usageLimitUsd >= 0 && usageLimitUsd <= 100000) {
    const old = await getUserUsageLimitUsd();
    await setUserUsageLimitUsd(usageLimitUsd);
    changes.push(`usageLimitUsd: ${old} → ${usageLimitUsd}`);
  }
  if (typeof storageQuotaGb === 'number' && storageQuotaGb >= 0 && storageQuotaGb <= 100) {
    const old = await getStorageQuotaGb();
    await setStorageQuotaGb(storageQuotaGb);
    changes.push(`storageQuotaGb: ${old} → ${storageQuotaGb}`);
  }
  if (typeof uploadQuotaMb === 'number' && uploadQuotaMb >= 0 && uploadQuotaMb <= 10000) {
    const old = await getUploadQuotaMb();
    await setUploadQuotaMb(uploadQuotaMb);
    changes.push(`uploadQuotaMb: ${old} → ${uploadQuotaMb}`);
  }

  if (changes.length === 0) {
    res.status(400).json({ error: 'No valid settings to update' });
    return;
  }

  // Audit log
  await dbRun(
    'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
    uuidv4(), req.user!.userId, 'update_settings', 'system', 'system_settings',
    JSON.stringify({ changes })
  );

  res.json({
    success: true,
    usageLimitUsd: await getUserUsageLimitUsd(),
    storageQuotaGb: await getStorageQuotaGb(),
    uploadQuotaMb: await getUploadQuotaMb(),
  });
});

// GET /api/admin/settings/usage-limit (backwards compat)
router.get('/settings/usage-limit', async (_req: Request, res: Response) => {
  res.json({ limit: await getUserUsageLimitUsd() });
});

// GET /api/admin/settings/users-usage — all users' usage costs
router.get('/settings/users-usage', async (_req: Request, res: Response) => {
  const limit = await getUserUsageLimitUsd();
  const users = await dbAll<{ id: string; email: string; display_name: string | null; status: string }>(
    "SELECT id, email, display_name, status FROM users WHERE role != 'admin'"
  );

  const result = [];
  for (const u of users) {
    const cost = await getUserDisplayCost(u.id);
    result.push({
      ...u,
      cost,
      limit,
      exceeded: cost >= limit,
    });
  }

  // Sort by cost descending
  result.sort((a, b) => b.cost - a.cost);
  res.json(result);
});

// ==================== Conversations ====================

// GET /api/admin/conversations?page=1&limit=20&search=&userId=
router.get('/conversations', async (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = (page - 1) * limit;
  const search = req.query.search as string || '';
  const userId = req.query.userId as string || '';

  let whereClause = 'WHERE 1=1';
  const params: any[] = [];

  if (search) {
    whereClause += ' AND (c.title LIKE ? OR u.email LIKE ? OR u.display_name LIKE ?)';
    const pattern = `%${search}%`;
    params.push(pattern, pattern, pattern);
  }
  if (userId) {
    whereClause += ' AND c.user_id = ?';
    params.push(userId);
  }

  const countRow = await dbGet<{ total: number }>(
    `SELECT COUNT(*) as total FROM conversations c LEFT JOIN users u ON u.id = c.user_id ${whereClause}`,
    ...params
  );

  const rows = await dbAll(`
    SELECT
      c.id, c.user_id, c.title, c.skill_id, c.mode, c.status, c.created_at,
      u.email as user_email, u.display_name as user_display_name,
      COALESCE(t.total_input, 0) as total_input_tokens,
      COALESCE(t.total_output, 0) as total_output_tokens,
      COALESCE(f.file_count, 0) as file_count,
      COALESCE(msg.message_count, 0) as message_count,
      COALESCE(msg.last_message_at, c.created_at) as last_activity
    FROM conversations c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN (
      SELECT conversation_id, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output
      FROM token_usage GROUP BY conversation_id
    ) t ON t.conversation_id = c.id
    LEFT JOIN (
      SELECT conversation_id, COUNT(*) as file_count
      FROM generated_files GROUP BY conversation_id
    ) f ON f.conversation_id = c.id
    LEFT JOIN (
      SELECT conversation_id, COUNT(*) as message_count, MAX(created_at) as last_message_at
      FROM messages GROUP BY conversation_id
    ) msg ON msg.conversation_id = c.id
    ${whereClause}
    ORDER BY COALESCE(msg.last_message_at, c.created_at) DESC
    LIMIT ? OFFSET ?
  `, ...params, limit, offset);

  res.json({
    conversations: rows,
    total: countRow?.total ?? 0,
    page,
    limit,
    totalPages: Math.ceil((countRow?.total ?? 0) / limit),
  });
});

// GET /api/admin/conversations/:id — conversation detail with messages + files + uploads
router.get('/conversations/:id', async (req: Request, res: Response) => {
  const convId = req.params.id;

  const conv = await dbGet<any>(`
    SELECT c.*, u.email as user_email, u.display_name as user_display_name
    FROM conversations c
    LEFT JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `, convId);

  if (!conv) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  const messages = await dbAll(`
    SELECT id, role, content, metadata, created_at
    FROM messages WHERE conversation_id = ?
    ORDER BY created_at ASC
  `, convId);

  const files = await dbAll(`
    SELECT id, filename, file_type, file_size, version, created_at
    FROM generated_files WHERE conversation_id = ?
    ORDER BY created_at DESC
  `, convId);

  const uploads = await dbAll(`
    SELECT id, filename, original_name, file_type, mime_type, file_size, created_at
    FROM user_uploads WHERE conversation_id = ?
    ORDER BY created_at DESC
  `, convId);

  const tokenUsage = await dbGet<{ total_input: number; total_output: number; call_count: number }>(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as call_count
    FROM token_usage WHERE conversation_id = ?
  `, convId);

  const tasks = await dbAll(`
    SELECT id, skill_id, description, status, result_summary, input_tokens, output_tokens, started_at, completed_at
    FROM task_executions WHERE conversation_id = ?
    ORDER BY created_at DESC
  `, convId);

  res.json({
    ...conv,
    messages,
    files,
    uploads,
    tokenUsage,
    tasks,
  });
});

// GET /api/admin/files/:id/download — admin can download any user's file
router.get('/files/:id/download', async (req: Request, res: Response) => {
  const fileId = req.params.id;

  const file = await dbGet<{ file_path: string }>(
    'SELECT file_path FROM generated_files WHERE id = ?',
    fileId
  );

  if (!file) { res.status(404).json({ error: 'File not found' }); return; }

  const fullPath = path.join(config.workspaceRoot, file.file_path);
  if (!fs.existsSync(fullPath)) { res.status(404).json({ error: 'File not found on disk' }); return; }

  const filename = path.basename(fullPath);

  try {
    const watermarked = await applyWatermark(fullPath);
    if (watermarked) {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
      res.setHeader('Content-Length', watermarked.length);
      res.end(watermarked); return;
    }
  } catch (err) { console.warn('[Admin Download] Watermark failed, serving original:', err); }

  res.download(fullPath, filename);
});

// ==================== Announcements ====================

// GET /api/admin/announcements
router.get('/announcements', async (_req: Request, res: Response) => {
  const rows = await dbAll<{
    id: string; title: string; content: string; created_by: string;
    start_date: string; end_date: string; is_active: number;
    created_at: string; updated_at: string; author_name: string | null;
  }>(
    `SELECT a.*, u.display_name AS author_name
     FROM announcements a
     LEFT JOIN users u ON u.id = a.created_by
     ORDER BY a.created_at DESC`
  );
  res.json(rows);
});

// POST /api/admin/announcements
router.post('/announcements', async (req: Request, res: Response) => {
  const { title, content, start_date, end_date } = req.body;
  if (!title?.trim() || !content?.trim()) {
    res.status(400).json({ error: 'Title and content are required' });
    return;
  }
  if (!start_date || !end_date) {
    res.status(400).json({ error: 'start_date and end_date are required' });
    return;
  }
  const id = uuidv4();
  await dbRun(
    'INSERT INTO announcements (id, title, content, created_by, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)',
    id, title.trim(), content.trim(), req.user!.userId, start_date, end_date
  );
  res.status(201).json({ id, title: title.trim(), content: content.trim(), start_date, end_date });
});

// PATCH /api/admin/announcements/:id
router.patch('/announcements/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { title, content, start_date, end_date, is_active } = req.body;
  const sets: string[] = [];
  const vals: any[] = [];
  if (title !== undefined) { sets.push('title = ?'); vals.push(title.trim()); }
  if (content !== undefined) { sets.push('content = ?'); vals.push(content.trim()); }
  if (start_date !== undefined) { sets.push('start_date = ?'); vals.push(start_date); }
  if (end_date !== undefined) { sets.push('end_date = ?'); vals.push(end_date); }
  if (is_active !== undefined) { sets.push('is_active = ?'); vals.push(is_active ? 1 : 0); }
  if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  vals.push(id);
  await dbRun(`UPDATE announcements SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  res.json({ ok: true });
});

// DELETE /api/admin/announcements/:id
router.delete('/announcements/:id', async (req: Request, res: Response) => {
  await dbRun('DELETE FROM announcements WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// ==================== Quota Groups ====================

// GET /api/admin/quota-groups
router.get('/quota-groups', async (_req: Request, res: Response) => {
  const groups = await dbAll(`
    SELECT qg.*, COUNT(u.id) as member_count
    FROM quota_groups qg
    LEFT JOIN users u ON u.quota_group_id = qg.id
    GROUP BY qg.id
    ORDER BY qg.limit_usd ASC
  `);
  res.json(groups);
});

// GET /api/admin/quota-groups/:id/members
router.get('/quota-groups/:id/members', async (req: Request, res: Response) => {
  const members = await dbAll(`
    SELECT u.id, u.email, u.display_name, u.status, u.quota_override,
      COALESCE(SUM(t.input_tokens), 0) as total_input,
      COALESCE(SUM(t.output_tokens), 0) as total_output
    FROM users u
    LEFT JOIN token_usage t ON t.user_id = u.id
    WHERE u.quota_group_id = ?
    GROUP BY u.id
    ORDER BY u.display_name ASC, u.email ASC
  `, req.params.id);
  res.json(members);
});

// POST /api/admin/quota-groups
router.post('/quota-groups', async (req: Request, res: Response) => {
  const { name, limit_usd, description } = req.body;
  if (!name || limit_usd == null || limit_usd < 0) {
    res.status(400).json({ error: 'name and limit_usd are required' }); return;
  }
  const id = uuidv4();
  await dbRun(
    'INSERT INTO quota_groups (id, name, limit_usd, description) VALUES (?, ?, ?, ?)',
    id, name.trim(), limit_usd, description?.trim() || null
  );
  const group = await dbGet('SELECT * FROM quota_groups WHERE id = ?', id);
  res.json(group);
});

// PATCH /api/admin/quota-groups/:id
router.patch('/quota-groups/:id', async (req: Request, res: Response) => {
  const { name, limit_usd, description } = req.body;
  const sets: string[] = [];
  const params: any[] = [];
  if (name != null) { sets.push('name = ?'); params.push(name.trim()); }
  if (limit_usd != null) {
    if (limit_usd < 0) { res.status(400).json({ error: 'limit_usd cannot be negative' }); return; }
    sets.push('limit_usd = ?'); params.push(limit_usd);
  }
  if (description !== undefined) { sets.push('description = ?'); params.push(description?.trim() || null); }
  if (sets.length === 0) { res.status(400).json({ error: 'No fields to update' }); return; }
  params.push(req.params.id);
  await dbRun(`UPDATE quota_groups SET ${sets.join(', ')} WHERE id = ?`, ...params);
  const group = await dbGet('SELECT * FROM quota_groups WHERE id = ?', req.params.id);
  res.json(group);
});

// DELETE /api/admin/quota-groups/:id
router.delete('/quota-groups/:id', async (req: Request, res: Response) => {
  // Unassign all members first
  await dbRun('UPDATE users SET quota_group_id = NULL WHERE quota_group_id = ?', req.params.id);
  await dbRun('DELETE FROM quota_groups WHERE id = ?', req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/quota-groups/:id/assign
router.post('/quota-groups/:id/assign', async (req: Request, res: Response) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    res.status(400).json({ error: 'userIds array is required' }); return;
  }
  const placeholders = userIds.map(() => '?').join(',');
  await dbRun(
    `UPDATE users SET quota_group_id = ? WHERE id IN (${placeholders})`,
    req.params.id, ...userIds
  );
  res.json({ ok: true, count: userIds.length });
});

// POST /api/admin/quota-groups/unassign
router.post('/quota-groups/unassign', async (req: Request, res: Response) => {
  const { userIds } = req.body;
  if (!Array.isArray(userIds) || userIds.length === 0) {
    res.status(400).json({ error: 'userIds array is required' }); return;
  }
  const placeholders = userIds.map(() => '?').join(',');
  await dbRun(
    `UPDATE users SET quota_group_id = NULL WHERE id IN (${placeholders})`,
    ...userIds
  );
  res.json({ ok: true, count: userIds.length });
});

// ==================== Invite Codes ====================

// GET /api/admin/invite-codes
router.get('/invite-codes', async (_req: Request, res: Response) => {
  const codes = await dbAll(`
    SELECT id, code, label, is_active, used_count, created_at
    FROM invite_codes
    ORDER BY created_at DESC
  `);
  res.json(codes);
});

// POST /api/admin/invite-codes
router.post('/invite-codes', async (req: Request, res: Response) => {
  const { code, label } = req.body;
  if (!code || !code.trim()) { res.status(400).json({ error: 'code is required' }); return; }
  if (!label || !label.trim()) { res.status(400).json({ error: 'label is required' }); return; }
  if (code.trim().length > 50) { res.status(400).json({ error: 'code max 50 chars' }); return; }
  if (label.trim().length > 100) { res.status(400).json({ error: 'label max 100 chars' }); return; }

  const existing = await dbGet('SELECT id FROM invite_codes WHERE code = ?', code.trim());
  if (existing) { res.status(409).json({ error: '此邀請碼已存在' }); return; }

  const id = uuidv4();
  await dbRun(
    'INSERT INTO invite_codes (id, code, label) VALUES (?, ?, ?)',
    id, code.trim(), label.trim()
  );
  res.status(201).json({ id, code: code.trim(), label: label.trim(), is_active: 1, used_count: 0 });
});

// PATCH /api/admin/invite-codes/:id
router.patch('/invite-codes/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const record = await dbGet('SELECT id FROM invite_codes WHERE id = ?', id);
  if (!record) { res.status(404).json({ error: 'Invite code not found' }); return; }

  const { label, is_active } = req.body;
  if (label !== undefined) {
    if (!label.trim()) { res.status(400).json({ error: 'label cannot be empty' }); return; }
    await dbRun('UPDATE invite_codes SET label = ? WHERE id = ?', label.trim(), id);
  }
  if (is_active !== undefined) {
    await dbRun('UPDATE invite_codes SET is_active = ? WHERE id = ?', is_active ? 1 : 0, id);
  }
  const updated = await dbGet('SELECT * FROM invite_codes WHERE id = ?', id);
  res.json(updated);
});

// DELETE /api/admin/invite-codes/:id
router.delete('/invite-codes/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const record = await dbGet('SELECT id FROM invite_codes WHERE id = ?', id);
  if (!record) { res.status(404).json({ error: 'Invite code not found' }); return; }

  // Nullify references on users
  await dbRun('UPDATE users SET invite_code_id = NULL WHERE invite_code_id = ?', id);
  await dbRun('DELETE FROM invite_codes WHERE id = ?', id);
  res.json({ ok: true });
});

// ==================== Analytics ====================

// GET /api/admin/analytics/overview?period=7d|30d
router.get('/analytics/overview', async (req: Request, res: Response) => {
  const period = (req.query.period as string) || '30d';
  const days = period === '7d' ? 7 : 30;

  // Conversation trend by day
  const convTrend = await dbAll<{ date: string; count: number }>(`
    SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as date, COUNT(*) as count
    FROM conversations
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
    ORDER BY date ASC
  `);

  // File generation trend by day
  const fileTrend = await dbAll<{ date: string; count: number }>(`
    SELECT DATE_FORMAT(created_at, '%Y-%m-%d') as date, COUNT(*) as count
    FROM generated_files
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
    ORDER BY date ASC
  `);

  // Fill missing dates
  const convMap = new Map(convTrend.map(r => [r.date, r.count]));
  const fileMap = new Map(fileTrend.map(r => [r.date, r.count]));
  const trend = [];
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    trend.push({ date: dateStr, conversations: convMap.get(dateStr) ?? 0, files: fileMap.get(dateStr) ?? 0 });
  }

  // Conversation breakdown by category
  const byCategory = await dbAll<{ category: string | null; count: number }>(`
    SELECT category, COUNT(*) as count
    FROM conversations
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY category
    ORDER BY count DESC
  `);

  // Conversation breakdown by mode
  const byMode = await dbAll<{ mode: string | null; count: number }>(`
    SELECT mode, COUNT(*) as count
    FROM conversations
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY mode
    ORDER BY count DESC
  `);

  // File breakdown by type
  const byFileType = await dbAll<{ file_type: string | null; count: number }>(`
    SELECT file_type, COUNT(*) as count
    FROM generated_files
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY file_type
    ORDER BY count DESC
  `);

  // Skill usage from task_executions
  const bySkill = await dbAll<{ skill_id: string | null; count: number }>(`
    SELECT skill_id, COUNT(*) as count
    FROM task_executions
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY skill_id
    ORDER BY count DESC
    LIMIT 15
  `);

  // Summary counts
  const totalConvRow = await dbGet<{ count: number }>(`
    SELECT COUNT(*) as count FROM conversations
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
  `);
  const totalFileRow = await dbGet<{ count: number }>(`
    SELECT COUNT(*) as count FROM generated_files
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
  `);
  const newUsersRow = await dbGet<{ count: number }>(`
    SELECT COUNT(*) as count FROM users
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
  `);
  const activeUsersRow = await dbGet<{ count: number }>(`
    SELECT COUNT(DISTINCT user_id) as count FROM conversations
    WHERE created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
  `);

  res.json({
    period,
    summary: {
      totalConversations: totalConvRow?.count ?? 0,
      totalFiles: totalFileRow?.count ?? 0,
      newUsers: newUsersRow?.count ?? 0,
      activeUsers: activeUsersRow?.count ?? 0,
    },
    trend,
    byCategory,
    byMode,
    byFileType,
    bySkill,
  });
});

// GET /api/admin/analytics/hot-topics?period=7d|30d&limit=15
router.get('/analytics/hot-topics', async (req: Request, res: Response) => {
  const period = (req.query.period as string) || '7d';
  const days = period === '7d' ? 7 : 30;
  const limit = Math.min(parseInt(req.query.limit as string) || 15, 50);

  const rows = await dbAll<{
    id: string; title: string | null;
    user_email: string; user_name: string | null;
    category: string | null;
    total_tokens: number; message_count: number;
  }>(`
    SELECT
      c.id, c.title, c.category,
      u.email as user_email, u.display_name as user_name,
      COALESCE(SUM(tu.input_tokens + tu.output_tokens), 0) as total_tokens,
      COUNT(DISTINCT m.id) as message_count
    FROM conversations c
    JOIN users u ON c.user_id = u.id
    LEFT JOIN token_usage tu ON tu.conversation_id = c.id
    LEFT JOIN messages m ON m.conversation_id = c.id
    WHERE c.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY c.id, c.title, c.category, u.email, u.display_name
    ORDER BY total_tokens DESC, message_count DESC
    LIMIT ${limit}
  `);

  res.json(rows);
});

// GET /api/admin/analytics/top-users?period=7d|30d&limit=10
router.get('/analytics/top-users', async (req: Request, res: Response) => {
  const period = (req.query.period as string) || '30d';
  const days = period === '7d' ? 7 : 30;
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);

  const rows = await dbAll<{
    id: string; email: string; display_name: string | null;
    conversations: number; files: number;
    total_input: number; total_output: number;
  }>(`
    SELECT
      u.id, u.email, u.display_name,
      COUNT(DISTINCT c.id) as conversations,
      COUNT(DISTINCT f.id) as files,
      COALESCE(SUM(tu.input_tokens), 0) as total_input,
      COALESCE(SUM(tu.output_tokens), 0) as total_output
    FROM users u
    LEFT JOIN conversations c ON c.user_id = u.id AND c.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    LEFT JOIN generated_files f ON f.user_id = u.id AND f.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    LEFT JOIN token_usage tu ON tu.user_id = u.id AND tu.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
    GROUP BY u.id, u.email, u.display_name
    ORDER BY conversations DESC, total_input DESC
    LIMIT ${limit}
  `);

  res.json(rows);
});

// POST /api/admin/analytics/topic-analysis  { period: '7d'|'30d' }
router.post('/analytics/topic-analysis', async (req: Request, res: Response) => {
  const period = (req.body?.period as string) || '7d';
  const days = period === '7d' ? 7 : 30;

  if (!config.deepseekApiKey) {
    res.status(503).json({ error: 'DeepSeek API key not configured' });
    return;
  }

  // Fetch top 40 conversation titles for analysis
  const rows = await dbAll<{ title: string | null; category: string | null; total_tokens: number }>(`
    SELECT c.title, c.category,
      COALESCE(SUM(tu.input_tokens + tu.output_tokens), 0) as total_tokens
    FROM conversations c
    LEFT JOIN token_usage tu ON tu.conversation_id = c.id
    WHERE c.created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)
      AND c.title IS NOT NULL AND c.title != ''
    GROUP BY c.id, c.title, c.category
    ORDER BY total_tokens DESC
    LIMIT 40
  `);

  if (rows.length === 0) {
    res.json({ analysis: null, categories: [] });
    return;
  }

  const titleList = rows.map((r, i) => `${i + 1}. ${r.title}`).join('\n');

  const prompt = `以下是一個 AI 文件生成平台近 ${days} 天內，使用者發起的對話標題列表（共 ${rows.length} 筆）。

${titleList}

請分析這些對話的主題類型，並以 JSON 格式回傳分析結果，格式如下：
{
  "summary": "一句話摘要使用者最常做什麼任務",
  "categories": [
    { "name": "類型名稱（繁體中文，3-8字）", "count": 數量, "pct": 百分比整數, "examples": ["範例標題1", "範例標題2"] }
  ]
}

要求：
- categories 最多 6 個，按數量降序排列
- 類型名稱使用繁體中文，清楚描述任務類型（如「財務報表分析」「簡報製作」「資料整理與計算」「競爭分析報告」等）
- 只回傳 JSON，不加任何說明文字`;

  const dsRes = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.deepseekApiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  });

  if (!dsRes.ok) {
    const err = await dsRes.text();
    console.error('DeepSeek error:', err);
    res.status(502).json({ error: 'DeepSeek API error' });
    return;
  }

  const dsData = await dsRes.json() as { choices: Array<{ message: { content: string } }> };
  const content = dsData.choices?.[0]?.message?.content ?? '{}';

  try {
    const parsed = JSON.parse(content);
    res.json(parsed);
  } catch {
    res.status(502).json({ error: 'Failed to parse DeepSeek response' });
  }
});

export default router;
