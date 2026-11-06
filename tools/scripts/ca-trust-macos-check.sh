#!/bin/bash
# The macOS CA step against a real keychain: connect's exact command, a certificate
# signed by that CA, a TLS client, then `intutic disconnect` taking it all back out.
#
# CI runners only. It changes the machine's trust settings, so it refuses to run on
# anything but a disposable GitHub-hosted macOS runner.
set -uo pipefail
if [ "${GITHUB_ACTIONS:-}" != true ] || [ "${RUNNER_ENVIRONMENT:-}" != github-hosted ] || [ "$(uname -s)" != Darwin ]; then
  echo "Refusing to run: this changes keychain trust settings and is for GitHub-hosted macOS runners only." >&2
  exit 2
fi

CLI="$PWD/tools/cli/dist/cli.js"
W=$(mktemp -d)
failed=0
LIMIT=60
check() { # check <name> <expected exit: 0 or 1> <command...>
  local name=$1 want=$2; shift 2
  echo "run   $name"
  # A hung keychain prompt has no one to answer it on a runner: past LIMIT it counts as a failure.
  local started=$SECONDS
  perl -e 'alarm shift; exec @ARGV' "$LIMIT" "$@" >"$W/out" 2>&1 </dev/null; local got=$?
  [ $((SECONDS - started)) -ge $((LIMIT - 1)) ] && echo "      timed out after $LIMIT s"
  [ "$got" -ne 0 ] && got=1
  if [ "$got" = "$want" ]; then echo "ok    $name"; else echo "FAIL  $name (wanted $want, got $got)"; sed 's/^/      /' "$W/out"; failed=1; fi
}

mkdir -p "$HOME/.intutic"
CA="$HOME/.intutic/ca.crt"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$W/ca.key" -out "$CA" -days 2 -subj /CN=intutic-ci-check-ca \
  -addext basicConstraints=critical,CA:TRUE -addext keyUsage=critical,keyCertSign,cRLSign 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout "$W/leaf.key" -out "$W/leaf.csr" -subj /CN=localhost 2>/dev/null
printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n' >"$W/ext"
openssl x509 -req -in "$W/leaf.csr" -CA "$CA" -CAkey "$W/ca.key" -CAcreateserial -out "$W/leaf.crt" -days 2 -extfile "$W/ext" 2>/dev/null

SSL=(security verify-cert -c "$W/leaf.crt" -p ssl -s localhost)
TLS=(node --use-system-ca -e "fetch('https://localhost:8443/').then(r=>process.exit(r.ok?0:1),e=>{console.error(e.cause??e);process.exit(1)})")
openssl s_server -accept 8443 -cert "$W/leaf.crt" -key "$W/leaf.key" -www -quiet >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
echo "login keychain: $(ls -la "$KEYCHAIN" 2>&1)"
sleep 1

check 'before: the CA is not trusted'        1 security verify-cert -c "$CA"
check 'before: a leaf it signed is refused'  1 "${SSL[@]}"
check 'before: a Node client is refused'     1 "${TLS[@]}"

# connect's command, under sudo: a person approves this at a password prompt.
check 'connect: add-trusted-cert to the login keychain' 0 \
  sudo security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN" "$CA"
check 'after: the CA is trusted'             0 security verify-cert -c "$CA"
check 'after: a leaf it signed is accepted'  0 "${SSL[@]}"
check 'after: a Node client connects'        0 "${TLS[@]}"

check 'installCaTrust: the login keychain path resolves' 0 node --input-type=module -e "
  import { caTrustCommandFor } from '$PWD/tools/cli/dist/lib/caTrust.js'
  import { existsSync } from 'node:fs'
  const k = caTrustCommandFor('darwin', 'user', '/tmp/ca.crt')[0].args.at(-2)
  process.exit(existsSync(k) ? 0 : 1)"

fingerprint=$(openssl x509 -in "$CA" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)
check 'disconnect: lists the CA in its plan'  0 bash -c "node '$CLI' disconnect --dry-run | grep -qi 'CA certificate'"
# With no screen, removing a trust setting waits on a prompt, even under sudo. The
# certificate must still go, and the user must be told what is left. The first 120 s
# is disconnect's own limit.
LIMIT=150
check 'disconnect with no screen: gives up, and exits 0' 0 node "$CLI" disconnect
LIMIT=60
grep -q 'sudo security remove-trusted-cert' "$W/out" && echo 'ok    disconnect names the command to run' || { echo 'FAIL  disconnect did not name the command'; sed 's/^/      /' "$W/out"; failed=1; }
check 'with no screen: the certificate is gone' 1 bash -c "security find-certificate -a -Z '$KEYCHAIN' | grep -qi '$fingerprint'"

# What a person's password does, where this macOS allows a script to stand in for it.
# This machine is thrown away; never do this on one you keep. Newer macOS refuses it, and
# then the removal with a prompt is not covered here: it needs a person at a screen.
if ! sudo security authorizationdb write com.apple.trust-settings.admin allow >/dev/null 2>&1; then
  echo "skip  full removal: this macOS will not allow trust changes without a password prompt"
  exit $failed
fi
check 'the command disconnect named'     0 sudo security remove-trusted-cert -d "$CA"
check 'put it back'                      0 sudo security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN" "$CA"
check 'trusted again'                    0 security verify-cert -c "$CA"
check 'disconnect: runs'                 0 node "$CLI" disconnect
check 'after disconnect: the certificate is gone'  1 bash -c "security find-certificate -a -Z '$KEYCHAIN' | grep -qi '$fingerprint'"
check 'after disconnect: the CA is not trusted'    1 security verify-cert -c "$CA"
check 'after disconnect: a Node client is refused' 1 "${TLS[@]}"

exit $failed
