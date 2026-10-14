---
title: Self-host with Docker Compose
description: Install, configure, upgrade and back up a Self-host deployment on one host with Docker Compose, connected or air-gapped.
---

# Self-host with Docker Compose <Badge type="danger" text="Self-host" />

One Linux host runs the whole stack behind an nginx front door on one HTTPS
address. Start from a [verified bundle](./self-host#getting-a-release).

## Install

From the unpacked bundle, as a user that can run Docker:

```bash
./intutic-enterprise-install.sh \
  --hostname intutic.example.internal \
  --license /path/to/license.json \
  --admin-email you@example.com --admin-name "Your Name" \
  --offline
```

`--offline` loads the images from the bundle's `images.tar` and pulls nothing,
which is what an air-gapped host needs.

Without `--offline` the installer pulls the images from `ghcr.io/intutic`, which
is private. Log in first with the username and pull token Intutic sent you:

```bash
docker login ghcr.io --username <username>   # paste the pull token when asked
```

The installer asks for the first owner's password (12 characters or more) when
run in a terminal. Otherwise it reads `INTUTIC_ADMIN_PASSWORD`, or generates
one and prints it once at the end.

What it does, in order:

1. Copies the Compose files and your license into `/opt/intutic` (`--install-dir`).
2. Installs your certificate (`--tls-cert`, `--tls-key`), or issues a self-signed
   one for the hostname.
3. Writes `/opt/intutic/.env` with generated secrets. It writes them only once:
   rerunning the installer (an upgrade) keeps them. `.env` also names the
   Compose files (`COMPOSE_FILE`), so `docker compose` run in `/opt/intutic`
   finds the stack with no `-f`.
4. Loads or pulls the images and checks each against the release's `images.lock`.
   An image that does not match is not started.
5. Starts the stack, waits for it to answer through nginx, and creates the owner.

Then sign in at `https://intutic.example.internal/`.

### Options

| Option | Default | |
|---|---|---|
| `--hostname` | required | The name users reach Intutic at |
| `--license` | required | Your license file |
| `--admin-email` | required on a first install | The first owner's email |
| `--admin-name` | `Administrator` | The first owner's name |
| `--offline` | off | Load images from the bundle; pull nothing |
| `--tls-cert`, `--tls-key` | self-signed | Your certificate and key for the hostname |
| `--smtp-url` | none | Your mail relay, e.g. `smtp://relay.example.internal:25` |
| `--install-dir` | `/opt/intutic` | Where the configuration lives |
| `--data-dir` | `<install-dir>/data` | Where Postgres keeps its data |
| `--https-port`, `--http-port` | 443, 80 | Published ports (80 redirects to HTTPS) |
| `--registry` | `ghcr.io/intutic` | Your mirror of the Intutic images |
| `--version` | the bundle's `VERSION` | The release to run |
| `--bundle` | the installer's directory | The unpacked bundle to install from |
| `--with-turbovec`, `--with-litellm` | off | The optional services: the semantic cache, and [LiteLLM](#llm-backed-checks) |
| `--dry-run` | off | Print what it would do |

## Point model requests at your endpoints

The proxy sends each provider's requests to that provider's public API unless
you set its address. On an air-gapped network, set the ones you use in
`/opt/intutic/.env`, then run `docker compose up -d` in `/opt/intutic`:

```bash
OPENAI_UPSTREAM_URL=https://openai-private.example.internal
ANTHROPIC_UPSTREAM_URL=https://anthropic-egress.example.internal
```

Also available: `GEMINI_UPSTREAM_URL`, `MISTRAL_UPSTREAM_URL`,
`OPENROUTER_UPSTREAM_URL` and `DEEPSEEK_UPSTREAM_URL`. Workspace provider keys
are set in the dashboard as usual.

## LLM-backed checks

SOP scoring, the trajectory judge and the compliance probes call a model
through LiteLLM, which the installer runs with `--with-litellm`. LiteLLM sends
those calls to your own OpenAI-compatible model server (Ollama or vLLM); no
hosted model is used. Without it the checks fall back to their deterministic
versions.

1. In `/opt/intutic/.env`, set:

   | Variable | |
   |---|---|
   | `INTUTIC_OPENWEIGHT_API_BASE` | Your model server, e.g. `http://vllm.example.internal:8000/v1` |
   | `INTUTIC_OPENWEIGHT_API_KEY` | Its key, if it checks one (default `not-needed`) |
   | `LITELLM_MASTER_KEY` | LiteLLM's admin key: `openssl rand -hex 32` |
   | `LITELLM_MODEL` | The model the platform works with (default `intutic-openweight-fast`) |
   | `INTUTIC_TRUSTED_MONITOR_MODEL` | The model that grades it (default `intutic-openweight-judge`). It must differ from `LITELLM_MODEL`, or every check grades its own output |

   Both names are aliases in `litellm_config.yaml`; replace the model each one
   points at with one your server serves, ideally two different models.
2. Rerun the installer with `--with-litellm`, or add `litellm` to
   `COMPOSE_PROFILES` in `.env` and run `docker compose up -d`. LiteLLM keeps its
   keys in a database of its own, `litellm`, which the `litellm-db` service
   creates in the bundled Postgres with the generated
   `LITELLM_DATABASE_PASSWORD`.
3. The control plane uses a key scoped to the two aliases, never the admin key.
   Mint it inside the LiteLLM container, which is the only place LiteLLM can
   be reached from:

   ```bash
   cd /opt/intutic
   docker compose exec -T litellm bash -s generate < bootstrap-litellm-platform-key.sh
   ```

   It prints the key once. Set it as `LITELLM_PLATFORM_KEY` in `.env`, then
   `docker compose up -d`. To replace a key, mint a new one, switch to it, and
   block the old one with `revoke <old key>` in place of `generate`.

## Email

Set `SMTP_URL` in `.env` (`smtp://host:25`, or `smtps://user:password@host:465`)
and optionally `EMAIL_FROM` (default `noreply@<hostname>`), then
`docker compose up -d`.

Alerts and approvals go out through the notification hub, which is on with
every channel: email through `SMTP_URL`, webhooks, Slack and PagerDuty, as your
notification rules name them. To turn a channel off, set its flag to `false` in
`.env` (`FF_SLACK_ADAPTER=false`). Webhooks and SIEM export refuse private
addresses unless their hosts are in `INTUTIC_WEBHOOK_ALLOWED_HOSTS`.

## GitHub Enterprise Server and Confluence Data Center

The GitHub and Confluence policy sources reach github.com and the address each
Confluence source names. To use your own servers, set these in `.env`, then
`docker compose up -d`:

```bash
GITHUB_BASE_URL=https://github.example.internal/api/v3
CONFLUENCE_BASE_URL=http://confluence.example.internal:8090
```

## Your own changes

Put changes to the stack in `/opt/intutic/docker-compose.override.yml`: an extra
network, resource limits, a different log driver. An upgrade never touches it.
The installer reads it whenever it exists, and lists it in `COMPOSE_FILE` in
`.env` so `docker compose` reads it too. If you create the file after
installing, rerun the installer, or set
`COMPOSE_FILE=docker-compose.enterprise.yml:docker-compose.override.yml`
yourself.

## Images and mirrors

The installer and the release bundle take the image list from the Compose file
itself, never from a separate list. The images your install runs:

```bash
cd /opt/intutic
docker compose config --images
```

To pull from your own registry instead of the bundle or `ghcr.io`, mirror those
images and set these in `.env`:

| Variable | Default |
|---|---|
| `INTUTIC_REGISTRY` | `ghcr.io/intutic`: control-plane, proxy, dashboard, docs |
| `POSTGRES_IMAGE` | `postgres` (16-alpine), pinned by digest |
| `VALKEY_IMAGE` | `valkey/valkey` (7-alpine), pinned by digest |
| `NGINX_IMAGE` | `nginx`, pinned by digest |
| `TURBOVEC_IMAGE` | `ghcr.io/intutic/turbovec`, pinned by digest |
| `LITELLM_IMAGE` | `ghcr.io/berriai/litellm`, pinned by digest |

## Upgrade

Verify the new bundle, unpack it, and run its installer with the same
`--hostname` and `--license`. Leave out `--admin-email`. The secrets, your
data and your override file stay; the images and Compose files are replaced and
the database is migrated before the new control plane starts. An install whose
`.env` has no `COMPOSE_FILE` (an older installer did not write one) gets it this
way; until then, its `docker compose` commands need
`-f docker-compose.enterprise.yml`.

`POSTGRES_PASSWORD`, `JWT_SECRET` and `ENCRYPTION_KEY` are required, and the
control plane refuses a template value such as `changeme` for any of them. The
installer generated all three. A stack set up by hand from
`.env.enterprise.example` that left `POSTGRES_PASSWORD` at its old
`changeme_prod` must change it before upgrading: set the new password on the
role (`docker compose exec postgres psql -U intutic -c "ALTER ROLE intutic PASSWORD '…'"`),
then put the same value in `.env`.

From 2.4.0 the proxy opens the provider keys the control plane stores
encrypted. The installer restarts the control plane first and the proxy after
it; the control plane encrypts the stored provider keys only once the new proxy
reports that it holds the key, and Compose stops the old proxy before starting
the new one, so no request is served with a key the proxy cannot read. A
provider key added or replaced in the seconds between the two restarts is the
exception: the old proxy cannot read it, so requests needing it fail until the
new proxy is up.

## Back up and restore

Everything that matters is in Postgres. Back it up with `pg_dump` from the
`postgres` service, and keep `/opt/intutic/.env` with it: stored credentials are
encrypted under its `ENCRYPTION_KEY`.

```bash
cd /opt/intutic
docker compose exec -T postgres pg_dump -U intutic -Fc intutic > intutic-$(date +%F).dump
```

To restore, install the same release on the new host with the backed-up `.env`
in place, stop the control plane, and `pg_restore` into the `postgres` service.

## When something is wrong

```bash
cd /opt/intutic
docker compose ps
docker compose logs --tail 200 control-plane nginx
```

The control plane refuses to start without `APP_URL` and `API_BASE_URL`; the
installer sets both from `--hostname`. A deployment without a valid license
shows only the license page: see [Your license](./self-host-license).
