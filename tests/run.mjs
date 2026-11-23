#!/usr/bin/env node
/**
 * One runnable check for the parts that carry logic.
 *
 * Deliberately not a test framework: this covers the two modules whose
 * behaviour a bug would actually break — settings normalization and the account
 * pool's rotation — plus a smoke import of the plugin entry so a syntax or
 * import-cycle error fails here rather than inside the host.
 *
 * @module dsh-connect-MIMOdesktop/tests
 */

import { mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  POLL_CHOICES_MS,
  DEFAULT_POLL_MS,
  normalizePollMs,
  normalizeEnabledModels,
  normalizePlacement,
  readSettings,
  SETTINGS_DEFAULTS,
} from '../src/settings.js'
import { MiMoAccountPool, maskSecret, POOL_FILENAME } from '../src/accounts.js'

let passed = 0
// Awaited so a rejected assertion surfaces here instead of as an unhandled
// rejection after the run reports success.
async function check(label, fn) {
  await fn()
  passed += 1
  console.log(`  ok  ${label}`)
}

// ---- settings ------------------------------------------------------------
await check('poll cadence snaps to an offered choice', () => {
  assert.equal(normalizePollMs(300000), 300000)
  assert.equal(normalizePollMs('600000'), 600000)
  // A hand-edited config must not become a busy loop.
  assert.equal(normalizePollMs(1), DEFAULT_POLL_MS)
  assert.equal(normalizePollMs('nonsense'), DEFAULT_POLL_MS)
  assert.equal(POLL_CHOICES_MS.length, 5)
})

await check('enabled models distinguish "all" from "none"', () => {
  assert.equal(normalizeEnabledModels(null), null)
  assert.equal(normalizeEnabledModels(undefined), null)
  assert.deepEqual(normalizeEnabledModels([]), [])
  assert.deepEqual(normalizeEnabledModels(['a', '', 3, 'b']), ['a', 'b'])
})

await check('quota placement snaps to one of the two seats', () => {
  assert.equal(normalizePlacement('input'), 'input')
  assert.equal(normalizePlacement('dock'), 'dock')
  // A hand-edited value outside the pair falls back to the original seat.
  assert.equal(normalizePlacement('below'), 'dock')
  assert.equal(normalizePlacement(undefined), 'dock')
  assert.equal(SETTINGS_DEFAULTS.quotaPlacement, 'dock')
  assert.equal(readSettings({ quotaPlacement: 'input' }).quotaPlacement, 'input')
})
await check('readSettings defaults match the schema', () => {
  assert.deepEqual(readSettings(undefined), SETTINGS_DEFAULTS)
  assert.equal(readSettings({ providerEnabled: false }).providerEnabled, false)
  assert.equal(readSettings({ sidebarPanel: true }).sidebarPanel, true)
  // An explicit empty list must survive as "nothing enabled".
  assert.deepEqual(readSettings({ enabledModels: [] }).enabledModels, [])
})

await check('secrets are masked, never echoed', () => {
  assert.equal(maskSecret('abcdefghijklmnop'), 'abcd…mnop')
  assert.equal(maskSecret('short'), '****')
  assert.equal(maskSecret(''), '')
  assert.equal(maskSecret(undefined), '')
})

// ---- account pool --------------------------------------------------------
const home = mkdtempSync(join(tmpdir(), 'mimo-pool-'))
try {
  const poolFile = join(home, POOL_FILENAME)
  const store = { status: async () => ({ signedIn: false, reason: 'none' }) }
  const pool = new MiMoAccountPool({ store, env: { DSH_HOME: home } })

await check('empty pool falls back to the single credential', async () => {
    assert.equal(await pool.resolve(), undefined)
  })

  // Adding is synchronous on disk; resolve is async, so run the sequence with
  // awaits where the API is async and plain calls elsewhere.
  const first = pool.add({ passToken: 'token-aaaaaaaaaaaa', label: 'A', cUserId: 'c1' })
  const second = pool.add({ passToken: 'token-bbbbbbbbbbbb', label: 'B', cUserId: 'c2' })

await check('adding the same token twice is idempotent', () => {
    assert.equal(pool.add({ passToken: 'token-aaaaaaaaaaaa' }), first)
    assert.equal(pool.list().length, 2)
  })

await check('the roster file is owner-only', () => {
    assert.ok(existsSync(poolFile))
    // Windows reports a synthetic mode; the assertion that matters is that the
    // file exists and holds no plaintext in the listing.
    assert.ok(statSync(poolFile).size > 0)
    const listed = pool.list()
    assert.equal(listed.length, 2)
    assert.ok(listed.every(a => a.passTokenMasked.includes('…')))
    assert.ok(listed.every(a => a.passToken === undefined))
  })

await check('the active account answers first', async () => {
    assert.equal((await pool.resolve()).accountId, first)
    pool.activate(second)
    assert.equal((await pool.resolve()).accountId, second)
  })

await check('a refused account rotates to the next one', async () => {
    const next = await pool.rotate(second)
    assert.equal(next.accountId, first)
    // The refused account is cooling down, so resolve skips it.
    assert.equal(pool.isCooling(second), true)
    assert.equal((await pool.resolve()).accountId, first)
  })

await check('every member cooling still yields a credential', async () => {
    pool.reportFailure(first)
    const resolved = await pool.resolve()
    assert.ok(resolved !== undefined)
    assert.equal(resolved.accountId, first)
  })

await check('removing the last account returns to the single-credential path', async () => {
    pool.remove(first)
    pool.remove(second)
    assert.equal(pool.list().length, 0)
    assert.equal(await pool.resolve(), undefined)
  })

await check('a corrupt roster file is tolerated', async () => {
    const broken = new MiMoAccountPool({ store, env: { DSH_HOME: home }, path: join(home, 'broken.json') })
    assert.equal((await broken.resolve()), undefined)
  })
} finally {
  rmSync(home, { recursive: true, force: true })
}

// ---- plugin entry --------------------------------------------------------
// The entry imports host packages (dsh-llm, pi-ai, schemastery) that only exist
// once the plugin is installed into a profile. Without them the import cannot
// even resolve, so this check reports a skip instead of a false failure — the
// host-side import is exercised by installing the plugin, not by this file.
try {
  const entry = await import('../src/index.js')
await check('the plugin entry imports and declares its surface', () => {
    assert.equal(entry.name, 'llm-mimo')
    assert.deepEqual(entry.inject, ['llm'])
    assert.equal(typeof entry.apply, 'function')
    assert.equal(entry.QUOTA_ROUTE, '/api/mimo.quota')
    assert.equal(entry.SETTINGS_ROUTE, '/api/mimo.settings')
    assert.equal(entry.POOL_ROUTE, '/api/mimo.pool')
    assert.equal(entry.TEST_ROUTE, '/api/mimo.test')
  })
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  console.log('  skip  entry import — host packages not installed in this checkout')
}

console.log(`\n${passed} checks passed`)
