/**
 * dsh-quota-failover — quota-wall resilience for the DeepSeek Harness.
 *
 * ## The problem
 *
 * A provider request that dies on a quota wall (`QUOTA` / `ACCOUNT_QUOTA` / a
 * terminal 429 / a dead credential) is a *terminal* failure for the agent loop.
 * `@deepseek-ai/dsh-llm-retry` will not touch it on purpose
 * (`isTerminalRateLimitError` — "subscription/account limits, not transient
 * throttles"), so the turn ends, the teammate goes `inactive`, and the user's
 * task stalls until someone notices.
 *
 * ## The seam
 *
 * The agent loop runs a pair of documented waterfalls around every model
 * request:
 *
 *   step(decision) {
 *     while (true) {
 *       const { config } = await this.prepareRequest(turn, step, signal); // -> agent/request
 *       ...
 *       if (finish.kind === 'error') {
 *         const action = await this.dispatch.waterfall('agent/request-error', { ... });
 *         if (action?.kind !== 'retry') throw new LlmError(...);  // terminal
 *         continue;                                                // -> prepareRequest again
 *       }
 *     }
 *   }
 *
 * A listener on `agent/request-error` that returns `{ kind: 'retry' }` sends the
 * loop back around; a listener on `agent/request` can rewrite provider/model for
 * that next attempt. This plugin registers both on the *shared* dispatcher, so
 * the Lead, teammates, `subagent`, `subagent_fork` and `workflow` children all
 * inherit whatever mode is configured.
 *
 * ## Modes (the whole point of v2)
 *
 * `notify` (default) — never touches routing. A subagent's model is the agent's
 * own choice; hijacking it would make the agent's decisions unpredictable. All
 * this mode does is *tell the agent what happened*: it injects an identified
 * user-role message into the failed agent's inbox (`agent.inject`, which does
 * NOT wake a turn, so it cannot start a failure loop) and records the event.
 *
 * `auto` — opt-in, the v1 behaviour: silently continue on the next candidate
 * route. When `respectAllowlist` is on (default) the candidate must be listed in
 * the profile's `subagent-model-selection-settings.allowedModels`, i.e. the
 * operator's own whitelist still has the last word.
 *
 * Everything is live-editable from the "额度转移" settings panel (see
 * `lib/client.js`); the panel writes `$DSH_HOME/quota-failover.config.json` and
 * this file re-reads it on every failure, so no restart is needed.
 *
 * @module dsh-quota-failover
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createComboAdapter } from './combo/adapter.js';
import { createComboCatalog } from './combo/catalog.js';
import { buildCategories, comboSlug, prettyFromKey } from './combo/classify.js';
import {
  COMBO_PROVIDER,
  MAX_COMBOS,
  MAX_MEMBERS,
  createComboStore,
  combosPath,
  displayComboName,
  normalizeCombos,
  pruneRotation,
} from './combo/combos.js';

export const name = 'dsh-quota-failover';

export const version = '0.3.6-b13';

/** Bumped on every code change so the panel can prove which build is live. */
export const PLUGIN_BUILD = 'b13-reasoning-passthrough';

const CONFIG_NAME = 'quota-failover.config.json';
const JOURNAL_NAME = 'quota-failover.json';
const RESULTS_NAME = 'quota-failover-probe.json';
const ROUTE_PREFIX = '/_quota-failover';

/** Failure codes that mean "this route cannot serve you again today". */
const HARD_CODES = new Set([
  'QUOTA',
  'ACCOUNT_QUOTA',
  'INSUFFICIENT_QUOTA',
  'BILLING',
  'PAYMENT_REQUIRED',
  'MISSING_CREDENTIAL',
  'AUTH',
]);

/** Failure codes worth surviving once the provider's own retry budget is spent. */
const SOFT_CODES = new Set([
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
  'EMPTY_RESPONSE_CODE',
  'STREAM_CUT',
  'NO_ADAPTER',
  'MODEL_NOT_FOUND',
  'NOT_FOUND',
  'UNAVAILABLE',
  // A route whose adapter cannot accept the prepared config (model defaults,
  // request shape) is a per-route fault: walk past it instead of ending a turn.
  'INVALID_PREPARED_CALL',
  'INVALID_CATALOG',
]);

/**
 * Providers word a quota wall a dozen ways and not all of them set a code we
 * can trust, so the message is consulted as well. Text rules run after the
 * code rules, mirroring `our-free-model`'s own classifier.
 */
const QUOTA_TEXT =
  /insufficient[_ ]?quota|quota (?:exceeded|exhausted|reached)|out of budget|available balance|insufficient balance|balance is (?:zero|empty)|usage limit|monthly limit|daily limit|free usage limit|GoUsageLimitError|FreeUsageLimitError|no credit|credit balance|billing|余额|额度|欠费/i;

/**
 * A route refusal is not a quota wall and not a transient failure: the request
 * is well formed, but *this provider/model* will never serve *this account*.
 * The classic shape is a 400 `INVALID_REQUEST` whose text names the model and
 * the account tier ("model [gpt-6-astra] is not allowed for user type
 * [personal_free_user]").
 *
 * Deliberately narrow: a bare `INVALID_REQUEST` must NOT qualify, because a
 * genuinely malformed request would burn every candidate for nothing. The text
 * has to admit that the *model or account* is the problem.
 */
const ROUTE_REFUSAL_TEXT =
  /model\s*\[[^\]]+\]\s*is not allowed|is not allowed for user type|model .{0,80}not (?:supported|available|allowed)|not (?:supported|available) (?:for|in) (?:your|this) (?:account|plan|region|country)|unsupported (?:model|account type)|no access to (?:this|the) model|该模型|暂不支持该模型|账号类型/i;

export const DEFAULTS = Object.freeze({
  enabled: true,
  /** 'notify' (tell the agent) or 'auto' (switch route and continue). */
  mode: 'notify',
  /** Inject a notice into the agent that failed. */
  notify: true,
  /** In auto mode, never leave the profile's subagent model whitelist. */
  respectAllowlist: true,
  /**
   * Ordered failover ladder. Every entry was probed live on this machine with a
   * real one-shot request; the free chain sits last because it is the slowest
   * but also the one that never bills.
   */
  candidates: Object.freeze([
    'workbuddy/deepseek-v4.1-flash',
    'lobsterai/deepseek-flash',
    'minimax/MiniMax-M3',
    'deepseek-official/deepseek-flash',
    'our-free-model/combo:free-ladder',
  ]),
  /** How long a session stays pinned to a failover route before retrying the original. */
  stickyMs: 30 * 60 * 1000,
  /** Record a bounded event journal next to the DSH home for observability. */
  journal: true,
  maxSessions: 512,
});

const MODES = new Set(['notify', 'auto']);

/**
 * The row's config schema, declared so a mistyped `config:` block fails loudly
 * at activation instead of being silently repaired at run time. Declaring it
 * is a *diagnosis* upgrade only: `normalizeOptions` below stays the runtime
 * truth, because schemastery passes unknown keys through and accepts NaN for
 * `z.number().min(0)`.
 *
 * Loaded through `createRequire` rather than a static import on purpose. This
 * plugin's entire value is being present when a route dies; a missing or
 * unresolvable schema dependency must never be the reason it stops loading.
 */
const Config = (() => {
  try {
    const require = createRequire(import.meta.url);
    const schemastery = require('@deepseek-ai/schemastery');
    const z = schemastery?.default ?? schemastery;
    // schemastery's default export is a callable namespace (`typeof z === 'function'`),
    // not a plain object, so both shapes have to pass this guard.
    const shape = typeof z;
    if ((shape !== 'function' && shape !== 'object') || z === null || typeof z.object !== 'function') {
      return undefined;
    }
    return z.object({
      enabled: z.boolean().default(true),
      mode: z.union(['notify', 'auto']).default(DEFAULTS.mode),
      notify: z.boolean().default(true),
      respectAllowlist: z.boolean().default(true),
      candidates: z
        .array(
          z.union([
            z.string(),
            z.object({ provider: z.string().required(), model: z.string().required() }),
          ]),
        )
        .default([...DEFAULTS.candidates]),
      stickyMs: z.number().min(0).default(DEFAULTS.stickyMs),
      journal: z.boolean().default(true),
      maxSessions: z.natural().min(1).default(DEFAULTS.maxSessions),
    });
  } catch {
    return undefined;
  }
})();

export { Config };

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function routeKey(provider, model) {
  return `${provider}\u0000${model}`;
}

function routeLabel(route) {
  if (route === undefined || route === null) return '?';
  return `${route.provider ?? '?'}/${route.model ?? '?'}`;
}

function parseCandidate(value) {
  if (typeof value === 'string') {
    const slash = value.indexOf('/');
    if (slash <= 0 || slash === value.length - 1) return undefined;
    return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
  }
  if (value !== null && typeof value === 'object') {
    if (typeof value.provider === 'string' && value.provider.length > 0 && typeof value.model === 'string' && value.model.length > 0) {
      return { provider: value.provider, model: value.model };
    }
  }
  return undefined;
}

function normalizeCandidates(list) {
  const source = Array.isArray(list) && list.length > 0 ? list : DEFAULTS.candidates;
  const out = [];
  const seen = new Set();
  for (const item of source) {
    const parsed = parseCandidate(item);
    if (parsed === undefined) continue;
    const key = routeKey(parsed.provider, parsed.model);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parsed);
  }
  return out;
}

