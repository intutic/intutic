/**
 * Sync Daemon & CLI Types — Shared across control plane + CLI + daemon.
 *
 * LLD #8 — Sync Daemon / CLI
 * HLD §3.14 — Real-Time State Mirroring
 *
 * @module
 */

import { z } from 'zod'
import { HarnessType } from './enums.js'
import type { WorkspaceSettings } from './workspaceSettings.js'

// Re-export for convenience
export type { HarnessType } from './enums.js'

// ─── Sync Config Payload ─────────────────────────────────────────────
// Control Plane → Daemon (push direction)

/** A single SOP entry within a sync config push. */
export interface SyncSopEntry {
  /** SOP registry ID. */
  sopId: string
  /** Human-readable SOP title. */
  title: string
  /** Full SOP content (markdown). Written to harness config files. */
  content: string
  /** SHA-256 canonical hash from SOP registry. */
  contentHash: string
  /** Which harness config files should receive this SOP. */
  harnessTargets: HarnessType[]
  /** SOP pointer comment for traceability (e.g., `<!-- sop://intutic/sop_abc | Title -->`). */
  sopRef?: string
}

/** Config push payload from control plane to sync daemon. */
export interface SyncConfigPayload {
  /** Workspace this config belongs to. */
  workspaceId: string
  /** Monotonic config version counter. Daemon skips if local >= remote. */
  configVersion: number
  /** Active SOPs to write to harness config files. */
  sops: SyncSopEntry[]
  /** Proxy URL for LLM API redirect (e.g., `https://proxy.intutic.ai`). */
  proxyUrl: string
  /**
   * Resolved workspace governance settings.
   * Always a complete WorkspaceSettings object (missing keys filled with defaults
   * by the control plane before sending).
   * WS-5 — Q1 fail behavior, Q2 proxy mode, Q3 bypass enforcement.
   */
  settings: WorkspaceSettings
  /** Applied SkillOpt config edits to write locally. */
  appliedEdits?: any[]
}

// ─── SOP Hash Report ─────────────────────────────────────────────────
// Daemon → Control Plane (pull direction)
// HLD §3.14 — SOP Integrity Verification

/** Hash of a single local SOP config file. */
export interface SopFileHash {
  /** File path relative to workspace root (e.g., `.cursorrules`). */
  filePath: string
  /** SHA-256 hash of actual local file content. */
  localHash: string
  /** Expected hash from last sync (canonical). */
  canonicalHash: string
  /** Whether local diverges from canonical. */
  drifted: boolean
}

/** SOP hash integrity report sent by daemon to control plane. */
export interface SopHashReport {
  /** Workspace ID. */
  workspaceId: string
  /** Harness type that was scanned. */
  harnessType: HarnessType
  /** File hashes for all synced config files. */
  files: SopFileHash[]
  /** ISO timestamp of report generation. */
  reportedAt: string
}

// ─── Daemon Status ───────────────────────────────────────────────────
// Daemon → Control Plane (heartbeat)

/** Detection status of a single harness in the workspace. */
export interface DetectedHarness {
  /** Harness type. */
  type: HarnessType
  /** Absolute path to the harness config file. */
  configPath: string
  /** Whether the harness was auto-detected. */
  detected: boolean
  /** ISO timestamp of last config file write (null if never written). */
  lastWriteAt: string | null
}

/** Daemon heartbeat status payload. */
export interface DaemonStatus {
  /** Workspace ID. */
  workspaceId: string
  /** Current local config version. */
  configVersion: number
  /** ISO timestamp when daemon connected. */
  connectedSince: string
  /** ISO timestamp of last successful sync. */
  lastSyncAt: string
  /** Detected harnesses in the workspace. */
  harnesses: DetectedHarness[]
  /** List of running agent processes polled on the local system. */
  activeProcesses?: string[]
  /** Local managed components health status. */
  components?: {
    proxy: 'healthy' | 'unhealthy' | 'stopped'
    valkey: 'healthy' | 'unhealthy' | 'stopped'
    sslTrust: 'trusted' | 'untrusted'
  }
}

