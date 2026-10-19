/**
 * Which profile patch owns the subagent model whitelist.
 *
 * The whitelist (`subagent-model-selection-settings.allowedModels`) is written
 * into the patch file of the profile the Host was booted with. That profile is
 * not always the Electron `desktop` one: `dsh web` boots `web`, `dsh headless`
 * boots `headless`, and a user can add their own.
 *
 * Hard-coding `profiles/desktop/cordis.patch.yml` therefore made every whitelist
 * read come back empty on a `web` install — the panel showed "0 条 / 0 个
 * provider", the availability sweep defaulted to the whole catalog, and combo
 * generation failed for every category with "白名单里没有这个类别的成员".
 *
 * Resolution order:
 *   1. `DSH_QUOTA_FAILOVER_PROFILE_PATCH` — an explicit patch file (escape hatch);
 *   2. `DSH_PROFILE` — the profile name, when the launcher exported it;
 *   3. the Host's own answer, `profileContext.patchPath`;
 *   4. scan every profile's `cordis.patch.yml` under `$DSH_HOME/profiles` for one
 *      that actually carries the whitelist block (no profile context needed);
 *   5. the first existing profile patch, so "block absent" is reported honestly;
 *   6. the legacy `desktop` path, for the paths shown in the panel.
 *
 * Step 3 is tried *before* scanning on purpose: a profile that has no whitelist
 * block must read as unconstrained, not as some other profile's whitelist.
 */
import fs from 'node:fs';
import path from 'node:path';

const SETTINGS_ROW = /^\s*-\s+id:\s*subagent-model-selection-settings\s*$/m;
const LEGACY_PROFILE = 'desktop';
const KNOWN_PROFILES = ['web', 'desktop', 'headless'];
const TTL_MS = 10_000;

let cache = { at: 0, home: '', hint: '', path: undefined };

/** True when a patch text carries the whitelist row. */
export function hasAllowlistBlock(text) {
  return typeof text === 'string' && SETTINGS_ROW.test(text);
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

function listProfiles(home) {
  try {
    return fs
      .readdirSync(path.join(home, 'profiles'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Resolve the patch file the whitelist should be read from.
 * @param {{home?: string, hint?: string, env?: Record<string, string|undefined>}} options
 *   `home` is the DSH home; `hint` is `profileContext.patchPath`; `env` defaults to
 *   `process.env` so tests can drive the override variables.
 * @returns {string} absolute path to a profile patch (it may not exist).
 */
export function resolveProfilePatchPath(options) {
  const home = typeof options?.home === 'string' ? options.home : '';
  const hint = typeof options?.hint === 'string' ? options.hint : '';
  const env = options?.env ?? {};
  const now = Date.now();
  if (cache.path !== undefined && cache.home === home && cache.hint === hint && now - cache.at < TTL_MS) {
    return cache.path;
  }

  const profilesDir = path.join(home, 'profiles');
  const patchOf = (name) => path.join(profilesDir, name, 'cordis.patch.yml');
  const asPatch = (value) => (path.isAbsolute(value) ? value : patchOf(value));

  // 1–3: answers that name the booted profile explicitly.
  const authoritative = [];
  for (const value of [env.DSH_QUOTA_FAILOVER_PROFILE_PATCH, env.DSH_PROFILE]) {
    if (typeof value === 'string' && value.trim().length > 0) authoritative.push(asPatch(value.trim()));
  }
  if (hint.length > 0) authoritative.push(hint);
  for (const candidate of authoritative) {
    if (readText(candidate) !== undefined) {
      cache = { at: now, home, hint, path: candidate };
      return candidate;
    }
  }

  // 4–5: no authoritative answer — find the profile whose patch carries the block.
  const names = listProfiles(home);
  const ordered = [];
  for (const known of KNOWN_PROFILES) if (names.includes(known)) ordered.push(patchOf(known));
  for (const name of names) ordered.push(patchOf(name));
  let firstExisting;
  let withBlock;
  for (const candidate of ordered) {
    const text = readText(candidate);
    if (text === undefined) continue;
    if (firstExisting === undefined) firstExisting = candidate;
    if (hasAllowlistBlock(text)) {
      withBlock = candidate;
      break;
    }
  }

  // 6: the legacy assumption, only so the panel can still show a real path.
  const value = withBlock ?? firstExisting ?? patchOf(LEGACY_PROFILE);
  cache = { at: now, home, hint, path: value };
  return value;
}

/** Drop the memoised answer (a profile switch, or a fresh patch write). */
export function resetProfilePatchCache() {
  cache = { at: 0, home: '', hint: '', path: undefined };
}
