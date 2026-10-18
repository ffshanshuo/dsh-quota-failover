/**
 * The combo catalog: saved combos + the live routes they point at.
 *
 * `llm.listModels()` is what the GUI models page consumes, so every combo is
 * advertised there as one model of the plugin's own provider. Capacity is the
 * intersection of the members' capacities — a combo must never promise more
 * context or output than its weakest member can serve.
 */
import { buildCategories } from './classify.js';
import { COMBOS_VERSION, COMBO_PROVIDER, COMBO_PREFIX, displayComboName } from './combos.js';

const MEMBER_INFO_TTL_MS = 60_000;
const FALLBACK_CONTEXT = 131_072;
const FALLBACK_OUTPUT = 8_192;

const reference = (combo) => `${COMBO_PROVIDER}/${combo.id}`;

function uniqueEfforts(infos) {
  const all = infos
    .map((info) => info?.reasoning)
    .filter((reasoning) => reasoning !== undefined && Array.isArray(reasoning.efforts));
  if (all.length !== infos.length) return undefined;
  const first = all[0];
  if (first.efforts.length === 0) return undefined;
  const byId = new Map();
  for (const reasoning of all) {
    for (const effort of reasoning.efforts) {
      if (typeof effort?.id !== 'string' || effort.id.length === 0) return undefined;
      if (!byId.has(effort.id)) byId.set(effort.id, effort);
    }
  }
  const ids = [...byId.keys()];
  const efforts = ids
    .map((id) => byId.get(id))
    .filter((effort) => all.every((reasoning) => reasoning.efforts.some((candidate) => candidate.id === effort.id)));
  if (efforts.length === 0) return undefined;
  const defaults = all.map((reasoning) => reasoning.defaultEffort).filter((id) => typeof id === 'string');
  const defaultEffort = defaults.length === all.length && efforts.some((effort) => effort.id === defaults[0])
    ? defaults[0]
    : efforts[0].id;
  return { efforts, defaultEffort };
}

export function createComboCatalog({ getLlm, store, logger }) {
  const infoCache = new Map();

  const read = () => {
    const snapshot = store.read();
    const byId = new Map(snapshot.combos.map((combo) => [combo.id, combo]));
    return { ...snapshot, byId };
  };

  const llm = () => {
    try {
      const service = getLlm();
      return service === undefined || service === null ? undefined : service;
    } catch {
      return undefined;
    }
  };

  const memberInfo = async (member, signal) => {
    const key = `${member.provider}\u0000${member.model}`;
    const hit = infoCache.get(key);
    if (hit !== undefined && Date.now() - hit.at < MEMBER_INFO_TTL_MS) return hit.value;
    const service = llm();
    if (service === undefined || typeof service.resolveModelInfo !== 'function') return undefined;
    try {
      const info = await service.resolveModelInfo(member.provider, member.model, signal);
      infoCache.set(key, { at: Date.now(), value: info });
      return info;
    } catch (error) {
      logger?.warn?.(`dsh-quota-failover: combo member ${member.provider}/${member.model} is not resolvable: ${String(error?.message ?? error)}`);
      infoCache.set(key, { at: Date.now(), value: undefined });
      return undefined;
    }
  };

  /** Resolve one exact combo model, including the capacity it may advertise. */
  const resolveModel = async (model, signal) => {
    const key = model.startsWith(COMBO_PREFIX) ? model.slice(COMBO_PREFIX.length) : '';
    const snapshot = read();
    const combo = snapshot.byId.get(COMBO_PREFIX + key);
    if (combo === undefined) {
      const error = new Error(`failover combos: no combo "${model}" is configured (设置 → 额度转移 → 组合)`);
      error.code = 'UNKNOWN_MODEL';
      throw error;
    }
    const infos = [];
    for (const member of combo.members) {
      const info = await memberInfo(member, signal);
      if (info !== undefined) infos.push(info);
    }
    const contexts = infos.map((info) => info.context?.contextWindow).filter((value) => Number.isFinite(value) && value > 0);
    const outputs = infos.map((info) => info.defaultMaxTokens).filter((value) => Number.isFinite(value) && value > 0);
    const contextWindow = contexts.length > 0 ? Math.min(...contexts) : FALLBACK_CONTEXT;
    const defaultMaxTokens = outputs.length === infos.length && outputs.length > 0 ? Math.min(...outputs) : FALLBACK_OUTPUT;
    const vision = infos.length > 0 && infos.length === combo.members.length
      && infos.every((info) => Array.isArray(info.inputModalities) && info.inputModalities.includes('image'));
    const reasoning = infos.length === combo.members.length ? uniqueEfforts(infos) : undefined;
    return {
      provider: COMBO_PROVIDER,
      id: combo.id,
      name: displayComboName(combo.name),
      description: `跨 ${combo.members.length} 个 provider / ${new Set(combo.members.map((member) => member.provider)).size} 个来源的同类模型组合（${combo.strategy === 'round-robin' ? '轮转' : '顺序'}降级）。`,
      inputModalities: vision ? ['text', 'image'] : ['text'],
      context: { contextWindow },
      defaultMaxTokens,
      ...(reasoning === undefined ? {} : { reasoning }),
    };
  };

  /** `LlmAdapter.listModels(provider)` — what the models page shows. */
  const listModels = () => {
    const snapshot = read();
    return snapshot.combos.map((combo) => ({
      provider: COMBO_PROVIDER,
      id: combo.id,
      name: displayComboName(combo.name),
      description: `${combo.members.length} 个成员 · ${combo.strategy === 'round-robin' ? `轮转(${combo.stickyLimit})` : '顺序'}${combo.enabled === false ? ' · 已停用' : ''}`,
      inputModalities: combo.vision ? ['text', 'image'] : ['text'],
    }));
  };

  /** Combos the adapter may actually try, newest config snapshot included. */
  const activeCombos = () => read().combos.filter((combo) => combo.enabled !== false);

  const find = (model) => read().byId.get(model);

  /** Category rows plus whether a combo already exists for the category. */
  const categories = (inventory) => {
    const snapshot = read();
    const combosByKey = new Map(snapshot.combos.map((combo) => [combo.key, combo]));
    const rows = buildCategoryRows(inventory);
    return rows.map((row) => {
      const combo = combosByKey.get(row.key);
      return {
        ...row,
        comboId: combo?.id,
        selected: combo !== undefined,
        enabled: combo === undefined ? undefined : combo.enabled !== false,
      };
    });
  };

  const buildCategoryRows = (inventory) => {
    // Imported lazily to keep this module's surface small and to let tests stub it.
    return inventoryCategories(inventory);
  };

  /** Does one member declare this exact reasoning effort id? */
  const supportsReasoningEffort = async (member, effort, signal) => {
    if (typeof effort !== 'string' || effort.length === 0) return false;
    const info = await memberInfo(member, signal);
    const efforts = info?.reasoning?.efforts;
    return Array.isArray(efforts) && efforts.some((item) => item?.id === effort);
  };

  return {
    version: COMBOS_VERSION,
    provider: COMBO_PROVIDER,
    reference,
    read,
    path: () => store.path(),
    resolveModel,
    listModels,
    activeCombos,
    find,
    categories,
    supportsReasoningEffort,
    invalidate: () => infoCache.clear(),
  };
}

/* Kept outside the factory for testability. */
function inventoryCategories(inventory) {
  const providers = Array.isArray(inventory?.providers) ? inventory.providers.map((row) => ({
    provider: row.provider,
    models: Array.isArray(row.models) ? row.models : [],
  })) : [];
  return buildCategories(providers, { excludeProviders: [COMBO_PROVIDER] });
}
