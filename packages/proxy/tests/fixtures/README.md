# Captured SSE fixtures

Every `openai_responses_*.sse` here is **real bytes off a real endpoint**. None
is hand-written. That distinction is the whole point of the directory, so this
file records how each was obtained and what it is and is not evidence of.

## Why capture at all

`/v1/responses` was originally implemented against the published spec, and was
governed as if it were chat completions: four `match provider` sites each had
two arms and silently treated Codex as a chat completion. Nothing errored. The
shape simply did not match, and a non-match is invisible.

That is the failure mode these fixtures exist to close. **It is
one-directional** — an unrecognised shape produces no signal at all, so a test
suite built only from the spec can be entirely green over a path that does not
work.

## What each one is

| file | source | what it proves |
|---|---|---|
| `openai_responses_failed_stream.sse` | **api.openai.com**, `gpt-4o-mini`, a key with no credits | `event: response.failed` is a well-formed terminal. Only `response.completed` was recognised, so a cleanly-failed stream scored `Truncated`, never read usage, and never got its governance block. |
| `openai_responses_success_stream.sse` | **llama.cpp** `/v1/responses`, Qwen2.5-Coder-3B, in-cluster | The happy-path event sequence, and that `usage.output_tokens` carries a true count. Output had been metered at **1 token** for every Codex request. |
| `openai_responses_toolcall_stream.sse` | **llama.cpp** `/v1/responses`, Qwen2.5-**7B**-Instruct | A streamed `function_call`: the item at `output_item.added`, 16 `function_call_arguments.delta` events, and the completed call on the terminal's `output[]`. |

## Provenance, stated rather than implied

Two of the three come from **llama.cpp's implementation of the protocol, not
OpenAI's**. That is an *independent* implementation rather than the reference
one. Agreement is strong evidence the shape is right; it is **not** proof
OpenAI matches byte for byte. Only `openai_responses_failed_stream.sse` came
from OpenAI itself.

Between them, the envelope (`event:` line then `data:` whose JSON `type`
repeats the event name), the terminal set, and the usage keys are confirmed
against **two independent servers**.

## Reproducing the tool-call capture

The model matters and the server does not. The demo's 3B writes tool calls as
fenced JSON in the message body — which is why the demo carries a repair shim —
while a 7B on the *same llama.cpp digest* emits native ones. Verified before
deploying anything, by sending the same request to both:

```bash
# 3B  -> "native tool_calls: no",  content is ```json { "name": "shell", ... }```
# 7B  -> "native tool_calls: YES", {"type":"function","function":{"name":"shell",...}}
```

To regenerate, deploy a tool-capable model beside the demo's — **never in place
of it**, since the demo's model is digest-pinned and its measured pass rates
were taken against that exact build:

```bash
kubectl apply -f shared/k8s/vllm/qwen7b-capture.yaml   # in the intutic-demo repo
kubectl port-forward -n intutic-demo svc/qwen7b-capture 18001:8000 &
curl -sS --no-buffer http://127.0.0.1:18001/v1/responses \
  -H 'Content-Type: application/json' \
  -d '{"model":"qwen2.5-7b-instruct","stream":true,"max_output_tokens":96,
       "input":"Run: kubectl apply -f k8s/catalogue.yaml",
       "tools":[{"type":"function","name":"shell","description":"Run a shell command.",
         "parameters":{"type":"object","properties":{"command":{"type":"string"}},"required":["command"]}}],
       "tool_choice":"required"}'
kubectl delete -f shared/k8s/vllm/qwen7b-capture.yaml   # it is disposable
```

Then replace `resp_*`, `fc_*`, `call_*` and `msg_*` ids with `*_CAPTURED`.
Nothing else is edited, and no fixture contains credential material.

## Testing against a captured fixture

`include_str!` is **compile-time**. Editing a fixture and re-running `cargo
test` without touching a source file tests the *old* bytes compiled into the
binary.

That is not hypothetical: the first negative control written for the usage
assertion **passed while proving nothing**, because the fixture had been broken
but the test binary was stale. A green negative control is exactly as
misleading as a green test over a control that does nothing.

So: after editing a fixture to prove a test catches a regression, `touch` a
source file — or `cargo clean -p intutic-proxy` — before believing the result.
