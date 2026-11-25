/**
 * MiMo account pool.
 *
 * The upstream channel offers no account-list API and no credit balance, so the
 * pool is a **local** roster: the user registers several passport triples, and
 * the plugin rotates between them when one is refused. Everything the pool
 * knows about an account is either typed in by the user or measured from
 * `/api/user/usage` — nothing is inferred from an upstream field that does not
 * exist.
 *
 * Rotation rules, mirroring the reference plugin where the data allows it:
 *
 *   - only members the user explicitly put in the pool are candidates;
 *   - an account refused by the gateway (401/403, or a revoked `passToken`)
 *     cools down for {@link FAILURE_COOLDOWN_MS} and the next member is tried;
 *   - an HTTP 400 is **not** a credential problem and never rotates;
 *   - with an empty pool the single credential from `credential.js` (plugin
 *     file or the desktop app) is used, so an existing install keeps working
 *     untouched.
 *
 * @module dsh-connect-mimo/accounts
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  chmodSync,
  unlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Pool file name under `$DSH_HOME`. */
export const POOL_FILENAME = '.mimo-connect-pool.json'

/** Current on-disk format. */
export const POOL_FORMAT_VERSION = 1

/** How long a refused account stays out of rotation. */
export const FAILURE_COOLDOWN_MS = 5 * 60 * 1000

/**
 * Absolute path of the pool file.
 *
 * @param env - environment to read.
 * @returns absolute path.
 */
export function poolPath(env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  return join(home, POOL_FILENAME)
}

/** Mask a secret for display: keep the length signal, drop the value. */
export function maskSecret(value) {
  if (typeof value !== 'string' || value.length === 0) return ''
  if (value.length <= 8) return '****'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/**
 * Read the pool document, tolerating a missing or corrupt file.
 *
 * A broken file must never take the provider down: an empty pool simply means
 * "use the single credential", which is the pre-pool behaviour.
 */
function readPoolDoc(path) {
  try {
    if (!existsSync(path)) {
      return { version: POOL_FORMAT_VERSION, accounts: [], pool: [], active: '', cooldowns: {} }
    }
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed === null || typeof parsed !== 'object') throw new Error('not an object')
    const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : []
    const pool = Array.isArray(parsed.pool) ? parsed.pool.filter(id => typeof id === 'string') : []
    // Cooldowns are persisted so a restart does not immediately re-hit an
    // account the gateway just refused. Expired entries are dropped on read:
    // the file is a hint, and a stale one must not bench a healthy account.
    const cooldowns = {}
    const now = Date.now()
    if (parsed.cooldowns !== null && typeof parsed.cooldowns === 'object') {
      for (const [id, until] of Object.entries(parsed.cooldowns)) {
        if (typeof until === 'number' && Number.isFinite(until) && until > now) cooldowns[id] = until
      }
    }
    return {
      version: POOL_FORMAT_VERSION,
      accounts: accounts.filter(
        a => a !== null && typeof a === 'object' && typeof a.passToken === 'string' && a.passToken.length > 0,
      ),
      pool,
      active: typeof parsed.active === 'string' ? parsed.active : '',
      cooldowns,
    }
  } catch {
    return { version: POOL_FORMAT_VERSION, accounts: [], pool: [], active: '', cooldowns: {} }
  }
}

/** Persist atomically and owner-only. */
function writePoolDoc(path, doc) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(tmp, JSON.stringify({ ...doc, version: POOL_FORMAT_VERSION }, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
  } catch (error) {
    try {
      unlinkSync(tmp)
    } catch {}
    throw error
  }
  try {
    chmodSync(path, 0o600)
  } catch {}
}

/**
 * The pool.
 *
 * Owns no session and performs no network I/O. It answers one question — "which
 * credential should the next request use" — and records which ones the gateway
 * refused.
 */
export class MiMoAccountPool {
  #env
  #path
  #store

  /**
   * @param options - the pool's dependencies.
   * @param options.store - the single-credential resolver, used when the pool
   *   is empty and as the source of the desktop-app credential.
   * @param [options.env] - environment, for tests.
   * @param [options.path] - pool file override, for tests.
   */
  constructor(options = {}) {
    this.#store = options.store
    this.#env = options.env ?? process.env
    this.#path = options.path ?? poolPath(this.#env)
  }

  /** Path of the pool file. */
  path() {
    return this.#path
  }

