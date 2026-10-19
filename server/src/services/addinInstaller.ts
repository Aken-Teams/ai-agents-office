/**
 * The Office add-in installer download, as configured by an admin.
 *
 * ── Why this is a setting and not a constant ──
 * Every deployment hands the installer out from somewhere different: PANJIT
 * serves it from an internal file share that nobody outside the network can
 * reach, and an external customer gets a public URL. The build cannot know
 * which, and shipping separate builds per customer to vary one URL is how a
 * product grows a fork per customer. So the deployment decides it at runtime.
 *
 * ── Two modes, because deployments differ in one specific way ──
 * 'url' points at a file somebody else serves. Preferred when the customer's IT
 * already hosts the add-in — which is usually true, since an Office add-in needs
 * a hosted manifest to exist at all — because they can then ship a new build by
 * replacing the file, with nobody logging in here.
 *
 * 'file' stores the installer on this server. It exists for the deployment that
 * has nowhere to put an EXE; without it the whole feature is unusable for them.
 * The trade is real and worth stating: a copy here is a second source of an
 * artefact whose trust chain (signing, antivirus reputation, corporate
 * allow-listing) belongs to whoever built it, and it goes stale silently unless
 * someone remembers to re-upload. That is a worse default, not a worse option.
 */
import fs from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import { dbGet, dbRun } from '../db.js';
import { config } from '../config.js';

const SETTING_KEY = 'addin_installer';

export interface AddinInstallerSettings {
  /** Off by default — a half-configured download must not appear to users. */
  enabled: boolean;
  /** Where the installer comes from. */
  mode: 'url' | 'file';
  /** Absolute http(s) URL. Empty string when unset. Used when mode === 'url'. */
  url: string;
  /** Uploaded installer, when mode === 'file'. Null when nothing is stored. */
  file: StoredInstaller | null;
  /** Shown next to the link, e.g. "v1.4.2". Optional. */
  version: string;
  /** One line under the title — which hosts it covers, who to ask for help. */
  note: string;
}

export interface StoredInstaller {
  /** Original filename, shown to the admin and sent as the download name. */
  name: string;
  size: number;
  /** ISO timestamp, so an admin can see at a glance how old the build is. */
  uploadedAt: string;
}

const EMPTY: AddinInstallerSettings = { enabled: false, mode: 'url', url: '', file: null, version: '', note: '' };

/** Installers live outside every per-user sandbox — they belong to the deployment. */
export const INSTALLER_DIR = path.join(config.workspaceRoot, '_system', 'addin');

/**
 * One stored installer at a time, under a FIXED name.
 *
 * The admin's filename is kept as metadata and used for the download, but never
 * as a path: a value like `..\..\startup\evil.exe` would otherwise choose
 * where on disk this lands, and the one thing an upload endpoint must never
 * give away is the write location.
 */
export const INSTALLER_PATH = path.join(INSTALLER_DIR, 'installer.bin');

/** Installers are big — a bundled .NET runtime alone clears 100MB. */
export const MAX_INSTALLER_BYTES = Math.max(
  1024 * 1024,
  parseInt(process.env.ADDIN_INSTALLER_MAX_MB || '', 10) > 0
    ? parseInt(process.env.ADDIN_INSTALLER_MAX_MB || '', 10) * 1024 * 1024
    : 200 * 1024 * 1024,
);

export const ALLOWED_INSTALLER_EXT = ['.exe', '.msi', '.zip'];

/**
 * Accept only an absolute http(s) URL.
 *
 * This value is written by an admin and rendered as an anchor's href for every
 * user, so the scheme check is the thing that matters: `javascript:` and `data:`
 * hrefs execute in the visitor's session, which would turn one compromised or
 * careless admin account into stored XSS on the landing page everyone sees.
 * Returns the normalised URL, or '' if it is not one.
 */
export function normalizeInstallerUrl(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  return parsed.toString().slice(0, 2048);
}

export async function getAddinInstaller(): Promise<AddinInstallerSettings> {
  const row = await dbGet<{ value: string }>("SELECT value FROM system_settings WHERE `key` = ?", SETTING_KEY);
  if (!row?.value) return { ...EMPTY };
  try {
    const v = JSON.parse(row.value);
    // The stored record is checked against the disk, not trusted on its own: a
    // workspace restored from a backup, or a volume that was never mounted,
    // would otherwise leave the UI advertising a download that 404s.
    const file: StoredInstaller | null = v.file && fs.existsSync(INSTALLER_PATH)
      ? {
          name: String(v.file.name || 'installer'),
          size: Number(v.file.size) || 0,
          uploadedAt: String(v.file.uploadedAt || ''),
        }
      : null;
    return {
      enabled: !!v.enabled,
      mode: v.mode === 'file' ? 'file' : 'url',
      url: normalizeInstallerUrl(v.url),
      file,
      version: typeof v.version === 'string' ? v.version.slice(0, 40) : '',
      note: typeof v.note === 'string' ? v.note.slice(0, 200) : '',
    };
  } catch {
    return { ...EMPTY };
  }
}

