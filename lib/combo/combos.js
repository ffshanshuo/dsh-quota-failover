/**
 * Combo records: model-id helpers, normalisation, persistence and chain order.
 *
 * Mirrors `dsh-our-free-model`'s combo contract (a whole array is sent on save;
 * the store is `{ version, updatedAt, combos }`), but the members here are
 * routes of *other* providers, so a combo survives exactly as long as those
 * providers keep their routes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { comboSlug, isAggregateModelId } from './classify.js';

/** Route this plugin registers as its own provider. */
export const COMBO_PROVIDER = 'failover-combos';
/** Model ids owned by that provider look like `combo:<category-key>`. */
export const COMBO_PREFIX = 'combo:';
export const COMBOS_NAME = 'quota-failover-combos.json';
export const COMBOS_VERSION = 1;
/**
 * Comfort hint only. The Host neither refuses a new combo above this count nor
 * truncates the saved file: the panel just nudges the user to tidy up.
 */
export const MAX_COMBOS = 40;
export const MAX_MEMBERS = 24;
export const STRATEGIES = ['fallback', 'round-robin'];
/**
 * Display-only prefix: combos show up next to plain models in the models page, so
 * the name has to say what it is. It lives on the display path only — stored combo
 * names stay bare, and one constant change renames every combo at once.
 */
export const COMBO_NAME_PREFIX = '⚡ ';
export function displayComboName(name) {
  const text = typeof name === 'string' ? name : '';
  const bare = text.startsWith(COMBO_NAME_PREFIX) ? text.slice(COMBO_NAME_PREFIX.length) : text;
  return COMBO_NAME_PREFIX + bare.trim();
}

export function resolveHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

export const combosPath = () => path.join(resolveHome(), COMBOS_NAME);

export function comboModelId(key) {
  return COMBO_PREFIX + comboSlug(key);
}

/** `combo:deepseek-v4-1-flash` → `deepseek-v4-1-flash`; anything else → undefined. */
export function parseComboModelId(model) {
  if (typeof model !== 'string' || !model.startsWith(COMBO_PREFIX)) return undefined;
  const slug = model.slice(COMBO_PREFIX.length).trim();
  return slug.length === 0 ? undefined : slug;
}

function parseMember(value) {
  if (typeof value === 'string') {
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) return undefined;
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
  }
  if (value !== null && typeof value === 'object') {
    if (
      typeof value.provider === 'string' && value.provider.length > 0 &&
      typeof value.model === 'string' && value.model.length > 0
    ) {
      return { provider: value.provider, model: value.model };
    }
  }
  return undefined;
}

const STRATEGY_SET = new Set(STRATEGIES);

/**
 * Coerce whatever sits on disk into the canonical record shape.
 * Invalid combos are dropped, never repaired into something surprising.
 */
export function normalizeCombos(raw) {
  const list = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === 'object' && Array.isArray(raw.combos)
      ? raw.combos
      : [];
  const out = [];
  const seen = new Set();
  for (const row of list) {
    if (row === null || typeof row !== 'object') continue;
    const key = typeof row.key === 'string' && row.key.length > 0
      ? comboSlug(row.key)
      : typeof row.name === 'string'
        ? comboSlug(row.name)
        : '';
    if (key.length === 0) continue;
    const id = COMBO_PREFIX + key;
    if (seen.has(id)) continue;
    const members = [];
    const memberKeys = new Set();
    for (const item of Array.isArray(row.members) ? row.members : []) {
      const member = parseMember(item);
      if (member === undefined) continue;
      if (member.provider === COMBO_PROVIDER || member.model.startsWith(COMBO_PREFIX)) continue;
      if (isAggregateModelId(member.model)) continue;
      const route = `${member.provider}\u0000${member.model}`;
      if (memberKeys.has(route)) continue;
      memberKeys.add(route);
      members.push(member);
      if (members.length >= MAX_MEMBERS) break;
    }
    if (members.length === 0) continue;
    const strategy = STRATEGY_SET.has(row.strategy) ? row.strategy : 'fallback';
    const stickyLimit = Number.isSafeInteger(row.stickyLimit) && row.stickyLimit > 0
      ? Math.min(row.stickyLimit, 20)
      : 1;
    out.push({
      id,
      key,
      name: typeof row.name === 'string' && row.name.trim().length > 0 ? row.name.trim().slice(0, 80) : key,
      strategy,
      stickyLimit,
      enabled: row.enabled !== false,
      // "whitelist" combos only hold routes from the subagent authorisation list;
      // "all" combos hold whatever the host catalog lists.
      scope: row.scope === 'whitelist' ? 'whitelist' : 'all',
      members,
      createdAt: typeof row.createdAt === 'string' ? row.createdAt : undefined,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : undefined,
      vision: row.vision === true,
    });
    seen.add(id);
  }
  return out;
}