  /** The raw document, for diagnostics. */
  doc() {
    return readPoolDoc(this.#path)
  }

  /**
   * Accounts, in pool order, with the measured cooldown state.
   *
   * Secrets are masked: this list is rendered in the settings page and written
   * to the diagnostics route, neither of which may carry a live token.
   */
  list() {
    const doc = this.doc()
    const now = Date.now()
    return doc.accounts.map(account => {
      const coolingUntil = doc.cooldowns[account.id] ?? 0
      return {
        id: account.id,
        label: account.label ?? '',
        cUserId: account.cUserId ?? '',
        userId: account.userId ?? '',
        savedAtMs: typeof account.savedAtMs === 'number' ? account.savedAtMs : undefined,
        passTokenMasked: maskSecret(account.passToken),
        inPool: doc.pool.includes(account.id),
        active: doc.active === account.id,
        cooling: coolingUntil > now,
        coolingUntilMs: coolingUntil > now ? coolingUntil : undefined,
      }
    })
  }

  /** Whether the pool holds at least one account. */
  hasAccounts() {
    return this.doc().accounts.length > 0
  }

  /**
   * Add an account and put it in the pool.
   *
   * Adding the same passport twice is a no-op that returns the existing id, so
   * a double-click cannot fork one account into two rows.
   *
   * @param entry - the passport triple plus an optional label.
   * @returns the account id.
   */
  add(entry) {
    const passToken = typeof entry?.passToken === 'string' ? entry.passToken.trim() : ''
    if (passToken.length === 0) throw new Error('passToken 不能为空')
    const doc = this.doc()
    const existing = doc.accounts.find(a => a.passToken === passToken)
    if (existing !== undefined) {
      if (!doc.pool.includes(existing.id)) {
        doc.pool.push(existing.id)
        writePoolDoc(this.#path, doc)
      }
      return existing.id
    }
    const id = `a${randomUUID().slice(0, 8)}`
    doc.accounts.push({
      id,
      label: typeof entry.label === 'string' ? entry.label : '',
      passToken,
      cUserId: typeof entry.cUserId === 'string' ? entry.cUserId : '',
      userId: typeof entry.userId === 'string' ? entry.userId : '',
      savedAtMs: Date.now(),
    })
    doc.pool.push(id)
    if (doc.active.length === 0) doc.active = id
    writePoolDoc(this.#path, doc)
    return id
  }

  /** Remove an account from the roster entirely. */
  remove(id) {
    const doc = this.doc()
    doc.accounts = doc.accounts.filter(a => a.id !== id)
    doc.pool = doc.pool.filter(pid => pid !== id)
    if (doc.active === id) doc.active = doc.pool[0] ?? ''
    delete doc.cooldowns[id]
    writePoolDoc(this.#path, doc)
    return true
  }

  /** Make one account the active one. */
  activate(id) {
    const doc = this.doc()
    if (!doc.accounts.some(a => a.id === id)) return false
    doc.active = id
    if (!doc.pool.includes(id)) doc.pool.push(id)
    writePoolDoc(this.#path, doc)
    return true
  }

  /**
   * Replace the pool membership.
   *
   * An empty list is allowed and means "no rotation": the active account is
   * still used, it just has nowhere to rotate to.
   */
  setPool(ids) {
    const doc = this.doc()
    const known = new Set(doc.accounts.map(a => a.id))
    doc.pool = (Array.isArray(ids) ? ids : []).filter(id => known.has(id))
    if (doc.active.length > 0 && !known.has(doc.active)) doc.active = doc.pool[0] ?? ''
    if (doc.active.length === 0) doc.active = doc.pool[0] ?? ''
    writePoolDoc(this.#path, doc)
    return doc.pool
  }

  /**
   * Record that the gateway refused an account.
   *
   * Written to disk, not held in memory: a restart used to forget the cooldown
   * and immediately re-hit the account that had just answered 403.
   */
  reportFailure(id) {
    if (typeof id !== 'string' || id.length === 0) return
    const doc = this.doc()
    doc.cooldowns[id] = Date.now() + FAILURE_COOLDOWN_MS
    writePoolDoc(this.#path, doc)
  }

  /** Record that an account answered, clearing any cooldown. */
  reportSuccess(id) {
    if (typeof id !== 'string') return
    const doc = this.doc()
    if (doc.cooldowns[id] === undefined) return
    delete doc.cooldowns[id]
    writePoolDoc(this.#path, doc)
  }

  /** Whether an account is currently cooling down. */
  isCooling(id) {
    return (this.doc().cooldowns[id] ?? 0) > Date.now()
  }

  /**
   * The credential to use right now.
   *
   * Order: the active account, then pool members that are not cooling down,
   * then — when the pool is empty — the single credential from
   * `credential.js`.
   *
   * @returns the credential, or undefined when nothing is available.
   */
  async resolve() {
    const doc = this.doc()
    const byId = new Map(doc.accounts.map(a => [a.id, a]))
    const ordered = []
    if (doc.active.length > 0 && byId.has(doc.active)) ordered.push(byId.get(doc.active))
    for (const id of doc.pool) {
      const account = byId.get(id)
      if (account !== undefined && !ordered.includes(account)) ordered.push(account)
    }

    for (const account of ordered) {
      if (this.isCooling(account.id)) continue
      return {
        passToken: account.passToken,
        cUserId: account.cUserId ?? '',
        userId: account.userId ?? '',
        source: 'pool',
        accountId: account.id,
      }
    }

    // Every member is cooling down: rather than fail, use the active one. A
    // cooldown is a hint, not a verdict — the gateway may have recovered.
    if (ordered.length > 0) {
      const fallback = ordered[0]
      return {
        passToken: fallback.passToken,
        cUserId: fallback.cUserId ?? '',
        userId: fallback.userId ?? '',
        source: 'pool',
        accountId: fallback.id,
      }
    }

    const status = await this.#store.status()
    return status.signedIn ? { ...status.credential, accountId: 'default' } : undefined
  }

  /**
   * The next credential after one that just failed.
   *
   * @param failedId - the account id that was refused.
   * @returns the next credential, or undefined when there is no alternative.
   */
  async rotate(failedId) {
    this.reportFailure(failedId)
    const doc = this.doc()
    const byId = new Map(doc.accounts.map(a => [a.id, a]))
    const ordered = doc.pool.map(id => byId.get(id)).filter(a => a !== undefined)
    for (const account of ordered) {
      if (account.id === failedId) continue
      if (this.isCooling(account.id)) continue
      doc.active = account.id
      writePoolDoc(this.#path, doc)
      return {
        passToken: account.passToken,
        cUserId: account.cUserId ?? '',
        userId: account.userId ?? '',
        source: 'pool',
        accountId: account.id,
      }
    }
    return undefined
  }
}
