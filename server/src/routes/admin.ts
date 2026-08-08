import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { dbGet, dbAll, dbRun } from '../db.js';
import { opsGet } from '../opsDb.js';
import { adminMiddleware } from '../middleware/adminAuth.js';
import { loadSkills } from '../skills/loader.js';
import { config, pricingMarkupSql } from '../config.js';
import { applyWatermark, getWatermarkSettings, setWatermarkSettings } from '../services/watermark.js';
import { getMailToken, fetchMessageDetail, resolveCidImages } from '../services/outlookApi.js';
import { mailGatewayStats, gatewayFetch } from '../services/mailGatewayLimit.js';
import { getSystemPressure } from '../services/systemPressure.js';
import { sendXlsx } from '../services/xlsxExport.js';
import { buildSecurityReportDocx } from '../services/securityReport.js';
import { getUserUsageLimitUsd, setUserUsageLimitUsd, getUserDisplayCost, getEffectiveUserLimit, getStorageQuotaGb, setStorageQuotaGb, getUploadQuotaMb, setUploadQuotaMb } from '../services/usageLimit.js';
import { getRolePermissions, setRolePermissions, type RolePermissions } from '../services/rolePermissions.js';
import { getLineSettings, setLineSetting, type LineSettings } from '../services/lineSettings.js';
import { getMessageQuotaStatus } from '../services/line/client.js';
import { setLineUserDisabled } from '../services/line/userMapping.js';
import { getQuotaNotifyRecipients, setQuotaNotifyRecipients, buildQuotaRequestEmail, type QuotaNotifyRecipient } from '../services/quotaNotify.js';
import { sendGatewayMail, resolveAdEmail, isGatewayMailConfigured } from '../services/gatewayMail.js';

const router = Router();
router.use(adminMiddleware);

// ==================== Sidebar badge counts ====================
// Lightweight pending-work counts for the admin sidebar red-dots.
// reports: untouched tickets (status 'open'); quotaRequests: pending quota requests.
router.get('/badge-counts', async (_req: Request, res: Response) => {
  let reports = 0;
  let quotaRequests = 0;
  try {
    if (config.reportSystemEnabled) {
      const r = await opsGet<{ n: number }>("SELECT COUNT(*) AS n FROM ops_tickets WHERE deleted_at IS NULL AND status = 'open'");
      reports = r?.n ?? 0;
    }
  } catch { /* ops db optional — never block the sidebar */ }
  try {
    const q = await dbGet<{ n: number }>("SELECT COUNT(*) AS n FROM quota_requests WHERE status = 'pending'");
    quotaRequests = q?.n ?? 0;
  } catch { /* ignore */ }
  res.json({ reports, quotaRequests });
});

// ==================== System pressure ====================

// GET /api/admin/system/pressure — live load for the sidebar indicator. ADMIN ONLY
// (檢閱者/readonly must not see infra/load internals). Synchronous and DB-free on
// purpose: the client polls this on an interval, so it must never add load of its own.
router.get('/system/pressure', (req: Request, res: Response) => {
  if ((req.user as { role?: string } | undefined)?.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' });
    return;
  }
  res.json(getSystemPressure());
});

// ==================== Overview ====================

