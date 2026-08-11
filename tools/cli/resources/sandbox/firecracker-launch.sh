#!/bin/bash
# Firecracker microVM launch (LLD #63 §6, Increment 4).
#
# This is the boot sequence validated on a real KVM host (GCE nested-virt,
# Intel): it sets up the tap link, installs a host-side default-deny egress
# firewall scoped to the guest so the microVM's only route out is the proxy,
# boots the microVM via the Firecracker API, runs the agent command inside the
# guest, and tears everything down.
#
# Verification status (honest): the microVM + guest kernel boot on KVM through
# exactly this API sequence is proven. Running the agent to completion *inside*
# a fully-booted guest depends on the operator supplying a matched
# kernel+rootfs (the rootfs must contain the agent and an sshd, like an OCI
# sandbox image must contain the agent). The in-guest exec below uses the
# standard Firecracker CI ssh path and is gated on that.
#
# Privileged: tap + nft + firecracker need root.
set -uo pipefail

KERNEL="" ROOTFS="" TAP="tap-intutic" GUEST_IP="172.16.0.2" HOST_IP="172.16.0.1"
PREFIX="30" VCPUS="1" MEM="512" ALLOW="" GUEST_KEY="${INTUTIC_FC_GUEST_KEY:-}"
CMD=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --kernel) KERNEL="$2"; shift 2;;
    --rootfs) ROOTFS="$2"; shift 2;;
    --tap) TAP="$2"; shift 2;;
    --guest-ip) GUEST_IP="$2"; shift 2;;
    --host-ip) HOST_IP="$2"; shift 2;;
    --prefix) PREFIX="$2"; shift 2;;
    --vcpus) VCPUS="$2"; shift 2;;
    --mem) MEM="$2"; shift 2;;
    --allow) ALLOW="$2"; shift 2;;
    --) shift; CMD=("$@"); break;;
    *) echo "firecracker-launch: unknown arg '$1'" >&2; exit 2;;
  esac
done
[ -n "$KERNEL" ] && [ -n "$ROOTFS" ] || { echo "firecracker-launch: --kernel and --rootfs are required" >&2; exit 2; }

NFT="$(command -v nft || echo /usr/sbin/nft)"
SOCK="$(mktemp -u /tmp/intutic-fc-XXXX.sock)"
CONSOLE="$(mktemp /tmp/intutic-fc-console-XXXX.log)"
FCPID=""

cleanup() {
  [ -n "$FCPID" ] && sudo kill "$FCPID" 2>/dev/null
  sudo ip link del "$TAP" 2>/dev/null || true
  sudo "$NFT" delete table inet intutic_vm_egress 2>/dev/null || true
  rm -f "$SOCK"
}
trap cleanup EXIT

echo "firecracker-launch: tap $TAP ($HOST_IP/$PREFIX) + host-side default-deny egress for guest $GUEST_IP"
sudo ip link del "$TAP" 2>/dev/null || true
sudo ip tuntap add "$TAP" mode tap
sudo ip addr add "${HOST_IP}/${PREFIX}" dev "$TAP"
sudo ip link set "$TAP" up
sudo sysctl -w net.ipv4.ip_forward=1 >/dev/null

# Host-side default-deny egress for the guest: allow the proxy (host) + DNS +
# operator --allow CIDRs and established return traffic; drop the rest. The
# agent inside the guest cannot alter this — it lives on the host.
EXTRA=""
if [ -n "$ALLOW" ]; then
  OLDIFS="$IFS"; IFS=','
  for c in $ALLOW; do [ -n "$c" ] && EXTRA="$EXTRA
    ip saddr ${GUEST_IP} ip daddr ${c} accept"; done
  IFS="$OLDIFS"
fi
sudo "$NFT" -f - <<EOF
table inet intutic_vm_egress {
  chain forward {
    type filter hook forward priority 0; policy accept;
    ip saddr ${GUEST_IP} ct state established,related accept
    ip saddr ${GUEST_IP} ip daddr ${HOST_IP} accept
    ip saddr ${GUEST_IP} udp dport 53 accept
    ip saddr ${GUEST_IP} tcp dport 53 accept$EXTRA
    ip saddr ${GUEST_IP} drop
  }
}
EOF

NETMASK="$(python3 -c "import ipaddress;print(ipaddress.IPv4Network('0.0.0.0/${PREFIX}').netmask)" 2>/dev/null || echo 255.255.255.252)"
BOOT_ARGS="console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw ip=${GUEST_IP}::${HOST_IP}:${NETMASK}::eth0:off"

echo "firecracker-launch: booting microVM (${VCPUS} vcpu, ${MEM} MiB)"
sudo firecracker --api-sock "$SOCK" >"$CONSOLE" 2>&1 &
FCPID=$!
sleep 1
api() { sudo curl -s --unix-socket "$SOCK" -X PUT "http://localhost/$1" -H 'Content-Type: application/json' -d "$2" >/dev/null; }
api "boot-source" "{\"kernel_image_path\":\"${KERNEL}\",\"boot_args\":\"${BOOT_ARGS}\"}"
api "drives/rootfs" "{\"drive_id\":\"rootfs\",\"path_on_host\":\"${ROOTFS}\",\"is_root_device\":true,\"is_read_only\":false}"
api "network-interfaces/eth0" "{\"iface_id\":\"eth0\",\"host_dev_name\":\"${TAP}\"}"
api "machine-config" "{\"vcpu_count\":${VCPUS},\"mem_size_mib\":${MEM}}"
api "actions" '{"action_type":"InstanceStart"}'

# Wait for the guest to reach sshd, then run the agent command inside it. This
# requires an sshd-enabled rootfs and INTUTIC_FC_GUEST_KEY (the guest ssh key).
if [ -z "$GUEST_KEY" ]; then
  echo "firecracker-launch: microVM booted. Set INTUTIC_FC_GUEST_KEY to run the agent in-guest over ssh." >&2
  echo "  guest console: $CONSOLE" >&2
  sleep 3
  exit 0
fi
SSH="ssh -i ${GUEST_KEY} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=8"
for _ in $(seq 1 20); do
  if $SSH "root@${GUEST_IP}" true 2>/dev/null; then break; fi
  sleep 1
done
$SSH "root@${GUEST_IP}" -- "${CMD[@]}"
exit $?
