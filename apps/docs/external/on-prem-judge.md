# On-Prem Judge Setup <Badge type="danger" text="Enterprise" />

A walkthrough for standing up the [self-hosted gateway](/external/self-hosted-gateway)'s local
LLM-as-judge — the option that keeps finalize-time judging entirely on your own infrastructure,
never reaching Intutic's control plane. This page covers the `intutic judge configure` command
that generates the artifacts a local judge needs; for what the local judge does and doesn't do
compared to the SaaS judge, see [the self-hosted gateway's own
writeup](/external/self-hosted-gateway#4-what-does-not-run-locally-read-this-before-you-deploy)
first — this page assumes you've read that trade-off list.

## `intutic judge configure`

```bash
intutic judge configure --out ./litellm_config.yaml
```

This is local-artifacts-only. It never calls a remote API, and it never flips `local_judge` on
for you — that flag is deliberately not exposed through the gateway's remote config API, so
turning it on always means applying a file you generated and reviewed yourself.

It walks you through:

1. **Pick a judge model** — from the [model catalog](/reference/model-catalog), unfiltered (a
   local LiteLLM deployment can serve any model any provider offers, not just the ones Intutic's
   managed gateway can route to), or type a custom reference — including a bare local alias like
   `my-org/local-qwen-judge` that isn't in any catalog at all.
2. **`litellm_config.yaml`** is written to the path you gave — the same `model_list` shape
   `infra/compose/litellm_config.yaml`'s hand-written example uses. Intutic's platform default
   is a cost-optimized open-weight judge behind the stable alias `intutic-openweight-judge`;
   reusing that alias on-prem keeps every env and Helm snippet deployment-shape-independent —
   only the `litellm_params` backing changes per deployment. To keep judging entirely in-org,
   edit the generated file (following `infra/compose/litellm_config.yaml`'s BYO-model section)
   so the alias points at your own Ollama/vLLM server:

   ```yaml
   model_list:
     - model_name: intutic-openweight-judge
       litellm_params:
         model: openai/<your-local-judge-model>   # any model your server exposes
         api_base: http://ollama:11434/v1         # or your vLLM server's OpenAI-compatible URL
         api_key: "not-needed"                    # most local servers ignore this

   general_settings:
     master_key: os.environ/LITELLM_MASTER_KEY
   ```

   A frontier judge is the explicit upgrade, never the default — back the alias (or a model
   name of your own) with e.g. `model: anthropic/claude-haiku-4-5-20251001` and
   `api_key: os.environ/ANTHROPIC_API_KEY` instead, billed to your own provider key.

3. **An env block** is printed for Docker Compose / bare-metal deployments. Note that
   `LITELLM_LOCAL_JUDGE_MODEL` deliberately has **no default** — an unset value fails loud at
   startup rather than silently judging on a model you didn't choose:

   ```bash
   INTUTIC_GATEWAY_LOCAL_JUDGE=true
   LITELLM_LOCAL_URL=http://litellm:4000
   LITELLM_LOCAL_API_KEY=${LITELLM_MASTER_KEY}
   LITELLM_LOCAL_JUDGE_MODEL=intutic-openweight-judge
   ```

4. **A Helm values snippet** is printed for `tools/helm/intutic-gateway`:

   ```yaml
   proxy:
     localJudge: true
   litellm:
     enabled: true
     judgeModel: "intutic-openweight-judge"
     configMapName: ""  # empty lets the chart render one from your litellm_config.yaml
   ```

None of these are applied automatically — copy what you need into your actual compose env file
or `values.yaml`, then restart the gateway.

## If the same model should also be served by the shared (non-local) LiteLLM deployment

Adding a model name to `infra/kubernetes/base/litellm/config.yaml` (the SaaS-side LiteLLM
config) obligates matching entries in `providerPricingService.ts`'s `STATIC_FALLBACK_RATES` and
`packages/proxy/src/pricing/offline_bundle.json` — `modelNameParity.test.ts` enforces this at
build time. This only applies if you're extending the shared deployment; a purely local/on-prem
judge configured via this page has no such obligation.

## Verifying it worked

Once the gateway is running with `local_judge` on and pointed at a reachable LiteLLM instance
serving the model you configured, a finalize-time judge call for that workspace should return a
`COMPLIANT | VIOLATION | AMBIGUOUS` verdict instead of the judge-unavailable note. If your judge
LLM is unreachable, the proxy reports that honestly — `Intutic LLM-as-a-Judge: verdict
UNAVAILABLE — treat as unverified, not as clean` — rather than silently passing every check; see
[the self-hosted gateway's fail-loud section](/external/self-hosted-gateway#4-what-does-not-run-locally-read-this-before-you-deploy)
for the full behavior.

## Related

- [Self-Hosted Gateway](/external/self-hosted-gateway)
- [Model Catalog](/reference/model-catalog)
- [CLI Reference — `intutic judge configure`](/reference/cli#intutic-judge-configure)
