# Intutic sandbox base image (LLD #63 §6).
#
# A minimal, genuinely-isolating runtime for `intutic exec --sandbox`. It ships
# only what the entrypoint needs to install the egress firewall and drop
# privilege: nftables, libcap (capsh), and a resolver. Bring your agent by
# extending this image (`FROM intutic/sandbox`) and installing your harness, or
# pass `--sandbox-image` with your own image that includes nftables + capsh.
#
# The image is intentionally not a place to run the agent as root: the
# entrypoint switches to the unprivileged `sandbox` user after applying the
# firewall.
FROM alpine:3.20

# nftables: the egress firewall. libcap: capsh, to drop NET_ADMIN. iproute2 +
# bash: entrypoint plumbing. curl + ca-certificates: so a sandboxed agent (and
# our own verification) can actually make governed calls through the proxy.
RUN apk add --no-cache nftables libcap iproute2 bash ca-certificates curl

# Unprivileged user the agent actually runs as.
RUN adduser -D -h /home/sandbox -s /bin/bash sandbox

COPY entrypoint.sh /usr/local/bin/intutic-sandbox-entrypoint
RUN chmod 0555 /usr/local/bin/intutic-sandbox-entrypoint

# The working directory the launcher bind-mounts the project into.
WORKDIR /work

ENTRYPOINT ["/usr/local/bin/intutic-sandbox-entrypoint"]
