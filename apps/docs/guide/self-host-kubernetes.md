---
title: Self-host on Kubernetes
description: Install a Self-host deployment with the intutic Helm chart, against your own Postgres, behind your Ingress.
---

# Self-host on Kubernetes <Badge type="danger" text="Self-host" />

The `intutic` Helm chart runs the control plane, proxy, dashboard, docs and
Valkey behind one Ingress host. Postgres is yours: any PostgreSQL 15 or later
the cluster can reach.

## 1. Postgres: two roles

The control plane connects as a restricted role, `intutic_app`, so the
database's row-level security can separate workspaces; the owner role runs
migrations and background jobs. Create the database and its owner; the
migration Job creates `intutic_app` and sets the password you give it below.

## 2. Secrets

```bash
kubectl create namespace intutic

kubectl -n intutic create secret generic intutic-secrets \
  --from-literal=JWT_SECRET="$(openssl rand -base64 64 | tr -d '\n')" \
  --from-literal=ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  --from-literal=INTUTIC_APP_PASSWORD="$APP_PASSWORD" \
  --from-literal=DATABASE_URL="postgresql://intutic_app:$APP_PASSWORD@db.example.internal:5432/intutic" \
  --from-literal=MIGRATION_DATABASE_URL="postgresql://intutic:$OWNER_PASSWORD@db.example.internal:5432/intutic" \
  --from-literal=BACKGROUND_DATABASE_URL="postgresql://intutic:$OWNER_PASSWORD@db.example.internal:5432/intutic"

kubectl -n intutic create secret generic intutic-license --from-file=license.json

kubectl -n intutic create secret tls intutic-tls --cert=server.crt --key=server.key

# The first owner, created once the install is up:
kubectl -n intutic create secret generic intutic-owner \
  --from-literal=email=you@example.com --from-literal=name="Your Name" \
  --from-literal=password="$OWNER_LOGIN_PASSWORD"
```

Optional keys in `intutic-secrets`: `SMTP_URL` (your mail relay),
`TRACE_SIGNING_PRIVATE_KEY`, `TRACE_SIGNING_RETIRED_KEYS`, `LITELLM_PLATFORM_KEY`.
Keep `ENCRYPTION_KEY` with your database backups: stored credentials are
encrypted under it.

## 3. Install

From the release bundle's `helm/` directory, or from `ghcr.io` with your pull
token:

```bash
helm install intutic oci://ghcr.io/intutic/charts/intutic --version <version> \
  --namespace intutic \
  --set hostname=intutic.example.internal \
  --set ingress.className=nginx \
  --set ingress.tls.secretName=intutic-tls \
  --set bootstrap.secretName=intutic-owner
```

Air-gapped: push the bundle's images to your registry (`docker load -i images.tar`,
then tag and push), install from `helm/intutic-<version>.tgz`, and set
`global.imageRegistry` to your registry and `valkey.image.repository` to your
copy of Valkey.

The migration Job runs before the install and every upgrade; the bootstrap Job
creates the owner after it, and does nothing once the licensed organisation
exists. Then sign in at `https://intutic.example.internal/`.

## Values

| Value | Default | |
|---|---|---|
| `hostname` | required | The name users reach Intutic at |
| `secretName` | `intutic-secrets` | The credentials above |
| `license.secretName` | `intutic-license` | The license, under the key `license.json` |
| `bootstrap.secretName` | none | Creates the first owner |
| `ingress.className`, `ingress.annotations` | none | Your Ingress controller |
| `ingress.tls.secretName` | none | Omit when your load balancer terminates TLS |
| `emailFrom` | `noreply@<hostname>` | Sender for every email |
| `global.imageRegistry` | `ghcr.io/intutic` | Your mirror of the Intutic images |
| `global.imageTag` | the chart's version | |
| `valkey.enabled` | `true` | `false` with `valkey.url` to use your own Valkey or Redis 7 |
| `proxy.env` | none | Where model requests go: `OPENAI_UPSTREAM_URL`, `ANTHROPIC_UPSTREAM_URL`, `GEMINI_UPSTREAM_URL`, `MISTRAL_UPSTREAM_URL`, `OPENROUTER_UPSTREAM_URL`, `DEEPSEEK_UPSTREAM_URL` |
| `controlPlane.env` | LiteLLM settings | Extra settings, e.g. `INTUTIC_WEBHOOK_ALLOWED_HOSTS` |
| `controlPlane.replicaCount`, `proxy.replicaCount`, `dashboard.replicaCount` | 2 | |
| `controlPlane.autoscaling.enabled` | `false` | |

The Ingress routes `/` to the dashboard, `/api`, `/scim` and `/.well-known` to
the control plane, `/v1` to the proxy and `/docs` to the docs.

## Upgrade

```bash
helm upgrade intutic oci://ghcr.io/intutic/charts/intutic --version <new version> \
  --namespace intutic --reuse-values
```

The migration Job runs first; a failed migration leaves the running release
untouched.
