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
check() { # check <name> <expected exit: 0 or 1> <command...>
  local name=$1 want=$2; shift 2
  "$@" >"$W/out" 2>&1; local got=$?
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
tls() { node --use-system-ca -e "fetch('https://localhost:8443/').then(r=>process.exit(r.ok?0:1),e=>{console.error(e.cause??e);process.exit(1)})"; }
openssl s_server -accept 8443 -cert "$W/leaf.crt" -key "$W/leaf.key" -www -quiet >/dev/null 2>&1 &
server=$!
trap 'kill $server 2>/dev/null' EXIT
sleep 1

check 'before: the CA is not trusted'        1 security verify-cert -c "$CA"
check 'before: a leaf it signed is refused'  1 "${SSL[@]}"
check 'before: a Node client is refused'     1 tls

# connect's command, under sudo: a person approves this at a password prompt.
check 'connect: add-trusted-cert to the login keychain' 0 \
  sudo security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN" "$CA"
check 'after: the CA is trusted'             0 security verify-cert -c "$CA"
check 'after: a leaf it signed is accepted'  0 "${SSL[@]}"
check 'after: a Node client connects'        0 tls

check 'installCaTrust: the login keychain path resolves' 0 node --input-type=module -e "
  import { caTrustCommandFor } from '$PWD/tools/cli/dist/lib/caTrust.js'
  import { existsSync } from 'node:fs'
  const k = caTrustCommandFor('darwin', 'user', '/tmp/ca.crt')[0].args.at(-2)
  process.exit(existsSync(k) ? 0 : 1)"

fingerprint=$(openssl x509 -in "$CA" -noout -fingerprint -sha1 | cut -d= -f2 | tr -d :)
check 'disconnect: lists the CA in its plan'  0 bash -c "node '$CLI' disconnect --dry-run | grep -qi 'CA certificate'"
check 'disconnect: runs'                      0 sudo -E env "HOME=$HOME" "PATH=$PATH" node "$CLI" disconnect
check 'after disconnect: the certificate is gone'  1 bash -c "security find-certificate -a -Z '$KEYCHAIN' | grep -qi '$fingerprint'"
check 'after disconnect: the CA is not trusted'    1 security verify-cert -c "$CA"
check 'after disconnect: a Node client is refused' 1 tls

exit $failed
