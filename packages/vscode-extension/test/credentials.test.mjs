import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { loadCredentials, KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT } = require('../dist/credentials.js')

const here = dirname(fileURLToPath(import.meta.url))

// The extension reads the token where `intutic login` stored it, so the names
// must be the CLI's own.
test('the keychain names are the ones the CLI writes', () => {
  const cli = readFileSync(join(here, '../../../tools/cli/src/config/keychain.ts'), 'utf-8')
  assert.match(cli, new RegExp(`const SERVICE_NAME = '${KEYCHAIN_SERVICE}'`))
  assert.match(cli, new RegExp(`const ACCOUNT_NAME = '${KEYCHAIN_ACCOUNT}'`))
  assert.match(cli, /`\$\{SERVICE_NAME\}:workspace:\$\{workspaceId\}`/)
})

function home(creds) {
  const dir = mkdtempSync(join(tmpdir(), 'intutic-vscode-creds-'))
  if (creds) {
    mkdirSync(join(dir, '.intutic'))
    writeFileSync(join(dir, '.intutic', 'credentials.json'), JSON.stringify(creds))
  }
  return dir
}

async function withHome(dir, env, fn) {
  const saved = { HOME: process.env.HOME, URL: process.env.INTUTIC_CONTROL_PLANE_URL }
  process.env.HOME = dir
  if (env === undefined) delete process.env.INTUTIC_CONTROL_PLANE_URL
  else process.env.INTUTIC_CONTROL_PLANE_URL = env
  try {
    return await fn()
  } finally {
    process.env.HOME = saved.HOME
    if (saved.URL === undefined) delete process.env.INTUTIC_CONTROL_PLANE_URL
    else process.env.INTUTIC_CONTROL_PLANE_URL = saved.URL
  }
}

test('the keychain sentinel is never sent as the key', async () => {
  // No workspace id, so nothing to look up: the key is absent, not "keychain".
  const creds = await withHome(home({ controlPlaneUrl: 'http://cp.test', apiKey: 'keychain' }), undefined, () => loadCredentials())
  assert.equal(creds.controlPlaneUrl, 'http://cp.test')
  assert.notEqual(creds.apiKey, 'keychain')
})

test('a plain key in the file is used as it is', async () => {
  const creds = await withHome(home({ controlPlaneUrl: 'http://cp.test', apiKey: 'plain-key', workspaceId: 'ws_1' }), undefined, () => loadCredentials())
  assert.deepEqual(creds, { controlPlaneUrl: 'http://cp.test', apiKey: 'plain-key', workspaceId: 'ws_1' })
})

test('the setting beats the environment, which beats the file; nothing named is null', async () => {
  const dir = home({ controlPlaneUrl: 'http://file.test' })
  assert.equal((await withHome(dir, 'http://env.test', () => loadCredentials('http://setting.test'))).controlPlaneUrl, 'http://setting.test')
  assert.equal((await withHome(dir, 'http://env.test', () => loadCredentials(''))).controlPlaneUrl, 'http://env.test')
  assert.equal((await withHome(dir, undefined, () => loadCredentials())).controlPlaneUrl, 'http://file.test')
  assert.equal(await withHome(home(null), undefined, () => loadCredentials()), null)
})
