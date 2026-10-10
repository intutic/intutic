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

The control plane connects over TLS and checks the server's certificate. If your
Postgres's certificate is signed by your own certificate authority, give the
chart that CA (step 2). `DATABASE_SSL` in `intutic-secrets` changes the check:

| `DATABASE_SSL` | |
|---|---|
| `verify` (default) | TLS, and the certificate must be valid for the host in the URL |
| `require` | TLS without checking the certificate |
| `disable` | No TLS, for a Postgres that does not offer it |

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

The owner's password needs 12 characters or more.

The control plane refuses to start when `JWT_SECRET` or `ENCRYPTION_KEY` is
shorter than 32 characters or a template value such as `changeme`, or when a
database URL's password is one. Generate each as above; `ENCRYPTION_KEY` is 64
hex characters.

Optional keys in `intutic-secrets`: `DATABASE_SSL` (above), `SMTP_URL` (your mail
relay), `TRACE_SIGNING_PRIVATE_KEY`, `TRACE_SIGNING_RETIRED_KEYS`,
`LITELLM_PLATFORM_KEY`. Keep `ENCRYPTION_KEY` with your database backups: stored
credentials are encrypted under it.

Alerts and approvals go out through the notification hub, which is on with
every channel: email through `SMTP_URL`, webhooks, Slack and PagerDuty. To turn
a channel off, set its flag in `controlPlane.env` (`FF_SLACK_ADAPTER: "false"`).
Webhook and SIEM targets on your private network need their hosts in
`controlPlane.env.INTUTIC_WEBHOOK_ALLOWED_HOSTS`.

Your own certificate authority, for Postgres or any internal service the control
plane calls over HTTPS (your mail relay, webhook targets, LiteLLM), goes in a
Secret of PEM certificates; install with `--set caBundle.secretName=intutic-ca`:

```bash
kubectl -n intutic create secret generic intutic-ca --from-file=ca.crt=corp-ca.pem
```

## 3. Registry access

The images and charts at `ghcr.io/intutic` are private. With the username and
pull token Intutic sent you, let the cluster pull the images and Helm pull the
chart:

```bash
kubectl -n intutic create secret docker-registry intutic-ghcr \
  --docker-server=ghcr.io --docker-username=<username> --docker-password=<pull token>

helm registry login ghcr.io --username <username>   # paste the pull token when asked
```

Installing from the bundle on an air-gapped network needs neither: see below.

## 4. Install

`<version>` is the release Intutic sent you, the `VERSION` file in its bundle.
Each release publishes its chart and its images under that one version;
`helm show chart oci://ghcr.io/intutic/charts/intutic --version <version>`
confirms you can reach it.

```bash
helm install intutic oci://ghcr.io/intutic/charts/intutic --version <version> \
  --namespace intutic \
  --set hostname=intutic.example.internal \
  --set ingress.className=nginx \
  --set ingress.tls.secretName=intutic-tls \
  --set bootstrap.secretName=intutic-owner \
  --set 'global.imagePullSecrets[0].name=intutic-ghcr'
```

The migration Job runs before the install and every upgrade; the bootstrap Job
creates the owner after it, and does nothing once the licensed organisation
exists. Then sign in at `https://intutic.example.internal/`.

### Air-gapped

The bundle (`intutic-selfhost-<version>-<arch>.tar.gz`) holds the images for one
architecture: use the one that matches your nodes. Push its images to your
registry, then install the chart from its `helm/` directory:

```bash
cd intutic-selfhost-<version>
docker load -i images.tar
REG=registry.example.internal/intutic
for image in control-plane proxy dashboard docs; do
  docker tag ghcr.io/intutic/$image:<version> $REG/$image:<version>
  docker push $REG/$image:<version>
done
# Valkey is saved under the tag in images.env (VALKEY_IMAGE).
docker tag valkey/valkey:intutic-<version> $REG/valkey:intutic-<version>
docker push $REG/valkey:intutic-<version>

helm install intutic helm/intutic-<version>.tgz \
  --namespace intutic \
  --set hostname=intutic.example.internal \
  --set ingress.className=nginx \
  --set ingress.tls.secretName=intutic-tls \
  --set bootstrap.secretName=intutic-owner \
  --set global.imageRegistry=$REG \
  --set valkey.image.repository=$REG/valkey \
  --set valkey.image.tag=intutic-<version>
```

If your registry needs credentials, add a pull Secret for it as in step 3 and
set `global.imagePullSecrets`.

## Values

