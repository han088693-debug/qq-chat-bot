/**
 * Build a SessionRouter from the bridge's `socialV2.sessionPolicies` config block.
 *
 * Why this is its own module: the routing decision itself lives in
 * `session-router.mjs` (pure, no IO), but the *translation* from the operator's
 * config shape into router state is where the interesting mistakes live — a
 * partial record, a preset that belongs to another mode, a `closed-agent`
 * override aimed at a group. Keeping that translation pure and tested here means
 * the bridge only has to catch, log, and fall back.
 *
 * Contract:
 *  - `overrides` is `{ [conversationKey]: { mode?, preset?, model?, reasoningEffort? } }`.
 *  - Missing `mode` inherits the process-global mode; missing `preset` inherits the
 *    first preset that mode allows (so an override that only pins `model` or
 *    `reasoningEffort` stays a policy *refinement*, not a preset switch).
 *  - Anything the router would refuse (unknown preset for the mode, `closed-agent`
 *    outside the owner's private chat) is refused here too, by construction — this
 *    function never widens what `SessionRouter` allows.
 */

import { SessionRouter, createInitialConversationState } from './session-router.mjs';

/**
 * @param {object} options
 * @param {number|string|null} options.ownerQQ
 * @param {string} options.currentMode   process-global mode (legacy spelling ok)
 * @param {object} options.overrides     `socialV2.sessionPolicies`
 * @returns {SessionRouter}
 */
export function buildSessionRouterFromOverrides({ ownerQQ = null, currentMode = 'reserved2', overrides = {} } = {}) {
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('sessionPolicies must be an object');
  }
  // Defaults-only state first: its preset table is the authoritative "which presets
  // may this mode use" answer, and it is the same table the router will validate against.
  const baseState = createInitialConversationState(ownerQQ, {
    defaultMode: currentMode,
    closedAgentEnabled: false,
  });
  const presetTable = new SessionRouter({ ownerQQ, defaultMode: currentMode, state: baseState }).modePresets;
  // `createInitialConversationState` folds legacy simulation spellings onto
  // `simulation`, whose preset list leads with the QSH names — this deployment
  // installs `qq-chat-v2` instead. Point the fallback at the preset the mode the
  // bridge actually runs (e.g. `reserved2`) resolves to, so a policy read for a
  // conversation without an override names a preset that exists.
  const requestedPresets = presetTable[currentMode];
  if (requestedPresets) baseState.defaults = { ...baseState.defaults, preset: requestedPresets[0] };

  const conversations = {};
  for (const [rawKey, record] of Object.entries(overrides)) {
    if (record === null || typeof record !== 'object' || Array.isArray(record)) {
      throw new TypeError(`sessionPolicies[${rawKey}] must be an object`);
    }
    const key = String(rawKey).trim();
    const mode = record.mode === undefined || record.mode === null
      ? currentMode
      : String(record.mode).trim();
    const allowed = presetTable[mode];
    if (!allowed) throw new TypeError(`sessionPolicies[${key}] uses unknown mode ${mode}`);
    const preset = record.preset === undefined || record.preset === null
      ? allowed[0]
      : String(record.preset).trim();
    const model = record.model === undefined ? null : record.model;
    const reasoningEffort = record.reasoningEffort === undefined ? null : record.reasoningEffort;
    conversations[key] = {
      mode,
      preset,
      model,
      reasoningEffort,
      // Config-level records were written by the operator (or the console endpoint),
      // which is the `console` actor as far as the router's audit trail is concerned.
      updatedBy: 'console',
    };
  }

  return new SessionRouter({ ownerQQ, defaultMode: currentMode, state: { ...baseState, conversations } });
}

/**
 * Fingerprint stored next to each DSH session id. A change in any component
 * means "this session was built for a different policy" and it gets retired.
 *
 * Compatibility rule (learned the hard way): sessions created before
 * per-conversation overrides existed were stamped with a THREE-element array.
 * Appending an empty fourth element unconditionally makes every existing
 * `state/sessions.json` fingerprint stale, so the next message retires a
 * perfectly healthy DSH session and rebuilds it — losing all its context. So
 * the fourth element exists only when the conversation actually has an override.
 *
 * @param {object} options
 * @param {string} options.mode
 * @param {string|null} options.preset
 * @param {number|string|null} [options.ownerQQ]
 * @param {{mode:string,preset:string|null,model:string|null,reasoningEffort:string|null}|null} [options.override]
 * @returns {string}
 */
export function sessionPolicyFingerprint({ mode, preset, ownerQQ = null, override = null } = {}) {
  const parts = [mode, preset ?? '', mode === 'closed-agent' ? ownerQQ : null];
  if (override) {
    parts.push(JSON.stringify([
      override.mode ?? null,
      override.preset ?? null,
      override.model ?? null,
      override.reasoningEffort ?? null,
    ]));
  }
  return JSON.stringify(parts);
}
