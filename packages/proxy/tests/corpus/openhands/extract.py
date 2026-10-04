#!/usr/bin/env python3
"""Extract tool-call sequences from public OpenHands trajectories (TD-248).

NOT vendored and NOT run by CI. Run deliberately, then point
`coding_agent_cycle_floor_test.rs` at the output:

    python3 packages/proxy/tests/corpus/openhands/extract.py /tmp/openhands.jsonl
    INTUTIC_CODING_CORPUS=/tmp/openhands.jsonl \
      cargo test --release --test coding_agent_cycle_floor_test -- --nocapture

Source: nebius/SWE-rebench-openhands-trajectories (CC-BY-4.0), read through the
Hugging Face datasets-server rows API. Ten pages of 100 rows at offsets drawn
with seed 248 — the sample the TD-248 numbers in PROVENANCE.md come from. The
rows API is not pinned to a dataset revision, so a later run can differ if the
dataset is republished; the numbers say which run they came from.

Writes one JSON object per trajectory: id, instance, resolved, exit_status and
the tool calls in order (name + arguments, string values cut at 2,000 chars —
the cycle detectors read names, the action classifier reads short arguments).
"""
import json
import random
import sys
import time
import urllib.request

DATASET = "nebius/SWE-rebench-openhands-trajectories"
ROWS = 67074
PAGES = 10
PAGE = 100


def trunc(v):
    if isinstance(v, str):
        return v[:2000]
    if isinstance(v, dict):
        return {k: trunc(x) for k, x in v.items()}
    if isinstance(v, list):
        return [trunc(x) for x in v]
    return v


def fetch(offset):
    url = (
        "https://datasets-server.huggingface.co/rows"
        f"?dataset={DATASET}&config=default&split=train&offset={offset}&length={PAGE}"
    )
    for _ in range(4):
        try:
            return json.load(urllib.request.urlopen(url, timeout=120))
        except Exception as err:  # noqa: BLE001 — retried, then fatal below
            print(f"retry offset {offset}: {err}", file=sys.stderr)
            time.sleep(5)
    # A missing page silently shrinks the sample; fail instead.
    sys.exit(f"could not fetch offset {offset}")


def main(out):
    random.seed(248)
    offsets = sorted(random.sample(range(0, ROWS - PAGE, PAGE), PAGES))
    n = 0
    with open(out, "w") as f:
        for off in offsets:
            for r in fetch(off).get("rows", []):
                if r.get("truncated_cells"):
                    sys.exit(f"row at offset {off} came back truncated; the sequence would be partial")
                row = r["row"]
                traj = row["trajectory"]
                if isinstance(traj, str):
                    traj = json.loads(traj)
                calls = []
                for m in traj:
                    for tc in m.get("tool_calls") or []:
                        fn = tc.get("function") or {}
                        args = fn.get("arguments")
                        try:
                            args = json.loads(args) if isinstance(args, str) else args
                        except ValueError:
                            pass
                        calls.append({"name": fn.get("name"), "input": trunc(args)})
                f.write(json.dumps({
                    "id": row["trajectory_id"],
                    "instance": row["instance_id"],
                    "resolved": row["resolved"],
                    "exit_status": row["exit_status"],
                    "calls": calls,
                }) + "\n")
                n += 1
    print(f"{n} trajectories written to {out}", file=sys.stderr)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: extract.py <out.jsonl>")
    main(sys.argv[1])
