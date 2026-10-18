/**
 * Category classification for cross-provider combos.
 *
 * A "category" is one model family as it appears across providers:
 * `workbuddy/deepseek-v4.1-flash`, `lobsterai/deepseek-v4.1-flash` and
 * `raccoon/sn-deepseek-v4-1-flash` are the same category, so a combo built from
 * that category fails over between providers instead of between model
 * generations.
 *
 * The provider is never part of the key; only the model id's own name is. Model
 * ids are written by hand by each provider, so the normalisation below is
 * deliberately lossy in the safe direction: `v4.1` / `v4-1` merge (same model),
 * while `v4` / `v4.1` stay apart (different model generations).
 */

/** Suffixes a provider adds to say "this is the same model, free tier". */
const FREE_SUFFIX = /-(?:free|contributor|contributor-free|free-contributor)$/;

/** Prefixes that belong to the provider's naming habit, not to the model. */
const NOISE_PREFIXES = ['sn-', 'stealth-', 'free-'];

/** Family names whose spelling differs between providers. */
const FAMILY_NAMES = new Map([
  ['deepseek', 'DeepSeek'],
  ['glm', 'GLM'],
  ['minimax', 'MiniMax'],
  ['kimi', 'Kimi'],
  ['qwen', 'Qwen'],
  ['gpt', 'GPT'],
  ['claude', 'Claude'],
  ['gemini', 'Gemini'],
  ['llama', 'Llama'],
  ['mistral', 'Mistral'],
  ['nemotron', 'Nemotron'],
  ['grok', 'Grok'],
  ['muse', 'Muse'],
  ['spark', 'Spark'],
  ['longcat', 'LongCat'],
  ['dots', 'Dots'],
  ['liquid', 'Liquid'],
  ['poolside', 'Poolside'],
  ['cohere', 'Cohere'],
  ['typhoon', 'Typhoon'],
  ['yi', 'Yi'],
  ['baichuan', 'Baichuan'],
  ['gpt-oss', 'GPT-OSS'],
]);

/** Last path segment of a model id: `vendor/family/model` → `model`. */
export function modelBaseName(modelId) {
  const text = typeof modelId === 'string' ? modelId.trim() : '';
  if (text.length === 0) return '';
  const slash = text.lastIndexOf('/');
  return slash >= 0 ? text.slice(slash + 1) : text;
}

/**
 * Canonical category key for one model id.
 * Empty string when there is nothing usable left.
 */
export function categoryKeyOf(modelId) {
  let key = modelBaseName(modelId).toLowerCase();
  if (key.length === 0) return '';
  key = key.replace(/:/g, '-');
  key = key.replace(/[_\s]+/g, '-');
  key = key.replace(/\./g, '-');
  key = key.replace(/[^a-z0-9-]+/g, '-');
  key = key.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  // Strip the free-tier suffix, repeatedly: `-free-free` is not unheard of.
  for (let guard = 0; guard < 4; guard += 1) {
    const next = key.replace(FREE_SUFFIX, '');
    if (next === key) break;
    key = next;
  }
  for (const prefix of NOISE_PREFIXES) {
    if (key.startsWith(prefix) && key.length > prefix.length) {
      key = key.slice(prefix.length);
      break;
    }
  }
  return key.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * Model ids that are a provider's own routing pool rather than one model.
 * Building a combo out of `auto` would silently mix arbitrary model families.
 */
export function isAggregateModelId(modelId) {
  const key = categoryKeyOf(modelId);
  return key === 'auto' || key === 'free' || key === 'random' || key === 'default';
}

/** `deepseek-v4-1-flash` → `DeepSeek V4.1 Flash`. */
export function prettyFromKey(key) {
  if (typeof key !== 'string' || key.length === 0) return 'Combo';
  const tokens = key.split('-').filter((token) => token.length > 0);
  const words = [];
  let version = [];
  const flushVersion = () => {
    if (version.length === 0) return;
    words.push(version.join('.'));
    version = [];
  };
  for (const token of tokens) {
    const family = FAMILY_NAMES.get(token);
    if (family !== undefined) {
      flushVersion();
      words.push(family);
      continue;
    }
    const versionToken = /^v?(\d+)$/.exec(token);
    if (versionToken !== null) {
      version.push(versionToken[1]);
      continue;
    }
    const wordNumber = /^([a-z]+)(\d+)$/.exec(token);
    if (wordNumber !== null) {
      flushVersion();
      words.push(wordNumber[1][0].toUpperCase() + wordNumber[1].slice(1) + wordNumber[2]);
      continue;
    }
    flushVersion();
    words.push(token[0].toUpperCase() + token.slice(1));
  }
  flushVersion();
  return words.join(' ') || 'Combo';
}

/** Provider-decorated display names → the model name on its own. */
function cleanDisplayName(rawName) {
  if (typeof rawName !== 'string') return '';
  let name = rawName.trim();
  if (name.length === 0) return '';
  name = name.replace(/^(?:公有|公用|私有电脑|私有云|私有|免费|内部|预置|公用免费)\s*/u, '');
  name = name.replace(/\s*[（(][^)）]*[)）]\s*$/u, '');
  name = name.trim();
  // Provider names in this machine's catalog are often Chinese; keep a latin
  // model name when one is left, and let the caller fall back to the key.
  if (/[\u3400-\u9fff]/u.test(name)) return '';
  return name;
}

