/**
 * The combo adapter: one model route per category, N real routes behind it.
 *
 * A combo is *stream-transparent*: chunks are held until the member has
 * committed an answer (first text / tool-call delta). If a member dies before
 * that point on an advanceable failure, the held chunks are dropped and the
 * next member starts from scratch — the caller never sees the failed member.
 * Once an answer is committed the combo is terminal, exactly like a plain
 * provider: retracting committed output is worse than failing.
 */
import { chainFor, pruneRotation, COMBO_PROVIDER } from './combos.js';

const RETRY_POLICY = Object.freeze({
  mode: 'normal',
  maxRetries: 0,
  retryableCodes: Object.freeze([]),
  initialDelayMs: 700,
  maxDelayMs: 8_000,
  jitterRatio: 0.2,
});

function errorChunk(message, code) {
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        message: String(message).slice(0, 2_000),
        code: typeof code === 'string' && code.length > 0 ? code : 'COMBO_FAILED',
      },
    },
  };
}

function abortedChunk(message = 'combo generation aborted') {
  return {
    type: 'finish',
    reason: {
      kind: 'aborted',
      failure: { message, code: 'ABORTED' },
    },
  };
}

function failureOf(error) {
  if (error === null || typeof error !== 'object') return { message: String(error), code: 'UNKNOWN' };
  return {
    message: typeof error.message === 'string' ? error.message : String(error),
    code: typeof error.code === 'string' ? error.code : 'UNKNOWN',
  };
}

const ADVANCE_CHUNK_TYPES = new Set(['text-delta', 'tool-call-delta']);

