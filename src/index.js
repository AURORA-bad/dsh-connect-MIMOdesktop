/**
 * DSH MiMo Connect — bring Xiaomi MiMo models into DeepSeek Harness.
 *
 * The plugin resolves a MiMo credential in two ways, in priority order:
 *
 *   1. its own saved sign-in (`$DSH_HOME/.mimo-connect-auth.json`)
 *   2. the Xiaomi MiMo desktop app's cookie database (read-only)
 *
 * A machine that already has a signed-in desktop app therefore needs no
 * configuration and sees no prompt: the provider appears with its models.
 * Only when neither source yields a credential does the plugin tell the user to
 * run its `login` command.
 *
 * There is no background service, no autostart entry, and no local proxy.
 *
 * @module dsh-mimo-connect
 */

import Schema from '@deepseek-ai/schemastery'
import { MiMoCredentialStore } from './credential.js'
import { MiMoCatalog, MIMO_PROVIDER, FALLBACK_MIMO_MODELS } from './catalog.js'
import { MiMoSession, MIMO_SERVER } from './session.js'
import { createMiMoAdapter } from './adapter.js'
import { MiMoQuotaReader } from './quota.js'
import { MiMoAccountPool } from './accounts.js'
import { readSettings, normalizePollMs, normalizePlacement, POLL_CHOICES_MS, SETTINGS_DEFAULTS } from './settings.js'

/** Stable Cordis plugin name. */
export const name = 'llm-mimo'

/** The model registry required before the provider can register. */
export const inject = ['llm']

/** Exact Fetch route the browser half reads the remaining quota from. */
export const QUOTA_ROUTE = '/api/mimo.quota'

/** Settings route: read the settings document, write one field. */
export const SETTINGS_ROUTE = '/api/mimo.settings'

/** Account-pool route: list, add, remove, activate, set membership. */
export const POOL_ROUTE = '/api/mimo.pool'

/** Probe route: send one minimal real request through a chosen model. */
export const TEST_ROUTE = '/api/mimo.test'

/**
 * Deadline for the probe request.
 *
 * Generous on purpose: the probe exists to prove reachability, and a cold
 * gateway plus a queue can take far longer than an ordinary turn would.
 */
const PROBE_TIMEOUT_MS = 60000

/** Plugin configuration. */
export const Config = Schema.object({
  /** Override the desktop cookie database path (see MIMO_COOKIE_DB). */
  cookieDb: Schema.string().default(''),
  /**
   * Legacy cadence knob, in seconds.
   *
   * Superseded by `pollIntervalMs`, which offers the same choices the settings
   * page renders. Kept so an existing config file keeps working; ignored when
   * `pollIntervalMs` is set.
   */
  pollSeconds: Schema.number().default(0),
  /** Whether the provider is listed at all. */
  providerEnabled: Schema.boolean().default(true).extra('volatile', true),
  /** Whether the composer dock shows the quota readout. */
  showQuotaInComposer: Schema.boolean().default(true).extra('volatile', true),
  /**
   * Which seat the readout renders in: `dock` (the stats row below the
   * composer) or `input` (the trailing controls before the model picker).
   */
  quotaPlacement: Schema.string().default('dock').extra('volatile', true),
  /** Whether the sidebar carries a MiMo panel row. */
  sidebarPanel: Schema.boolean().default(false).extra('volatile', true),
  /**
   * Credential/roster re-check cadence, in milliseconds.
   *
   * One of {@link POLL_CHOICES_MS}; anything else falls back to the default, so
   * a hand-edited config cannot turn the poll loop into a busy loop.
   */
  pollIntervalMs: Schema.number().default(SETTINGS_DEFAULTS.pollIntervalMs).extra('volatile', true),
  /**
   * Model ids the picker offers.
   *
   * `null` (absent) means "everything the catalog holds", which is the
   * pre-settings behaviour. An explicit list narrows it; an empty list means
   * none, and is honoured rather than read as "all".
   */
  enabledModels: Schema.array(Schema.string()).default(null).extra('volatile', true),
})

