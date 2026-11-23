#!/usr/bin/env node
/**
 * Build `src/client.js` into `lib/client.js`.
 *
 * There is no bundler here on purpose. The browser half is hand-written in the
 * `window.__ModuleLoader__.load` shape the host expects, so "building" is a
 * copy plus the sourcemap reference — the same thing the upstream package ships.
 * A bundler would add a dependency and a config file to do nothing.
 *
 * @module dsh-connect-MIMOdesktop/tools/build-client
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'src', 'client.js')
const target = join(root, 'lib', 'client.js')

const body = readFileSync(source, 'utf-8')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, `${body.trimEnd()}\n`)
console.log(`dsh-connect-MIMOdesktop: wrote ${target}`)
