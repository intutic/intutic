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
- **Model requests go where you send them.** Each provider's address is a
  setting (`OPENAI_UPSTREAM_URL`, `ANTHROPIC_UPSTREAM_URL` and so on): your
  private endpoint, your own model server, or an egress gateway.

## Requirements

- **One hostname** users can reach (for example `intutic.example.internal`) and a
  TLS certificate for it. The installer can issue a self-signed one to start.
- **Docker Compose:** one Linux x86-64 host with 4 vCPUs, 16 GB of memory and
  100 GB of disk, Docker Engine 24+ and Docker Compose v2, and `openssl`.
- **Kubernetes:** a cluster running 1.27 or later, Helm 3, PostgreSQL 15 or later,
  and an Ingress controller.
- **Images:** linux/amd64.

## Getting a release

Each release is a signed bundle. Intutic sends you time-limited links to three
files: the bundle (`intutic-selfhost-<version>.tar.gz`), its checksums
(`SHA256SUMS`) and their signature (`SHA256SUMS.sig`). Verify the bundle before
you install it, with the cosign public key Intutic gives you:

```bash
cosign verify-blob --key intutic-cosign.pub --signature SHA256SUMS.sig SHA256SUMS
tar -xzf intutic-selfhost-<version>.tar.gz
cd intutic-selfhost-<version>
sha256sum -c SHA256SUMS
```

The bundle holds every image (`images.tar`), the installer, the Compose files and
the Helm charts. On Kubernetes with registry access, the images and charts are
also at `ghcr.io/intutic`, with a pull token Intutic issues to you.

## Next

- [Install with Docker Compose](./self-host-compose), including an air-gapped host
- [Install on Kubernetes](./self-host-kubernetes)
- [Your license](./self-host-license): installing it, renewing it, and what happens when it ends
