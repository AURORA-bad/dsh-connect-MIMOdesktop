/**
 * The MiMo adapter.
 *
 * Mirrors the structure dsh-workbuddy-connect uses to register a provider into
 * the DSH LLM seam:
 *
 *   - a pi-ai provider built by `createProvider` with the OpenAI-completions
 *     API, so DSH drives streaming and tool calls through its normal path,
 *   - a hand-assembled `PiAiAdapter` profile (the internal `resolveProfiles()`
 *     helper is not part of dsh-llm-pi-ai's public surface),
 *   - an `invalidate()` hook so DSH re-lists models after a credential change.
 *
 * Structural difference from the reference: there is no loopback shim. The
 * gateway already speaks OpenAI, so models point straight at it and the
 * credential is supplied per request by the session's cookie header.
 *
 * @module dsh-mimo-connect/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { MIMO_DISPLAY_NAME, MIMO_PROVIDER, displayNameOf } from './catalog.js'
import { MIMO_SERVER } from './session.js'

/** Provider idle ceiling while one stream read is outstanding. */
export const MIMO_STREAM_IDLE_TIMEOUT_MS = 3e5

/**
 * Inert pi-ai auth plane, as in the reference plugin.
 *
 * The MiMo route authenticates exclusively through `resolveApiKey`, which
 * returns the session cookie. pi-ai's ambient discovery must never manufacture
 * a credential for this route, or a stray env var could silently shadow the
 * resolved sign-in.
 */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return []
    },
    async modify() {
      throw new Error('dsh-mimo-connect: the mimo route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false
    },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
}

/**
 * Image-request budgets required by the dsh-llm-pi-ai profile type.
 */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
}

/**
 * Convert one catalog entry into the pi-ai model shape DSH consumes.
 *
 * **No reasoning declaration, deliberately.** Advertising `reasoning: true`
 * makes DSH offer an Off/Minimal/Low/Medium/High picker. Two things are known:
 *
 *   - these models *do* produce chain-of-thought, returned as
 *     `reasoning_content` and surfaced as `thinking_*` stream events;
 *   - **whether the gateway honours any control over it is still unmeasured.**
 *
 * During the desktop free-quota era every control tested left the reasoning
 * token count unchanged (176–237 across runs): `thinking.type=disabled`,
 * `thinking.enabled=false`, `reasoning_effort` (none/low), `enable_thinking=false`
 * and `chat_template_kwargs`.
 *
 * That result has **not** been re-confirmed under the subscription model. A
 * signed-in probe on 2026-10-12 re-ran all six variants against a real account
 * and every one was refused with `403 membership_required` before any tokens
 * were generated — the account has no active subscription, so the comparison
 * produced no data at all. Reporting "all levels identical ⇒ controls ignored"
 * from zero measurements would be a false conclusion, so no such claim is made
 * here.
 *
 * So the field stays omitted, and the reason is *"not measurable yet"* rather
 * than *"measured as ineffective"*. Showing a picker that silently does nothing
 * is worse than showing none; showing one that might work but cannot be checked
 * is not justified either. An account with an active subscription can settle it
 * by sending the six variants by hand; until then the field stays omitted.
 *
 * The `headers` field is the authentication channel: pi-ai spreads
 * `model.headers` into the request it builds from `model.baseUrl`, so the
 * session's cookie header can be attached without a loopback shim.
 *
 * @param info - catalog entry.
 * @param baseUrl - the endpoint this model is served from.
 * @param headers - extra request headers (the cookie header).
 * @returns the pi-ai model descriptor.
 */
export function toPiModel(info, baseUrl, headers = {}) {
  return {
    id: info.id,
    name: displayNameOf(info),
    api: 'openai-completions',
    provider: MIMO_PROVIDER,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
    headers,
  }
}

/**
 * Adapter subclass that reads live catalog state, so a roster change is
 * reflected on the next listing without a re-register.
 */
class MiMoPiAiAdapter extends PiAiAdapter {
  #catalog
  #filter

