---
title: Self-host
description: Run the whole of Intutic on your own infrastructure, including an air-gapped network, under an annual Self-host license.
---

# Self-host <Badge type="danger" text="Self-host" />

Self-host runs the whole product — control plane, proxy, dashboard and these
docs — on infrastructure you operate, under an annual license. Nothing in a
Self-host deployment needs a route to the internet: it installs from a signed
bundle, checks its license offline, and sends model requests only where you
point it.

It is sold as a yearly license, invoiced in advance; [Plans & pricing](./plans#how-usage-is-billed)
has the terms. Talk to Intutic sales to start.

## What runs

| Service | What it does |
|---|---|
| Control plane | The API, policies, traces, users and the license check |
| Proxy | Governs every LLM request your agents make |
| Dashboard | The web app, served from your own address |
| Docs | This site, served at `/docs/` on that address |
| Postgres | Your data. Bundled with Docker Compose; bring your own on Kubernetes |
| Valkey | Caches and queues |
| nginx (Compose) or your Ingress (Kubernetes) | One HTTPS address for all of the above |

Optional: a semantic response cache (TurboVec) and a LiteLLM gateway in front
of your own model server, which powers the LLM-backed checks (SOP scoring, the
trajectory judge, compliance probes). Without one, those checks fall back to
their deterministic versions.

## What is different from Intutic Cloud

- **No sign-up.** The installer creates the first owner; everyone else joins by
  invitation, SSO or SCIM.
- **No trials, no billing pages.** The plan is the license: every feature, unlimited
  seats and requests, no per-request fee.
- **Cloud-only integrations are off**, because they need the public internet:
  Stripe, the cloud marketplaces, the Notion and Google Drive connectors, the mem0
  and Supermemory memory providers, VirusTotal lookups and product telemetry.
  Confluence and GitHub connectors work against your own Confluence Data Center
  or GitHub Enterprise Server.
- **Email goes through your relay** (`SMTP_URL`). Without one, no email is sent
  and owners share sign-in details themselves.
- **Alerts reach your channels with no flag to set.** The notification hub sends
  alerts (a silent gate, a failed integrity check) and approvals to the email
  addresses, webhooks, Slack channels and PagerDuty services your notification
  rules name. Every channel is on; set `FF_EMAIL_ADAPTER`, `FF_WEBHOOK_ADAPTER`,
  `FF_SLACK_ADAPTER` or `FF_PAGERDUTY_ADAPTER` to `false` to turn one off. A
  webhook or SIEM destination on your private network needs its host in
  `INTUTIC_WEBHOOK_ALLOWED_HOSTS`.
- **Model requests go where you send them.** Each provider's address is a
  setting (`OPENAI_UPSTREAM_URL`, `ANTHROPIC_UPSTREAM_URL` and so on): your
  private endpoint, your own model server, or an egress gateway.

## Requirements

- **One hostname** users can reach (for example `intutic.example.internal`) and a
  TLS certificate for it. The installer can issue a self-signed one to start.
- **Docker Compose:** one Linux host, x86-64 or arm64, with 4 vCPUs, 16 GB of memory and
  100 GB of disk, Docker Engine 24+ and Docker Compose v2, and `openssl`.
- **Kubernetes:** a cluster running 1.27 or later, Helm 3, PostgreSQL 15 or later,
  and an Ingress controller.
- **Images:** linux/amd64 and linux/arm64. Each tag at `ghcr.io/intutic` holds
  both; the air-gap bundle comes in one per architecture.

## Getting a release

Each release is a signed bundle per architecture. Tell Intutic which yours is
(`uname -m`: `x86_64` is `amd64`, `aarch64` is `arm64`), and you get
time-limited links to three files: the bundle
(`intutic-selfhost-<version>-<arch>.tar.gz`), its checksums (`SHA256SUMS`) and
their signature (`SHA256SUMS.sigstore.json`). Verify the
bundle where you downloaded it, before it goes into your network. You need
[cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3.0 or
later and Intutic's public key, [`intutic-cosign.pub`](../intutic-cosign.pub):

```bash
cosign verify-blob --key intutic-cosign.pub --bundle SHA256SUMS.sigstore.json SHA256SUMS
tar -xzf intutic-selfhost-<version>-<arch>.tar.gz
cd intutic-selfhost-<version>
sha256sum -c ../SHA256SUMS
```

Check against `../SHA256SUMS`, the copy you just verified, not the copy inside
the bundle.

The bundle holds every image (`images.tar`), the installer, the Compose files and
the Helm charts. On Kubernetes with registry access, the images and charts are
also at `ghcr.io/intutic`, with a pull token Intutic issues to you.

## Rotate the encryption key

`ENCRYPTION_KEY` seals every credential Intutic stores: provider keys, SSO
client secrets, connector and task-tracker tokens, SIEM destination settings,
notification and GitHub webhook signing secrets, trace storage credentials and
Slack bot tokens (see [Stored credentials](/security#stored-credentials)). The
control plane and the proxy both hold it. Rotation re-encrypts all of them under
the new key; nothing has to be saved again. To replace the key, add the new one
first as a key that may open values, then make it the key that seals them:

1. Generate the new key: `openssl rand -hex 32`.
2. Set `ENCRYPTION_KEY_PREVIOUS` to the **new** key, and restart the control
   plane and the proxy. Nothing is re-encrypted yet; both can now open a value
   sealed under either key.
3. Set `ENCRYPTION_KEY` to the new key and `ENCRYPTION_KEY_PREVIOUS` to the
   **old** one, and restart both again, in either order. When it starts, the
   control plane re-encrypts every secret in the database under the new key.
   Provider keys follow as soon as every running proxy holds the new key: each
   proxy announces the keys it holds, and the control plane waits for that, so
   no proxy is ever left unable to read one.
4. Confirm it finished. This exits 0 once every stored secret is under the new
   key, and lists what is not, store by store:

   ```bash
   # Docker Compose, in /opt/intutic
   docker compose exec control-plane node services/control-plane/dist/scripts/reencryptCredentials.js --check
   # Kubernetes
   kubectl -n intutic exec deploy/intutic-control-plane -- node services/control-plane/dist/scripts/reencryptCredentials.js --check
   ```

   Without `--check` it re-encrypts instead of reporting, for a run without a
   restart. A deployment that runs no proxy adds `--ignore-proxies`. A secret
   that neither key opens is reported and left as it is; save it again.
5. Remove `ENCRYPTION_KEY_PREVIOUS` and restart both. `SLACK_ENCRYPTION_KEY`, if
   you set it on a release before 2.4.0, can go too: Slack tokens are sealed
   under `ENCRYPTION_KEY` now.

On Docker Compose the keys are in `/opt/intutic/.env`, and `docker compose up -d`
in `/opt/intutic` restarts what changed. On Kubernetes they are keys of the
Secret named by `secretName` (`intutic-secrets`):
`kubectl -n intutic rollout restart deploy/intutic-control-plane deploy/intutic-proxy`
restarts both.

## Next

- [Install with Docker Compose](./self-host-compose), including an air-gapped host
- [Install on Kubernetes](./self-host-kubernetes)
- [Your license](./self-host-license): installing it, renewing it, and what happens when it ends
