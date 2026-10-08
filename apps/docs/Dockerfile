# ─────────────────────────────────────────────────────────────
# Docs Dockerfile — @intutic/docs (VitePress)
# ─────────────────────────────────────────────────────────────
# 2-stage build: VitePress → nginx static serving
#
# Build context is the monorepo root:
#   docker build -f apps/docs/Dockerfile -t intutic-docs .
# ─────────────────────────────────────────────────────────────

# ── Stage 1: Builder ────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@11.6.0

# Copy workspace and lock files
COPY pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/docs/package.json ./apps/docs/package.json
COPY packages/theme/package.json ./packages/theme/package.json
COPY packages/logger/package.json ./packages/logger/package.json

RUN pnpm install --filter=@intutic/docs --filter=@intutic/theme --filter=@intutic/logger --frozen-lockfile --ignore-scripts

COPY packages/logger/ ./packages/logger/
COPY packages/theme/ ./packages/theme/
COPY apps/docs/ ./apps/docs/
COPY tsconfig.base.json ./tsconfig.base.json

# docs.intutic.ai publishes every page, open-source and paid-tier alike: the
# Cloud and Enterprise pages carry their badge, and the dashboard's help links
# point at them (an open-source-only site answered 14 of its 22 links with a
# 404). See the guard in apps/docs/.vitepress/config.ts.
ENV INTUTIC_ENTERPRISE_BUILD=true
# Fail the build outright if it would leave the paid-tier pages out: that site
# would break the dashboard's help links.
ENV INTUTIC_REQUIRE_FULL=true
# Path the site is served under: `/` for docs.intutic.ai, `/docs/` for the copy
# bundled with a Self-host deployment (release-selfhost.yml).
ARG DOCS_BASE=/
ENV DOCS_BASE=$DOCS_BASE

# Build theme first, so that custom variables and synced assets exist
RUN pnpm --filter=@intutic/theme run build
RUN pnpm --filter=@intutic/docs run build
# The flags above are only intent; check the result. Settings is a Cloud page,
# and the dashboard links to it more than any other.
RUN test -f apps/docs/.vitepress/dist/guide/settings.html \
 || { echo 'docs image is missing the paid-tier pages (guide/settings.html); the dashboard help links would 404' >&2; exit 1; }

# ── Stage 2: nginx ──────────────────────────────────────────
FROM nginx:1.27-alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy docs nginx config
COPY infra/nginx/docs.conf /etc/nginx/conf.d/default.conf

# Copy built static site, at the path it was built for: `/docs/` in the
# Self-host image, so the deployment's front door (nginx or a Kubernetes
# Ingress) passes /docs/... through unchanged, with no prefix to strip.
ARG DOCS_BASE=/
ENV DOCS_BASE=$DOCS_BASE
COPY --from=builder /app/apps/docs/.vitepress/dist /usr/share/nginx/html${DOCS_BASE}
RUN sed -i "s#/404.html#${DOCS_BASE}404.html#g" /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider "http://localhost:80${DOCS_BASE}" || exit 1

CMD ["nginx", "-g", "daemon off;"]
