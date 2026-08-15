---
title: Sandboxed Execution
description: Running agents inside an isolated runtime whose only egress is the governing proxy — backends, platform support, and enforcement levels.
---

# Sandboxed Execution <Badge type="tip" text="Open-Core" />

`intutic exec` normally runs an agent directly on your machine, with the
proxy environment injected. `intutic exec --sandbox` runs it inside an
isolated runtime instead — a dropped capability set, a read-only root
filesystem, resource caps, and egress locked to the proxy — so the agent
cannot reach the network except through governance, and cannot alter the
firewall it runs behind (LLD #63 §6).

```bash
intutic exec --sandbox -- claude
intutic exec --sandbox=firecracker -- python my_agent.py
```

## The honesty rule

A sandbox backend that isn't actually available is refused, never silently
swapped for a weaker one or skipped in favor of running on the bare host.
If Docker isn't running, `--sandbox` fails with an error telling you to
start it — it does **not** fall back to running the agent ungoverned.

## Backends and what they actually support today

There are exactly two backends. Nothing else — no Kubernetes-native
runtime, no spot-instance orchestration, no serverless or "stateless
agent" execution mode, no MCP-server-specific sandbox — exists in the code
today. If you run agents on one of those platforms, `intutic exec
--sandbox` still works the same way any other command does there: the OCI
backend is a `docker run`/`podman run` invocation, so it runs on any host
where one of those is installed, including inside a Kubernetes pod, a VM,
or a spot instance — but there's no platform-specific integration beyond
that.

### OCI containers (`--sandbox` or `--sandbox=oci`, the default)

Runs the agent in a Docker or Podman container (`tools/cli/src/lib/sandbox/oci.ts`).
This is the backend to reach for by default — it only needs a container
runtime, which is available almost everywhere a developer or a CI/build
agent already runs.

The isolation envelope:

| Control | What it does |
|---|---|
| `--cap-drop=ALL` + a narrow `--cap-add` | Starts from zero Linux capabilities; only what the entrypoint needs to install the firewall and drop privilege is added back — the agent itself runs with an empty capability set |
| `--security-opt=no-new-privileges` | No setuid-root escalation inside the container |
| `--read-only` rootfs + `tmpfs` scratch | The container's filesystem can't be modified; `/tmp`, `/run`, and the sandbox home are writable scratch space only |
| `--pids-limit` / `--memory` / `--cpus` | Bounds on fork-bombs and resource exhaustion |
| A default-deny egress firewall inside the container | Installed by the image's entrypoint before the agent starts; permits only the proxy (reached via `host.docker.internal`) and DNS |

**Requires an image containing the agent, `nftables`, and `capsh`** — the
default is `intutic/sandbox:latest` (`--sandbox-image` to use your own).
Building and shipping your own image with your agent's toolchain baked in
is the normal path for anything beyond the default agent.

### Firecracker microVMs (`--sandbox=firecracker`)

Runs the agent in a Firecracker microVM instead of a container — a
separate guest kernel over KVM rather than shared-kernel namespaces, which
is a stronger isolation boundary. The egress model is the same in spirit
(the microVM's only route out is the governing proxy) but enforced
**outside the guest**, by a default-deny firewall on the host side of the
guest's tap interface — the agent inside the VM cannot reach or alter it.

::: warning Maturity status — read before relying on this in production
The microVM genuinely **boots on real KVM** — this has been validated on
a nested-virtualization host, where Firecracker loaded and ran a guest
kernel through this backend's exact launch sequence. What has **not** been
validated end-to-end is an agent running to completion inside a
fully-booted guest. `health()` gates on KVM being available, the
`firecracker` binary, and an operator-supplied kernel + rootfs pair
(`INTUTIC_FC_KERNEL` / `INTUTIC_FC_ROOTFS` — you build these the same way
you build an OCI image for the container backend, containing your agent).
If any of that is missing, the backend refuses rather than pretending to
run — it will not fall back to the container backend for you.
:::

**Requires KVM** (so a bare-metal host or a VM host with nested
virtualization enabled — not every cloud VM size supports this) plus the
`firecracker` binary and your own kernel/rootfs images.

## Enforcement levels

A workspace can require sandboxing rather than leaving it to each
developer to remember `--sandbox`:

| Level | Behavior |
|---|---|
| **Off** (default) | Agents run on the host as normal. Developers can still opt in with `--sandbox`. |
| **Recommend** | An un-sandboxed `intutic exec` still runs, but prints a warning nudging the developer to add `--sandbox`. |
| **Require** | An un-sandboxed `intutic exec` is refused — the developer must re-run with `--sandbox`. |

Set this from **Settings → Security → Sandboxed Execution** in the
dashboard, or resolved directly by the CLI from workspace settings
(`GET /api/v1/workspace/settings`, cached locally so an offline developer
still sees the last-known requirement rather than defaulting open).

::: warning This is a client-side, advisory layer
`intutic exec --sandbox` is what enforces this — a determined developer
can bypass the requirement entirely by not using `intutic exec` at all
and calling their agent directly. Pair it with
[Network Egress Control](/guide/policies#network-egress-control) and
`intutic enforce`'s host firewall for the layer that closes that gap:
even a bypassed sandbox requirement still can't route traffic anywhere
but the governing proxy once host-level enforcement is on.
:::

## Related

| Page | What it covers |
|---|---|
| [Network Egress Control](/guide/policies#network-egress-control) | The proxy-level and host-firewall guardrails sandboxing pairs with |
| [Policies & Enforcement](/guide/policies) | Where the workspace-level sandbox requirement is set |
| [CLI Reference — `intutic exec`](/reference/cli#intutic-exec) | Every `--sandbox*` flag |