| Value | Default | |
|---|---|---|
| `hostname` | required | The name users reach Intutic at |
| `secretName` | `intutic-secrets` | The credentials above |
| `license.secretName` | `intutic-license` | The license, under the key `license.json` |
| `bootstrap.secretName` | none | Creates the first owner: keys `email`, `name`, `password` (12+ characters) |
| `caBundle.secretName`, `caBundle.key` | none, `ca.crt` | Extra CA certificates to trust, for Postgres and internal HTTPS services |
| `ingress.enabled` | `true` | `false` to route to the Services with your own Ingress or gateway |
| `ingress.className`, `ingress.annotations` | none | Your Ingress controller |
| `ingress.tls.secretName` | none | Omit when your load balancer terminates TLS |
| `emailFrom` | `noreply@<hostname>` | Sender for every email |
| `global.imageRegistry` | `ghcr.io/intutic` | Your mirror of the Intutic images |
| `global.imageTag` | the chart's version | |
| `global.imagePullSecrets` | none | Pull Secrets for the registry, e.g. `[{name: intutic-ghcr}]` |
| `valkey.enabled` | `true` | `false` with `valkey.url` to use your own Valkey or Redis 7 |
| `valkey.image.repository`, `valkey.image.tag` | `valkey/valkey`, `7-alpine` | Your copy of Valkey |
| `valkey.persistence.size`, `valkey.persistence.storageClass` | `5Gi`, the cluster default | Valkey's volume |
| `proxy.env` | none | Where model requests go: `OPENAI_UPSTREAM_URL`, `ANTHROPIC_UPSTREAM_URL`, `GEMINI_UPSTREAM_URL`, `MISTRAL_UPSTREAM_URL`, `OPENROUTER_UPSTREAM_URL`, `DEEPSEEK_UPSTREAM_URL` |
| `controlPlane.env` | LiteLLM model names, `LOG_LEVEL` | Extra settings, e.g. `INTUTIC_WEBHOOK_ALLOWED_HOSTS`, or `LITELLM_ADMIN_BASE_URL`: your LiteLLM's address, which turns on the LLM-backed checks |
| `controlPlane.replicaCount`, `proxy.replicaCount`, `dashboard.replicaCount` | 2 | |
| `docs.replicaCount` | 1 | |
| `controlPlane.autoscaling.enabled` | `false` | With `minReplicas`, `maxReplicas` and CPU and memory targets |
| `controlPlane.resources`, `proxy.resources`, `dashboard.resources`, `docs.resources`, `valkey.resources` | see `helm show values` | Requests and limits |
| `controlPlane.nodeSelector`, `controlPlane.tolerations`, `controlPlane.affinity` | spread across nodes | Where the control plane runs |
| `serviceAccount.create`, `serviceAccount.name`, `serviceAccount.annotations` | `true`, named after the release, none | The pods' ServiceAccount. With `create: false`, name one that exists; the migration Job runs as it too |
| `podDisruptionBudget.enabled`, `podDisruptionBudget.minAvailable` | `true`, 1 | Keeps a control plane running through node drains |
| `migrationJob.backoffLimit`, `migrationJob.ttlSecondsAfterFinished` | 3, 300 | The migration Job's retries, and how long a finished one is kept |

`helm show values oci://ghcr.io/intutic/charts/intutic --version <version>`
prints every value with its comments.

The Ingress routes `/` to the dashboard, `/api`, `/scim` and `/.well-known` to
the control plane, `/v1` to the proxy and `/docs` to the docs.

## Upgrade

```bash
helm upgrade intutic oci://ghcr.io/intutic/charts/intutic --version <new version> \
  --namespace intutic --reuse-values
```

The migration Job runs first; a failed migration leaves the running release
untouched.

From 2.4.0 the proxy opens the provider keys the control plane stores
encrypted, and the control plane encrypts them only once a proxy holding the key
has started. `helm upgrade` rolls the proxy and the control plane together, so
until the proxy's rollout finishes, a pod from the previous release can still
receive a request for a workspace whose key is already encrypted; that request
fails with the provider's authentication error. To avoid it, upgrade the proxy
first, wait for its rollout, then upgrade the rest:

```bash
kubectl -n intutic set image deploy/intutic-proxy proxy=ghcr.io/intutic/proxy:<new version>
kubectl -n intutic rollout status deploy/intutic-proxy
helm upgrade intutic oci://ghcr.io/intutic/charts/intutic --version <new version> \
  --namespace intutic --reuse-values
```