/** Read the combos file, mtime-cached. Never throws. */
export function createComboStore({ logger, path: filePath } = {}) {
  const file = () => (typeof filePath === 'function' ? filePath() : combosPath());
  let cache = { mtimeMs: Number.NaN, size: -1, value: undefined };
  const read = () => {
    const target = file();
    let stat;
    try {
      stat = fs.statSync(target);
    } catch {
      cache = { mtimeMs: Number.NaN, size: -1, value: undefined };
      return { file: target, exists: false, updatedAt: undefined, combos: [], raw: undefined };
    }
    if (stat.mtimeMs === cache.mtimeMs && stat.size === cache.size) return cache.value;
    let value;
    try {
      const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
      const combos = normalizeCombos(parsed);
      value = {
        file: target,
        exists: true,
        updatedAt: typeof parsed?.updatedAt === 'string' ? parsed.updatedAt : new Date(stat.mtimeMs).toISOString(),
        combos,
        raw: parsed,
      };
    } catch (error) {
      logger?.warn?.(`dsh-quota-failover: combos file is unreadable, treating it as empty: ${String(error)}`);
      value = { file: target, exists: true, updatedAt: undefined, combos: [], raw: undefined, error: String(error) };
    }
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, value };
    return value;
  };
  const write = (combos) => {
    const target = file();
    const normalized = normalizeCombos(combos);
    const value = {
      version: COMBOS_VERSION,
      updatedAt: new Date().toISOString(),
      combos: normalized,
    };
    const tmp = `${target}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(value, undefined, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
    cache = { mtimeMs: Number.NaN, size: -1, value: undefined };
    return { ...value, file: target, exists: true, combos: normalized };
  };
  return { path: () => file(), read, write };
}

/**
 * The order to try members in for one generation.
 * `fallback` always starts at the head; `round-robin` walks the ring and sticks
 * to one member for `stickyLimit` generations so prompt cache can be reused.
 * The cursor lives in memory only — a restart merely resets the rotation.
 */
export function chainFor(entry, rotation, { stickyLimit } = {}) {
  const members = entry.members.slice();
  if (members.length <= 1 || entry.strategy !== 'round-robin') return members;
  const limit = Math.max(1, Number.isSafeInteger(stickyLimit) ? stickyLimit : entry.stickyLimit);
  let cursor = rotation.get(entry.id);
  if (cursor === undefined || cursor.index >= members.length) {
    cursor = { index: 0, used: 0 };
    rotation.set(entry.id, cursor);
  }
  const rotated = members.slice(cursor.index).concat(members.slice(0, cursor.index));
  cursor.used += 1;
  if (cursor.used >= limit) {
    cursor.index = (cursor.index + 1) % members.length;
    cursor.used = 0;
  }
  return rotated;
}

/** Drop rotation cursors for combos that no longer exist. */
export function pruneRotation(rotation, combos) {
  const live = new Set(combos.map((combo) => combo.id));
  for (const id of [...rotation.keys()]) {
    if (!live.has(id)) rotation.delete(id);
  }
}