// ─── CLI Config ──────────────────────────────────────────────────────
// Stored in ~/.intutic/

/** Credentials stored at ~/.intutic/credentials.json. */
export interface IntuticCredentials {
  /** API key (vk_*) or JWT access token. */
  apiKey: string
  /** Workspace ID. */
  workspaceId: string
  /** Control plane URL. */
  controlPlaneUrl: string
  /** Member email (for display). */
  email: string
  /** ISO timestamp when credentials were stored. */
  storedAt: string
}

/** Workspace config stored at ~/.intutic/config.json. */
export interface IntuticConfig {
  /** Workspace root directory (absolute path). */
  workspaceRoot: string
  /** Detected harnesses. */
  harnesses: HarnessType[]
  /** Current config version from last sync. */
  configVersion: number
  /** Whether dev mode is active (local control plane). */
  devMode: boolean
  /** Local daily spending cap limit in USD. */
  maxDailyBudgetUsd?: number
  /** Local daily spending cap limit in USD (alias). */
  max_daily_budget_usd?: number
}

/** Local integrity store at .intutic/integrity.json (per-workspace). */
export interface IntegrityStore {
  /** Last sync timestamp. */
  lastSyncAt: string
  /** Config version at last sync. */
  configVersion: number
  /** Canonical hashes of synced files. */
  files: Record<string, string>  // filePath → SHA-256 hash
}

// ─── Config Capture (Daemon → Control Plane) ────────────────────────
// LLD #51 — Harness Config Capture + SkillOpt Pipeline

/** A single harness config file captured by the daemon. */
export interface CapturedConfigFile {
  /** Relative file path (e.g., `.cursorrules`, `CLAUDE.md`). */
  path: string
  /** Full file content. */
  content: string
  /** SHA-256 hash of content. */
  contentHash: string
}

/** Payload sent by daemon to capture harness config snapshots (multi-file). */
export interface BatchConfigCapturePayload {
  /** Workspace ID. */
  workspaceId: string
  /** Harness type the config belongs to. */
  harnessType: HarnessType
  /** Captured config files. */
  files: CapturedConfigFile[]
}

/** Structured diff between two config snapshots. */
export interface ConfigDiff {
  /** Lines added. */
  addedLines: number
  /** Lines removed. */
  removedLines: number
  /** Summary of changes. */
  summary: string
  /** Previous content (null if first snapshot). */
  previousContent: string | null
  /** Current content. */
  currentContent: string
}

// ─── Zod Schemas ─────────────────────────────────────────────────────

/** Zod schema for SOP hash report (daemon → control plane). */
export const SopHashReportSchema = z.object({
  workspaceId: z.string().min(1),
  harnessType: z.nativeEnum(HarnessType),
  files: z.array(z.object({
    filePath: z.string().min(1),
    localHash: z.string().length(64),  // SHA-256 hex
    canonicalHash: z.string().length(64),
    drifted: z.boolean(),
  })),
  reportedAt: z.string().datetime(),
})

/** Zod schema for daemon status (heartbeat). */
export const DaemonStatusSchema = z.object({
  workspaceId: z.string().min(1),
  configVersion: z.number().int().min(0),
  connectedSince: z.string().datetime(),
  lastSyncAt: z.string().datetime(),
  harnesses: z.array(z.object({
    type: z.nativeEnum(HarnessType),
    configPath: z.string(),
    detected: z.boolean(),
    lastWriteAt: z.string().datetime().nullable(),
  })),
  activeProcesses: z.array(z.string()).optional(),
  components: z.object({
    proxy: z.enum(['healthy', 'unhealthy', 'stopped']),
    valkey: z.enum(['healthy', 'unhealthy', 'stopped']),
    sslTrust: z.enum(['trusted', 'untrusted']),
  }).optional(),
})

/** Zod schema for batch config capture payload (daemon → control plane). */
export const BatchConfigCapturePayloadSchema = z.object({
  workspaceId: z.string().min(1),
  harnessType: z.nativeEnum(HarnessType),
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string(),
    contentHash: z.string().length(64),
  })),
})

