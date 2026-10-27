# @intutic/id

Prefixed, collision-resistant IDs and timestamps for Intutic packages.

```ts
import { newId, newIso } from '@intutic/id'

newId('wk') // 'wk_V1StGXR8_Z5jdHi6B-myT'  prefix, underscore, 21-character nanoid
newIso()    // '2026-10-26T21:38:09.123Z'   ISO 8601, UTC
```

- `newId(prefix)` returns `<prefix>_<nanoid(21)>`. Use a short prefix per kind of thing (`wk` for a workspace, `tc` for a tool call) so an ID is readable in a log line and still unique.
- `newIso()` returns the current time as an ISO 8601 string. Use it instead of formatting dates by hand so timestamps look the same everywhere.

The package has one runtime dependency (`nanoid`) and no configuration.

MIT licensed. Source: [github.com/intutic/intutic](https://github.com/intutic/intutic/tree/main/packages/id).
