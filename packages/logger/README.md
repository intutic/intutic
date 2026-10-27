# @intutic/logger

Structured JSON logging for Intutic packages, built on [pino](https://getpino.io), with the active OpenTelemetry trace attached to each line.

```ts
import { createLogger } from '@intutic/logger'

const log = createLogger('circuit-breaker')
log.info({ workspaceId: 'wk_abc123' }, 'Tool call evaluated')
```

- `createLogger(name, bindings?)` returns a pino `Logger` (also exported as the `Logger` type) that writes one JSON object per line to standard output. `bindings` are key-value pairs added to every line. There are no file transports. The level is `info` unless `LOG_LEVEL` says otherwise.
- When a trace is active, its `trace_id` and `span_id` are added to the line.
- Set `PINO_DEST=stderr` to write to standard error instead. A process that keeps standard output for JSON-RPC frames, such as an MCP stdio server, needs this.

MIT licensed. Source: [github.com/intutic/intutic](https://github.com/intutic/intutic/tree/main/packages/logger).
