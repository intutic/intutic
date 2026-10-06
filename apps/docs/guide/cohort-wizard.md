# The Cohort Wizard

A guided walk through provisioning a provider credential and verifying it — for a workspace
setting up from scratch. It exists in two forms that walk the same steps, backed by the same API
routes as the standalone Provider Keys settings: an interactive CLI command, and a dashboard
modal.

Neither is a separate code path from the settings you'd otherwise click through one at a time —
`intutic setup` calls the exact route `intutic credentials set` already calls, and the
dashboard's Guided Setup button drives the same mutations `ProviderKeyWizard` uses. This is a
sequence over existing actions, not new behavior to trust separately.

There is no judge-model step: judges run only on self-hosted open-weight models, so there is
no hosted judge model to choose (see [Settings — Judges](/guide/settings#judges)).

## `intutic setup` (CLI)

```bash
intutic setup
```

Steps:

1. **Codescan** — detects harnesses in the current workspace (the same detection `intutic init`
   uses).
2. **Mode** — connected to Intutic (needs `intutic login` first) or local/offline, with no
   control plane.
3. **Provider** — pick one from the registry; each option shows whether the proxy currently
   routes to it (see [Provider Keys](/guide/settings#provider-keys)).
4. **Credentials** — prompted per the provider's own field list (a password field for an API
   key, a multiline field for a service-account JSON blob, and so on).
5. **Verify** — the credential is checked against the provider's own API before it's saved. Only
   a confirmed-invalid key (401/403) stops you, and even then you can choose to save it anyway;
   a rate-limited or unreachable response is reported but never blocks.
6. **Persist** — connected mode saves the credential to your workspace (the same
   `PUT /api/v1/workspace/provider-credentials/:provider` route `intutic credentials set` uses);
   local mode writes a `.intutic.env` file (mode `0600`) you source yourself, and points you at
   [`intutic judge configure`](/reference/cli#intutic-judge-configure) to set up an on-prem
   judge on a self-hosted model.
7. **Summary.**

`intutic init` is unaffected — it stays exactly as it was, flag-driven and safe for CI. `intutic
setup` is the interactive counterpart for a human at a keyboard.

<!-- ENTERPRISE_ONLY_START -->

## Guided Setup (dashboard)

Under **Settings → Security**, on the Provider Keys card, a **Guided setup** button opens the same
flow as a modal: pick a provider → enter its credential → verify → done. Each step calls the
exact hook the standalone panel next to it already uses (`useProvisionProviderCredential`,
`useVerifyProviderCredential`), so anything you configure through the wizard shows up
immediately in Provider Keys, and vice versa — there's no separate state to fall out of sync.

The wizard doesn't include a codescan step in the browser (there's no workspace filesystem to
scan from a browser tab) — that part is CLI-only.

<!-- ENTERPRISE_ONLY_END -->

## Related

- [Settings & Configuration — Provider Keys, Judges](/guide/settings)
- [CLI Reference — `intutic setup`](/reference/cli#intutic-setup)
- [On-prem judge setup](/external/on-prem-judge)
