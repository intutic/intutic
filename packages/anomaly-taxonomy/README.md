# @intutic/anomaly-taxonomy

The twelve runtime anomaly categories Intutic classifies against, and the
severity each carries. Types and constants only — no detection logic, no
thresholds, no probes.

```bash
npm install @intutic/anomaly-taxonomy
```

```ts
import {
  AnomalyType,
  ANOMALY_SEVERITY_MAP,
  isAnomalyType,
} from '@intutic/anomaly-taxonomy'

ANOMALY_SEVERITY_MAP[AnomalyType.DATA_EXFILTRATION] // 'CRITICAL'
isAnomalyType(notification.category) // narrow an untrusted string
```

## Why this is a package

The taxonomy is declared in two languages. The Rust proxy raises these
categories inline on the request path and cannot call into TypeScript, so it
keeps its own copy; the control plane classifies against them asynchronously in
TypeScript.

Two hand-maintained lists drift, and drift here is silent — a renamed category
simply stops being classified downstream, with no error raised anywhere. This
package is the source of truth, and the proxy's test suite parses it and fails
the build on any divergence.

## What it deliberately does not contain

Detection. Deciding *whether* a request is anomalous involves thresholds,
sequence analysis, baselines and probes; sharing the vocabulary should not
require sharing any of that. Keeping them apart is what lets the vocabulary be
used by anything that needs to read an Intutic verdict.

Apache-2.0.