/** Persist the record as-is. Used by the upload/delete paths, which own `file`. */
async function writeSettings(s: AddinInstallerSettings): Promise<void> {
  await dbRun("REPLACE INTO system_settings (`key`, value) VALUES (?, ?)", SETTING_KEY, JSON.stringify(s));
}

/**
 * Record a freshly uploaded installer. The bytes are already on disk; this
 * switches the mode over so the admin does not have to remember a second step.
 */
export async function recordUploadedInstaller(name: string, size: number): Promise<AddinInstallerSettings> {
  const current = await getAddinInstaller();
  const next: AddinInstallerSettings = {
    ...current,
    mode: 'file',
    file: { name: name.slice(0, 160), size, uploadedAt: new Date().toISOString() },
  };
  await writeSettings(next);
  return next;
}

/** Remove the stored installer, and fall back to URL mode. */
export async function deleteUploadedInstaller(): Promise<AddinInstallerSettings> {
  try { fs.rmSync(INSTALLER_PATH, { force: true }); } catch { /* already gone */ }
  const current = await getAddinInstaller();
  const next: AddinInstallerSettings = { ...current, mode: 'url', file: null };
  // Nothing to serve in file mode any more, so an enabled toggle would point
  // users at a download that cannot work.
  if (!next.url) next.enabled = false;
  await writeSettings(next);
  return next;
}

export async function setAddinInstaller(s: Partial<AddinInstallerSettings>): Promise<AddinInstallerSettings> {
  // `file` is never taken from the request — only the upload and delete paths
  // may claim that bytes exist on disk.
  const current = await getAddinInstaller();
  const next: AddinInstallerSettings = {
    mode: s.mode === 'file' ? 'file' : 'url',
    url: normalizeInstallerUrl(s.url),
    file: current.file,
    version: String(s.version ?? '').trim().slice(0, 40),
    note: String(s.note ?? '').trim().slice(0, 200),
    enabled: false,
  };
  // An enabled download with nothing behind it is a dead button, so the toggle
  // only holds while the selected mode actually has something to serve.
  const hasSource = next.mode === 'file' ? !!next.file : !!next.url;
  next.enabled = !!s.enabled && hasSource;
  await writeSettings(next);
  return next;
}

/**
 * What a signed-in user is allowed to see: the link itself, or nothing at all.
 * `enabled` never crosses to the client — an absent object already says "no
 * download here", and a disabled-but-populated one would hand out a URL the
 * admin has deliberately switched off.
 */
export async function getPublicAddinInstaller(): Promise<{ url: string; version: string; note: string; fileName?: string } | null> {
  const s = await getAddinInstaller();
  if (!s.enabled) return null;
  if (s.mode === 'file') {
    if (!s.file) return null;
    // A relative path, so the download works on whatever host the app is
    // reached through — including a reverse proxy whose public name this
    // process has no way to know.
    return { url: '/api/app-config/installer', version: s.version, note: s.note, fileName: s.file.name };
  }
  if (!s.url) return null;
  return { url: s.url, version: s.version, note: s.note };
}

// ── Paper trail ────────────────────────────────────────────────────────────
// Two questions this has to answer later, both of which need the same table:
// "who published this build" and "who installed it". Keeping uploads and
// downloads in one chronological log means the second answer can be read
// against the first without joining on timestamps.

export type InstallerEventType = 'upload' | 'delete' | 'url_set' | 'download';

export interface InstallerEvent {
  id: string;
  created_at: string;
  event_type: InstallerEventType;
  user_id: string | null;
  source: 'file' | 'url' | null;
  version: string | null;
  file_name: string | null;
  file_size: number | null;
  ip: string | null;
  user_agent: string | null;
}

/**
 * Best-effort: a failure to write the log must never fail the upload or block
 * someone's download. A missing row is a gap in an audit trail; a thrown error
 * here would be a broken feature.
 */
export async function logInstallerEvent(e: {
  type: InstallerEventType;
  userId?: string | null;
  source?: 'file' | 'url' | null;
  version?: string | null;
  fileName?: string | null;
  fileSize?: number | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<void> {
  try {
    await dbRun(
      `INSERT INTO addin_installer_events
         (id, event_type, user_id, source, version, file_name, file_size, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      randomUUID(), e.type, e.userId ?? null, e.source ?? null,
      (e.version ?? '').slice(0, 40) || null,
      (e.fileName ?? '').slice(0, 255) || null,
      e.fileSize ?? null,
      (e.ip ?? '').slice(0, 64) || null,
      (e.userAgent ?? '').slice(0, 255) || null,
    );
  } catch (err) {
    console.warn('[addinInstaller] event log failed:', (err as Error).message);
  }
}
