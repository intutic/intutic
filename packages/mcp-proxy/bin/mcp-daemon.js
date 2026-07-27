#!/usr/bin/env node
/**
 * Committed launcher for `intutic-mcp-daemon`. See mcp-proxy.js for why the
 * `bin` targets are committed files rather than build output.
 */
import('../dist/daemon/index.js');