  /**
   * @param catalog - the catalog holder.
   * @param options - pi-ai adapter options.
   * @param filter - returns the catalog entries this account may use. Read on
   *   every listing, so a settings change reaches the picker without a
   *   re-register (the host re-lists on `llm/adapters-updated`).
   */
  constructor(catalog, options, filter) {
    super(options)
    this.#catalog = catalog
    this.#filter = filter ?? (() => catalog.current())
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  #infoFor(model) {
    return this.#filter().find(entry => entry.id === model)
  }

  /**
   * List models without touching the network.
   *
   * **dsh 0.2.1-rc.2 changed the base implementation.** `PiAiAdapter.listModels`
   * now begins with `await this.config.resolveApiKey(provider, profile)`, and
   * only tolerates a `MISSING_CREDENTIAL` `LlmError`; anything else propagates:
   *
   * ```js
   * try { await this.config.resolveApiKey(provider, profile) }
   * catch (error) {
   *   if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return []
   *   throw error
   * }
   * ```
   *
   * Inheriting that would make this plugin's `resolveApiKey` run a real STS
   * exchange every time a user opens the model picker. Two consequences, both
   * bad: the picker pays a network round trip (measured at 100–170 ms when
   * healthy, seconds when not), and any transient upstream failure — a 401 from
   * an expired `passToken`, a timeout, no subscription — throws out of
   * `listModels` and empties the picker. That is exactly the "provider
   * disappears" failure this plugin exists to avoid.
   *
   * Listing needs no credential at all: the roster comes from this plugin's own
   * catalog, which is the same source `buildModels()` feeds into the snapshot.
   * So this override answers from the catalog directly, mirroring the shape the
   * base class returns.
   *
   * Deliberately **not** implemented by calling the base class's protected
   * `current()` / `profileOf()`: they are reachable at runtime but declared
   * `private`, so relying on them would silently break if the host renamed them.
   * Reading our own catalog has no such coupling.
   *
   * The mint still happens where it is actually required — `resolveApiKey` on
   * the streaming path, which supplies the cookie header for the request.
   */
  async listModels(provider) {
    if (provider !== MIMO_PROVIDER) {
      throw new Error(`dsh-mimo-connect: unknown provider "${provider}"`)
    }
    return this.#filter().map(entry => ({
      provider,
      id: entry.id,
      // The picker shows the catalog's label, which carries the credit
      // multiplier the desktop app displays (e.g. `MiMo V2.6 Flash · x0.40`).
      name: displayNameOf(entry),
      inputModalities: entry.supportsImages === true ? ['text', 'image'] : ['text'],
    }))
  }

  async resolveModel(provider, model, signal) {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.#infoFor(model)
    return info === undefined ? resolved : { ...resolved, name: displayNameOf(info) }
  }
}

/**
 * Build the adapter DSH registers.
 *
 * @param {object} options - the adapter's dependencies.
 * @param options.catalog - the catalog holder.
 * @param options.getSession - returns the session currently in effect. A getter
 *   rather than a session instance, because the session is replaced whenever
 *   the credential changes (sign-in, sign-out, account switch).
 * @param {() => any} [options.resolveAttachments] - returns the host's durable
 *   attachment service. Required whenever a model advertises image input:
 *   dsh-llm-pi-ai throws `UNSUPPORTED_CONTENT` the moment a message carries an
 *   image block and this resolves to undefined.
 * @param {() => any} [options.getFs] - returns the host's filesystem service,
 *   used to map an attachment's normalized copy to a path the model's tools can
 *   read. Entries the host does not expose simply drop the path from the image
 *   handle.
 * @param {Function} [options.resolveImageAccess] - overrides the `getFs`-derived
 *   image-access mapping when a host wants to supply its own.
 * @returns `{ adapter, invalidate }`.
 */
