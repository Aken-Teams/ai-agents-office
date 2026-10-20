/**
 * Role Permissions Service — manages per-role visibility of navigation items and features.
 * Stored as a JSON blob in system_settings with key 'role_permissions'.
 */
import { dbGet, dbRun } from '../db.js';

export interface RolePermissions {
  adminSidebar: {
    /** Pages 唯讀管理員 can SEE. Allow-list: absent = hidden. */
    readonly: string[];
    /** Pages 唯讀管理員 can also MODIFY. Subset of `readonly` in practice. */
    readonlyOperate?: string[];
    /**
     * 管理員 restrictions, stored as EXCEPTIONS rather than an allow-list.
     *
     * Why the inverted shape: an admin allow-list would have to name every page,
     * so any page added later would be invisible to admins until somebody
     * remembered to add it — a new feature silently missing from the console
     * with no error to explain it. As exceptions, the default (both empty) is
     * "admins can do everything", which is also what every existing install
     * already has stored.
     *
     * The case this exists for: 額度審核. The customer's position is that they
     * approve their own quota requests and the vendor's admin should not be
     * doing it for them — so the admin needs to be able to open the page and
     * read it while being unable to click 核准. That is 僅檢視, and until now
     * the admin column had no such state.
     */
    adminHidden?: string[];
    adminViewOnly?: string[];
  };
  frontendNav: { user: string[]; readonly: string[] };
  features: { user: string[]; readonly: string[] };
}

/**
 * Pages that can never be restricted for 管理員.
 *
 * 權限管理 itself is the escape hatch: if an admin could hide or freeze it, a
 * single mis-click would lock every admin out of the only screen that can undo
 * the mis-click, with no way back short of editing the database by hand.
 */
export const ADMIN_UNRESTRICTABLE_PAGES = ['permissions'];

/** Normalise the admin exception lists, dropping anything unrestrictable. */
export function adminRestriction(perms: RolePermissions, pageKey: string | null): 'full' | 'view' | 'hidden' {
  if (!pageKey || ADMIN_UNRESTRICTABLE_PAGES.includes(pageKey)) return 'full';
  if (perms.adminSidebar.adminHidden?.includes(pageKey)) return 'hidden';
  if (perms.adminSidebar.adminViewOnly?.includes(pageKey)) return 'view';
  return 'full';
}

export const DEFAULT_ROLE_PERMISSIONS: RolePermissions = {
  adminSidebar: {
    readonly: [
      'overview', 'org', 'users', 'quota-groups', 'quota-requests',
      'invite-codes', 'skills', 'tokens', 'analytics', 'terms',
      'security', 'audit', 'templates', 'settings',
      // 'conversations' and 'announcements' excluded by default (was readonlyHidden)
      // 'permissions' excluded — admin only
    ],
    readonlyOperate: ['terms'],
    adminHidden: [],
    adminViewOnly: [],
  },
  frontendNav: {
    user: ['dashboard', 'assistant', 'conversations', 'files', 'usage', 'memories', 'guide'],
    readonly: ['dashboard', 'assistant', 'conversations', 'files', 'usage', 'memories', 'guide'],
  },
  features: {
    user: ['email-agent'],
    readonly: ['email-agent'],
  },
};

export async function getRolePermissions(): Promise<RolePermissions> {
  const row = await dbGet<{ value: string }>(
    "SELECT `value` FROM system_settings WHERE `key` = 'role_permissions'"
  );
  if (!row) return DEFAULT_ROLE_PERMISSIONS;
  try {
    return JSON.parse(row.value);
  } catch {
    return DEFAULT_ROLE_PERMISSIONS;
  }
}

export async function setRolePermissions(perms: RolePermissions): Promise<void> {
  // Strip the unrestrictable pages before they are ever written. The middleware
  // ignores them anyway, but a stored entry would show up in the UI as a setting
  // that silently does nothing, which is worse than refusing to store it.
  const strip = (list?: string[]) => (list || []).filter(k => !ADMIN_UNRESTRICTABLE_PAGES.includes(k));
  perms = {
    ...perms,
    adminSidebar: {
      ...perms.adminSidebar,
      adminHidden: strip(perms.adminSidebar.adminHidden),
      adminViewOnly: strip(perms.adminSidebar.adminViewOnly),
    },
  };
  const json = JSON.stringify(perms);
  const existing = await dbGet("SELECT `key` FROM system_settings WHERE `key` = 'role_permissions'");
  if (existing) {
    await dbRun("UPDATE system_settings SET `value` = ? WHERE `key` = 'role_permissions'", json);
  } else {
    await dbRun("INSERT INTO system_settings (`key`, `value`) VALUES ('role_permissions', ?)", json);
  }
}
