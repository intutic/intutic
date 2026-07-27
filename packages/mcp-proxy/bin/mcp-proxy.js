#!/usr/bin/env node
/**
 * Committed launcher for `intutic-mcp-proxy`.
 *
 * Exists so the `bin` target is present on disk at install time. pnpm links
 * bins during the install phase, before any build has run, so pointing `bin`
 * straight at `dist/index.js` made every `pnpm install` in a clean tree emit
 *
 *   [WARN] Failed to create bin at .../intutic-mcp-proxy.
 *          ENOENT: no such file or directory, open '.../dist/index.js'
 *
 * and then skip the symlink entirely — so `node_modules/.bin/intutic-mcp-proxy`
 * did not exist even after the build produced `dist/`. Harmless while nothing
 * invoked it, and a confusing failure the moment something did.
 *
 * This file is committed, so the target always resolves and the symlink is
 * always created; the build output is reached at run time instead.
 */
import('../dist/index.js');
