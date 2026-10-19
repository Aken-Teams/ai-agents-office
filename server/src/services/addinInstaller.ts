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
 * ── Why the server never hosts the file ──
 * It stores a URL, not an upload. An EXE is the one artefact where getting
 * distribution wrong is actually dangerous: whoever serves it owns the trust
 * chain (signing, antivirus reputation, corporate allow-listing). Those belong
 * to the team that builds and signs the installer, and a copy sitting in this
 * app's workspace would be a second, unsigned, silently-stale source of it.
 */
import { dbGet, dbRun } from '../db.js';

const SETTING_KEY = 'addin_installer';

export interface AddinInstallerSettings {
  /** Off by default — a half-configured download must not appear to users. */
  enabled: boolean;
  /** Absolute http(s) URL. Empty string when unset. */
  url: string;
  /** Shown next to the link, e.g. "v1.4.2". Optional. */
  version: string;
  /** One line under the title — which hosts it covers, who to ask for help. */
  note: string;
}

const EMPTY: AddinInstallerSettings = { enabled: false, url: '', version: '', note: '' };

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
    return {
      enabled: !!v.enabled,
      url: normalizeInstallerUrl(v.url),
      version: typeof v.version === 'string' ? v.version.slice(0, 40) : '',
      note: typeof v.note === 'string' ? v.note.slice(0, 200) : '',
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function setAddinInstaller(s: Partial<AddinInstallerSettings>): Promise<AddinInstallerSettings> {
  const next: AddinInstallerSettings = {
    // A URL that failed validation leaves `url` empty, and an enabled download
    // with no URL is a dead button — so the toggle can only hold while there is
    // something to download.
    url: normalizeInstallerUrl(s.url),
    version: String(s.version ?? '').trim().slice(0, 40),
    note: String(s.note ?? '').trim().slice(0, 200),
    enabled: false,
  };
  next.enabled = !!s.enabled && !!next.url;
  await dbRun("REPLACE INTO system_settings (`key`, value) VALUES (?, ?)", SETTING_KEY, JSON.stringify(next));
  return next;
}

/**
 * What a signed-in user is allowed to see: the link itself, or nothing at all.
 * `enabled` never crosses to the client — an absent object already says "no
 * download here", and a disabled-but-populated one would hand out a URL the
 * admin has deliberately switched off.
 */
export async function getPublicAddinInstaller(): Promise<{ url: string; version: string; note: string } | null> {
  const s = await getAddinInstaller();
  if (!s.enabled || !s.url) return null;
  return { url: s.url, version: s.version, note: s.note };
}