// GET /api/admin/overview/stats
router.get('/overview/stats', async (req: Request, res: Response) => {
  const { from, to } = req.query as { from?: string; to?: string };
  const conds: string[] = [];
  const tokenParams: string[] = [];
  if (from) { conds.push('DATE(created_at) >= ?'); tokenParams.push(from); }
  if (to)   { conds.push('DATE(created_at) <= ?'); tokenParams.push(to); }
  const tokenWhere = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const totalUsersRow = await dbGet<{ count: number }>(
    'SELECT COUNT(*) as count FROM users'
  );

  const activeSkills = loadSkills().length;

  const tokenRow = await dbGet<{ total: number }>(
    `SELECT COALESCE(SUM(input_tokens + output_tokens), 0) as total FROM token_usage ${tokenWhere}`,
    ...tokenParams
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

// GET /api/admin/overview/token-velocity?period=7d|30d|monthly&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/overview/token-velocity', async (req: Request, res: Response) => {
  const { from, to, period: periodParam } = req.query as { from?: string; to?: string; period?: string };
  const period = periodParam || '7d';

  // Custom date range mode
  if (from || to) {
    const conds: string[] = [];
    const params: string[] = [];
    if (from) { conds.push('DATE(created_at) >= ?'); params.push(from); }
    if (to)   { conds.push('DATE(created_at) <= ?'); params.push(to); }
    const where = `WHERE ${conds.join(' AND ')}`;
    const rows = await dbAll<{ date: string; total_input: number; total_output: number; invocation_count: number }>(`
      SELECT
        DATE_FORMAT(created_at, '%Y-%m-%d') as date,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        COUNT(*) as invocation_count
      FROM token_usage ${where}
      GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
      ORDER BY date ASC
    `, ...params);
    const dataMap = new Map(rows.map(r => [r.date, r]));
    const start = new Date(from || new Date().toISOString().slice(0, 10));
    const end = new Date(to || new Date().toISOString().slice(0, 10));
    const result = [];
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      result.push(dataMap.get(key) || { date: key, total_input: 0, total_output: 0, invocation_count: 0 });
    }
    return res.json(result);
  }

  if (period === 'monthly') {
    const rows = await dbAll<{ date: string; total_input: number; total_output: number; invocation_count: number }>(`
      SELECT
        DATE_FORMAT(created_at, '%Y-%m') as date,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        COUNT(*) as invocation_count
      FROM token_usage
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY date ASC
    `);

    const dataMap = new Map(rows.map(r => [r.date, r]));
    const result = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const existing = dataMap.get(monthStr);
      result.push(existing || { date: monthStr, total_input: 0, total_output: 0, invocation_count: 0 });
    }
    return res.json(result);
  }

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
  const role = req.query.role as string || '';
  const sortBy = req.query.sortBy as string || '';
  const sortDir = (req.query.sortDir as string || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const format = req.query.format as string || '';

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
  if (role && ['admin', 'readonly', 'user'].includes(role)) {
    whereClause += ' AND u.role = ?';
    params.push(role);
  }

  const orderBy =
    sortBy === 'tokens' ? `total_tokens ${sortDir}` :
    sortBy === 'conversations' ? `conversation_count ${sortDir}` :
    sortBy === 'files' ? `file_count ${sortDir}` :
    'u.created_at DESC';

  const baseSelect = `
    SELECT
      u.id, u.email, u.display_name, u.status, u.role, u.created_at, u.last_login_at,
      u.company, u.quota_group_id, qg.name as quota_group_name,
      u.invite_code_id, ic.code as invite_code, ic.label as invite_code_label,
      COALESCE(t.total_tokens, 0) as total_tokens,
      COALESCE(t.total_input, 0) as total_input_tokens,
      COALESCE(t.total_output, 0) as total_output_tokens,
      COALESCE(t.cost, 0) as cost,
      COALESCE(f.file_count, 0) as file_count,
      COALESCE(c.conv_count, 0) as conversation_count
    FROM users u
    LEFT JOIN quota_groups qg ON qg.id = u.quota_group_id
    LEFT JOIN invite_codes ic ON ic.id = u.invite_code_id
    LEFT JOIN (
      SELECT user_id, SUM(input_tokens + output_tokens) as total_tokens,
        SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
        SUM((input_tokens / 1000000 * 3 + output_tokens / 1000000 * 15) * ${pricingMarkupSql('created_at')}) as cost
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
    ORDER BY ${orderBy}`;

  // Excel export — ALL filtered rows (no pagination cap), styled workbook.
  if (format === 'xlsx') {
    const rows = await dbAll<any>(baseSelect, ...params);
    const roleLabel: Record<string, string> = { admin: '管理者', readonly: '檢閱者', user: '一般用戶' };
    const headers = ['Email', '名稱', '角色', '狀態', '公司', '額度群組', '總 Tokens', '輸入 Tokens', '輸出 Tokens', '成本(USD)', '對話數', '檔案數', '建立時間', '最後登入'];
    const sheetRows = rows.map(u => [
      u.email, u.display_name || '', roleLabel[u.role] || u.role, u.status, u.company || '', u.quota_group_name || '',
      u.total_tokens, u.total_input_tokens, u.total_output_tokens,
      Math.round((u.cost ?? 0) * 100) / 100,
      u.conversation_count, u.file_count, u.created_at, u.last_login_at || '',
    ]);
    await sendXlsx(res, `users_${new Date().toISOString().slice(0, 10)}.xlsx`, [{ name: '用戶資料', headers, rows: sheetRows }]);
    return;
  }

  const countRow = await dbGet<{ total: number }>(
    `SELECT COUNT(*) as total FROM users u ${whereClause}`,
    ...params
  );
  const rows = await dbAll(`${baseSelect} LIMIT ? OFFSET ?`, ...params, limit, offset);

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
      u.company, qg.name as quota_group_name,
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

  const tokenStats = await dbGet<{ total_input: number; total_output: number; invocation_count: number; total_cost: number }>(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as invocation_count,
      COALESCE(SUM((input_tokens / 1000000 * 3 + output_tokens / 1000000 * 15) * ${pricingMarkupSql('created_at')}), 0) as total_cost
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
    total_cost: tokenStats?.total_cost ?? 0,
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

  if (!['user', 'admin', 'readonly'].includes(role)) {
    res.status(400).json({ error: 'Invalid role. Must be "user", "admin", or "readonly"' });
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

// GET /api/admin/tokens/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/tokens/summary', async (req: Request, res: Response) => {
  const { from, to } = req.query as { from?: string; to?: string };
  const conds: string[] = [];
  const params: string[] = [];
  if (from) { conds.push('DATE(created_at) >= ?'); params.push(from); }
  if (to)   { conds.push('DATE(created_at) <= ?'); params.push(to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  // Claude Sonnet 4 pricing: $3/M input, $15/M output. Cost is computed PER RECORD
  // with the markup in effect at each row's timestamp (強茂 ×10 before 2026-07-07
  // 16:00, ×5 after), so a range spanning the switch prices every record correctly.
  const row = await dbGet<{ total_input: number; total_output: number; total_invocations: number; est_cost: number }>(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as total_invocations,
      COALESCE(SUM((input_tokens / 1000000 * 3 + output_tokens / 1000000 * 15) * ${pricingMarkupSql('created_at')}), 0) as est_cost
    FROM token_usage
    ${where}
  `, ...params);

  const totalInput = row?.total_input ?? 0;
  const totalOutput = row?.total_output ?? 0;
  const estimatedCost = row?.est_cost ?? 0;

  res.json({
    totalInput,
    totalOutput,
    totalInvocations: row?.total_invocations ?? 0,
    estimatedCost: Math.round(estimatedCost * 10000) / 10000,
  });
});

// GET /api/admin/tokens/chart?period=7d|30d|monthly&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/tokens/chart', async (req: Request, res: Response) => {
  const period = (req.query.period as string) || '7d';
  const { from, to } = req.query as { from?: string; to?: string };

  // Custom date range — return daily data between from and to
  if (from || to) {
    const conds: string[] = [];
    const params: string[] = [];
    if (from) { conds.push('DATE(created_at) >= ?'); params.push(from); }
    if (to)   { conds.push('DATE(created_at) <= ?'); params.push(to); }
    const rows = await dbAll<{ date: string; total_input: number; total_output: number; invocation_count: number }>(`
      SELECT
        DATE_FORMAT(created_at, '%Y-%m-%d') as date,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        COUNT(*) as invocation_count
      FROM token_usage
      WHERE ${conds.join(' AND ')}
      GROUP BY DATE_FORMAT(created_at, '%Y-%m-%d')
      ORDER BY date ASC
    `, ...params);
    const dataMap = new Map(rows.map(r => [r.date, r]));
    const result = [];
    const start = new Date(from || rows[0]?.date || new Date().toISOString().slice(0, 10));
    const end   = new Date(to   || new Date().toISOString().slice(0, 10));
    for (const d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().slice(0, 10);
      result.push(dataMap.get(dateStr) || { date: dateStr, total_input: 0, total_output: 0, invocation_count: 0 });
    }
    return res.json(result);
  }

  if (period === 'monthly') {
    // Return last 12 months of data grouped by month
    const rows = await dbAll<{ date: string; total_input: number; total_output: number; invocation_count: number }>(`
      SELECT
        DATE_FORMAT(created_at, '%Y-%m') as date,
        SUM(input_tokens) as total_input,
        SUM(output_tokens) as total_output,
        COUNT(*) as invocation_count
      FROM token_usage
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY date ASC
    `);

    const dataMap = new Map(rows.map(r => [r.date, r]));
    const result = [];
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      const existing = dataMap.get(monthStr);
      result.push(existing || { date: monthStr, total_input: 0, total_output: 0, invocation_count: 0 });
    }
    return res.json(result);
  }

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

// GET /api/admin/tokens/by-user?limit=10&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/tokens/by-user', async (req: Request, res: Response) => {
  const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
  const { from, to } = req.query as { from?: string; to?: string };
  const dateConds: string[] = [];
  const params: (string | number)[] = [];
  if (from) { dateConds.push('DATE(tu.created_at) >= ?'); params.push(from); }
  if (to)   { dateConds.push('DATE(tu.created_at) <= ?'); params.push(to); }
  const dateWhere = dateConds.length ? `AND ${dateConds.join(' AND ')}` : '';

  const rows = await dbAll(`
    SELECT
      u.id, u.email, u.display_name,
      SUM(tu.input_tokens) as total_input,
      SUM(tu.output_tokens) as total_output,
      SUM((tu.input_tokens / 1000000 * 3 + tu.output_tokens / 1000000 * 15) * ${pricingMarkupSql('tu.created_at')}) as cost,
      COUNT(*) as invocation_count
    FROM token_usage tu
    JOIN users u ON u.id = tu.user_id
    WHERE u.role != 'admin' ${dateWhere}
    GROUP BY tu.user_id
    ORDER BY (SUM(tu.input_tokens) + SUM(tu.output_tokens)) DESC
    LIMIT ?
  `, ...params, limit);

  res.json(rows);
});

// GET /api/admin/tokens/ledger?page=1&limit=20&from=YYYY-MM-DD&to=YYYY-MM-DD
router.get('/tokens/ledger', async (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = (page - 1) * limit;
  const { from, to } = req.query as { from?: string; to?: string };
  const conds: string[] = [];
  const filterParams: string[] = [];
  if (from) { conds.push('DATE(tu.created_at) >= ?'); filterParams.push(from); }
  if (to)   { conds.push('DATE(tu.created_at) <= ?'); filterParams.push(to); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const countRow = await dbGet<{ total: number }>(
    `SELECT COUNT(*) as total FROM token_usage tu ${where}`,
    ...filterParams
  );

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
    ${where}
    ORDER BY tu.created_at DESC
    LIMIT ? OFFSET ?
  `, ...filterParams, limit, offset);

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
    mailGateway: mailGatewayStats(), // 信件 gateway 限流閘門即時狀態 + 累計計數
  });
});

// POST /api/admin/security/mail-gateway/selftest { n } — fire N CONCURRENT gateway
// requests (using this admin's own mail token) to reproduce the class-burst load
// WITHOUT needing 30 AD accounts: the 429 limit is on the SERVER's outbound IP, so
// one token × N concurrent hits the same limit as N users opening at once.
router.post('/security/mail-gateway/selftest', async (req: Request, res: Response) => {
  const n = Math.min(Math.max(parseInt(req.body?.n, 10) || 30, 1), 100);
  const rounds = Math.min(Math.max(parseInt(req.body?.rounds, 10) || 1, 1), 20); // sustained: repeat the burst
  const token = await getMailToken((req as any).user!.userId);
  if (!token) { res.status(400).json({ error: '需要你自己的信箱 token（請用 AD 帳號登入且已授權信箱）。' }); return; }
  // Hit the REAL list endpoint the poller uses (heavier than /folders → closer to the
  // production load that trips the gateway).
  const url = `${config.adApiUrl}/outlook/messages?folder=Inbox&limit=10&order=desc`;
  const headers = { 'X-API-Key': config.adApiKey, 'Authorization': `Bearer ${token}` };
  // Streamed keepalive so long tests (many rounds) don't get reset by the dev proxy.
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
  const keepalive = setInterval(() => { try { res.write(': ka\n\n'); } catch { /* closed */ } }, 5000);
  const before = mailGatewayStats();
  const t0 = Date.now();
  const total = n * rounds;
  const results: { status: number; ms: number }[] = [];
  // Live progress: emit a throttled tick as each request completes, so a big test
  // (e.g. 100×20 = 2000 reqs through a 10-wide gate → minutes) shows "X/total done"
  // instead of a dead spinner that reads as "the app got slower / it's stuck".
  let completed = 0, okCount = 0, limitedCount = 0, lastEmit = 0;
  const emitProgress = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 500) return;
    lastEmit = now;
    const s = mailGatewayStats();
    try { res.write(`data: ${JSON.stringify({ type: 'progress', done: completed, total, ok: okCount, rateLimited: limitedCount, active: s.active, queued: s.queued, elapsedMs: now - t0 })}\n\n`); } catch { /* closed */ }
  };
  emitProgress(true);
  for (let round = 0; round < rounds; round++) {
    const batch = await Promise.all(Array.from({ length: n }, async () => {
      const s = Date.now();
      try {
        const r = await gatewayFetch(url, { headers }, { timeoutMs: 45000 }); // match production GATEWAY_TIMEOUT_MS
        completed++; if (r.status === 200) okCount++; else if (r.status === 429) limitedCount++;
        emitProgress();
        return { status: r.status, ms: Date.now() - s };
      } catch (e) { completed++; emitProgress(); return { status: 0, ms: Date.now() - s }; }
    }));
    results.push(...batch);
  }
  const after = mailGatewayStats();
  clearInterval(keepalive);
  try {
    res.write(`data: ${JSON.stringify({
      type: 'done',
      n, rounds, total,
      totalMs: Date.now() - t0,
      reqPerSec: +(total / Math.max(0.001, (Date.now() - t0) / 1000)).toFixed(1),
      ok: results.filter(r => r.status === 200).length,
      rateLimitedResponses: results.filter(r => r.status === 429).length,
      failed: results.filter(r => r.status === 0).length,
      peakQueued: after.peakQueued,
      gateway429Hit: after.rateLimited - before.rateLimited,
      gateway429Recovered: after.recovered - before.recovered,
      gateway429Surfaced: after.surfaced - before.surfaced,
    })}\n\n`);
    res.end();
  } catch { /* closed */ }
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

// ── AI-generated professional security report (Word) ────────────────────────
// Generation is slow (Claude writes the whole report), so we run it as an
// in-memory async job and let the client poll — avoids proxy idle-timeouts.
interface SecurityReportJob {
  status: 'running' | 'done' | 'error';
  buffer?: Buffer;
  filename?: string;
  error?: string;
  createdAt: number;
}
const securityReportJobs = new Map<string, SecurityReportJob>();

function pruneSecurityReportJobs() {
  const now = Date.now();
  for (const [id, job] of securityReportJobs) {
    if (now - job.createdAt > 30 * 60_000) securityReportJobs.delete(id);
  }
}

// POST /api/admin/security/report — kick off generation, returns { jobId }.
// POST (not GET) so read-only reviewers are blocked by adminMiddleware — only
// full admins may generate the security audit report.
router.post('/security/report', async (req: Request, res: Response) => {
  pruneSecurityReportJobs();
  const from = typeof req.body?.from === 'string' && req.body.from ? req.body.from : null;
  const to = typeof req.body?.to === 'string' && req.body.to ? req.body.to : null;
  const jobId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  securityReportJobs.set(jobId, { status: 'running', createdAt: Date.now() });

  buildSecurityReportDocx(from, to)
    .then(({ buffer, filename }) => {
      securityReportJobs.set(jobId, { status: 'done', buffer, filename, createdAt: Date.now() });
    })
    .catch((err) => {
      console.error('[SecurityReport] generation failed:', err);
      securityReportJobs.set(jobId, { status: 'error', error: err?.message || '產生失敗', createdAt: Date.now() });
    });

  res.json({ jobId });
});

// GET /api/admin/security/report/:jobId/status — poll job state
router.get('/security/report/:jobId/status', (req: Request, res: Response) => {
  const jobId = req.params.jobId as string;
  const job = securityReportJobs.get(jobId);
  if (!job) return res.status(404).json({ status: 'error', error: 'not found' });
  res.json({ status: job.status, error: job.error });
});

// GET /api/admin/security/report/:jobId/download — stream the finished .docx
router.get('/security/report/:jobId/download', (req: Request, res: Response) => {
  const jobId = req.params.jobId as string;
  const job = securityReportJobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'not found' });
  if (job.status !== 'done' || !job.buffer) return res.status(409).json({ error: 'not ready' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(job.filename || 'security_report.docx')}"`);
  res.end(job.buffer);
  securityReportJobs.delete(jobId);
});

// ==================== Settings ====================

// GET /api/admin/settings — All system settings
router.get('/settings', async (_req: Request, res: Response) => {
  res.json({
    usageLimitUsd: await getUserUsageLimitUsd(),
    storageQuotaGb: await getStorageQuotaGb(),
    uploadQuotaMb: await getUploadQuotaMb(),
    watermark: await getWatermarkSettings(),
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
  const { watermark } = req.body as { watermark?: { enabled?: boolean; text?: string } };
  if (watermark && typeof watermark === 'object') {
    const enabled = !!watermark.enabled;
    const text = typeof watermark.text === 'string' ? watermark.text : '';
    await setWatermarkSettings({ enabled, text });
    changes.push(`watermark: enabled=${enabled}, text="${text}"`);
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
    watermark: await getWatermarkSettings(),
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

// ==================== Terms of Service ====================

// GET /api/admin/terms — raw TOS template for editing
router.get('/terms', async (_req: Request, res: Response) => {
  const tosRow = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'tos_content'");
  const versionRow = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'tos_version'");
  res.json({ content: tosRow?.value || '', version: versionRow?.value || '1' });
});

// PATCH /api/admin/terms — update TOS content, optionally bump version
router.patch('/terms', async (req: Request, res: Response) => {
  const { content, bumpVersion, resetAcceptance } = req.body as {
    content?: string; bumpVersion?: boolean; resetAcceptance?: boolean;
  };
  if (typeof content !== 'string' || !content.trim()) {
    res.status(400).json({ error: 'Content is required' });
    return;
  }

  await dbRun("REPLACE INTO system_settings (`key`, value) VALUES (?, ?)", 'tos_content', content);

  if (bumpVersion) {
    const versionRow = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'tos_version'");
    const newVersion = String(parseInt(versionRow?.value || '1', 10) + 1);
    await dbRun("REPLACE INTO system_settings (`key`, value) VALUES (?, ?)", 'tos_version', newVersion);

    if (resetAcceptance) {
      await dbRun('UPDATE users SET terms_accepted_at = NULL');
    }
  }

  // Audit log
  await dbRun(
    'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
    uuidv4(), req.user!.userId, 'update_tos', 'system', 'tos_content',
    JSON.stringify({ bumpVersion: !!bumpVersion, resetAcceptance: !!resetAcceptance })
  );

  const newVersionRow = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = 'tos_version'");
  res.json({ success: true, version: newVersionRow?.value || '1' });
});

// ==================== Conversations ====================

// GET /api/admin/conversations?page=1&limit=20&search=&userId=
router.get('/conversations', async (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = (page - 1) * limit;
  const search = req.query.search as string || '';
  const userId = req.query.userId as string || '';
  const category = req.query.category as string || '';

  // Hide team-member sub-conversations (0-message noise) AND the email-assistant
  // conversations — both are surfaced via their own dedicated endpoints
  // (/teams and /email-agent) so this list stays clean.
  let whereClause = "WHERE c.team_id IS NULL AND (c.category IS NULL OR c.category <> 'email-agent')";
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
  // Optional category filter (e.g. the KM 助手 tab → category=km-agent).
  if (category) {
    whereClause += ' AND c.category = ?';
    params.push(category);
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
      COALESCE(t.cost, 0) as cost,
      COALESCE(f.file_count, 0) as file_count,
      COALESCE(msg.message_count, 0) as message_count,
      COALESCE(msg.last_message_at, c.created_at) as last_activity
    FROM conversations c
    LEFT JOIN users u ON u.id = c.user_id
    LEFT JOIN (
      SELECT conversation_id, SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
        SUM((input_tokens / 1000000 * 3 + output_tokens / 1000000 * 15) * ${pricingMarkupSql('created_at')}) as cost
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

// GET /api/admin/email-agent — list email-assistant usage per user.
// Surfaces whether each user is doing per-email ANALYSIS (信件解析, stored in
// email_summary_cache) vs. actual Q&A CONVERSATION (對話, stored in messages).
router.get('/email-agent', async (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
  const offset = (page - 1) * limit;
  const search = (req.query.search as string || '').trim();

  let where = "WHERE c.category = 'email-agent'";
  const params: any[] = [];
  if (search) {
    where += ' AND (u.email LIKE ? OR u.display_name LIKE ?)';
    const p = `%${search}%`;
    params.push(p, p);
  }

  const countRow = await dbGet<{ total: number }>(
    `SELECT COUNT(*) as total FROM conversations c LEFT JOIN users u ON u.id = c.user_id ${where}`,
    ...params,
  );

  const rows = await dbAll(`
    SELECT
      c.id, c.user_id, c.created_at, c.status,
      u.email AS user_email, u.display_name AS user_display_name,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.role = 'user') AS question_count,
      (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count,
      (SELECT COUNT(*) FROM email_summary_cache e WHERE e.user_id = c.user_id) AS analysis_count,
      (SELECT COUNT(*) FROM email_summary_cache e WHERE e.user_id = c.user_id AND e.analysis IS NOT NULL AND e.analysis <> '') AS deep_count,
      (SELECT COUNT(*) FROM email_summary_cache e WHERE e.user_id = c.user_id AND e.attachment_analysis IS NOT NULL AND e.attachment_analysis <> '') AS attachment_count,
      GREATEST(
        COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id), c.created_at),
        COALESCE((SELECT MAX(e.created_at) FROM email_summary_cache e WHERE e.user_id = c.user_id), c.created_at)
      ) AS last_activity
    FROM conversations c
    LEFT JOIN users u ON u.id = c.user_id
    ${where}
    ORDER BY last_activity DESC, c.created_at DESC
    LIMIT ? OFFSET ?
  `, ...params, limit, offset);

  res.json({
    items: rows,
    total: countRow?.total ?? 0,
    page,
    limit,
    totalPages: Math.ceil((countRow?.total ?? 0) / limit),
  });
});

// GET /api/admin/email-agent/:id — one user's email-assistant detail:
// the Q&A chat messages AND the per-email analyses (subject/priority/summary/deep).
router.get('/email-agent/:id', async (req: Request, res: Response) => {
  const convId = req.params.id;
  const conversation = await dbGet<any>(`
    SELECT c.id, c.user_id, c.title, c.created_at, c.status,
           u.email AS user_email, u.display_name AS user_display_name
    FROM conversations c LEFT JOIN users u ON u.id = c.user_id
    WHERE c.id = ? AND c.category = 'email-agent'`, convId);
  if (!conversation) { res.status(404).json({ error: 'Not found' }); return; }

  const messages = await dbAll(
    `SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`,
    convId,
  );
  const totalRow = await dbGet<{ n: number }>(
    'SELECT COUNT(*) AS n FROM email_summary_cache WHERE user_id = ?', conversation.user_id);

  res.json({ conversation, messages, analysisTotal: totalRow?.n ?? 0 });
});

// GET /api/admin/email-agent/:id/analyses?page=&limit= — paginated per-email
// analyses for one user (subject / priority / summary / deep analysis).
router.get('/email-agent/:id/analyses', async (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);
  const offset = (page - 1) * limit;
  const conv = await dbGet<{ user_id: string }>(
    "SELECT user_id FROM conversations WHERE id = ? AND category = 'email-agent'", req.params.id);
  if (!conv) { res.status(404).json({ error: 'Not found' }); return; }

  const totalRow = await dbGet<{ n: number }>(
    'SELECT COUNT(*) AS n FROM email_summary_cache WHERE user_id = ?', conv.user_id);
  const total = totalRow?.n ?? 0;
  const analyses = await dbAll(`
    SELECT email_id, email_subject, summary, priority, category,
           analysis AS deep_analysis, attachment_analysis, created_at
    FROM email_summary_cache WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    conv.user_id, limit, offset);

  res.json({ analyses, total, page, limit, totalPages: Math.ceil(total / limit) });
});

// GET /api/admin/email-agent/:id/email?emailId=... — fetch the ORIGINAL email body
// live from the mail gateway, using the owner's stored mail token. NOTE: this
// exposes the user's raw mailbox content to the admin (sensitive; admin-only).
router.get('/email-agent/:id/email', async (req: Request, res: Response) => {
  const emailId = String(req.query.emailId || '').trim();
  if (!emailId) { res.status(400).json({ error: 'emailId required' }); return; }
  // Whole handler wrapped so a DB/gateway hiccup returns clean JSON (never the
  // default "Internal Server Error" text that breaks the client's JSON parse).
  try {
    const conv = await dbGet<{ user_id: string }>(
      "SELECT user_id FROM conversations WHERE id = ? AND category = 'email-agent'", req.params.id);
    if (!conv) { res.status(404).json({ error: 'Not found' }); return; }
    const token = await getMailToken(conv.user_id);
    if (!token) { res.status(409).json({ error: 'no_token', message: '信箱連線已過期或未授權，無法讀取原信件' }); return; }
    const msg = await fetchMessageDetail(token, emailId);
    if (!msg) { res.status(404).json({ error: 'not_found', message: '找不到原始信件（可能已被刪除或移動）' }); return; }
    // Resolve inline cid: images to data URIs so embedded logos/pictures render.
    let body = msg.body || '';
    if (body && msg.attachments?.length) {
      try { body = await resolveCidImages(token, emailId, body, msg.attachments); } catch { /* keep raw body */ }
    }
    // Recipient (msg.to) intentionally omitted — the backend is for technical
    // review (what emails / AI quality), not for exposing who mail went to.
    // Attachments: names/types only (NO content, NO download) — just an indicator.
    const attachments = (msg.attachments || [])
      .filter(a => !a.is_inline)
      .map(a => ({ filename: a.filename, contentType: a.content_type, size: a.size }));
    res.json({
      subject: msg.subject,
      from: msg.from,
      receivedAt: msg.received_at,
      body,
      bodyType: msg.body_type || 'text',
      hasAttachments: !!msg.has_attachments,
      attachments,
    });
  } catch (err) {
    console.error('[admin] email fetch failed:', err);
    res.status(502).json({ error: 'fetch_failed', message: '讀取原信件失敗（信箱 API 暫時異常，請稍後再試）' });
  }
});

// GET /api/admin/teams — list AI team collaborations with aggregates
router.get('/teams', async (req: Request, res: Response) => {
  const page = Math.max(parseInt(req.query.page as string) || 1, 1);
  const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
  const offset = (page - 1) * limit;
  const search = (req.query.search as string || '').trim();

  let where = 'WHERE 1=1';
  const params: any[] = [];
  if (search) {
    where += ' AND (t.title LIKE ? OR t.topic LIKE ? OR u.email LIKE ? OR u.display_name LIKE ?)';
    const p = `%${search}%`;
    params.push(p, p, p, p);
  }

  const countRow = await dbGet<{ total: number }>(
    `SELECT COUNT(*) as total FROM agent_teams t LEFT JOIN users u ON u.id = t.user_id ${where}`,
    ...params,
  );

  const rows = await dbAll(`
    SELECT
      t.id, t.title, t.topic, t.icon, t.created_at,
      u.email AS user_email, u.display_name AS user_display_name,
      (SELECT COUNT(*) FROM conversations c WHERE c.team_id = t.id AND c.status != 'deleted') AS member_count,
      (SELECT COUNT(*) FROM team_runs r WHERE r.team_id = t.id) AS run_count,
      (SELECT COALESCE(SUM(r.input_tokens + r.output_tokens), 0) FROM team_runs r WHERE r.team_id = t.id) AS total_tokens,
      (SELECT MAX(r.created_at) FROM team_runs r WHERE r.team_id = t.id) AS last_run_at
    FROM agent_teams t
    LEFT JOIN users u ON u.id = t.user_id
    ${where}
    ORDER BY (last_run_at IS NULL), last_run_at DESC, t.created_at DESC
    LIMIT ? OFFSET ?
  `, ...params, limit, offset);

  res.json({
    teams: rows,
    total: countRow?.total ?? 0,
    page,
    limit,
    totalPages: Math.ceil((countRow?.total ?? 0) / limit),
  });
});

// GET /api/admin/teams/:id — team detail: members + collaboration runs
router.get('/teams/:id', async (req: Request, res: Response) => {
  const teamId = req.params.id;
  const team = await dbGet<any>(`
    SELECT t.id, t.title, t.topic, t.icon, t.created_at,
           u.email AS user_email, u.display_name AS user_display_name
    FROM agent_teams t LEFT JOIN users u ON u.id = t.user_id WHERE t.id = ?`, teamId);
  if (!team) { res.status(404).json({ error: 'Team not found' }); return; }

  const members = await dbAll(
    `SELECT id, title, skill_id, icon, system_prompt FROM conversations WHERE team_id = ? AND status != 'deleted' ORDER BY created_at ASC`,
    teamId,
  );
  const runs = await dbAll(`
    SELECT id, question, status, input_tokens, output_tokens, created_at,
           LEFT(result, 400) AS result_preview, share_token
    FROM team_runs WHERE team_id = ? ORDER BY created_at DESC LIMIT 100`, teamId);

  res.json({ team, members, runs });
});

// GET /api/admin/teams/:id/runs/:runId — full run: question, each member's answer, final report
router.get('/teams/:id/runs/:runId', async (req: Request, res: Response) => {
  const run = await dbGet<any>(
    `SELECT id, question, result, member_outputs, input_tokens, output_tokens, status, created_at
     FROM team_runs WHERE id = ? AND team_id = ?`, req.params.runId, req.params.id);
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  let members: any[] = [];
  try { members = JSON.parse(run.member_outputs || '[]'); } catch { /* tolerate bad JSON */ }
  res.json({
    id: run.id,
    question: run.question,
    result: run.result || '',
    members,                                 // [{ memberId, name, icon, text (round1), text2 (discussion) }]
    input_tokens: run.input_tokens,
    output_tokens: run.output_tokens,
    status: run.status,
    created_at: run.created_at,
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

  const tokenUsage = await dbGet<{ total_input: number; total_output: number; call_count: number; cost: number }>(`
    SELECT
      COALESCE(SUM(input_tokens), 0) as total_input,
      COALESCE(SUM(output_tokens), 0) as total_output,
      COUNT(*) as call_count,
      COALESCE(SUM((input_tokens / 1000000 * 3 + output_tokens / 1000000 * 15) * ${pricingMarkupSql('created_at')}), 0) as cost
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
  // member_search: a concatenation of each group's member names + emails, so the
  // admin UI can filter groups by a person's name without loading every member.
  const groups = await dbAll(`
    SELECT qg.*, COUNT(u.id) as member_count,
           GROUP_CONCAT(CONCAT_WS(' ', u.display_name, u.email) SEPARATOR ' | ') AS member_search
    FROM quota_groups qg
    LEFT JOIN users u ON u.quota_group_id = qg.id
    GROUP BY qg.id
    ORDER BY qg.limit_usd ASC
  `);
  res.json(groups);
});

// GET /api/admin/quota-groups/:id/members
router.get('/quota-groups/:id/members', async (req: Request, res: Response) => {
  // Usage must match the per-user "額度用量" panel (getUserDisplayCost): in
  // official mode the quota resets monthly, so only the CURRENT calendar month
  // counts. Summing token_usage over all time here was the cause of the group
  // view showing a higher number ($43.45 lifetime) than the user detail
  // ($24.11 this month). Apply the same monthly window so both agree.
  const params: unknown[] = [];
  let monthFilter = '';
  if (!config.isBeta) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    monthFilter = ' AND t.created_at >= ?';
    params.push(monthStart);
  }
  params.push(req.params.id);
  const members = await dbAll(`
    SELECT u.id, u.email, u.display_name, u.status, u.quota_override,
      COALESCE(SUM(t.input_tokens), 0) as total_input,
      COALESCE(SUM(t.output_tokens), 0) as total_output,
      COALESCE(SUM((t.input_tokens / 1000000 * 3 + t.output_tokens / 1000000 * 15) * ${pricingMarkupSql('t.created_at')}), 0) as cost
    FROM users u
    LEFT JOIN token_usage t ON t.user_id = u.id${monthFilter}
    WHERE u.quota_group_id = ?
    GROUP BY u.id
    ORDER BY u.display_name ASC, u.email ASC
  `, ...params);
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

// GET /api/admin/analytics/monthly?month=YYYY-MM
router.get('/analytics/monthly', async (req: Request, res: Response) => {
  const month = (req.query.month as string) || '';
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    res.status(400).json({ error: 'Invalid month format. Use YYYY-MM' });
    return;
  }

  const byCategory = await dbAll<{ category: string | null; count: number }>(`
    SELECT category, COUNT(*) as count
    FROM conversations
    WHERE DATE_FORMAT(created_at, '%Y-%m') = ?
    GROUP BY category ORDER BY count DESC
  `, [month]);

  const byMode = await dbAll<{ mode: string | null; count: number }>(`
    SELECT mode, COUNT(*) as count
    FROM conversations
    WHERE DATE_FORMAT(created_at, '%Y-%m') = ?
    GROUP BY mode ORDER BY count DESC
  `, [month]);

  const byFileType = await dbAll<{ file_type: string | null; count: number }>(`
    SELECT file_type, COUNT(*) as count
    FROM generated_files
    WHERE DATE_FORMAT(created_at, '%Y-%m') = ?
    GROUP BY file_type ORDER BY count DESC
  `, [month]);

  const bySkill = await dbAll<{ skill_id: string | null; count: number }>(`
    SELECT skill_id, COUNT(*) as count
    FROM task_executions
    WHERE DATE_FORMAT(created_at, '%Y-%m') = ?
    GROUP BY skill_id ORDER BY count DESC LIMIT 10
  `, [month]);

  const totalConvRow = await dbGet<{ count: number }>(`SELECT COUNT(*) as count FROM conversations WHERE DATE_FORMAT(created_at, '%Y-%m') = ?`, [month]);
  const totalFileRow = await dbGet<{ count: number }>(`SELECT COUNT(*) as count FROM generated_files WHERE DATE_FORMAT(created_at, '%Y-%m') = ?`, [month]);
  const activeUsersRow = await dbGet<{ count: number }>(`SELECT COUNT(DISTINCT user_id) as count FROM conversations WHERE DATE_FORMAT(created_at, '%Y-%m') = ?`, [month]);

  res.json({
    byCategory,
    byMode,
    byFileType,
    bySkill,
    summary: {
      totalConversations: totalConvRow?.count ?? 0,
      totalFiles: totalFileRow?.count ?? 0,
      activeUsers: activeUsersRow?.count ?? 0,
    },
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
    ORDER BY (COALESCE(SUM(tu.input_tokens), 0) + COALESCE(SUM(tu.output_tokens), 0)) DESC, conversations DESC
    LIMIT ${limit}
  `);

  res.json(rows);
});

// GET /api/admin/analytics/topic-analysis?period=7d|30d
router.get('/analytics/topic-analysis', async (req: Request, res: Response) => {
  const period = (req.query?.period as string) || '7d';
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

// GET /api/admin/tokens/monthly-summary?from=YYYY-MM&to=YYYY-MM
router.get('/tokens/monthly-summary', async (req: Request, res: Response) => {
  const from = (req.query.from as string) || '';
  const to   = (req.query.to   as string) || '';
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  if (from) { conditions.push("DATE_FORMAT(tu.created_at, '%Y-%m') >= ?"); params.push(from); }
  if (to)   { conditions.push("DATE_FORMAT(tu.created_at, '%Y-%m') <= ?"); params.push(to); }
  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
  const rows = await dbAll(`
    SELECT
      DATE_FORMAT(tu.created_at, '%Y-%m') AS month,
      u.email,
      COALESCE(u.display_name, u.email) AS display_name,
      SUM(tu.input_tokens)  AS input_tokens,
      SUM(tu.output_tokens) AS output_tokens,
      SUM(tu.input_tokens + tu.output_tokens) AS total_tokens,
      COALESCE(SUM((tu.input_tokens / 1000000 * 3 + tu.output_tokens / 1000000 * 15) * ${pricingMarkupSql('tu.created_at')}), 0) AS cost,
      COUNT(DISTINCT tu.conversation_id) AS conversations,
      COUNT(*) AS sessions
    FROM token_usage tu
    LEFT JOIN users u ON u.id = tu.user_id
    ${where}
    GROUP BY DATE_FORMAT(tu.created_at, '%Y-%m'), tu.user_id, u.email, u.display_name
    ORDER BY month DESC, total_tokens DESC
  `, ...params);

  // Excel export — all filtered rows, styled workbook (matches the CSV columns).
  if ((req.query.format as string) === 'xlsx') {
    const headers = ['月份', 'Email', '姓名', '輸入 Token', '輸出 Token', '總 Token', '預估費用(USD)', '對話次數', 'API 呼叫次數'];
    const sheetRows = (rows as any[]).map(r => {
      // Cost is boundary-exact (computed per record in SQL); split-month rows already correct.
      return [r.month, r.email, r.display_name, r.input_tokens, r.output_tokens, r.total_tokens, Math.round(r.cost * 10000) / 10000, r.conversations, r.sessions];
    });
    const label = from || to ? `${from || 'all'}_${to || 'all'}` : 'all';
    await sendXlsx(res, `token_billing_${label}.xlsx`, [{ name: 'Token 用量', headers, rows: sheetRows }]);
    return;
  }

  res.json(rows);
});

// ==================== Quota Requests ====================

// GET /api/admin/quota-requests — List quota increase requests
router.get('/quota-requests', async (req: Request, res: Response) => {
  const status = req.query.status as string | undefined;
  let where = '';
  const params: any[] = [];
  if (status && ['pending', 'approved', 'denied'].includes(status)) {
    where = 'WHERE qr.status = ?';
    params.push(status);
  }

  const rows = await dbAll<any>(`
    SELECT qr.*, u.email, u.display_name, u.role AS user_role,
           u.quota_override AS cur_override, qg.limit_usd AS cur_group_limit,
           (u.id IS NULL) AS user_deleted
    FROM quota_requests qr
    LEFT JOIN users u ON u.id = qr.user_id
    LEFT JOIN quota_groups qg ON qg.id = u.quota_group_id
    ${where}
    ORDER BY CASE qr.status WHEN 'pending' THEN 0 ELSE 1 END, qr.created_at DESC
    LIMIT 100
  `, ...params);

  // Annotate each row with the requester's CURRENT effective limit so the UI can
  // flag approvals that no longer match (history vs current state), and mark
  // deleted/unlimited requesters.
  const globalLimit = await getUserUsageLimitUsd();
  const annotated = rows.map((r: any) => {
    const userDeleted = !!r.user_deleted;
    const userUnlimited = r.user_role === 'admin';
    const currentLimit = userDeleted || userUnlimited
      ? null
      : (r.cur_override ?? r.cur_group_limit ?? globalLimit);
    const { cur_override, cur_group_limit, user_role, ...rest } = r;
    return { ...rest, user_deleted: userDeleted, user_unlimited: userUnlimited, current_limit_effective: currentLimit };
  });

  res.json(annotated);
});

// PATCH /api/admin/quota-requests/:id — Approve or deny a quota request
router.patch('/quota-requests/:id', async (req: Request, res: Response) => {
  const { id } = req.params;
  const { action, new_limit, admin_notes, group_id } = req.body;

  if (!action || !['approve', 'deny'].includes(action)) {
    res.status(400).json({ error: 'action must be "approve" or "deny"' });
    return;
  }

  const request = await dbGet<any>('SELECT * FROM quota_requests WHERE id = ?', id);
  if (!request) {
    res.status(404).json({ error: 'Request not found' });
    return;
  }
  if (request.status !== 'pending') {
    res.status(400).json({ error: 'Request already reviewed' });
    return;
  }

  if (action === 'approve') {
    // Preferred path: approve by assigning the user to a quota GROUP. This keeps
    // approvals manageable by reviewers (who operate on groups) and clears any
    // personal override so the group actually takes effect. A raw `new_limit`
    // (personal override) is still accepted as an admin-only exception.
    const group = group_id
      ? await dbGet<{ id: string; limit_usd: number }>('SELECT id, limit_usd FROM quota_groups WHERE id = ?', group_id)
      : null;
    if (group_id && !group) { res.status(400).json({ error: '找不到指定的額度群組' }); return; }

    if (group) {
      await dbRun(
        "UPDATE quota_requests SET status = 'approved', new_limit = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
        group.limit_usd, admin_notes || null, req.user!.userId, id
      );
      // Join the group + clear personal override (so the group, not a hidden
      // override, drives the limit — and a reviewer can re-assign later).
      await dbRun(
        'UPDATE users SET quota_group_id = ?, quota_override = NULL, updated_at = NOW() WHERE id = ?',
        group.id, request.user_id
      );
      await dbRun(
        'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
        uuidv4(), req.user!.userId, 'approve_quota_request', 'quota_request', id,
        JSON.stringify({ user_id: request.user_id, group_id: group.id, new_limit: group.limit_usd })
      );
    } else {
      // Admin exception: personal override.
      if (new_limit == null || isNaN(parseFloat(new_limit)) || parseFloat(new_limit) <= 0) {
        res.status(400).json({ error: '核准需提供 group_id（指派群組）或正數 new_limit（個人額度）' });
        return;
      }
      const limitVal = parseFloat(new_limit);
      await dbRun(
        "UPDATE quota_requests SET status = 'approved', new_limit = ?, admin_notes = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
        limitVal, admin_notes || null, req.user!.userId, id
      );
      await dbRun(
        'UPDATE users SET quota_override = ?, updated_at = NOW() WHERE id = ?',
        limitVal, request.user_id
      );
      await dbRun(
        'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
        uuidv4(), req.user!.userId, 'approve_quota_request', 'quota_request', id,
        JSON.stringify({ user_id: request.user_id, new_limit: limitVal })
      );
    }
  } else {
    // Deny
    await dbRun(
      "UPDATE quota_requests SET status = 'denied', admin_notes = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ?",
      admin_notes || null, req.user!.userId, id
    );

    // Audit log
    await dbRun(
      'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
      uuidv4(), req.user!.userId, 'deny_quota_request', 'quota_request', id,
      JSON.stringify({ user_id: request.user_id, admin_notes })
    );
  }

  res.json({ success: true });
});

// ==================== AD Org Chart (pro-panjit only) ====================

const AD_DOMAINS = ['PANJIT', 'PYNMAX', 'WXPJ', 'PJWS', 'GDPJ', 'PJXZ', 'PJSD'];

// GET /api/admin/org/tree?domain=PANJIT
router.get('/org/tree', async (req: Request, res: Response) => {
  if (config.deployMode !== 'pro-panjit') {
    return res.status(403).json({ error: 'Not available in this deployment mode' });
  }
  const adUrl = process.env.AD_URL;
  const adApi = process.env.AD_API;
  if (!adUrl || !adApi) {
    return res.status(500).json({ error: 'AD integration not configured' });
  }
  const domain = (req.query.domain as string || 'PANJIT').toUpperCase();
  if (!AD_DOMAINS.includes(domain)) {
    return res.status(400).json({ error: `Invalid domain. Allowed: ${AD_DOMAINS.join(', ')}` });
  }
  try {
    const upstream = await fetch(`${adUrl}/ldap/api/v1/organizations/tree?domain=${domain}`, {
      headers: { 'X-API-Key': adApi },
    });
    const data = await upstream.json() as Record<string, unknown>;
    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: 'AD API error', detail: data });
    }
    res.json(data);
  } catch (err) {
    console.error('[AD Org] fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch AD org tree' });
  }
});

// GET /api/admin/org/domains
router.get('/org/domains', (_req: Request, res: Response) => {
  if (config.deployMode !== 'pro-panjit') {
    return res.status(403).json({ error: 'Not available in this deployment mode' });
  }
  res.json({ domains: AD_DOMAINS });
});

// ---- AD member picker + provisioning (pro-panjit) ----

interface AdRawNode { name?: string; type?: string; members?: Array<{ username?: string; displayName?: string }>; children?: AdRawNode[]; }
type AdSysRow = { id: string; ad_username: string | null; status: string; quota_override: number | null; group_limit: number | null };

// Walk the AD org tree and annotate each member with its system account (if any)
// and effective quota limit, preserving the OU/department hierarchy.
function annotateAdTree(node: AdRawNode | undefined, sysByUser: Map<string, AdSysRow>, globalDefault: number): unknown {
  if (!node) return { name: '', type: 'ou', members: [], children: [] };
  const members = (node.members || []).map(m => {
    const uname = m.username || '';
    const sys = sysByUser.get(uname.toLowerCase());
    const effectiveLimit = sys
      ? (sys.quota_override != null ? sys.quota_override : (sys.group_limit != null ? sys.group_limit : globalDefault))
      : globalDefault;
    return { username: uname, displayName: m.displayName || uname, inSystem: !!sys, userId: sys?.id || null, status: sys?.status || null, effectiveLimit };
  });
  return {
    name: node.name || '',
    type: node.type || 'ou',
    members,
    children: (node.children || []).map(c => annotateAdTree(c, sysByUser, globalDefault)),
  };
}

// GET /api/admin/ad/members?domain=PANJIT
// Returns the AD organization TREE for a company (OU/department hierarchy), each
// member annotated with its system account (if any) and effective quota —
// used by the "assign to group" picker.
router.get('/ad/members', async (req: Request, res: Response) => {
  if (config.deployMode !== 'pro-panjit') return res.status(403).json({ error: 'Not available in this deployment mode' });
  const adUrl = process.env.AD_URL, adApi = process.env.AD_API;
  if (!adUrl || !adApi) return res.status(500).json({ error: 'AD integration not configured' });
  const domain = (req.query.domain as string || 'PANJIT').toUpperCase();
  if (!AD_DOMAINS.includes(domain)) return res.status(400).json({ error: `Invalid domain. Allowed: ${AD_DOMAINS.join(', ')}` });
  try {
    const upstream = await fetch(`${adUrl}/ldap/api/v1/organizations/tree?domain=${domain}`, { headers: { 'X-API-Key': adApi } });
    if (!upstream.ok) return res.status(upstream.status).json({ error: 'AD API error' });
    const data = await upstream.json() as { tree?: AdRawNode };

    const sysRows = await dbAll<AdSysRow>(
      `SELECT u.id, u.ad_username, u.status, u.quota_override, qg.limit_usd AS group_limit
       FROM users u LEFT JOIN quota_groups qg ON qg.id = u.quota_group_id
       WHERE u.ad_domain = ? AND u.auth_provider = 'ad'`, domain
    );
    const sysByUser = new Map<string, AdSysRow>();
    for (const r of sysRows) if (r.ad_username) sysByUser.set(r.ad_username.toLowerCase(), r);
    const globalDefault = await getUserUsageLimitUsd();

    res.json({ domain, tree: annotateAdTree(data.tree, sysByUser, globalDefault), globalDefault });
  } catch (err) {
    console.error('[AD members] fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch AD members' });
  }
});

// ---- Quota-request email notification recipients (pro-panjit) ----

// GET /api/admin/quota-notify → bound recipients + gateway status
router.get('/quota-notify', async (_req: Request, res: Response) => {
  if (config.deployMode !== 'pro-panjit') return res.status(403).json({ error: 'Not available in this deployment mode' });
  const recipients = await getQuotaNotifyRecipients();
  res.json({ recipients, mailConfigured: isGatewayMailConfigured() });
});

// PUT /api/admin/quota-notify { recipients: [{email, name?}] }
router.put('/quota-notify', async (req: Request, res: Response) => {
  if (config.deployMode !== 'pro-panjit') return res.status(403).json({ error: 'Not available in this deployment mode' });
  const list = Array.isArray(req.body?.recipients) ? req.body.recipients as QuotaNotifyRecipient[] : null;
  if (!list) return res.status(400).json({ error: 'recipients array required' });
  if (list.length > 50) return res.status(400).json({ error: '收件者上限為 50 人' });
  await setQuotaNotifyRecipients(list);
  res.json({ ok: true, recipients: await getQuotaNotifyRecipients() });
});

// POST /api/admin/quota-notify/test { email? } → send a test mail (surfaces gateway errors)
router.post('/quota-notify/test', async (req: Request, res: Response) => {
  if (config.deployMode !== 'pro-panjit') return res.status(403).json({ error: 'Not available in this deployment mode' });
  const explicit = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  let to: string[];
  if (explicit && explicit.includes('@')) {
    to = [explicit.toLowerCase()];
  } else {
    to = (await getQuotaNotifyRecipients()).map(r => r.email);
  }
  if (!to.length) return res.status(400).json({ error: '尚未設定收件者，且未提供測試信箱' });
  // Send the REAL notification template (with sample data) so the test looks
  // exactly like an actual quota-request notification.
  const { subject, body } = buildQuotaRequestEmail({
    requesterName: '王小明',
    requesterEmail: 'sample.user@panjit.com.tw',
    reason: '近期需製作多份季度簡報與報告，目前額度即將用罄，懇請調高額度。',
    currentLimit: 50,
    currentCost: 47.32,
    adminUrl: config.publicWebUrl,
    isTest: true,
  });
  const result = await sendGatewayMail({ to, subject, body, bodyType: 'html' });
  if (!result.ok) {
    return res.status(502).json({ ok: false, status: result.status, detail: result.detail, sentTo: to });
  }
  res.json({ ok: true, sentTo: to });
});

// GET /api/admin/ad/resolve-email?username=&domain= → resolve an AD person's mailbox
router.get('/ad/resolve-email', async (req: Request, res: Response) => {
  if (config.deployMode !== 'pro-panjit') return res.status(403).json({ error: 'Not available in this deployment mode' });
  const username = String(req.query.username || '').trim();
  const domain = String(req.query.domain || '').trim().toUpperCase();
  if (!username || !AD_DOMAINS.includes(domain)) return res.status(400).json({ error: 'username 與有效 domain 為必填' });
  const r = await resolveAdEmail(username, domain);
  res.json(r);
});

// POST /api/admin/users/provision-ad  { username, domain, displayName? }
// Admin-side provisioning: create a system account for an AD person WITHOUT a
// password (auth_provider='ad'); they connect on their next AD login. Idempotent.
router.post('/users/provision-ad', async (req: Request, res: Response) => {
  if (config.deployMode !== 'pro-panjit') return res.status(403).json({ error: 'Not available in this deployment mode' });
  const username = String(req.body.username || '').trim();
  const domain = String(req.body.domain || '').trim().toUpperCase();
  let displayName = String(req.body.displayName || '').trim();
  if (!username || !AD_DOMAINS.includes(domain)) return res.status(400).json({ error: 'username 與有效 domain 為必填' });

  const existing = await dbGet<{ id: string; email: string; display_name: string | null }>(
    'SELECT id, email, display_name FROM users WHERE ad_username = ? AND ad_domain = ?', username, domain
  );
  if (existing) return res.json({ id: existing.id, email: existing.email, displayName: existing.display_name, alreadyExists: true });

  // Look up the AD mail (and name) so the account uses the real address.
  let mail: string | null = null;
  if (config.adApiKey) {
    try {
      const det = await fetch(`${config.adApiUrl}/users/${encodeURIComponent(username)}?domain=${encodeURIComponent(domain)}`,
        { headers: { 'X-API-Key': config.adApiKey }, signal: AbortSignal.timeout(8000) });
      if (det.ok) {
        // Gateway nests the record under `user`; tolerate a flat shape too.
        const d = await det.json() as { user?: { mail?: string; displayName?: string }; mail?: string; displayName?: string };
        const rec = d.user ?? d;
        mail = rec.mail || null; if (!displayName) displayName = rec.displayName || '';
      }
    } catch { /* fall back to synthetic email */ }
  }
  const email = mail ? mail.toLowerCase().trim() : `${username.toLowerCase()}@${domain.toLowerCase()}.panjit.local`;
  displayName = (displayName || username).trim();

  const conflict = await dbGet<{ id: string; ad_username: string | null }>('SELECT id, ad_username FROM users WHERE email = ?', email);
  if (conflict) {
    if (conflict.ad_username) return res.json({ id: conflict.id, email, displayName, alreadyExists: true });
    return res.status(409).json({ error: `信箱 ${email} 已有非 AD 帳號使用，無法自動建立` });
  }

  const id = uuidv4();
  await dbRun(
    'INSERT INTO users (id, email, password_hash, display_name, role, status, auth_provider, ad_username, ad_domain, onboarding_completed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, email, 'AD_NO_PASSWORD', displayName, 'user', 'active', 'ad', username, domain, 1
  );
  try {
    await dbRun('INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
      uuidv4(), req.user!.userId, 'provision_ad_user', 'user', id, JSON.stringify({ ad_username: username, ad_domain: domain, email }));
  } catch { /* audit is best-effort */ }
  res.status(201).json({ id, email, displayName, created: true });
});

// ==================== Permissions ====================

// GET /api/admin/permissions — get role permissions config
router.get('/permissions', async (_req: Request, res: Response) => {
  const perms = await getRolePermissions();
  res.json(perms);
});

// PUT /api/admin/permissions — update role permissions config (admin only, readonly blocked by middleware)
router.put('/permissions', async (req: Request, res: Response) => {
  const body = req.body as RolePermissions;
  if (!body || !body.adminSidebar || !body.frontendNav || !body.features) {
    res.status(400).json({ error: 'Invalid permissions format' });
    return;
  }
  await setRolePermissions(body);
  res.json({ success: true });
});

// ==================== LINE Bot admin ====================

const LINE_SETTING_RANGES: Record<keyof LineSettings, { min: number; max: number }> = {
  maxMsgPerMin: { min: 1, max: 1000 },
  conversationIdleHours: { min: 1, max: 168 },
  fileShareTtlDays: { min: 1, max: 365 },
  defaultQuotaUsd: { min: 0, max: 100000 },
};

// GET /api/admin/line/settings — runtime-editable settings + read-only bot status.
// Secrets (channelSecret/accessToken) are never returned; only whether they're set.
router.get('/line/settings', (_req: Request, res: Response) => {
  res.json({
    settings: getLineSettings(),
    status: {
      enabled: config.line.enabled,
      channelConfigured: !!(config.line.channelSecret && config.line.channelAccessToken),
      channelId: config.line.channelId,
      botBasicId: config.line.botBasicId,
      liffId: config.line.liffId,
      publicApiBase: config.line.publicApiBase,
      webhookUrl: config.line.publicApiBase ? `${config.line.publicApiBase}/webhook/line` : '',
    },
  });
});

// PATCH /api/admin/line/settings — update one or more runtime settings (effective immediately).
router.patch('/line/settings', async (req: Request, res: Response) => {
  const before = getLineSettings();
  const changes: string[] = [];

  for (const key of Object.keys(LINE_SETTING_RANGES) as (keyof LineSettings)[]) {
    const val = req.body[key];
    if (typeof val !== 'number' || !Number.isFinite(val)) continue;
    const { min, max } = LINE_SETTING_RANGES[key];
    if (val < min || val > max) {
      res.status(400).json({ error: `${key} must be between ${min} and ${max}` });
      return;
    }
    if (val !== before[key]) {
      await setLineSetting(key, val);
      changes.push(`${key}: ${before[key]} → ${val}`);
    }
  }

  if (changes.length === 0) {
    res.status(400).json({ error: 'No valid settings to update' });
    return;
  }

  await dbRun(
    'INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details) VALUES (?, ?, ?, ?, ?, ?)',
    uuidv4(), req.user!.userId, 'update_line_settings', 'system', 'line_settings',
    JSON.stringify({ changes })
  );

  res.json({ success: true, settings: getLineSettings() });
});

// GET /api/admin/line/users — LINE-linked users with their quota usage.
router.get('/line/users', async (_req: Request, res: Response) => {
  const globalDefault = await getUserUsageLimitUsd();
  // Quota usage resets monthly in official mode — only count the current calendar
  // month so this matches getUserDisplayCost / the user detail panel (see the
  // quota-groups members endpoint for the same fix).
  const usageParams: unknown[] = [];
  let monthFilter = '';
  if (!config.isBeta) {
    const now = new Date();
    const monthStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    monthFilter = ' WHERE created_at >= ?';
    usageParams.push(monthStart);
  }
  const rows = await dbAll<{
    line_user_id: string; display_name: string | null; linked_via: string | null;
    last_message_at: string | null; user_id: string; email: string; status: string;
    quota_override: number | null; quota_group_id: string | null; group_limit: number | null;
    in_tok: number; out_tok: number; cost: number; disabled: number;
  }>(
    `SELECT lu.line_user_id, lu.display_name, lu.linked_via, lu.last_message_at, lu.disabled,
            u.id AS user_id, u.email, u.status, u.quota_override, u.quota_group_id,
            qg.limit_usd AS group_limit,
            COALESCE(tu.in_tok, 0) AS in_tok, COALESCE(tu.out_tok, 0) AS out_tok, COALESCE(tu.cost, 0) AS cost
     FROM line_users lu
     JOIN users u ON u.id = lu.internal_user_id
     LEFT JOIN quota_groups qg ON qg.id = u.quota_group_id
     LEFT JOIN (
       SELECT user_id, SUM(input_tokens) AS in_tok, SUM(output_tokens) AS out_tok,
              SUM((input_tokens / 1000000 * 3 + output_tokens / 1000000 * 15) * ${pricingMarkupSql('created_at')}) AS cost
       FROM token_usage${monthFilter} GROUP BY user_id
     ) tu ON tu.user_id = u.id
     ORDER BY (lu.last_message_at IS NULL), lu.last_message_at DESC`,
    ...usageParams
  );

  const users = rows.map(r => {
    // Cost is boundary-exact (per record; ×10 before 2026-07-07 16:00, ×5 after).
    const cost = r.cost ?? 0;
    // Effective limit: personal override > group > global default.
    const limit = r.quota_override != null ? r.quota_override
      : r.group_limit != null ? r.group_limit
        : globalDefault;
    const limitSource = r.quota_override != null ? 'personal'
      : r.group_limit != null ? 'group'
        : 'global';
    return {
      lineUserId: r.line_user_id,
      displayName: r.display_name,
      email: r.email,
      userId: r.user_id,
      status: r.status,
      linkedVia: r.linked_via,
      lastMessageAt: r.last_message_at,
      disabled: !!r.disabled,
      cost: Math.round(cost * 100) / 100,
      limit: Math.round(limit * 100) / 100,
      remaining: Math.round((limit - cost) * 100) / 100,
      pctUsed: limit > 0 ? Math.round((cost / limit) * 100) : 0,
      exceeded: cost >= limit,
      limitSource,
    };
  });

  res.json({ users, count: users.length });
});

// POST /api/admin/line/users/:lineUserId/disable — suspend a LINE user. The
// binding is kept; they can't chat until re-enabled.
router.post('/line/users/:lineUserId/disable', async (req: Request, res: Response) => {
  await setLineUserDisabled(String(req.params.lineUserId), true);
  res.json({ success: true });
});

// POST /api/admin/line/users/:lineUserId/enable — restore a suspended user to
// their original access.
router.post('/line/users/:lineUserId/enable', async (req: Request, res: Response) => {
  await setLineUserDisabled(String(req.params.lineUserId), false);
  res.json({ success: true });
});

// DELETE /api/admin/line/users/:lineUserId — fully unbind a LINE account from
// its internal user (vs. /disable, which keeps the binding). Removes only the
// binding row + the user's stale bind tokens so this LINE can be re-bound to
// another account. The internal user account and its data are left untouched
// (the line_users → users cascade only fires when the user itself is deleted).
router.delete('/line/users/:lineUserId', async (req: Request, res: Response) => {
  const lineUserId = String(req.params.lineUserId);
  const row = await dbGet<{ internal_user_id: string }>(
    'SELECT internal_user_id FROM line_users WHERE line_user_id = ?', lineUserId,
  );
  if (!row) { res.status(404).json({ error: 'LINE 綁定不存在' }); return; }
  await dbRun('DELETE FROM line_users WHERE line_user_id = ?', lineUserId);
  // Clear the unbound user's bind tokens so a fresh QR binds cleanly.
  await dbRun('DELETE FROM line_link_tokens WHERE user_id = ?', row.internal_user_id);
  res.json({ success: true });
});

// GET /api/admin/line/message-quota — LINE Official Account monthly push quota.
// Live call to the LINE API; returns { error } (200) when it can't be fetched
// (e.g. no access token) so the UI can degrade gracefully.
router.get('/line/message-quota', async (_req: Request, res: Response) => {
  try {
    const quota = await getMessageQuotaStatus();
    res.json(quota);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ error: msg });
  }
});

// ── API-key usage tracking (ai_call_log) — ADMIN ONLY ────────────────────────
// Ground-truth ledger of every Claude spawn: account (subscription, free) vs
// api_key (billed), which model, and why the API key was used. Powers the admin
// "API 追蹤" report so the daily API spend is fully explainable and attributable.
router.get('/api-tracking/stats', async (req: Request, res: Response) => {
  // Admin only — readonly reviewers must not see billing / API-key internals.
  if ((req.user as { role?: string } | undefined)?.role !== 'admin') {
    res.status(403).json({ error: 'Admin only' });
    return;
  }
  const period = (req.query.period as string) || '30d';
  const days = period === '7d' ? 7 : period === '90d' ? 90 : 30;
  const since = `created_at >= DATE_SUB(NOW(), INTERVAL ${days} DAY)`;
  try {
    const [byAuth, daily, byModel, bySkill, reasons, recentApiKey] = await Promise.all([
      dbAll<{ auth_mode: string; calls: number; inTok: number; outTok: number }>(
        `SELECT auth_mode, COUNT(*) calls, SUM(input_tokens) inTok, SUM(output_tokens) outTok
         FROM ai_call_log WHERE ${since} GROUP BY auth_mode`),
      dbAll<{ d: string; auth_mode: string; calls: number; outTok: number }>(
        `SELECT DATE_FORMAT(created_at,'%Y-%m-%d') d, auth_mode, COUNT(*) calls, SUM(output_tokens) outTok
         FROM ai_call_log WHERE ${since} GROUP BY d, auth_mode ORDER BY d ASC`),
      dbAll<{ model: string | null; auth_mode: string; calls: number; outTok: number }>(
        `SELECT model, auth_mode, COUNT(*) calls, SUM(output_tokens) outTok
         FROM ai_call_log WHERE ${since} GROUP BY model, auth_mode ORDER BY outTok DESC`),
      dbAll<{ skill_id: string | null; auth_mode: string; calls: number }>(
        `SELECT skill_id, auth_mode, COUNT(*) calls
         FROM ai_call_log WHERE ${since} GROUP BY skill_id, auth_mode ORDER BY calls DESC`),
      dbAll<{ reason: string | null; calls: number }>(
        `SELECT reason, COUNT(*) calls FROM ai_call_log
         WHERE auth_mode='api_key' AND ${since} GROUP BY reason ORDER BY calls DESC`),
      dbAll<{ created_at: string; skill_id: string | null; model: string | null; reason: string | null; input_tokens: number; output_tokens: number; success: number }>(
        `SELECT created_at, skill_id, model, reason, input_tokens, output_tokens, success
         FROM ai_call_log WHERE auth_mode='api_key' ORDER BY created_at DESC LIMIT 100`),
    ]);
    res.json({ period, days, byAuth, daily, byModel, bySkill, reasons, recentApiKey });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Ledger table may not exist yet (no Claude spawn since deploy) — return empty.
    if (/doesn't exist|no such table|ER_NO_SUCH_TABLE/i.test(msg)) {
      res.json({ period, days, byAuth: [], daily: [], byModel: [], bySkill: [], reasons: [], recentApiKey: [], empty: true });
      return;
    }
    console.error('[api-tracking] query failed:', msg);
    res.status(500).json({ error: 'query failed' });
  }
});

export default router;
