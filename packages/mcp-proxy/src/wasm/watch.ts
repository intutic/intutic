/**
 * Watch the local rules directory and call back, debounced, when a `.wasm`
 * file appears, changes or goes away (TD-442).
 *
 * The rescan rides the 60-second policy tick (`policy.ts` `start(onTick)`)
 * and no second timer was wanted. A filesystem watcher is not a timer: it
 * costs nothing while nothing changes and fires within a second when
 * something does, which is the ~5 s hot-reload the Rust proxy has
 * (`registry.rs` `ensure_local_up_to_date`). The tick stays as the fallback
 * for platforms where `fs.watch` misses events.
 *
 * A missing directory is not an error — the operator may never create it.
 * The watcher is retried on every policy tick through `ensureWasmWatch`, so
 * a directory created later is picked up without a restart.
 */
import * as node_fs from 'node:fs'
import { createStderrLogger as createLogger } from '../stderrLog.js'

const log = createLogger('mcp-proxy-wasm-watch')


export interface WasmDirWatcher {
  close(): void
}

export function watchWasmDir(
  dir: string,
  onChange: () => void | Promise<void>,
  debounceMs = 500,
): WasmDirWatcher | null {
  if (!node_fs.existsSync(dir)) return null
  let timer: NodeJS.Timeout | null = null
  let watcher: node_fs.FSWatcher
  try {
    watcher = node_fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename && !String(filename).endsWith('.wasm')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        Promise.resolve(onChange()).catch((err) => {
          log.warn({ action: 'wasm_watch_rescan_failed', err: (err as Error).message }, 'WASM rescan after a directory change failed')
        })
      }, debounceMs)
      timer.unref()
    })
  } catch (err) {
    log.warn({ action: 'wasm_watch_unavailable', dir, err: (err as Error).message }, 'fs.watch unavailable for the WASM rules directory; the policy tick still rescans')
    return null
  }
  watcher.on('error', (err) => {
    log.warn({ action: 'wasm_watch_error', dir, err: err.message }, 'WASM directory watcher errored; the policy tick still rescans')
  })
  return {
    close() {
      if (timer) clearTimeout(timer)
      watcher.close()
    },
  }
}
