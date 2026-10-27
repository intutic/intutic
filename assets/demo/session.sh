#!/usr/bin/env bash
# The terminal session record.sh captures. Run from record.sh, with DEMO_PROJECT set.
cd "$DEMO_PROJECT"
G=.intutic/hooks/claude-code-check.js
DIM=$'\e[2m'; BOLD=$'\e[1m'; GRN=$'\e[32m'; RED=$'\e[31m'; CYN=$'\e[36m'; RST=$'\e[0m'

type_cmd() {
  printf '%s$%s ' "$GRN" "$RST"
  local s="$1"
  for ((i = 0; i < ${#s}; i++)); do printf '%s' "${s:i:1}"; sleep 0.03; done
  printf '\n'
  sleep 0.4
}

verdict() { # label, hook payload
  printf '\n%s%s%s\n' "$BOLD" "$1" "$RST"
  sleep 0.5
  local out rc
  out="$(echo "$2" | node "$G" 2>&1)"
  rc=$?
  if [ "$rc" = 0 ]; then
    printf '  %s✓ allowed%s\n' "$GRN" "$RST"
  else
    printf '  %s✗ BLOCKED%s\n' "$RED" "$RST"
    echo "$out" | sed -n '1p' | sed -e 's/^\[Intutic Governance\] BLOCKED: //' -e 's/ \[[^]]*\]//' | fold -s -w 66 | sed 's/^/    /'
  fi
  sleep 1.6
}

payload() { # tool, json for tool_input
  printf '{"tool_name":"%s","tool_input":%s,"session_id":"s1","cwd":"%s"}' "$1" "$2" "$DEMO_PROJECT"
}

clear
printf '%sAn agent works a catalogue ticket. One SOP, no account, no model.%s\n\n' "$DIM" "$RST"
sleep 1.2
type_cmd 'head -5 .intutic/sops/catalogue-ticket.md'
head -5 .intutic/sops/catalogue-ticket.md | sed 's/^/  /'
sleep 2.2

verdict 'agent → Edit(k8s/catalogue.yaml)' "$(payload Edit '{"file_path":"k8s/catalogue.yaml","old_string":"a","new_string":"b"}')"
verdict 'agent → Edit(.intutic/allowlist.json)' "$(payload Edit '{"file_path":".intutic/allowlist.json","old_string":"a","new_string":"b"}')"
verdict 'agent → Bash(kubectl delete configmap catalogue-scratch)' "$(payload Bash '{"command":"kubectl delete configmap catalogue-scratch -n sock-shop"}')"

printf '\n%sRefused before it ran. Local hook gate, intutic %s.%s\n' "$CYN" "$(intutic --version)" "$RST"
sleep 3