export function createMiMoAdapter(options) {
  const { catalog, getSession, resolveAttachments, resolveImageAccess, getFs } = options
  /**
   * Which catalog entries are enabled.
   *
   * `undefined` (the pre-settings default) means "everything". An empty array is
   * honoured as "nothing enabled" — the settings page can switch every model off,
   * and a picker that silently re-lists them all would be a lie.
   */
  const filter = () => {
    const enabled = options.enabledModels?.()
    if (enabled === undefined || enabled === null) return catalog.current()
    const allowed = new Set(enabled)
    return catalog.current().filter(entry => allowed.has(entry.id))
  }

  const baseUrl = `${MIMO_SERVER}/api/route`
  const chatUrl = `${baseUrl}/chat/completions`

  /**
   * Build the model list, attaching the current cookie header to each model.
   *
   * `getModels` is re-read on every listing, so a renewed `serviceToken`
   * reaches the next request without re-registering the provider.
   */
  const buildModels = () =>
    filter().map(info => toPiModel(info, baseUrl, { Cookie: getSession().jar.headerFor(chatUrl) }))

  const provider = {
    ...createProvider({
      id: MIMO_PROVIDER,
      name: MIMO_DISPLAY_NAME,
      auth: {
        apiKey: {
          name: 'MiMo session cookie',
          async resolve({ credential }) {
            const apiKey = credential?.key
            if (apiKey === undefined || apiKey.length === 0) return undefined
            return { auth: { apiKey }, source: 'MiMo' }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    // Read the roster live, so a change is visible without re-registering.
    getModels: () => buildModels(),
  }

  const profile = {
    provider: MIMO_PROVIDER,
    displayName: MIMO_DISPLAY_NAME,
    streamIdleTimeoutMs: MIMO_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-mimo-connect retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map([[MIMO_PROVIDER, profile]])

  const adapter = new MiMoPiAiAdapter(catalog, {
    profiles: () => profiles,
    auth: INERT_AUTH,
    /**
     * Hand pi-ai an opaque per-request credential.
     *
     * Establishing the session here is what makes the cookie available: pi-ai
     * resolves the API key before streaming, and the model list the request is
     * dispatched with is built inside `streamWithSnapshot` — which reads
     * `getModels()` after this resolves. So the header captured in
     * `buildModels()` reflects the freshly minted `serviceToken`.
     *
     * The returned string itself is inert; the gateway ignores the bearer
     * token and authenticates on the cookie header carried via
     * `model.headers`.
     *
     * This runs on the streaming path, where a real mint is required. It is
     * deliberately **not** how the listing path is answered — see the
     * `listModels` override, which avoids the network entirely.
     */
    resolveApiKey: async () => {
      await getSession().ensureSession()
      return 'mimo-session'
    },
    // The attachment service is what makes image input possible at all: with
    // no resolver, pi-ai rejects any message containing an image block with
    // UNSUPPORTED_CONTENT — including a text-only turn in a conversation whose
    // earlier tool results carried images.
    ...(resolveAttachments === undefined ? {} : { resolveAttachments: () => resolveAttachments() }),
    /**
     * Host-side image access, wired the same way `dsh-llm-pi-ai` wires its own:
     *
     * ```js
     * resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
     *   attachments,
     *   (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath),
     *   ref,
     * )
     * ```
     *
     * dsh-llm-pi-ai resolves this only after it has already established that the
     * durable attachment service is present, and a missing mapping degrades to a
     * handle without a local path (`requestImageHandleText`) rather than failing
     * the turn — the base64 payload is embedded from
     * `attachments.readImageRequest()` regardless. Bridging `fs` is what adds
     * the normalized copy's read-only path to that handle.
     */
    resolveImageAccess:
      resolveImageAccess === undefined
        ? (attachments, ref) =>
            resolveImageAttachmentAccess(
              attachments,
              hostPath => getFs?.()?.processPathFromHostPath(hostPath),
              ref,
            )
        : (attachments, ref) => resolveImageAccess(attachments, ref),
  }, filter)

  return {
    adapter,
    invalidate: () => {
      profiles = new Map([[MIMO_PROVIDER, profile]])
    },
  }
}
