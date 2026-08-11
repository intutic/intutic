#!/bin/sh
# Intutic sandbox entrypoint (LLD #63 §6).
#
# The container starts as root with NET_ADMIN so this script can install a
# firewall; the agent must NOT keep that power. So, in order:
#   1. Resolve the governing proxy's address (written into /etc/hosts by the
#      launcher via --add-host).
#   2. Apply a default-DROP egress firewall permitting outbound only to the
#      proxy, DNS, loopback, and established return traffic — the same shape as
#      the host-level L2 rules, scoped to this container's network namespace.
#   3. Drop NET_ADMIN/NET_RAW and switch to the unprivileged `sandbox` user, so
#      the agent cannot alter or remove the firewall it now runs behind.
#   4. exec the agent command.
#
# Honesty rule (LLD #63 §6): if the firewall cannot be applied, we refuse to run
# rather than run ungoverned. A sandbox that silently fails open is worse than
# no sandbox, because the caller believes it is protected.
set -eu

PROXY_HOST="${INTUTIC_SANDBOX_PROXY_HOST:-host.docker.internal}"

# Resolve the proxy host. --add-host writes it to /etc/hosts, which is the most
# reliable source inside a minimal image (busybox has no getent).
PROXY_IP="$(awk -v h="$PROXY_HOST" '$2==h || $3==h {print $1; exit}' /etc/hosts 2>/dev/null || true)"
if [ -z "$PROXY_IP" ]; then
  PROXY_IP="$(getent hosts "$PROXY_HOST" 2>/dev/null | awk '{print $1; exit}' || true)"
fi
if [ -z "$PROXY_IP" ]; then
  echo "intutic-sandbox: cannot resolve proxy host '$PROXY_HOST' — refusing to run ungoverned" >&2
  exit 91
fi

# Extra operator-allowed destinations (comma-separated CIDRs), e.g. a package
# registry the build step needs. Rendered as additional accept rules.
EXTRA_RULES=""
if [ -n "${INTUTIC_SANDBOX_ALLOW:-}" ]; then
  OLDIFS="$IFS"; IFS=','
  for cidr in $INTUTIC_SANDBOX_ALLOW; do
    [ -z "$cidr" ] && continue
    case "$cidr" in
      *:*) EXTRA_RULES="$EXTRA_RULES
    ip6 daddr $cidr accept" ;;
      *)   EXTRA_RULES="$EXTRA_RULES
    ip daddr $cidr accept" ;;
    esac
  done
  IFS="$OLDIFS"
fi

if ! nft -f - <<EOF
table inet intutic_egress {
  chain output {
    type filter hook output priority 0; policy drop;
    oif "lo" accept
    ct state established,related accept
    meta l4proto { tcp, udp } th dport 53 accept
    ip daddr $PROXY_IP accept$EXTRA_RULES
  }
}
EOF
then
  echo "intutic-sandbox: FAILED to apply egress firewall — refusing to run ungoverned" >&2
  exit 90
fi

# Strip the `--` separator the launcher inserts before the command.
if [ "${1:-}" = "--" ]; then shift; fi
if [ "$#" -eq 0 ]; then
  echo "intutic-sandbox: no command given" >&2
  exit 2
fi

# Drop every capability we needed as root — the network-admin caps used for the
# firewall, and the setpcap/setuid/setgid caps used for this very transition —
# from the bounding set, then run as the unprivileged sandbox user. capsh still
# holds these in its permitted set long enough to perform the user switch; the
# bounding-set drop only stops them being *re-acquired*, so the agent process
# ends up with an empty capability set and no path back to any of them. The
# firewall above is therefore immutable from inside the sandbox.
exec capsh \
  --drop=cap_net_admin,cap_net_raw,cap_setpcap,cap_setuid,cap_setgid \
  --user=sandbox -- -c 'exec "$@"' intutic-sandbox "$@"