export function createComboAdapter({ catalog, getLlm, isAdvanceable, logger, record }) {
  const rotation = new Map();
  const stats = new Map();

  const note = (combo, update) => {
    const previous = stats.get(combo.id) ?? { runs: 0, lastRunAt: undefined, lastOutcome: undefined, lastMember: undefined, switches: 0 };
    stats.set(combo.id, { ...previous, ...update, runs: previous.runs + 1 });
  };

  const llmService = () => {
    try {
      const service = getLlm();
      return service === undefined || service === null ? undefined : service;
    } catch {
      return undefined;
    }
  };

  const memberFailureAdvances = (failure) => {
    try {
      return isAdvanceable(failure) === true;
    } catch {
      return false;
    }
  };

  /**
   * The routing half of the call we hand a member. `prepareCall` resolves this
   * into the frozen config the runtime demands back at dispatch time, so every
   * field the runtime compares must be decided *here*, not patched afterwards.
   *
   * The combo's own reasoning effort is forwarded only to members that declare
   * the same level: the efforts a combo advertises are the *intersection* of its
   * members, so a member without that level falls back to its own default
   * instead of rejecting the request.
   */
  const innerProposal = async (member, options, signal) => {
    const proposal = { provider: member.provider, model: member.model };
    if (options.temperature !== undefined) proposal.temperature = options.temperature;
    if (options.maxTokens !== undefined) proposal.maxTokens = options.maxTokens;
    if (options.stop !== undefined) proposal.stop = options.stop;
    if (options.reasoningEffort !== undefined && typeof catalog.supportsReasoningEffort === 'function') {
      try {
        if (await catalog.supportsReasoningEffort(member, options.reasoningEffort, signal)) {
          proposal.reasoningEffort = options.reasoningEffort;
        }
      } catch {
        /* capability probes never fail a generation; fall back to the default */
      }
    }
    return proposal;
  };

  /**
   * Rebuild the dispatch options from the *resolved* config. `LlmRuntime`
   * rejects a dispatch whose provider/model/reasoningEffort/temperature/
   * maxTokens/stop differ from what `prepareCall` resolved (and applies model
   * defaults such as a reasoning effort or a max-token ceiling), so those six
   * fields must come from `call.config` verbatim — including explicit
   * `undefined` — while everything else comes from the combo's caller.
   */
  const buildInnerOptions = (config, options, signal) => ({
    ...options,
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    stop: config.stop,
    signal,
  });

  const resolvedConfigOf = (call, member) => (
    call !== null && typeof call === 'object' && call.config !== null && typeof call.config === 'object'
      ? call.config
      // Test doubles may hand back only a stream; mirror the proposal so the
      // dispatch still names the member route.
      : { provider: member.provider, model: member.model }
  );

  async function* streamCombo(entry, options) {
    const llm = llmService();
    if (llm === undefined || typeof llm.prepareCall !== 'function') {
      yield errorChunk('failover combos: the llm service is not available', 'NO_ADAPTER');
      return;
    }
    const members = chainFor(entry, rotation);
    if (members.length === 0) {
      yield errorChunk(`combo "${entry.name}" has no model available`, 'COMBO_EMPTY');
      return;
    }
    const attempted = [];
    note(entry, { lastRunAt: new Date().toISOString(), lastOutcome: 'running' });
    let committedAny = false;
    for (let index = 0; index < members.length; index += 1) {
      const member = members[index];
      const label = `${member.provider}/${member.model}`;
      const last = index === members.length - 1;
      if (options.signal?.aborted === true) {
        note(entry, { lastOutcome: 'aborted', lastMember: label });
        yield abortedChunk();
        return;
      }
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      if (options.signal !== undefined && options.signal !== null && typeof options.signal.addEventListener === 'function') {
        options.signal.addEventListener('abort', forwardAbort, { once: true });
      }
      let call;
      try {
        call = await llm.prepareCall(await innerProposal(member, options, controller.signal), controller.signal);
      } catch (error) {
        const failure = failureOf(error);
        attempted.push(`${label} (${failure.code})`);
        logger?.warn?.(`dsh-quota-failover: combo "${entry.name}" skipped ${label}: ${failure.code} ${failure.message}`);
        if (!last && memberFailureAdvances(failure)) continue;
        note(entry, { lastOutcome: 'failed', lastMember: label });
        yield errorChunk(`combo "${entry.name}" exhausted every candidate: ${attempted.join('; ')}`, failure.code);
        return;
      }
      const held = [];
      let committed = false;
      let advanced = false;
      let terminal = undefined;
      try {
        const innerOptions = buildInnerOptions(resolvedConfigOf(call, member), options, controller.signal);
        for await (const chunk of call.stream(innerOptions)) {
          if (chunk !== null && typeof chunk === 'object' && chunk.type === 'finish') {
            const reason = chunk.reason;
            const kind = typeof reason?.kind === 'string' ? reason.kind : 'error';
            // Before the first committed byte any advanceable failure — on any
            // member, including the last — is worth walking past; when members
            // run out the loop below reports the whole chain.
            if (kind === 'error' && !committed && memberFailureAdvances(reason.failure)) {
              attempted.push(`${label} (${failureOf(reason.failure).code})`);
              logger?.warn?.(`dsh-quota-failover: combo "${entry.name}" advanced past ${label}: ${failureOf(reason.failure).code}`);
              advanced = true;
              break;
            }
            terminal = chunk;
            break;
          }
          if (committed) {
            yield chunk;
            continue;
          }
          if (ADVANCE_CHUNK_TYPES.has(chunk?.type)) {
            committed = true;
            committedAny = true;
            for (const buffered of held) yield buffered;
            held.length = 0;
            yield chunk;
            continue;
          }
          held.push(chunk);
        }
      } catch (error) {
        const failure = failureOf(error);
        if (!committed && !last && memberFailureAdvances(failure)) {
          attempted.push(`${label} (${failure.code})`);
          logger?.warn?.(`dsh-quota-failover: combo "${entry.name}" advanced past ${label}: ${failure.code} ${failure.message}`);
          advanced = true;
        } else {
          note(entry, { lastOutcome: 'failed', lastMember: label });
          yield errorChunk(`combo "${entry.name}" member ${label} failed: ${failure.message}`, failure.code);
          return;
        }
      } finally {
        if (options.signal !== undefined && options.signal !== null && typeof options.signal.removeEventListener === 'function') {
          options.signal.removeEventListener('abort', forwardAbort);
        }
      }
      if (advanced) {
        note(entry, { lastOutcome: 'switched', lastMember: label, switches: (stats.get(entry.id)?.switches ?? 0) + 1 });
        continue;
      }
      if (terminal !== undefined) {
        note(entry, {
          lastOutcome: terminal.reason?.kind === 'stop' || terminal.reason?.kind === 'tool-calls' || terminal.reason?.kind === 'max-tokens'
            ? 'ok'
            : (terminal.reason?.kind ?? 'unknown'),
          lastMember: label,
        });
        for (const buffered of held) yield buffered;
        held.length = 0;
        void committedAny;
        yield terminal;
        return;
      }
      // Stream ended with no finish chunk: treat as a truncated member.
      const failure = { message: 'stream ended without a finish reason', code: 'STREAM_CUT' };
      if (!committed && !last && memberFailureAdvances(failure)) {
        attempted.push(`${label} (STREAM_CUT)`);
        note(entry, { lastOutcome: 'switched', lastMember: label });
        continue;
      }
      note(entry, { lastOutcome: 'failed', lastMember: label });
      yield errorChunk(`combo "${entry.name}" member ${label} ended without a finish reason`, 'STREAM_CUT');
      return;
    }
    note(entry, { lastOutcome: 'exhausted' });
    const chunk = errorChunk(`combo "${entry.name}" exhausted every candidate: ${attempted.join('; ')}`, 'SERVER');
    const recorded = { kind: 'combo-exhausted', combo: entry.name, comboId: entry.id, tried: attempted };
    try {
      record?.(recorded);
    } catch {
      /* journal failures never fail a generation */
    }
    yield chunk;
  }

  return {
    provider: COMBO_PROVIDER,

    providerInfo(provider) {
      return { id: provider, name: '额度转移 Combo' };
    },

    providerRetryPolicy() {
      // The combo has already walked its own chain; a kernel retry would pay
      // every member a second time.
      return RETRY_POLICY;
    },

    willAdvance(failure) {
      return memberFailureAdvances(failure);
    },

    async listModels(provider) {
      if (provider !== COMBO_PROVIDER) return [];
      return catalog.listModels();
    },

    async resolveModel(provider, model, signal) {
      if (provider !== COMBO_PROVIDER) {
        const error = new Error(`failover combos: unexpected provider "${provider}"`);
        error.code = 'UNKNOWN_MODEL';
        throw error;
      }
      return catalog.resolveModel(model, signal);
    },

    async prepareCall(provider, model, signal) {
      if (provider !== COMBO_PROVIDER) {
        const error = new Error(`failover combos: unexpected provider "${provider}"`);
        error.code = 'UNKNOWN_MODEL';
        throw error;
      }
      const resolved = await catalog.resolveModel(model, signal);
      const entry = catalog.find(model);
      if (entry === undefined) {
        const error = new Error(`failover combos: no combo "${model}" is configured`);
        error.code = 'UNKNOWN_MODEL';
        throw error;
      }
      return {
        model: resolved,
        stream: (options) => streamCombo(entry, options),
      };
    },

    stats() {
      return [...stats.entries()].map(([id, value]) => ({ id, ...value }));
    },

    /** Called after a config write: drop cursors of deleted combos and re-read info. */
    prune(combos) {
      pruneRotation(rotation, Array.isArray(combos) ? combos : []);
      catalog.invalidate();
    },

    rotationSize() {
      return rotation.size;
    },
  };
}