/**
 * Register the MiMo provider with DSH.
 *
 * @param ctx - the Cordis plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const cookieDb = typeof config?.cookieDb?.get === 'function'
    ? String(config.cookieDb.get() ?? '').trim()
    : typeof config?.cookieDb === 'string' ? config.cookieDb.trim() : ''
  const store = new MiMoCredentialStore(cookieDb.length > 0 ? { cookieCandidates: [cookieDb] } : {})
  const catalog = new MiMoCatalog()
  // The pool owns account rotation; with an empty pool it defers to `store`,
  // which is the pre-pool single-credential path.
  const pool = new MiMoAccountPool({ store })
  const settings = readSettings(config)

  /**
   * Settings reads go through the settings service when it is up, so a value
   * saved from the page is visible to the next read without a plugin reload;
   * the apply-time snapshot is only the fallback.
   */
  const liveSettings = () => {
    try {
      const target = ctx.get('settings')
      // A descriptor carries the resolved value; there is no `get(ns)` on the
      // settings service, so reading the row is the live path.
      const row = target?.describe?.().find(r => String(r.ns).includes('mimo'))
      return row === undefined ? settings : readSettings(row.value ?? row.user ?? row.base)
    } catch {
      return settings
    }
  }

  // This plugin renders its own settings page, so the host's auto-generated
  // form would be a duplicate one. Declaring the policy is also what makes the
  // fields writable through the settings service at all: a namespace with no
  // declared presentation is not editable from another plugin's route.
  ctx.inject(['settings'], scope => {
    ctx.effect(() => scope.settings.configure({ auto: false }, ctx.fiber))
  })

  // The session is rebuilt whenever the credential identity changes, so a
  // sign-out or account switch cannot leave a stale cookie jar in place.
  let session = new MiMoSession({})
  let currentIdentity

  /**
   * The credential identity the gateway roster was last fetched for.
   *
   * The roster is per-account, not per-turn, so this guards the poll loop from
   * re-asking the gateway every `pollSeconds`. Cleared when the identity
   * changes so a different account gets its own roster.
   */
  let rosterFetchedFor

  // Reads the account's remaining quota. The getter keeps it
  // pointed at whatever session is current, so a credential swap is picked up
  // without rebuilding the reader.
  const quota = new MiMoQuotaReader({ getSession: () => session })

  let stopped = false
  const timers = []

  /** Release handle for the registered adapter, once registration succeeds. */
  let releaseAdapter
  let registered = false

  const { adapter, invalidate } = createMiMoAdapter({
    catalog,
    getSession: () => session,
    // Read live, so a settings change reaches the picker on the next listing.
    enabledModels: () => liveSettings().enabledModels,
    /**
     * The host's durable attachment service, resolved lazily.
     *
     * dsh-llm-pi-ai throws `UNSUPPORTED_CONTENT` the moment a message carries
     * an image block and this returns undefined — and that includes a text-only
     * turn in a conversation whose earlier tool results contained images, which
     * is how a plain "你好" can fail right after a model switch.
     *
     * `ctx.get` is used rather than `ctx.inject` because the adapter is built
     * once at apply time, before inject callbacks run; a getter keeps the
     * lookup deferred until the service is actually needed.
     */
    resolveAttachments: () => ctx.get('attachments'),
    /**
     * The host's filesystem service, resolved lazily, for the model-facing
     * image handle.
     *
     * dsh-llm-pi-ai's own wiring maps an attachment's normalized copy to a path
     * the tools can read (`processPathFromHostPath`). Passing this getter keeps
     * that behaviour; when the service is absent the handle simply omits the
     * path instead of failing the turn.
     */
    getFs: () => ctx.get('fs'),
  })

  /**
   * Point the session at whatever credential is now in effect.
   *
   * @returns the resolved credential, or undefined when signed out.
   */
  const adoptCredential = async () => {
    const resolved = await pool.resolve()
    const status =
      resolved === undefined
        ? await store.status()
        : { signedIn: true, credential: resolved }
    if (!status.signedIn) {
      if (currentIdentity !== undefined) {
        currentIdentity = undefined
        rosterFetchedFor = undefined
        session = new MiMoSession({})
        quota.invalidate()
        invalidate()
      }
      return undefined
    }

    const identity = store.identityOf(status.credential)
    if (identity !== currentIdentity) {
      currentIdentity = identity
      // A different account may be entitled to a different roster; refetch it.
      rosterFetchedFor = undefined
      session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(status.credential) })
      // A different account has a different allowance; drop the old figure.
      quota.invalidate()
      invalidate()
      ctx.emit('llm/adapters-updated')
      return status.credential
    }

    // The stored credential is unchanged, but the jar may have been emptied from
    // the server side: a rejected credential is revoked with `passToken=EXPIRED`,
    // which the jar deletes. Identity comparison cannot see that, because it only
    // reads the file on disk — so without this the plugin would sit in
    // "signed in but can never mint" until DSH restarted. Re-seed when the
    // passport cookie the mint depends on has gone missing.
    if (!session.hasPassport()) {
      session = new MiMoSession({ jar: MiMoCredentialStore.jarFor(status.credential) })
      quota.invalidate()
      invalidate()
    }
    return status.credential
  }

  /**
   * Reconcile against the currently available credential.
   *
   * Establishing the session eagerly means the first turn does not pay the
   * redirect-chain latency, and a broken credential surfaces at startup rather
   * than mid-conversation.
   *
   * Once a session exists, the model roster is refreshed from the gateway. That
   * is what keeps the picker honest: the built-in snapshot exists only so the
   * provider can register before the network is touched, and it is replaced as
   * soon as the gateway can be asked. A failed refresh is not an error — the
   * snapshot is a working fallback, and `catalog.source()` keeps reporting
   * `'builtin'` so the unverified state stays visible.
   *
   * The roster is also re-read whenever the credential identity changes (see
   * `adoptCredential`), because a different account may be entitled to a
   * different set of models.
   */
  /**
   * In-flight sync, if any.
   *
   * The poll loop fires on a timer with `void sync()`, so a sweep that outlives
   * the interval would otherwise stack: each stale sweep re-runs the credential
   * read and can start its own session mint and catalog refresh against the
   * same session. Re-entrant callers join the running sweep instead.
   */
  let syncing

  const sync = async () => {
    if (stopped) return
    if (syncing !== undefined) return syncing
    syncing = runSync().finally(() => {
      syncing = undefined
    })
    return syncing
  }

  const runSync = async () => {
    const credential = await adoptCredential()
    if (credential === undefined) return
    try {
      await session.ensureSession()
    } catch (error) {
      ctx.logger.warn(
        'dsh-mimo-connect: 会话建立失败，将在下次请求时重试',
        error instanceof Error ? error.message : String(error),
      )
      return
    }

    // Only ask once per credential identity: the roster is not per-turn state,
    // and the poll loop re-enters here every `pollSeconds`.
    if (rosterFetchedFor === currentIdentity) return
    try {
      const adopted = await catalog.refreshFromGateway(session)
      rosterFetchedFor = currentIdentity
      if (adopted) {
        // The picker must re-list with the gateway's roster, not the snapshot.
        invalidate()
        ctx.emit('llm/adapters-updated')
      }
    } catch (error) {
      ctx.logger.warn(
        'dsh-mimo-connect: 模型清单刷新失败，继续使用内置清单',
        error instanceof Error ? error.message : String(error),
      )
    }
  }

  /** Mount the provider once, then keep it in sync with the credential. */
  const start = () => {
    if (!settings.providerEnabled) {
      // Switched off in the settings page: no provider, no polling, no network.
      // The routes stay mounted so the page can switch it back on.
      ctx.logger.info('dsh-mimo-connect: provider disabled in settings')
      return
    }
    let registrationError
    try {
      releaseAdapter = ctx.llm.registerAdapter([MIMO_PROVIDER], adapter)
      registered = true
      ctx.effect(() => () => {
        releaseAdapter?.()
        releaseAdapter = undefined
        registered = false
      })
    } catch (error) {
      registrationError = error instanceof Error ? error.message : String(error)
      ctx.logger.error('dsh-mimo-connect: provider registration failed', error)
    }

    if (!registered) return

    void sync()

    // `pollIntervalMs` supersedes the legacy `pollSeconds`; an explicit 0 still
    // disables polling for anyone who wants a single startup sweep.
    const legacyRaw = typeof config?.pollSeconds?.get === 'function' ? config.pollSeconds.get() : config?.pollSeconds
    const legacySeconds = Math.max(0, Number(legacyRaw) || 0)
    const pollMs = legacySeconds > 0 ? legacySeconds * 1000 : normalizePollMs(settings.pollIntervalMs)
    if (pollMs > 0) {
      const timer = setInterval(() => {
        void sync()
      }, pollMs)
      timer.unref?.()
      timers.push(timer)
    }
  }

  start()

  // Tear down timers with the plugin instance. Stop first, so an in-flight sync
  // cannot start new work, and clear timers before the loop closes.
  ctx.effect(() => () => {
    stopped = true
    for (const timer of timers) clearInterval(timer)
    timers.length = 0
  })

  // Serve the remaining quota to the browser half.
  //
  // `connection.fetch.register` puts an exact path behind the same
  // browser-session fence every other `/api` route sits behind, so the client
  // can read it with a plain `fetch`. The route exists only while this plugin
  // is loaded, and degrades to `available: false` rather than an error status:
  // the composer pill simply does not render when there is nothing to show.
  //
  // `ctx.inject` is used rather than adding `connection` to the plugin's own
  // `inject` list, because the service is optional: a host assembled without a
  // browser connection (a headless run, or the CLI) has none, and that must not
  // hold back provider registration. A scoped inject stays pending until the
  // service appears, so the route mounts whenever a browser exists.
  ctx.inject(['connection'], scope => {
    const json = (body, status = 200) =>
      Response.json(body, { status, headers: { 'cache-control': 'no-store' } })

    scope.connection.fetch.register({
      path: QUOTA_ROUTE,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async request => {
        const reading = await quota.read({ signal: request.signal })
        if (reading === undefined) {
          return json({ available: false })
        }
        return json({ available: true, ...reading })
      },
    })

    // Settings read/write. The browser half renders the page; this route is the
    // only way it can see or change a value, because the settings document
    // lives in the plugin's resolved config on the node side.
    scope.connection.fetch.register({
      path: SETTINGS_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async request => {
        if (request.method === 'GET') {
          return json({
            ok: true,
            values: liveSettings(),
            pollChoices: POLL_CHOICES_MS,
            catalog: catalog.current().map(entry => ({
              id: entry.id,
              name: entry.name,
              supportsImages: entry.supportsImages === true,
            })),
            catalogSource: catalog.source(),
          })
        }
        const body = await request.json().catch(() => undefined)
        const field = body?.field
        const allowed = new Set([
          'providerEnabled',
          'showQuotaInComposer',
          'quotaPlacement',
          'sidebarPanel',
          'pollIntervalMs',
          'enabledModels',
        ])
        if (typeof field !== 'string' || !allowed.has(field)) {
          return json({ ok: false, error: 'unknown field' }, 400)
        }
        const target = ctx.get('settings')
        if (target === undefined) return json({ ok: false, error: 'settings service unavailable' }, 503)
        try {
          const row = target.describe().find(r => String(r.ns).includes('mimo'))
          if (row === undefined) return json({ ok: false, error: 'mimo namespace missing' }, 503)
          const value =
            field === 'pollIntervalMs'
              ? normalizePollMs(body.value)
              : field === 'quotaPlacement'
                ? normalizePlacement(body.value)
                : body.value
          await target.mutate(row.ns, [{ op: 'set', path: [field], value }], undefined)
          return json({ ok: true, field, value })
        } catch (error) {
          return json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            500,
          )
        }
      },
    })

    // Account pool. Secrets never leave the node side: the list is masked, and
    // a write accepts a token but never echoes it back.
    scope.connection.fetch.register({
      path: POOL_ROUTE,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: async request => {
        if (request.method === 'GET') {
          return json({ ok: true, accounts: pool.list(), path: pool.path() })
        }
        const body = await request.json().catch(() => undefined)
        const action = body?.action
        try {
          if (action === 'add') {
            const id = pool.add({
              passToken: body.passToken,
              cUserId: body.cUserId,
              userId: body.userId,
              label: body.label,
            })
            return json({ ok: true, id, accounts: pool.list() })
          }
          if (action === 'remove') {
            pool.remove(String(body.id ?? ''))
            return json({ ok: true, accounts: pool.list() })
          }
          if (action === 'activate') {
            const ok = pool.activate(String(body.id ?? ''))
            return json({ ok, accounts: pool.list() })
          }
          if (action === 'pool') {
            const ids = pool.setPool(Array.isArray(body.ids) ? body.ids : [])
            return json({ ok: true, pool: ids, accounts: pool.list() })
          }
          return json({ ok: false, error: 'unknown action' }, 400)
        } catch (error) {
          return json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            400,
          )
        }
      },
    })

    // Probe one model with a real, minimal request.
    //
    // The reference plugin's "test" button sends ~25k tokens to smoke out rate
    // limiting. That is not affordable here and not useful either: MiMo bills by
    // subscription allowance, and the only thing worth proving is that this
    // credential can reach a completion at all. So the probe asks for a single
    // token and reports the round trip plus whatever the gateway said.
    scope.connection.fetch.register({
      path: TEST_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async request => {
        const body = await request.json().catch(() => undefined)
        const model = typeof body?.model === 'string' ? body.model : undefined
        if (model === undefined || !catalog.has(model)) {
          return json({ ok: false, error: 'unknown model' }, 400)
        }
        const startedAt = Date.now()
        try {
          await session.ensureSession()
          const response = await session.request(`${MIMO_SERVER}/api/route/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'text/event-stream, application/json',
            },
            body: JSON.stringify({
              model,
              stream: false,
              max_tokens: 1,
              messages: [{ role: 'user', content: 'ping' }],
            }),
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          })
          const text = await response.text()
          const elapsedMs = Date.now() - startedAt
          if (!response.ok) {
            // Surface the gateway's own words: they distinguish an expired
            // cookie from a missing subscription from a rate limit, and the
            // person reading the page can act on that.
            return json({
              ok: false,
              status: response.status,
              elapsedMs,
              error: text.slice(0, 400),
            })
          }
          return json({ ok: true, status: response.status, elapsedMs })
        } catch (error) {
          return json({
            ok: false,
            elapsedMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      },
    })
  })

  /** Build the non-secret status document used by diagnostics. */
  const statusDocument = async () => {
    const status = await store.status()
    return {
      signedIn: status.signedIn,
      ...(status.signedIn
        ? {
            account: {
              userId: status.credential.userId,
              cUserId: status.credential.cUserId,
              // Which source answered: 'plugin' or 'desktop'.
              source: status.credential.source,
              ...(status.credential.cookiePath === undefined
                ? {}
                : { cookiePath: status.credential.cookiePath }),
            },
          }
        : { reason: status.reason }),
      registered,
      session: session.describe(),
      catalog: {
        source: catalog.source(),
        models: catalog.current().map(entry => entry.id),
      },
      settings: liveSettings(),
      pool: {
        path: pool.path(),
        accounts: pool.list(),
        activeId: pool.doc().active || null,
      },
      cookieCandidates: store.cookieCandidates(),
      ownCredentialPath: store.ownPath(),
      // Cache-only: reading the status must not issue an outbound request.
      quota: quota.peek(),
    }
  }

  // Expose the status as a COMPUTED context property.
  //
  // `ctx` is a cordis proxy: a bare `ctx.status = fn` is read as a service
  // write and throws `cannot set property "status" without provide`, which
  // takes the entire plugin tree down. `ctx.accessor` is the supported way to
  // declare a derived, read-only value.
  try {
    ctx.accessor('mimoStatus', { get: () => statusDocument })
  } catch (error) {
    // Never let a diagnostics surface break plugin loading.
    ctx.logger.warn('dsh-mimo-connect: could not expose the mimoStatus accessor', error)
  }
}

export { MIMO_PROVIDER, FALLBACK_MIMO_MODELS }
