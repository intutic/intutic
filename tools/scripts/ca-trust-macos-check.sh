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
# The CA a proxy really generates, not an imitation: Apple's verifier is particular about extensions.
curl -fsSL -o "$W/proxy" https://github.com/intutic/intutic/releases/download/v3.1.5/intutic-proxy-darwin-arm64
chmod +x "$W/proxy"
# Away from the repo: its config.yaml names a control plane, which this build refuses.
(cd "$W" && exec env -i PATH="$PATH" HOME="$HOME" INTUTIC_STANDALONE=1 PORT=4941 INTUTIC_PROXY_BIND=127.0.0.1 ANTHROPIC_API_KEY=unused "$W/proxy") >"$W/proxy.log" 2>&1 &
proxy=$!
for _ in $(seq 1 60); do [ -s "$CA" ] && [ -s "$HOME/.intutic/ca.key" ] && break; sleep 0.5; done
kill $proxy 2>/dev/null
[ -s "$CA" ] || { echo 'FAIL  the proxy wrote no CA'; cat "$W/proxy.log"; exit 1; }
openssl req -newkey rsa:2048 -nodes -keyout "$W/leaf.key" -out "$W/leaf.csr" -subj /CN=localhost 2>/dev/null
printf 'subjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\n' >"$W/ext"
openssl x509 -req -in "$W/leaf.csr" -CA "$CA" -CAkey "$HOME/.intutic/ca.key" -CAcreateserial -out "$W/leaf.crt" -days 2 -extfile "$W/ext" 2>/dev/null

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
in_keychain_cmd=(bash -c "security find-certificate -a -Z '$KEYCHAIN' | grep -qi '$fingerprint'")
check 'disconnect: lists the CA in its plan'  0 bash -c "node '$CLI' disconnect --dry-run | grep -qi 'CA certificate'"
# A prompt no one answers. The first 120 s is disconnect's own limit.
LIMIT=150
check 'no one answers: disconnect gives up, and exits 0' 0 node "$CLI" disconnect
LIMIT=60
grep -q 'sudo security remove-trusted-cert' "$W/out" && echo 'ok    disconnect names the command to run' || { echo 'FAIL  disconnect did not name the command'; failed=1; }
check 'no one answers: the CA is still trusted' 0 security verify-cert -c "$CA"
check 'no one answers: the certificate stays for a second run' 0 "${in_keychain_cmd[@]}"
pkill -x SecurityAgent 2>/dev/null; sleep 1

# The real prompt, answered as a person would. This machine is thrown away; the admin
# account and its password exist for this script alone.
ADMIN=catest
PW=$(openssl rand -hex 12)
echo "::add-mask::$PW"
sudo sysadminctl -addUser "$ADMIN" -password "$PW" -admin >/dev/null 2>&1
ui() { perl -e 'alarm 25; exec @ARGV' osascript "$@" 2>&1 | cut -c1-200; }
prompt_up() {
  for _ in $(seq 1 40); do
    [ "$(ui -e 'tell application "System Events" to if exists process "SecurityAgent" then return count of windows of process "SecurityAgent"')" -ge 1 ] 2>/dev/null && return 0
    sleep 0.5
  done
  echo '      no prompt appeared'; return 1
}
type_password() {
  prompt_up && ui - "$ADMIN" "$1" <<'OSA'
on run argv
  tell application "System Events" to tell process "SecurityAgent"
    set frontmost to true
    delay 0.3
    key code 48 using shift down
    delay 0.2
    keystroke "a" using command down
    keystroke item 1 of argv
    key code 48
    delay 0.2
    keystroke item 2 of argv
    delay 0.2
    keystroke return
  end tell
end run
OSA
}
click_cancel() { prompt_up && ui -e 'tell application "System Events" to tell process "SecurityAgent" to click button "Cancel" of window 1' >/dev/null; }
at_prompt() { # at_prompt <name> <expected exit> <answer function and args, as one string> <command...>
  local name=$1 want=$2 answer=$3; shift 3
  echo "run   $name"
  local started=$SECONDS
  perl -e 'alarm shift; exec @ARGV' 100 "$@" >"$W/out" 2>&1 </dev/null &
  local job=$!
  eval "$answer"
  wait $job; local got=$?
  [ "$got" -ne 0 ] && got=1
  if [ "$got" = "$want" ]; then echo "ok    $name ($((SECONDS - started)) s)"; else echo "FAIL  $name (wanted $want, got $got, $((SECONDS - started)) s)"; sed 's/^/      /' "$W/out"; failed=1; fi
}
no_warning() { if grep -q 'still trusted' "$W/out"; then echo "FAIL  $1: said the CA is still trusted"; sed 's/^/      /' "$W/out"; failed=1; else echo "ok    $1"; fi; }
warned() { if grep -q 'still trusted' "$W/out"; then echo "ok    $1"; else echo "FAIL  $1: said nothing"; sed 's/^/      /' "$W/out"; failed=1; fi; }

at_prompt 'Cancel at the prompt: disconnect exits 0' 0 click_cancel node "$CLI" disconnect
warned 'Cancel at the prompt: disconnect says the CA is still trusted'
check 'Cancel at the prompt: the CA is still trusted' 0 security verify-cert -c "$CA"
check 'Cancel at the prompt: the certificate stays for a second run' 0 "${in_keychain_cmd[@]}"

at_prompt 'a wrong password, then the right one: disconnect exits 0' 0 "type_password notthepassword; sleep 3; type_password $PW" node "$CLI" disconnect
no_warning 'the right password: no warning'
check 'after disconnect: the CA is not trusted'    1 security verify-cert -c "$CA"
check 'after disconnect: the certificate is gone'  1 "${in_keychain_cmd[@]}"
check 'after disconnect: a leaf it signed is refused' 1 "${SSL[@]}"
check 'after disconnect: a Node client is refused' 1 "${TLS[@]}"
check 'a second disconnect finds nothing to do'    0 bash -c "! node '$CLI' disconnect --dry-run | grep -qi 'CA certificate'"

# The command disconnect names, for someone who would rather run it.
check 'put it back' 0 sudo security add-trusted-cert -d -r trustRoot -k "$KEYCHAIN" "$CA"
at_prompt 'the command disconnect named' 0 "type_password $PW" sudo security remove-trusted-cert -d "$CA"
check 'after the command: the CA is not trusted' 1 security verify-cert -c "$CA"

exit $failed
