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
   rerunning the installer (an upgrade) keeps them.
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
| `--with-turbovec`, `--with-litellm` | off | The optional services |
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

## Email

Set `SMTP_URL` in `.env` (`smtp://host:25`, or `smtps://user:password@host:465`)
and optionally `EMAIL_FROM` (default `noreply@<hostname>`), then
`docker compose up -d`.

Alerts and approvals go out through the notification hub, which is on with
every channel: email through `SMTP_URL`, webhooks, Slack and PagerDuty, as your
notification rules name them. To turn a channel off, set its flag to `false` in
`.env` (`FF_SLACK_ADAPTER=false`). Webhooks and SIEM export refuse private
addresses unless their hosts are in `INTUTIC_WEBHOOK_ALLOWED_HOSTS`.

## Your own changes

Put changes to the stack in `/opt/intutic/docker-compose.override.yml`: an extra
network, resource limits, a different log driver. The installer and
`docker compose` both read it, and an upgrade never touches it.

## Images and mirrors

The installer and the release bundle take the image list from the Compose file
itself, never from a separate list:

```bash
docker compose -f docker-compose.enterprise.yml config --images
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
the database is migrated before the new control plane starts.

`POSTGRES_PASSWORD`, `JWT_SECRET` and `ENCRYPTION_KEY` are required, and the
control plane refuses a template value such as `changeme` for any of them. The
installer generated all three. A stack set up by hand from
`.env.enterprise.example` that left `POSTGRES_PASSWORD` at its old
`changeme_prod` must change it before upgrading: set the new password on the
role (`docker compose exec postgres psql -U intutic -c "ALTER ROLE intutic PASSWORD '…'"`),
then put the same value in `.env`.

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
