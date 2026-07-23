/**
 * Claude Code adapter — CLAUDE.md
 * HLD §3.14 — Harness Onboarding Matrix
 * @module
 */
import { HarnessType } from '@intutic/shared-types'
import { createMarkdownAdapter } from './base.js'

export const claudeCodeAdapter = createMarkdownAdapter(HarnessType.CLAUDE_CODE, 'CLAUDE.md')
