/**
 * Credential and config store — reads/writes ~/.intutic/ files.
 *
 * Credentials are stored with mode 0o600 (owner-only read/write).
 * Parent directories are created automatically.
 *
 * LLD #8 — Sync Daemon / CLI
 * @module
 */

import { readFileSync, writeFileSync, unlinkSync, mkdirSync, constants } from 'node:fs'
import { dirname } from 'node:path'
import type { IntuticCredentials, IntuticConfig, IntegrityStore } from '@intutic/shared-types'
import { getCredentialsPath, getConfigPath, getIntegrityPath } from './paths.js'
import { storeToken, retrieveToken, deleteToken } from './keychain.js'

// ─── Helpers ─────────────────────────────────────────────────────────

function ensureDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function writeJsonFile(filePath: string, data: unknown, mode?: number): void {
  ensureDir(filePath)
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: mode ?? 0o644,
  })
}

// ─── Credentials ─────────────────────────────────────────────────────

/** Load stored credentials. Returns null if not found. */
export async function loadCredentials(): Promise<IntuticCredentials | null> {
  const creds = readJsonFile<IntuticCredentials>(getCredentialsPath())
  if (!creds) return null

  if (creds.apiKey === 'keychain') {
    const token = await retrieveToken(creds.workspaceId)
    if (token) {
      creds.apiKey = token
    }
  }
  return creds
}

/** Save credentials with restricted permissions (0o600). */
export async function saveCredentials(creds: IntuticCredentials): Promise<void> {
  const savedToKeychain = await storeToken(creds.workspaceId, creds.apiKey)
  const credsToSave = { ...creds }
  if (savedToKeychain) {
    credsToSave.apiKey = 'keychain'
  }
  writeJsonFile(getCredentialsPath(), credsToSave, 0o600)
}

/** Delete credentials file. */
export async function clearCredentials(): Promise<void> {
  try {
    const creds = readJsonFile<IntuticCredentials>(getCredentialsPath())
    if (creds) {
      await deleteToken(creds.workspaceId)
    }
  } catch {
    // Ignore keychain deletion failures
  }
  try {
    unlinkSync(getCredentialsPath())
  } catch {
    // File may not exist — safe to ignore
  }
}

// ─── Workspace Config ────────────────────────────────────────────────

/** Load workspace config. Returns null if not found. */
export function loadConfig(): IntuticConfig | null {
  return readJsonFile<IntuticConfig>(getConfigPath())
}

/** Save workspace config. */
export function saveConfig(config: IntuticConfig): void {
  writeJsonFile(getConfigPath(), config)
}

// ─── Integrity Store ─────────────────────────────────────────────────

/** Load per-workspace integrity store. Returns null if not found. */
export function loadIntegrity(workspaceRoot: string): IntegrityStore | null {
  return readJsonFile<IntegrityStore>(getIntegrityPath(workspaceRoot))
}

/** Save per-workspace integrity store. */
export function saveIntegrity(workspaceRoot: string, store: IntegrityStore): void {
  writeJsonFile(getIntegrityPath(workspaceRoot), store)
}