function normalizeOptions(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {};
  const stickyMs = typeof config.stickyMs === 'number' && Number.isFinite(config.stickyMs) && config.stickyMs >= 0
    ? config.stickyMs
    : DEFAULTS.stickyMs;
  return {
    enabled: config.enabled !== false,
    mode: MODES.has(config.mode) ? config.mode : DEFAULTS.mode,
    notify: config.notify !== false,
    respectAllowlist: config.respectAllowlist !== false,
    candidates: normalizeCandidates(config.candidates),
    stickyMs,
    journal: config.journal !== false,
    maxSessions: Number.isSafeInteger(config.maxSessions) && config.maxSessions > 0 ? config.maxSessions : DEFAULTS.maxSessions,
  };
}

function resolveHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return path.join(os.homedir(), '.dsh');
}

const configPath = () => path.join(resolveHome(), CONFIG_NAME);
const journalPath = () => path.join(resolveHome(), JOURNAL_NAME);
const resultsPath = () => path.join(resolveHome(), RESULTS_NAME);
const profilePatchPath = () => path.join(resolveHome(), 'profiles', 'desktop', 'cordis.patch.yml');

/* ------------------------------------------------------------------ */
/* live config file (written by the settings panel)                    */
/* ------------------------------------------------------------------ */

/** Cache keyed by mtime so a failure costs one `statSync`, not a parse. */
let configCache = { mtimeMs: Number.NaN, value: undefined };

function readConfigFile() {
  const file = configPath();
  try {
    const stat = fs.statSync(file);
    if (configCache.value !== undefined && configCache.mtimeMs === stat.mtimeMs) return configCache.value;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const value = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    configCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    // Absent or unreadable: the row's own config stays authoritative.
    return {};
  }
}

function writeConfigFile(next) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, undefined, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
  configCache = { mtimeMs: Number.NaN, value: undefined };
  return next;
}

/** File overrides the row; anything absent falls back to the row/defaults. */
function effectiveOptions(base) {
  const file = readConfigFile();
  return normalizeOptions({
    enabled: file.enabled ?? base.enabled,
    mode: file.mode ?? base.mode,
    notify: file.notify ?? base.notify,
    respectAllowlist: file.respectAllowlist ?? base.respectAllowlist,
    candidates: file.candidates ?? base.candidates,
    stickyMs: file.stickyMs ?? base.stickyMs,
    journal: file.journal ?? base.journal,
    maxSessions: file.maxSessions ?? base.maxSessions,
  });
}

/* ------------------------------------------------------------------ */
/* subagent model whitelist (read-only mirror of the profile patch)     */
/* ------------------------------------------------------------------ */

/**
 * Parses `subagent-model-selection-settings.allowedModels` out of the profile
 * patch. It is YAML, but a *regular* block, so a line scanner is enough and
 * avoids pulling a YAML parser into a plugin that must never fail to load.
 *
 * Returns `{ enabled, routes: [{provider, model}], providers: [{id, count}] }`
 * or `undefined` when the block is absent (whitelist unconstrained).
 */
let policyCache = { mtimeMs: Number.NaN, value: undefined };

function readAllowlist() {
  const file = profilePatchPath();
  try {
    const stat = fs.statSync(file);
    if (policyCache.value !== undefined && policyCache.mtimeMs === stat.mtimeMs) return policyCache.value;
    const text = fs.readFileSync(file, 'utf8');
    const value = parseAllowlist(text);
    policyCache = { mtimeMs: stat.mtimeMs, value };
    return value;
  } catch {
    return undefined;
  }
}

function parseAllowlist(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let indent = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*-\s+id:\s*subagent-model-selection-settings\s*$/.test(lines[i])) {
      start = i;
      indent = lines[i].length - lines[i].replace(/^\s*/, '').length;
      break;
    }
  }
  if (start === -1) return undefined;
  let enabled;
  const routes = [];
  let inModels = false;
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
    const lineIndent = line.length - line.replace(/^\s*/, '').length;
    if (lineIndent <= indent && /^\s*-\s+/.test(line)) break; // next loader row
    const enabledMatch = /^\s*enabled:\s*(true|false)\s*$/.exec(line);
    if (enabledMatch !== null && inModels === false) {
      enabled = enabledMatch[1] === 'true';
      continue;
    }
    if (/^\s*allowedModels:\s*$/.test(line)) {
      inModels = true;
      continue;
    }
    if (/\S/.test(line) && /^\s*allowedModels:\s*\[/.test(line)) {
      // Inline list form is not used by this profile; treat as unknown.
      return { enabled: enabled !== false, routes: [], providers: [] };
    }
    if (inModels === false) continue;
    const providerMatch = /^\s*-\s+provider:\s*(.+?)\s*$/.exec(line);
    if (providerMatch !== null) {
      const provider = providerMatch[1];
      let model;
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = lines[j];
        if (next.trim().length === 0) continue;
        const modelMatch = /^\s*model:\s*(.+?)\s*$/.exec(next);
        if (modelMatch !== null) {
          model = modelMatch[1];
          break;
        }
        if (/^\s*-\s+provider:/.test(next)) break;
      }
      if (model !== undefined) {
        const trimmed = model.replace(/^['"]|['"]$/g, '');
        routes.push({ provider, model: trimmed });
      }
      continue;
    }
  }
  const counts = new Map();
  for (const route of routes) counts.set(route.provider, (counts.get(route.provider) ?? 0) + 1);
  const providers = [...counts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((left, right) => right.count - left.count || left.id.localeCompare(right.id));
  return { enabled: enabled !== false, routes, providers };
}

/* ------------------------------------------------------------------ */
/* probe results store                                                 */
/* ------------------------------------------------------------------ */

/**
 * The availability sweep is expensive enough (one real request per route) that
 * its outcome must outlive the panel tab that triggered it. Two readers share
 * this store: the settings panel renders it, and the `route_availability` tool
 * hands it to whichever agent asks — a teammate choosing a model can look at the
 * same evidence the user sees.
 *
 * Shape: `{ version, testedAt, lastRun: { at, scope, total, done, ok, cancelled? },
 *           routes: [{ provider, model, ok, at, ms, kind?, code?, message?, sample? }] }`
 * Newer results replace older ones per route; untouched routes keep their own
 * `at`, so "last tested" is honest per row as well as in aggregate.
 */
function readResultsFile() {
  try {
    const parsed = JSON.parse(fs.readFileSync(resultsPath(), 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.routes)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function writeResultsFile(value) {
  const file = resultsPath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* a leftover tmp file is not worth a second failure */
    }
  }
}

/** Fold one finished job into the store; returns the stored value. */
function mergeProbeResults(job) {
  const previous = readResultsFile();
  const byRoute = new Map();
  for (const row of previous?.routes ?? []) {
    if (row === null || typeof row !== 'object') continue;
    if (typeof row.provider !== 'string' || typeof row.model !== 'string') continue;
    byRoute.set(routeKey(row.provider, row.model), row);
  }
  const at = typeof job.finishedAt === 'string' ? job.finishedAt : new Date().toISOString();
  for (const row of job.results) {
    if (row === null || typeof row !== 'object') continue;
    if (typeof row.provider !== 'string' || typeof row.model !== 'string') continue;
    byRoute.set(routeKey(row.provider, row.model), {
      provider: row.provider,
      model: row.model,
      ok: row.ok === true,
      at,
      ms: Number.isFinite(row.ms) ? row.ms : 0,
      source: 'probe',
      ...(row.ok === true
        ? {
            ...(typeof row.sample === 'string' && row.sample.length > 0 ? { sample: row.sample } : {}),
            ...(typeof row.finish === 'string' ? { finish: row.finish } : {}),
          }
        : {
            kind: typeof row.kind === 'string' ? row.kind : 'other',
            code: typeof row.code === 'string' ? row.code : 'no code',
            message: typeof row.message === 'string' ? row.message : '',
          }),
    });
  }
  const routes = [...byRoute.values()].sort(
    (left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
  );
  const ok = routes.filter((row) => row.ok === true).length;
  const value = {
    version: 1,
    testedAt: at,
    ...(typeof previous?.observedAt === 'string' ? { observedAt: previous.observedAt } : {}),
    lastRun: {
      at,
      scope: typeof job.scope === 'string' ? job.scope : 'unknown',
      total: job.total,
      done: job.done,
      ok: job.results.filter((row) => row.ok === true).length,
      ...(job.cancelled === true ? { cancelled: true } : {}),
    },
    routes,
  };
  writeResultsFile(value);
  return value;
}

/* ------------------------------------------------------------------ */
/* journal                                                             */
/* ------------------------------------------------------------------ */

/**
 * A small, bounded journal on disk. It exists because a failover that succeeds
 * is by design invisible: nothing in the transcript says the answer came from a
 * different provider. Without this there is no way to tell an armed plugin from
 * an absent one.
 */
function createJournal(ctx, options) {
  if (!options.journal) {
    return { record: () => {}, file: journalPath() };
  }
  const file = journalPath();
  const state = {
    armedAt: new Date().toISOString(),
    pid: process.pid,
    version,
    mode: options.mode,
    candidates: options.candidates,
    events: [],
  };
  const write = () => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state, undefined, 2), { mode: 0o600 });
    } catch (error) {
      ctx.logger?.warn?.(`dsh-quota-failover: journal write failed: ${String(error)}`);
    }
  };
  const record = (event) => {
    state.events.push({ at: new Date().toISOString(), ...event });
    while (state.events.length > 64) state.events.shift();
    write();
  };
  write();
  return { record, file };
}

