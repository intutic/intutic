# ─────────────────────────────────────────────────────────────
# Docs Dockerfile — @intutic/docs (VitePress)
# ─────────────────────────────────────────────────────────────
# 2-stage build: VitePress → nginx static serving
#
# Build context is the monorepo root:
#   docker build -f apps/docs/Dockerfile -t intutic-docs .
#
# TD-106 | Sprint 5A
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

# Set explicit Open Source build flags for public docs.intutic.ai deployment
ENV INTUTIC_OPEN_SOURCE=true
ENV INTUTIC_MODE=oss
ENV INTUTIC_ENTERPRISE_BUILD=false
# Fail the build outright if OSS gating is ever off — see the guard in
# apps/docs/.vitepress/config.ts. Without this the failure mode is a silently
# published site full of paid-tier pages.
ENV INTUTIC_REQUIRE_OSS=true

# Build theme first, so that custom variables and synced assets exist
RUN pnpm --filter=@intutic/theme run build
RUN pnpm --filter=@intutic/docs run build

# ── Stage 2: nginx ──────────────────────────────────────────
FROM nginx:1.27-alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy docs nginx config
COPY infra/nginx/docs.conf /etc/nginx/conf.d/default.conf

# Copy built static site
COPY --from=builder /app/apps/docs/.vitepress/dist /usr/share/nginx/html

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -q --spider http://localhost:80/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