function displayNameFor(key, members) {
  for (const member of members) {
    const cleaned = cleanDisplayName(member.name);
    if (cleaned.length > 0 && cleaned.length <= 60) return cleaned;
  }
  return prettyFromKey(key);
}

/**
 * Group every listed model into categories.
 *
 * @param {Array<{provider: string, models: Array<{model: string, name?: string}>}>} providers
 * @param {{excludeProviders?: string[]}} [options]
 * @returns {Array<{key: string, name: string, count: number, providers: number,
 *   members: Array<{provider: string, model: string, name: string}>, shared: boolean}>}
 */
export function buildCategories(providers, options = {}) {
  const exclude = new Set(Array.isArray(options.excludeProviders) ? options.excludeProviders : []);
  const groups = new Map();
  for (const provider of Array.isArray(providers) ? providers : []) {
    if (provider === null || typeof provider !== 'object') continue;
    const providerId = typeof provider.provider === 'string' ? provider.provider : '';
    if (providerId.length === 0 || exclude.has(providerId)) continue;
    for (const model of Array.isArray(provider.models) ? provider.models : []) {
      const modelId = typeof model?.model === 'string' ? model.model : '';
      if (modelId.length === 0 || isAggregateModelId(modelId)) continue;
      const key = categoryKeyOf(modelId);
      if (key.length === 0 || key.length > 48) continue;
      let group = groups.get(key);
      if (group === undefined) {
        group = { key, members: [], providerIds: new Set() };
        groups.set(key, group);
      }
      if (group.providerIds.has(providerId)) continue;
      group.members.push({
        provider: providerId,
        model: modelId,
        name: typeof model.name === 'string' ? model.name : '',
      });
      group.providerIds.add(providerId);
    }
  }
  const rows = [];
  for (const group of groups.values()) {
    group.members.sort((left, right) => left.provider.localeCompare(right.provider));
    rows.push({
      key: group.key,
      name: displayNameFor(group.key, group.members),
      count: group.members.length,
      providers: group.providerIds.size,
      members: group.members.map((member) => ({ provider: member.provider, model: member.model, name: member.name })),
      shared: group.providerIds.size > 1,
    });
  }
  rows.sort((left, right) => {
    if (left.shared !== right.shared) return left.shared ? -1 : 1;
    if (left.providers !== right.providers) return right.providers - left.providers;
    if (left.count !== right.count) return right.count - left.count;
    return left.key.localeCompare(right.key);
  });
  return rows;
}

/** ASCII slug used inside a model id (`combo:<slug>`). */
export function comboSlug(key) {
  const slug = String(key ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? 'combo' : slug.slice(0, 48);
}
