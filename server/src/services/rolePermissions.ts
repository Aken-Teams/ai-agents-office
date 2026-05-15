/**
 * Role Permissions Service — manages per-role visibility of navigation items and features.
 * Stored as a JSON blob in system_settings with key 'role_permissions'.
 */
import { dbGet, dbRun } from '../db.js';

export interface RolePermissions {
  adminSidebar: { readonly: string[]; readonlyOperate?: string[] };
  frontendNav: { user: string[]; readonly: string[] };
  features: { user: string[]; readonly: string[] };
}

export const DEFAULT_ROLE_PERMISSIONS: RolePermissions = {
  adminSidebar: {
    readonly: [
      'overview', 'org', 'users', 'quota-groups', 'quota-requests',
      'invite-codes', 'skills', 'tokens', 'analytics', 'terms',
      'security', 'settings',
      // 'conversations' and 'announcements' excluded by default (was readonlyHidden)
      // 'permissions' excluded — admin only
    ],
    readonlyOperate: ['terms'],
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
  const json = JSON.stringify(perms);
  const existing = await dbGet("SELECT `key` FROM system_settings WHERE `key` = 'role_permissions'");
  if (existing) {
    await dbRun("UPDATE system_settings SET `value` = ? WHERE `key` = 'role_permissions'", json);
  } else {
    await dbRun("INSERT INTO system_settings (`key`, `value`) VALUES ('role_permissions', ?)", json);
  }
}
