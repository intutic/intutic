/**
 * version.ts — this package's own version, read from its package.json.
 *
 * The standalone `intutic` MCP server reports it to clients in its
 * `initialize` response. It was a hard-coded `'0.1.0'` that never moved with
 * a release. `../package.json` resolves from both `src/` (tests) and `dist/`
 * (the published build), and npm always ships package.json.
 *
 * @module
 */

import { createRequire } from 'node:module'

export const PACKAGE_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version