function readJournalFile() {
  try {
    return JSON.parse(fs.readFileSync(journalPath(), 'utf8'));
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ */
/* failure classification                                              */
/* ------------------------------------------------------------------ */

function isQuotaWall(failure) {
  if (failure === null || typeof failure !== 'object') return false;
  const code = typeof failure.code === 'string' ? failure.code : '';
  if (HARD_CODES.has(code)) return true;
  const message = typeof failure.message === 'string' ? failure.message : '';
  return QUOTA_TEXT.test(message);
}

function isRouteRefusal(failure) {
  if (failure === null || typeof failure !== 'object') return false;
  const message = typeof failure.message === 'string' ? failure.message : '';
  if (!ROUTE_REFUSAL_TEXT.test(message)) return false;
  const code = typeof failure.code === 'string' ? failure.code : '';
  // Any code is acceptable once the text names the route as the cause; the text
  // is the discriminating signal here, not the status.
  return code !== '' || message.length > 0;
}

function isSoftFailure(failure) {
  if (failure === null || typeof failure !== 'object') return false;
  const code = typeof failure.code === 'string' ? failure.code : '';
  if (SOFT_CODES.has(code)) return true;
  if (isQuotaWall(failure)) return true;
  return isRouteRefusal(failure);
}

function pickCandidate(candidates, tried) {
  for (const candidate of candidates) {
    if (tried.has(routeKey(candidate.provider, candidate.model))) continue;
    return candidate;
  }
  return undefined;
}

/* ------------------------------------------------------------------ */
/* the notice handed to the agent                                      */
/* ------------------------------------------------------------------ */

const failureHeader = (route, failure, kind) => {
  const code = typeof failure?.code === 'string' && failure.code.length > 0 ? failure.code : 'no code';
  const detail = typeof failure?.message === 'string' ? failure.message.trim().slice(0, 400) : '';
  const lines = [
    `- 路由: ${routeLabel(route)}`,
    `- 类别: ${kind}`,
    `- 错误码: ${code}`,
  ];
  if (detail.length > 0) lines.push(`- 原始信息: ${detail}`);
  return lines;
};

function buildNotice({ route, failure, kind, tried, candidates }) {
  const lines = [
    '[quota-failover] 上一次模型请求被拒绝，这一轮已终止。这是**模型路由层面**的失败，不是你写错了输出或工具调用。',
    ...failureHeader(route, failure, kind),
  ];
  if (tried.length > 0) lines.push(`- 本轮已尝试: ${tried.join(', ')}`);
  if (candidates.length > 0) lines.push(`- 可用候选路由: ${candidates.join(', ')}`);
  lines.push(
    '',
    '下一步怎么做：',
    '1. 先向用户说明当前受阻原因 + 你已经完成的进度（哪些文件改了、哪些还没做）。',
    '2. 不要重复调用同一条已耗尽额度/不被该账号允许的路由。',
    '3. 用户切换模型（或授权自动切换）后，在新的一轮里接着做没完成的部分。',
  );
  return lines.join('\n');
}

/**
 * The note for the agent that *chose* the model — normally the delegating parent.
 *
 * This is the whole point of notify mode: a route can die for reasons that have
 * nothing to do with the task, but which route to use is a decision the agent
 * made, and only that agent knows whether the task needed what the dead model
 * provided (video, images, a long context, a particular tool). Answering for it
 * would be guessing; telling it is the honest option.
 */
function buildDelegatorNotice({ route, failure, kind, tried, candidates, childSessionId }) {
  const lines = [
    '[quota-failover] 你派发的子智能体模型请求被拒绝，它这一轮已终止（任务本身没有失败，是路由层面的失败）。',
    `- 子会话: ${childSessionId ?? '(unknown)'}`,
    ...failureHeader(route, failure, kind),
  ];
  if (tried.length > 0) lines.push(`- 它本轮已尝试: ${tried.join(', ')}`);
  if (candidates.length > 0) lines.push(`- 本机可用候选路由: ${candidates.join(', ')}`);
  lines.push(
    '',
    '这是给你（做模型选择的这一方）的信息，请据此自己决定，不要盲目重试：',
    '1. 先判断这个任务是否依赖刚才那个模型的特有能力（视频/图像输入、超长上下文、特定工具或推理强度）。',
    '2. 若依赖，换模型时必须挑一个仍然具备该能力的路由；否则换了也只会失败一次，等于白烧一轮。',
    '3. 若不依赖，可以把任务改派给一个可用的路由重做，或先向用户报告受阻原因与已完成进度、请用户定夺。',
    '4. 不要在同一路由上重试：它对当前账号/额度已经不可用。',
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* host plugin                                                         */
/* ------------------------------------------------------------------ */

export function apply(ctx, config) {
  const base = normalizeOptions(config);
  const initial = effectiveOptions(base);
  const journal = createJournal(ctx, initial);

  /**
   * Per-session bookkeeping.
   *   turn     — the turn `tried` belongs to; a new turn resets the budget
   *   tried    — routes already burned in this turn, so the ladder advances
   *   pending  — the route the next `agent/request` must use (auto mode only)
   *   notified — failure fingerprints already reported, so one outage does not
   *              produce a notice per retry
   *
   * `pending` deliberately survives the turn boundary: once a provider is
   * quota-dead, re-dialing it at the top of every turn is exactly the stall we
   * are removing. `stickyMs` bounds that.
   */
  const sessions = new Map();

  const stateFor = (sessionId, turn, maxSessions) => {
    let entry = sessions.get(sessionId);
    if (entry === undefined) {
      if (sessions.size >= maxSessions) {
        const oldest = sessions.keys().next();
        if (!oldest.done) sessions.delete(oldest.value);
      }
      entry = { turn, tried: new Set(), pending: undefined, pendingAt: 0, notified: new Map() };
      sessions.set(sessionId, entry);
      return entry;
    }
    if (entry.turn !== turn) {
      entry.turn = turn;
      entry.tried = new Set();
    }
    return entry;
  };

  const currentRouteOf = (agent) => {
    try {
      const header = agent?.session?.requestHeader?.();
      const headerConfig = header?.config;
      if (headerConfig !== undefined && typeof headerConfig.provider === 'string' && typeof headerConfig.model === 'string') {
        return { provider: headerConfig.provider, model: headerConfig.model };
      }
    } catch {
      /* a session that cannot answer this is simply treated as route-less */
    }
    return undefined;
  };

  /**
   * Rewrite the route for the retry (auto mode only). Registered `prepend` so
   * this listener is outermost in the waterfall: it runs `next()` first, which
   * lets the harness's own model-selection listener and every other contributor
   * settle, and then has the final word.
   */
  const disposeRequest = ctx.on('agent/request', async ({ agent }, next) => {
    const resolved = await next();
    if (effectiveOptions(base).mode !== 'auto') return resolved;
    const sessionId = agent?.session?.id;
    if (sessionId === undefined) return resolved;
    const entry = sessions.get(sessionId);
    if (entry === undefined || entry.pending === undefined) return resolved;
    if (initial.stickyMs > 0 && Date.now() - entry.pendingAt > initial.stickyMs) {
      entry.pending = undefined;
      journal.record({ kind: 'expired', session: sessionId });
      return resolved;
    }
    const target = entry.pending;
    if (resolved.provider === target.provider && resolved.model === target.model) return resolved;
    // The previous route's reasoning effort is meaningless on the new one, and
    // forwarding it would either be rejected or silently clamp the new model.
    // Dropping it hands the decision to the new route's own default, exactly as
    // the harness's model-selection listener does.
    const { reasoningEffort: _inherited, ...rest } = resolved;
    return { ...rest, provider: target.provider, model: target.model };
  }, { prepend: true });

  /**
   * Tell the agent what happened — without waking anything and without touching
   * the inbox.
   *
   * Two earlier attempts are recorded here because both are wrong:
   *  - `agent.inject()` targets `next-step`; the turn is already terminal, so the
   *    entry is dropped (measured: `outcome: "canceled"`).
   *  - queueing at `next-turn` looks right but revived short-lived children: a
   *    queued message makes the agent start another turn, that turn hits the same
   *    dead route, and the surrounding `workflow` run aborts with
   *    "workflow run was cancelled". Requirement 4 is "do not disturb", so an
   *    inbox write is out.
   *
   * Appending a `user/message` to the session surface is the native way to leave a
   * note in history (it is the same append the harness uses to commit delivered
   * input): the note is in context for whoever continues this agent, and nothing
   * is woken.
   */
  const notifyAgent = (agent, text) => {
    try {
      const session = agent?.session;
      if (typeof session?.append !== 'function') return false;
      session.append(
        'user/message',
        {
          role: 'user',
          id: `quota-failover-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
          content: [{ type: 'text', text }],
          source: { kind: 'dsh-quota-failover' },
        },
        { surfaceOp: 'append' },
      );
      return true;
    } catch (error) {
      ctx.logger?.warn?.(`dsh-quota-failover: could not notify the agent: ${String(error)}`);
      return false;
    }
  };

  /**
   * The agent that delegated to this one — i.e. the agent that made the model
   * choice in the first place.
   *
   * Uses the registry's runtime ownership relation (`ctx.agents.isOwnedBy`)
   * rather than durable session lineage: a resumed session can outlive the
   * process that created it, while this relation cannot claim a parent that is
   * not live right now. Scanned only when a failure actually happens.
   */
  const delegatorOf = (agent) => {
    if (agent === undefined || agent === null) return undefined;
    const id = typeof agent.id === 'string' ? agent.id : undefined;
    if (id === undefined) return undefined;
    let registry;
    try {
      registry = ctx.get('agents');
    } catch {
      return undefined;
    }
    if (registry === undefined || registry === null) return undefined;
    let live;
    try {
      live = registry.list();
    } catch {
      return undefined;
    }
    if (!Array.isArray(live)) return undefined;
    for (const candidate of live) {
      if (candidate === undefined || candidate === null || candidate === agent) continue;
      if (typeof candidate.id !== 'string' || candidate.id === id) continue;
      try {
        if (registry.isOwnedBy(id, candidate) === true) return candidate;
      } catch {
        /* an ownership query that throws simply does not match */
      }
    }
    return undefined;
  };

  /**
   * Deliver the decision note to the delegating agent.
   *
   * Two channels, chosen by whether that agent still has a step to take:
   *
   *  - running (the normal case: it is the one waiting on the subagent's tool
   *    result, so the failure itself drives it into another step) → `inject()`,
   *    which lands model-facing context in the next admitted step without waking
   *    anything. That is exactly "tell the decider, do not restart anything".
   *  - idle (its turn is over — e.g. a teammate's root went idle while the
   *    teammate ran on its own) → `inject()` would sit in the inbox forever, so
   *    the note is appended to that session's history instead. Nobody is woken;
   *    the note is simply in context the next time that agent runs.
   */
  const notifyDelegator = (delegator, text) => {
    if (delegator === undefined || delegator === null) return false;
    if (delegator.status === 'idle') return notifyAgent(delegator, text);
    try {
      if (typeof delegator.inject === 'function') {
        delegator.inject({ content: [{ type: 'text', text }], source: { kind: 'dsh-quota-failover' } });
        return true;
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-quota-failover: could not inject into the delegator: ${String(error)}`);
    }
    return notifyAgent(delegator, text);
  };

  const handle = (payload, reason) => {
    const failure = payload?.failure;
    if (!failure) return undefined;
    if (payload?.signal?.aborted === true) return undefined;
    const options = effectiveOptions(base);
    if (!options.enabled) return undefined;

    const agent = payload?.agent;
    const sessionId = agent?.session?.id ?? '(unknown)';
    const turn = payload?.turn;
    const entry = stateFor(sessionId, turn, options.maxSessions);
    const current = entry.pending ?? currentRouteOf(agent) ?? { provider: payload?.provider, model: undefined };
    if (current.provider !== undefined && current.model !== undefined) {
      entry.tried.add(routeKey(current.provider, current.model));
    }
    const code = typeof failure.code === 'string' ? failure.code : 'no code';
    const triedLabels = [...entry.tried].map((key) => key.split('\u0000').join('/'));
    recordRuntimeVerdict(current, failure);

    if (options.mode === 'notify') {
      /* ---- tell the agent, change nothing ---- */
      const fingerprint = `${routeKey(current.provider ?? '?', current.model ?? '?')}\u0000${code}`;
      const last = entry.notified.get(fingerprint) ?? 0;
      const alreadyNotified = options.stickyMs > 0 && Date.now() - last < options.stickyMs;
      let injected = false;
      let toldDelegator = false;
      let foundDelegator = false;
      if (options.notify && !alreadyNotified) {
        const candidates = options.candidates.map(routeLabel);
        const text = buildNotice({
          route: current,
          failure,
          kind: reason,
          tried: triedLabels,
          candidates,
        });
        injected = notifyAgent(agent, text);
        const delegator = delegatorOf(agent);
        foundDelegator = delegator !== undefined;
        if (delegator !== undefined) {
          toldDelegator = notifyDelegator(
            delegator,
            buildDelegatorNotice({
              route: current,
              failure,
              kind: reason,
              tried: triedLabels,
              candidates,
              childSessionId: sessionId,
            }),
          );
        }
        if (injected) entry.notified.set(fingerprint, Date.now());
      }
      journal.record({
        kind: injected ? 'notify' : alreadyNotified ? 'notify-skipped' : 'observe',
        session: sessionId,
        turn,
        route: current,
        code,
        reason,
        delegatorFound: foundDelegator,
        delegatorNotified: toldDelegator,
      });
      ctx.logger?.info?.(
        `dsh-quota-failover: ${reason} on ${routeLabel(current)} (session ${sessionId}) — ${
          injected ? 'told the agent' : alreadyNotified ? 'already told the agent' : 'not told (notify disabled)'
        }${toldDelegator ? ', told the delegator' : ''}`,
      );
      return undefined; // leave the turn terminal, exactly as DSH decided
    }

    /* ---- auto: hop to the next candidate route and keep going ---- */
    let candidates = options.candidates;
    if (options.respectAllowlist) {
      const allowlist = readAllowlist();
      if (allowlist !== undefined && allowlist.enabled && allowlist.routes.length > 0) {
        const allowed = new Set(allowlist.routes.map((route) => routeKey(route.provider, route.model)));
        const filtered = candidates.filter((candidate) => allowed.has(routeKey(candidate.provider, candidate.model)));
        if (filtered.length > 0) candidates = filtered;
      }
    }
    const target = pickCandidate(candidates, entry.tried);
    if (target === undefined) {
      journal.record({ kind: 'exhausted', session: sessionId, turn, from: current, tried: triedLabels, reason });
      ctx.logger?.warn?.(
        `dsh-quota-failover: every candidate is spent for session ${sessionId}; leaving the failure terminal (${reason})`,
      );
      return undefined;
    }
    entry.pending = target;
    entry.pendingAt = Date.now();
    entry.tried.add(routeKey(target.provider, target.model));
    journal.record({ kind: 'failover', session: sessionId, turn, from: current, to: target, reason });
    ctx.logger?.info?.(
      `dsh-quota-failover: ${reason} on ${routeLabel(current)} — retrying on ${routeLabel(target)}`,
    );
    if (options.notify) {
      notifyAgent(
        agent,
        `[quota-failover] ${routeLabel(current)} 不可用（${code}），本次重试已自动改用 ${routeLabel(target)}。`
          + '这不影响你的判断：继续按原计划推进任务；若后续仍失败，再向用户说明。',
      );
      // A silent route swap is invisible to whoever chose the model, and the new
      // route may lack a capability the old one had. Say so.
      const delegator = delegatorOf(agent);
      if (delegator !== undefined) {
        notifyDelegator(
          delegator,
          `[quota-failover] ${routeLabel(current)} 不可用（${code}），已按配置**自动**把子会话 `
            + `${sessionId} 的模型换成 ${routeLabel(target)} 继续。`
            + '\n注意：自动切换不知道任务需要哪些模态能力；如果这个任务依赖原模型的视频/图像/长上下文能力，'
            + '新路由可能缺少它，请自行确认，必要时改用你挑定的模型重做。',
        );
      }
    }
    return { kind: 'retry' };
  };

  // Quota walls are terminal by definition, so this listener claims them before
  // `dsh-llm-retry` can spend its budget re-dialing a door that is locked.
  const disposeQuota = ctx.on('agent/request-error', (payload, next) => {
    if (!isQuotaWall(payload?.failure)) return next();
    const action = handle(payload, `quota wall (${payload?.failure?.code ?? 'no code'})`);
    return action === undefined ? next() : action;
  }, { prepend: true });

  // Everything else is only worth a provider swap once the provider's own retry
  // policy has given up — which is precisely when `dsh-llm-retry` calls `next()`
  // and this listener (registered after it) finally sees the failure.
  const disposeSoft = ctx.on('agent/request-error', (payload, next) => {
    if (!isSoftFailure(payload?.failure)) return next();
    const action = handle(payload, `unrecovered failure (${payload?.failure?.code ?? 'no code'})`);
    return action === undefined ? next() : action;
  });

  /* ---------------------------------------------------------------- */
  /* model availability probe                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Ask one route for a few tokens, directly through the `llm` service.
   *
   * This deliberately does not go through an agent: the question "does this
   * provider/model answer at all for this account?" has a much cheaper answer
   * than "can an agent solve a task with it?" — one small request, no tools, no
   * session, nothing written to any transcript. It is also the same path every
   * failing call takes, so a route that reports ok here is exactly one the
   * failover ladder could use.
   *
   * The classification reuses the plugin's own failure predicates, so the panel
   * can say *why* a route is unusable (quota wall vs. route refusal vs. other)
   * rather than just "failed".
   */
  const classifyProbeFailure = (failure) => {
    if (isQuotaWall(failure)) return 'quota';
    if (isRouteRefusal(failure)) return 'route-refusal';
    if (isSoftFailure(failure)) return 'soft';
    return 'other';
  };

  const probeRoute = async (route, { timeoutMs, prompt }) => {
    const startedAt = Date.now();
    const llm = (() => {
      try {
        return ctx.get('llm');
      } catch {
        return undefined;
      }
    })();
    if (llm === undefined || llm === null || typeof llm.prepareCall !== 'function') {
      return { ...route, ok: false, ms: 0, kind: 'other', code: 'NO_LLM', message: 'the llm service is unavailable' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
    try {
      const call = await llm.prepareCall({ provider: route.provider, model: route.model, maxTokens: 32 }, controller.signal);
      const options = {
        ...call.config,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        purpose: 'quota-failover-probe',
        signal: controller.signal,
      };
      let text = '';
      let finish;
      for await (const chunk of call.stream(options)) {
        if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text;
        else if (chunk?.type === 'finish') finish = chunk.reason;
      }
      // A stream that ends in `finish.reason.kind === "error"` never throws:
      // the adapter reports failures that happen after the call is accepted
      // (unknown model, quota wall, upstream refusal) as a terminal chunk.
      // Treat those as probe failures too, otherwise a dead route reads as
      // "ok, 1 ms, empty sample".
      if (finish !== null && typeof finish === 'object' && finish.kind === 'error') {
        const failure = finish.failure ?? {};
        const message = typeof failure.message === 'string' ? failure.message : String(failure.message ?? 'stream failed');
        return {
          ...route,
          ok: false,
          ms: Date.now() - startedAt,
          kind: classifyProbeFailure({
            code: typeof failure.code === 'string' ? failure.code : '',
            message,
          }),
          code: typeof failure.code === 'string' && failure.code !== '' ? failure.code : 'no code',
          message: message.slice(0, 240),
        };
      }
      return {
        ...route,
        ok: true,
        ms: Date.now() - startedAt,
        sample: text.trim().slice(0, 80),
        ...(typeof finish === 'string' ? { finish } : {}),
      };
    } catch (error) {
      const failure = {
        code: typeof error?.code === 'string' ? error.code : '',
        message: typeof error?.message === 'string' ? error.message : String(error),
      };
      const timedOut = controller.signal.aborted === true;
      return {
        ...route,
        ok: false,
        ms: Date.now() - startedAt,
        kind: timedOut ? 'timeout' : classifyProbeFailure(failure),
        code: timedOut ? 'TIMEOUT' : failure.code || 'no code',
        message: failure.message.slice(0, 240),
      };
    } finally {
      clearTimeout(timer);
    }
  };

  /* ---------------------------------------------------------------- */
  /* route inventory + batch probe                                    */
  /* ---------------------------------------------------------------- */

  /**
   * Real traffic is the best availability evidence there is: when an actual
   * request fails, record that route's verdict in the store the panel renders.
   * A sweep taken at 20:55 otherwise keeps claiming a route works after the
   * account ran dry at 21:40, which is exactly how "✓ 可用" turns into a
   * QUOTA_EXCEEDED turn minutes later. Best-effort on purpose — bookkeeping
   * must never be the reason a turn ends.
   */
  const recordRuntimeVerdict = (route, failure) => {
    try {
      if (route === null || route === undefined) return;
      if (typeof route.provider !== 'string' || typeof route.model !== 'string') return;
      if (route.provider === COMBO_PROVIDER) return; // a combo names its members, not itself
      const kind = classifyProbeFailure(failure);
      if (kind === 'other') return;
      const at = new Date().toISOString();
      const previous = readResultsFile();
      const rows = Array.isArray(previous?.routes)
        ? previous.routes.filter((row) => !(row?.provider === route.provider && row?.model === route.model))
        : [];
      rows.push({
        provider: route.provider,
        model: route.model,
        ok: false,
        at,
        ms: 0,
        source: 'runtime',
        kind,
        code: typeof failure?.code === 'string' && failure.code !== '' ? failure.code : 'no code',
        message: (typeof failure?.message === 'string' ? failure.message : '').replace(/\s+/g, ' ').slice(0, 240),
      });
      rows.sort(
        (left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model),
      );
      writeResultsFile({
        version: 1,
        ...(typeof previous?.testedAt === 'string' ? { testedAt: previous.testedAt } : {}),
        observedAt: at,
        ...(previous?.lastRun !== undefined ? { lastRun: previous.lastRun } : {}),
        routes: rows,
      });
    } catch {
      /* evidence is best-effort */
    }
  };

  /**
   * Every route this host can actually call right now.
   *
   * `listProviders()` is the adapter registry — the same set core routing
   * dispatches to — and `listModels(provider)` is each adapter's advisory
   * catalog. Adapters are allowed to advertise nothing (the base class returns
   * an empty list), so a provider can legitimately show up with zero models;
   * the panel says so instead of hiding the provider.
   */
  const llmService = () => {
    try {
      return ctx.get('llm');
    } catch {
      return undefined;
    }
  };

  let routeCache = { at: 0, value: undefined };
  const ROUTE_CACHE_MS = 15_000;

  const enumerateRoutes = async () => {
    const now = Date.now();
    if (routeCache.value !== undefined && now - routeCache.at < ROUTE_CACHE_MS) return routeCache.value;
    const llm = llmService();
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return [];
    let providers = [];
    try {
      providers = llm.listProviders();
    } catch {
      providers = [];
    }
    const rows = [];
    for (const provider of Array.isArray(providers) ? providers : []) {
      const id = typeof provider?.id === 'string' ? provider.id : '';
      if (id.length === 0) continue;
      let models = [];
      let error;
      try {
        if (typeof llm.listModels === 'function') models = await llm.listModels(id);
      } catch (failure) {
        error = String(failure?.message ?? failure).slice(0, 200);
      }
      const listed = (Array.isArray(models) ? models : []).map((model) => ({
        model: typeof model?.id === 'string' ? model.id : String(model?.id ?? ''),
        name: typeof model?.name === 'string' ? model.name : '',
        ...(typeof model?.description === 'string' ? { description: model.description.slice(0, 160) } : {}),
      })).filter((model) => model.model.length > 0);
      rows.push({
        provider: id,
        name: typeof provider?.name === 'string' ? provider.name : id,
        routes: listed.map((model) => ({ provider: id, model: model.model })),
        models: listed,
        ...(error === undefined ? {} : { error }),
      });
    }
    const total = rows.reduce((sum, row) => sum + row.routes.length, 0);
    const value = { providers: rows, total };
    routeCache = { at: now, value };
    return value;
  };

  /* ---------------------------------------------------------------- */
  /* failover combos: own provider, own model catalog, own config     */
  /* ---------------------------------------------------------------- */

  // A combo is one model id (`failover-combos/combo:<slug>`) over a set of real
  // routes. `dsh-our-free-model` builds the same thing for its free lanes; this
  // plugin builds it across *every* provider the host can route to, which is the
  // piece that plugin cannot do (its combos can only contain its own models).
  const comboStore = createComboStore({ logger: ctx.logger, path: () => combosPath() });
  const comboCatalog = createComboCatalog({ getLlm: llmService, store: comboStore, logger: ctx.logger });
  const comboAdapter = createComboAdapter({
    catalog: comboCatalog,
    getLlm: llmService,
    // The same verdicts that make the outer failover switch routes make a combo
    // member worth skipping. Auth/permission/region failures are *not* here:
    // another member cannot fix a login problem, so the combo reports it.
    isAdvanceable: (failure) => isQuotaWall(failure) || isRouteRefusal(failure) || isSoftFailure(failure),
    logger: ctx.logger,
    record: (event) => {
      try {
        journal.record(event);
      } catch {
        /* journal failures never fail a generation */
      }
    },
  });

  const comboWarnings = () => {
    const snapshot = comboStore.read();
    if (snapshot.combos.length === 0) {
      return '还没有组合。在「设置 → 内置插件 → 额度转移」面板里按模型类别生成。';
    }
    // MAX_COMBOS is a comfort hint, not a limit: nothing is refused or truncated.
    if (snapshot.combos.length >= MAX_COMBOS) {
      return `组合已经很多（${snapshot.combos.length} 个）：面板和「设置 → 模型」里的列表会变长，不需要的可以在卡片上删除。`;
    }
    return undefined;
  };

  /**
   * The subagent whitelist is the set of routes the user has authorised. A combo
   * built "按白名单" must use exactly those routes as members — selecting a
   * category because it *touches* the whitelist and then filling the combo from
   * the whole catalog is not what that button says.
   */
  const whitelistRoutes = () => {
    try {
      const allowlist = readAllowlist();
      return Array.isArray(allowlist?.routes) ? allowlist.routes : [];
    } catch {
      return [];
    }
  };

  /** Categories formed only from whitelisted routes (may include ids not listed). */
  const whitelistCategoryRows = () => {
    const byProvider = new Map();
    for (const route of whitelistRoutes()) {
      const provider = typeof route?.provider === 'string' ? route.provider : '';
      const model = typeof route?.model === 'string' ? route.model : '';
      if (provider.length === 0 || model.length === 0) continue;
      if (provider === COMBO_PROVIDER || model.startsWith('combo:')) continue;
      if (!byProvider.has(provider)) byProvider.set(provider, []);
      byProvider.get(provider).push({ model });
    }
    const providers = [...byProvider.entries()].map(([provider, models]) => ({ provider, models }));
    return buildCategories(providers, { excludeProviders: [COMBO_PROVIDER] });
  };

  /**
   * One row per model category with both scopes attached:
   * `members` = catalog listing, `whiteMembers` = whitelisted subset.
   * A category only present in the whitelist still gets a row (catalog counts 0)
   * so it can be generated — adapters accept unlisted ids.
   */
  const mergeCategoryScopes = (catalogRows, whiteRows) => {
    const whiteByKey = new Map(whiteRows.map((row) => [row.key, row]));
    const catalogKeys = new Set(catalogRows.map((row) => row.key));
    const merged = catalogRows.map((row) => {
      const white = whiteByKey.get(row.key);
      return {
        ...row,
        catalogCount: row.count,
        catalogProviders: row.providers,
        whiteCount: white?.count ?? 0,
        whiteProviders: white?.providers ?? 0,
        whiteMembers: white?.members ?? [],
      };
    });
    for (const row of whiteRows) {
      if (catalogKeys.has(row.key)) continue;
      merged.push({
        ...row,
        count: 0,
        providers: 0,
        members: [],
        catalogCount: 0,
        catalogProviders: 0,
        whiteCount: row.count,
        whiteProviders: row.providers,
        whiteMembers: row.members,
      });
    }
    return merged;
  };

  /** Categories + saved combos + adapter stats, one payload for the panel. */
  const combosBody = async (inventory) => {
    const snapshot = comboStore.read();
    const catalogRows = comboCatalog.categories(inventory ?? (await enumerateRoutes()));
    const merged = mergeCategoryScopes(catalogRows, whitelistCategoryRows());
    // A row is worth showing when it can form a cross-provider combo from the
    // catalog, when the whitelist alone can form one, or when it already exists.
    const categories = merged.filter((row) => row.providers > 1 || row.whiteCount > 1 || row.selected === true);
    return {
      ok: true,
      provider: COMBO_PROVIDER,
      path: combosPath(),
      updatedAt: snapshot.updatedAt,
      combos: snapshot.combos.map((combo) => Object.assign({}, combo, { name: displayComboName(combo.name) })),
      categories,
      hidden: merged.length - categories.length,
      stats: comboAdapter.stats(),
      whites: { routes: whitelistRoutes().length },
      note: comboWarnings(),
    };
  };

  const readComboMembers = async (category, wanted, scope = 'all') => {
    const whiteSet = scope === 'whitelist'
      ? new Set(whitelistRoutes().map((route) => `${route.provider}\u0000${route.model}`))
      : undefined;
    const listed = Array.isArray(wanted) && wanted.length > 0
      ? wanted
      : category === undefined
        ? []
        : scope === 'whitelist' && Array.isArray(category.whiteMembers) && category.whiteMembers.length > 0
          ? category.whiteMembers
          : category.members;
    const source = listed.map((member) => {
      const provider = typeof member?.provider === 'string' ? member.provider.trim() : '';
      const model = typeof member?.model === 'string' ? member.model.trim() : '';
      return provider.length === 0 || model.length === 0 ? undefined : { provider, model };
    }).filter((member) => member !== undefined);
    const seen = new Set();
    const members = [];
    for (const member of source) {
      if (member.provider === COMBO_PROVIDER) continue;
      if (member.model.startsWith('combo:')) continue;
      const key = `${member.provider}\u0000${member.model}`;
      if (whiteSet !== undefined && !whiteSet.has(key)) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      members.push(member);
      if (members.length >= MAX_MEMBERS) break;
    }
    return members;
  };

  /** `inputModalities` is only trustworthy after a real resolve; keep it best-effort. */
  const membersAdvertiseVision = async (members) => {
    if (members.length === 0) return false;
    const llm = llmService();
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2_500);
    try {
      const info = await Promise.all(members.map(async (member) => {
        try {
          return await llm.resolveModelInfo(member.provider, member.model, controller.signal);
        } catch {
          return undefined;
        }
      }));
      return info.every((row) => row !== undefined && Array.isArray(row.inputModalities) && row.inputModalities.includes('image'));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };

  const saveCombos = async (next) => {
    const normalized = normalizeCombos(next);
    comboStore.write(normalized);
    try {
      comboAdapter.prune(normalized);
    } catch {
      /* rotation bookkeeping is best-effort */
    }
    return combosBody();
  };

  const handleCombos = async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, await combosBody());
      return;
    }
    const body = await readBody(req);
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'a JSON object body is required' });
      return;
    }
    const action = typeof body.action === 'string' ? body.action : 'create';
    const snapshot = comboStore.read();
    const combos = snapshot.combos.slice();
    const findIndex = (id) => combos.findIndex((combo) => combo.id === id);
    const inventory = await enumerateRoutes();
    const categoryRows = mergeCategoryScopes(comboCatalog.categories(inventory), whitelistCategoryRows());
    const rowFor = (key) => categoryRows.find((row) => row.key === key);

    if (action === 'create' || action === 'rebuild') {
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      let category = rowFor(key);
      const existingIndex = action === 'rebuild'
        ? combos.findIndex((combo) => (typeof body.id === 'string' ? combo.id === body.id : combo.key === comboSlug(key)))
        : findIndex(typeof body.id === 'string' ? body.id : '');
      const existing = existingIndex >= 0 ? combos[existingIndex] : undefined;
      if (category === undefined && action === 'rebuild') {
        if (existing !== undefined) category = { key: existing.key, name: existing.name, members: existing.members };
      }
      // create defaults to the catalog scope; rebuild keeps the combo's own scope
      // unless the caller explicitly switches it.
      const scope = body.scope === 'whitelist'
        ? 'whitelist'
        : body.scope === 'all'
          ? 'all'
          : (action === 'rebuild' ? (existing?.scope === 'whitelist' ? 'whitelist' : 'all') : 'all');
      const members = await readComboMembers(category, body.members, scope);
      if (members.length === 0) {
        sendJson(res, 400, {
          ok: false,
          error: scope === 'whitelist'
            ? '无法生成组合：白名单里没有这个类别的成员（先到「设置 → 内置插件 → 子智能体」把模型加进授权列表，再点「刷新类别」）'
            : '无法生成组合：没有可用的成员（先点「刷新类别」读一次宿主模型清单）',
        });
        return;
      }
      const slug = comboSlug(key.length > 0 ? key : members.map((member) => member.model).join('-'));
      const dedupe = combos.findIndex((combo) => combo.id === `combo:${slug}`);
      if (action === 'create' && dedupe >= 0) {
        sendJson(res, 409, { ok: false, error: `组合 ${slug} 已存在；可以在卡片上删除后重建，或点「刷新成员」` });
        return;
      }
      const targetIndex = action === 'rebuild' && existingIndex >= 0 ? existingIndex : dedupe;
      const previous = targetIndex >= 0 ? combos[targetIndex] : undefined;
      const now = new Date().toISOString();
      const record = {
        key: previous?.key ?? slug,
        name: typeof body.name === 'string' && body.name.trim().length > 0
          ? body.name.trim().slice(0, 80)
          : previous?.name ?? category?.name ?? prettyFromKey(slug),
        strategy: previous?.strategy ?? (body.strategy === 'round-robin' ? 'round-robin' : 'fallback'),
        stickyLimit: previous?.stickyLimit ?? (Number.isSafeInteger(body.stickyLimit) && body.stickyLimit > 0 ? Math.min(body.stickyLimit, 20) : 1),
        enabled: previous?.enabled ?? (body.enabled !== false),
        scope,
        members,
        vision: await membersAdvertiseVision(members),
        createdAt: previous?.createdAt ?? now,
        updatedAt: now,
      };
      if (targetIndex >= 0) combos[targetIndex] = record;
      else combos.push(record);
      sendJson(res, 200, await saveCombos(combos));
      return;
    }

    if (action === 'delete') {
      const id = typeof body.id === 'string' ? body.id : '';
      const index = findIndex(id);
      if (index < 0) {
        sendJson(res, 404, { ok: false, error: `没有这个组合：${id}` });
        return;
      }
      combos.splice(index, 1);
      sendJson(res, 200, await saveCombos(combos));
      return;
    }

    if (action === 'update' || action === 'toggle') {
      const index = findIndex(typeof body.id === 'string' ? body.id : '');
      if (index < 0) {
        sendJson(res, 404, { ok: false, error: `没有这个组合：${String(body.id)}` });
        return;
      }
      const previous = combos[index];
      combos[index] = {
        ...previous,
        ...(typeof body.name === 'string' && body.name.trim().length > 0 ? { name: body.name.trim().slice(0, 80) } : {}),
        ...(body.strategy === 'fallback' || body.strategy === 'round-robin' ? { strategy: body.strategy } : {}),
        ...(Number.isSafeInteger(body.stickyLimit) && body.stickyLimit > 0 ? { stickyLimit: Math.min(body.stickyLimit, 20) } : {}),
        ...(typeof body.enabled === 'boolean' ? { enabled: body.enabled } : {}),
        updatedAt: new Date().toISOString(),
      };
      sendJson(res, 200, await saveCombos(combos));
      return;
    }

    if (action === 'delete-all') {
      sendJson(res, 200, await saveCombos([]));
      return;
    }

    sendJson(res, 400, { ok: false, error: `unknown action: ${action}` });
  };


  /**
   * One probe run at a time, polled by the panel.
   *
   * A full sweep is dozens of network round trips, so it cannot ride on one HTTP
   * response: the POST starts the job and the panel polls `/probe/state`. Probes
   * run three at a time — enough to finish a sweep in a reasonable time without
   * turning a rate-limited provider into a self-inflicted outage.
   */
  let probeJob = null;
  let probeSeq = 0;
  const PROBE_CONCURRENCY = 3;
  // Generous by design: a free lane can sit 50s before its first token, and a sweep of a
  // hundred routes at three workers needs room for the slow tail.
  const PROBE_WALL_CLOCK_MS = 10 * 60_000;

  const startProbeJob = (routes, options) => {
    const job = {
      id: ++probeSeq,
      startedAt: new Date().toISOString(),
      scope: typeof options.scope === 'string' ? options.scope : 'routes',
      total: routes.length,
      done: 0,
      running: true,
      cancelled: false,
      results: [],
    };
    probeJob = job;
    const deadline = Date.now() + PROBE_WALL_CLOCK_MS;
    const queue = routes.slice();
    const worker = async () => {
      while (queue.length > 0) {
        if (job.cancelled === true) return;
        if (Date.now() > deadline) {
          job.cancelled = true;
          return;
        }
        const route = queue.shift();
        let result;
        try {
          result = await probeRoute(route, options);
        } catch (error) {
          result = { ...route, ok: false, ms: 0, kind: 'other', code: 'PROBE_FAILED', message: String(error?.message ?? error).slice(0, 200) };
        }
        job.results.push(result);
        job.done += 1;
      }
    };
    void Promise.all([worker(), worker(), worker()])
      .catch(() => undefined)
      .then(() => {
        job.running = false;
        job.finishedAt = new Date().toISOString();
        // Persist before the journal entry: the journal is bounded and prunable,
        // while this store is what the panel and the `route_availability` tool read.
        try {
          mergeProbeResults(job);
        } catch (error) {
          ctx.logger?.warn?.(`dsh-quota-failover: could not persist probe results: ${String(error)}`);
        }
        const failed = job.results.filter((result) => result.ok !== true);
        journal.record({
          kind: 'probe',
          total: job.total,
          done: job.done,
          ok: job.results.length - failed.length,
          failed: failed.slice(0, 12).map((result) => ({
            route: `${result.provider}/${result.model}`,
            code: result.code ?? 'unknown',
          })),
          ...(job.cancelled ? { cancelled: true } : {}),
        });
      });
    return job;
  };

  /* ---------------------------------------------------------------- */
  /* settings panel API                                               */
  /* ---------------------------------------------------------------- */

  const disposers = [disposeRequest, disposeQuota, disposeSoft];
  // `webServer` is provided by the host composition and it can appear *after*
  // this plugin's apply() runs. Reading `ctx.get('webServer')` once at apply time
  // answers `undefined` in that case and silently loses the whole panel API — the
  // panel then sticks on "正在读取插件状态…" because every call 404s.
  // `dsh-our-free-model` documents the same trap and fixes it with `ctx.inject`.
  // One `exact` route per endpoint: that is the registration shape this host's
  // webServer is known to accept.
  const handler = async (req, res) => {
            try {
              const url = new URL(req.url ?? '/', 'http://127.0.0.1');
              const tail = url.pathname.slice(ROUTE_PREFIX.length) || '/';
              if (tail === '/state' || tail === '/state/') {
                sendJson(res, 200, stateBody(base));
                return;
              }
              if (tail === '/config' && req.method === 'POST') {
                const patch = await readBody(req);
                if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
                  sendJson(res, 400, { ok: false, error: 'a JSON object body is required' });
                  return;
                }
                const current = effectiveOptions(base);
                const merged = normalizeOptions({ ...current, ...patch });
                writeConfigFile({
                  enabled: merged.enabled,
                  mode: merged.mode,
                  notify: merged.notify,
                  respectAllowlist: merged.respectAllowlist,
                  candidates: merged.candidates,
                  stickyMs: merged.stickyMs,
                  journal: merged.journal,
                  maxSessions: merged.maxSessions,
                });
                sendJson(res, 200, stateBody(base));
                return;
              }
              if (tail === '/routes' && req.method === 'GET') {
                const inventory = await enumerateRoutes();
                sendJson(res, 200, { ok: true, providers: inventory.providers, total: inventory.total });
                return;
              }
              if (tail === '/allowlist' && req.method === 'GET') {
                // The settings panel defaults its probe scope to this list, so the Host
                // parses its own loader patch rather than duplicating the rules in the client.
                const allowlist = readAllowlist();
                if (allowlist === undefined) {
                  sendJson(res, 200, {
                    ok: true,
                    enabled: false,
                    total: 0,
                    routes: [],
                    providers: [],
                    note: '配置里没有 subagent-model-selection-settings',
                  });
                  return;
                }
                sendJson(res, 200, {
                  ok: true,
                  enabled: allowlist.enabled,
                  total: allowlist.routes.length,
                  routes: allowlist.routes,
                  providers: allowlist.providers,
                  source: profilePatchPath(),
                });
                return;
              }
              if (tail === '/probe/results' && req.method === 'GET') {
                const results = readResultsFile();
                sendJson(res, 200, { ok: true, results: results ?? undefined });
                return;
              }
              if (tail === '/combos') {
                await handleCombos(req, res);
                return;
              }
              if (tail === '/probe/state' && req.method === 'GET') {
                sendJson(res, 200, { ok: true, job: probeJob });
                return;
              }
              if (tail === '/probe' && req.method === 'POST') {
                const body = await readBody(req);
                if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                  sendJson(res, 400, { ok: false, error: 'a JSON object body is required' });
                  return;
                }
                if (probeJob !== null && probeJob.running === true) {
                  sendJson(res, 409, { ok: false, error: '已有一次测试在进行中，等它结束或稍后再试', job: probeJob });
                  return;
                }
                const current = effectiveOptions(base);
                const scope = body.scope === 'all'
                  ? 'all'
                  : body.scope === 'allowlist'
                    ? 'allowlist'
                    : body.scope === 'combos'
                      ? 'combos'
                      : 'candidates';
                let requested;
                if (Array.isArray(body.routes) && body.routes.length > 0) {
                  requested = body.routes.map(parseCandidate).filter((route) => route !== undefined);
                } else if (scope === 'all') {
                  const inventory = await enumerateRoutes();
                  requested = inventory.providers.flatMap((provider) => provider.routes);
                } else if (scope === 'allowlist') {
                  const allowlist = readAllowlist();
                  requested = (allowlist?.routes ?? []).map((route) => ({ provider: route.provider, model: route.model }));
                } else if (scope === 'combos') {
                  requested = comboCatalog.activeCombos().flatMap((combo) => combo.members);
                } else {
                  requested = current.candidates;
                }
                // The panel checks providers one by one, so the same route list can be
                // narrowed here instead of forcing the client to resend every model.
                const providerFilter = Array.isArray(body.providers)
                  ? body.providers.filter((id) => typeof id === 'string' && id.length > 0)
                  : [];
                if (providerFilter.length > 0) {
                  requested = requested.filter((route) => providerFilter.includes(route.provider));
                }
                const seen = new Set();
                requested = requested.filter((route) => {
                  const key = routeKey(route.provider, route.model);
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                const routes = requested.slice(0, 200);
                const truncated = Math.max(0, requested.length - routes.length);
                if (routes.length === 0) {
                  const why = scope === 'allowlist'
                    ? '子智能体模型白名单为空，或没有匹配已勾选的 provider（设置 → 内置插件 → 子智能体）'
                    : scope === 'all'
                      ? '宿主没有公布任何模型列表'
                      : scope === 'combos'
                        ? '还没有启用中的组合'
                        : '候选路由为空';
                  sendJson(res, 400, { ok: false, error: `没有可选路由：${why}` });
                  return;
                }
                const timeoutMs = Number.isFinite(body.timeoutMs) ? body.timeoutMs : 20_000;
                const prompt = typeof body.prompt === 'string' && body.prompt.trim().length > 0
                  ? body.prompt
                  : 'Reply with exactly this token and nothing else: OK';
                const job = startProbeJob(routes, { timeoutMs, prompt, scope });
                sendJson(res, 200, {
                  ok: true,
                  job,
                  scope,
                  requested: requested.length,
                  ...(truncated > 0 ? { truncated } : {}),
                });
                return;
              }
              if (tail === '/reset' && req.method === 'POST') {
                try {
                  fs.rmSync(configPath(), { force: true });
                } catch {
                  /* nothing to remove */
                }
                configCache = { mtimeMs: Number.NaN, value: undefined };
                sendJson(res, 200, stateBody(base));
                return;
              }
              if (tail === '/journal/clear' && req.method === 'POST') {
                const next = readJournalFile();
                if (next !== undefined && Array.isArray(next.events)) {
                  next.events = [];
                  try {
                    fs.writeFileSync(journalPath(), JSON.stringify(next, undefined, 2), { mode: 0o600 });
                  } catch {
                    /* best effort */
                  }
                }
                sendJson(res, 200, { ok: true });
                return;
              }
              sendJson(res, 404, { ok: false, error: `no such endpoint: ${tail}` });
            } catch (error) {
              sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
      };
  let webServerFiber;
  const registerWebServerRoutes = (webServer, scope) => {
    for (const endpoint of ['/state', '/config', '/routes', '/allowlist', '/probe', '/probe/state', '/probe/results', '/combos', '/reset', '/journal/clear']) {
      const register = () => webServer.register({ kind: 'exact', path: ROUTE_PREFIX + endpoint, handler });
      if (scope !== undefined && typeof scope.effect === 'function') {
        disposers.push(scope.effect(register, `dsh-quota-failover: ${endpoint}`));
      } else {
        disposers.push(register());
      }
    }
  };
  if (typeof ctx.inject === 'function') {
    // Pends until the composition provides `webServer`; that ordering is not
    // something this plugin can assume at apply time.
    webServerFiber = ctx.inject(['webServer'], (scoped) => {
      try {
        const webServer = scoped?.webServer;
        if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return;
        registerWebServerRoutes(webServer, scoped);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-quota-failover: settings API unavailable: ${String(error)}`);
      }
    });
  } else {
    try {
      const webServer = ctx.get('webServer');
      if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
        registerWebServerRoutes(webServer, undefined);
      }
    } catch (error) {
      ctx.logger?.warn?.(`dsh-quota-failover: settings API unavailable: ${String(error)}`);
    }
  }

  // The combo provider has to be registered with the llm service, which — like
  // `webServer` — is not guaranteed to exist when apply() runs. `ctx.inject`
  // waits for it instead of silently losing the whole provider.
  let comboFiber;
  const registerComboProvider = (scoped) => {
    try {
      const llm = scoped?.llm ?? (typeof ctx.get === 'function' ? ctx.get('llm') : undefined);
      if (llm === undefined || llm === null || typeof llm.registerAdapter !== 'function') return;
      const handle = llm.registerAdapter([COMBO_PROVIDER], comboAdapter);
      if (typeof handle === 'function') {
        disposers.push(handle);
      } else if (handle !== null && typeof handle === 'object') {
        if (typeof handle.dispose === 'function') disposers.push(() => handle.dispose());
        else if (typeof handle.replace === 'function') disposers.push(() => handle.replace([]));
      }
      ctx.logger?.info?.(`dsh-quota-failover: combo provider "${COMBO_PROVIDER}" registered`);
    } catch (error) {
      ctx.logger?.warn?.(`dsh-quota-failover: combo provider registration failed: ${String(error)}`);
    }
  };
  if (typeof ctx.inject === 'function') {
    comboFiber = ctx.inject(['llm'], registerComboProvider);
  } else {
    registerComboProvider(undefined);
  }

  function stateBody(rowConfig) {
    const row = normalizeOptions(rowConfig);
    const options = effectiveOptions(row);
    const allowlist = readAllowlist();
    return {
      ok: true,
      version,
      build: PLUGIN_BUILD,
      paths: { config: configPath(), journal: journalPath(), profilePatch: profilePatchPath() },
      config: options,
      rowConfig: row,
      journal: readJournalFile(),
      probe: (() => {
        const stored = readResultsFile();
        if (stored === undefined) return undefined;
        return {
          testedAt: stored.testedAt,
          total: stored.routes.length,
          ok: stored.routes.filter((row) => row.ok === true).length,
          path: resultsPath(),
        };
      })(),
      allowlist: allowlist === undefined
        ? undefined
        : {
            enabled: allowlist.enabled,
            total: allowlist.routes.length,
            providers: allowlist.providers,
          },
      combos: (() => {
        const snapshot = comboStore.read();
        return {
          total: snapshot.combos.length,
          enabled: snapshot.combos.filter((combo) => combo.enabled !== false).length,
          path: combosPath(),
          updatedAt: snapshot.updatedAt,
          models: snapshot.combos.map((combo) => `${COMBO_PROVIDER}/${combo.id}`),
        };
      })(),
    };
  }

  /* ---------------------------------------------------------------- */
  /* route_availability tool                                          */
  /* ---------------------------------------------------------------- */

  const KIND_TEXT = {
    quota: '额度墙',
    'route-refusal': '账号不支持该模型',
    soft: '临时故障',
    timeout: '超时',
    other: '其它错误',
  };

  /**
   * The same evidence the panel renders, phrased so an agent can act on it:
   * last test time first (freshness decides how much to trust it), then one
   * block per provider with per-route verdicts.
   */
  const availabilityReport = ({ provider } = {}) => {
    const stored = readResultsFile();
    if (stored === undefined || stored.routes.length === 0) {
      const allowlist = readAllowlist();
      const scope = allowlist === undefined
        ? '设置 → 内置插件 → 子智能体（当前没有配置白名单）'
        : `设置 → 内置插件 → 子智能体（白名单 ${allowlist.routes.length} 条 / ${allowlist.providers.length} 个 provider）`;
      return [
        '还没有任何连通性测试结果。',
        '在「设置 → 内置插件 → 额度转移」面板里点「测试选中的 provider」，测完再看这里。',
        `默认测试范围是 ${scope}；结果保存在 ${resultsPath()}。`,
      ].join('\n');
    }
    const wanted = typeof provider === 'string' && provider.length > 0 ? provider : undefined;
    const rows = wanted === undefined ? stored.routes : stored.routes.filter((row) => row.provider === wanted);
    if (rows.length === 0) {
      return `没有 provider "${wanted}" 的测试结果。已测过的 provider：${[...new Set(stored.routes.map((row) => row.provider))].join('、')}。`;
    }
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.provider)) groups.set(row.provider, []);
      groups.get(row.provider).push(row);
    }
    const ok = rows.filter((row) => row.ok === true).length;
    const lines = [
      `模型路由可用性：最近一次测试 ${stored.testedAt}，已测 ${rows.length} 条，${ok} 条可用。`,
      '（每条都是一次真实发出的极短请求；✓ 只代表这条路由现在能出字。）',
    ];
    for (const [providerId, providerRows] of groups) {
      const providerOk = providerRows.filter((row) => row.ok === true).length;
      const lastAt = providerRows
        .map((row) => row.at)
        .filter((value) => typeof value === 'string')
        .sort()
        .pop();
      lines.push('');
      lines.push(`## ${providerId}（${providerRows.length} 条，${providerOk} 可用，上次 ${lastAt ?? stored.testedAt}）`);
      for (const row of providerRows) {
        const mark = row.ok === true ? '✓' : '✗';
        const ms = `${Number.isFinite(row.ms) ? row.ms : 0}ms`;
        const detail = row.ok === true
          ? `${ms}${typeof row.sample === 'string' && row.sample.length > 0 ? ` · 返回 "${row.sample}"` : ''}`
          : `${KIND_TEXT[row.kind] ?? row.kind ?? '其它错误'} · ${row.code ?? 'no code'}${row.message ? ` · ${String(row.message).replace(/\s+/g, ' ').slice(0, 180)}` : ''}（${ms}）`;
        lines.push(`- ${mark} ${row.model} — ${detail}`);
      }
    }
    lines.push('');
    lines.push('如需更新，请让用户在「设置 → 内置插件 → 额度转移」面板重测；本工具只读已保存的结果。');
    return lines.join('\n');
  };

  let toolFiber;
  try {
    const registerAvailabilityTool = (runtimeCtx) => {
      try {
        const tools = runtimeCtx?.tools;
        if (tools === undefined || tools === null || typeof tools.register !== 'function') return;
        const disposer = tools.register({
          name: 'route_availability',
          description: [
            '查看本机模型路由的连通性测试结果：最近一次测试时间，以及按 provider 分组的可用/不可用明细（失败类型、错误码、耗时）。',
            '这些结果来自「设置 → 内置插件 → 额度转移」面板对每条 provider/model 真实发出的极短请求，可用来判断某个路由现在能不能用。',
            '本工具只读已保存的结果，不会发出新请求；需要更新时请让用户在该面板重测。',
          ].join(''),
          parameters: {
            type: 'object',
            properties: {
              provider: {
                type: 'string',
                description: '只看这一个 provider；不填则返回全部已测 provider。',
              },
            },
            additionalProperties: false,
          },
          output: {
            schema: {
              type: 'object',
              properties: { text: { type: 'string' } },
              required: ['text'],
              additionalProperties: false,
            },
            render: (_args, value) => [
              { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) },
            ],
          },
          async execute(args) {
            const wanted = typeof args?.provider === 'string' && args.provider.trim().length > 0
              ? args.provider.trim()
              : undefined;
            return { text: availabilityReport({ provider: wanted }) };
          },
        });
        if (typeof disposer === 'function') disposers.push(disposer);
      } catch (error) {
        ctx.logger?.warn?.(`dsh-quota-failover: route_availability registration failed: ${String(error)}`);
      }
    };
    if (typeof ctx.inject === 'function') {
      toolFiber = ctx.inject(['tools'], registerAvailabilityTool);
    } else {
      registerAvailabilityTool(ctx);
    }
  } catch (error) {
    ctx.logger?.warn?.(`dsh-quota-failover: route_availability tool unavailable: ${String(error)}`);
  }

  return () => {
    if (comboFiber !== undefined && comboFiber !== null && typeof comboFiber.dispose === 'function') {
      try {
        const disposing = comboFiber.dispose();
        if (disposing !== undefined && typeof disposing.catch === 'function') disposing.catch(() => undefined);
      } catch {
        /* a disposed llm fiber is not an error worth surfacing */
      }
    }
    if (webServerFiber !== undefined && webServerFiber !== null && typeof webServerFiber.dispose === 'function') {
      try {
        const disposing = webServerFiber.dispose();
        if (disposing !== undefined && typeof disposing.catch === 'function') disposing.catch(() => undefined);
      } catch {
        /* a disposed route fiber is not an error worth surfacing */
      }
    }
    if (toolFiber !== undefined && toolFiber !== null && typeof toolFiber.dispose === 'function') {
      try {
        const disposing = toolFiber.dispose();
        if (disposing !== undefined && typeof disposing.catch === 'function') disposing.catch(() => undefined);
      } catch {
        /* a disposed tool fiber is not an error worth surfacing */
      }
    }
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        /* a disposed listener is not an error worth surfacing */
      }
    }
    sessions.clear();
  };
}

/* ------------------------------------------------------------------ */
/* http helpers                                                        */
/* ------------------------------------------------------------------ */

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(text);
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8');
  return text.length === 0 ? {} : JSON.parse(text);
}
