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

# Edition: which pages the site carries.
#   oss  (default) the open-source pages only. VitePress leaves out every page
#        badged Cloud, Self-serve+, Biz Org+, Enterprise or Self-host, plus Plans
#        & pricing, strips ENTERPRISE_ONLY blocks, and refuses to build if a
#        hosted or self-host term survives (apps/docs/.vitepress/config.ts).
#   full every page, for the copy bundled with a Self-host deployment
#        (release-selfhost.yml, selfhost-smoke.yml), whose dashboard help links
#        point at the paid-tier pages.
# docs.intutic.ai builds oss until the hosted Cloud and the Self-host
# distribution launch: only the open-source core is released. At launch, pass
# --build-arg DOCS_EDITION=full in .github/workflows/deploy.yml (docs leg) and
# tools/scripts/deploy.sh (docs component), and relax the check in
# verify_oss_posture() that refuses exactly that.
ARG DOCS_EDITION=oss
# Path the site is served under: `/` for docs.intutic.ai, `/docs/` for the copy
# bundled with a Self-host deployment (release-selfhost.yml).
ARG DOCS_BASE=/
ENV DOCS_BASE=$DOCS_BASE

# Build theme first, so that custom variables and synced assets exist
RUN pnpm --filter=@intutic/theme run build
# INTUTIC_ENTERPRISE_BUILD is the only mode signal config.ts reads; full also
# sets INTUTIC_REQUIRE_FULL, which makes config.ts throw rather than build
# without the paid-tier pages. An unknown edition fails here.
RUN case "$DOCS_EDITION" in \
      full) export INTUTIC_ENTERPRISE_BUILD=true INTUTIC_REQUIRE_FULL=true ;; \
      oss)  export INTUTIC_ENTERPRISE_BUILD=false INTUTIC_REQUIRE_FULL=false ;; \
      *)    echo "DOCS_EDITION must be oss or full, not '$DOCS_EDITION'" >&2; exit 1 ;; \
    esac \
 && pnpm --filter=@intutic/docs run build
# The edition is only intent; check the result. Settings is the Cloud page the
# dashboard links to most; Self-host and Plans & pricing are the pages the
# open-source site most needs to leave out. full must have all three, oss none.
RUN for page in guide/settings guide/self-host guide/plans; do \
      f="apps/docs/.vitepress/dist/$page.html"; \
      if [ "$DOCS_EDITION" = full ]; then \
        test -f "$f" || { echo "full docs image is missing $page.html; the dashboard help links would 404" >&2; exit 1; }; \
      else \
        test ! -e "$f" || { echo "oss docs image carries the paid-tier page $page.html" >&2; exit 1; }; \
      fi; \
    done
# The Content-Security-Policy allows the pages' inline scripts by hash, and one
# of them changes with every build, so the hashes come from this build's pages.
RUN node apps/docs/scripts/csp-script-hashes.mjs apps/docs/.vitepress/dist > /app/csp-script-hashes.txt

# ── Stage 2: nginx ──────────────────────────────────────────
FROM nginx:1.27-alpine

# Remove default nginx config
RUN rm /etc/nginx/conf.d/default.conf

# Copy docs nginx config
COPY infra/nginx/docs.conf /etc/nginx/conf.d/default.conf
COPY infra/nginx/docs-security-headers.conf /etc/nginx/snippets/docs-security-headers.conf
COPY --from=builder /app/csp-script-hashes.txt /tmp/csp-script-hashes.txt
RUN sed -i "s#__SCRIPT_HASHES__#$(cat /tmp/csp-script-hashes.txt)#" /etc/nginx/snippets/docs-security-headers.conf \
 && ! grep -q __SCRIPT_HASHES__ /etc/nginx/snippets/docs-security-headers.conf \
 && rm /tmp/csp-script-hashes.txt

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
