# check=skip=InvalidDefaultArgInFrom
# The chaos e2e suite's sandbox image: the Node sandbox image plus the built
# MCP proxy with its production dependencies (`pnpm deploy --prod`), which is
# the build context. It brings an agent the way the docs say to: FROM the
# Node image, nothing about the entrypoint changed.
ARG INTUTIC_SANDBOX_NODE
FROM ${INTUTIC_SANDBOX_NODE}

COPY . /opt/intutic/mcp-proxy
