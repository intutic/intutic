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

1. **Pick a judge model** — a self-hosted model from the [model catalog](/reference/model-catalog)
   (Ollama models; Ollama Cloud's `-cloud` models are hosted and excluded), or type a custom
   reference — including a bare local alias like `my-org/local-qwen-judge` that isn't in any
   catalog at all. Judges run only on self-hosted models: a custom reference that names a hosted
   provider (`anthropic/...`, `openai/...`, `openrouter/...`, an Ollama Cloud model…) is refused,
   even with your own key, and nothing is written.
2. **`litellm_config.yaml`** is written to the path you gave — the same `model_list` shape
   `infra/compose/litellm_config.yaml`'s hand-written example uses. Intutic's platform default
   is a cost-optimized open-weight judge behind the stable alias `intutic-openweight-judge`;
   reusing that alias on-prem keeps every env and Helm snippet deployment-shape-independent —
   only the `litellm_params` backing changes per deployment. Whatever name you use, it must be
   backed by your own Ollama/vLLM server (following `infra/compose/litellm_config.yaml`'s
   BYO-model section):

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

   Don't back the alias with a hosted API (Anthropic, OpenAI, OpenRouter, Ollama Cloud…):
   judges run only on self-hosted models.

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

## Typed stage (optional)

The local judge can run a typed stage before the free-text call. This is the same cascade the
SaaS judge uses. The judge model answers two yes/no questions about the response, one token
each, and the gateway reads `p(yes)` from the token log-probabilities. The two answers combine
into one score, the mean log-odds of a violation. Then:

- **Below the band:** the response is clean. No free-text call is made.
- **Above the band:** the verdict is `VIOLATION`. The free-text judge still runs once, for the
  reasoning text. If it does not agree, or it fails, the note names the typed probability
  instead. The verdict stays `VIOLATION` either way.
- **Inside the band:** the free-text judge decides, exactly as without the typed stage.

If a typed call fails (an HTTP error, or a response without yes/no log-probabilities), the
gateway logs a warning and the free-text judge decides. With no workspace SOP, the typed stage
is skipped.

```bash
INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_LO=-4      # log-odds; below this is clean
INTUTIC_GATEWAY_LOCAL_JUDGE_TYPED_HI=2.461   # log-odds; above this is a violation
LITELLM_LOCAL_TYPED_JUDGE_MODEL=             # optional; defaults to LITELLM_LOCAL_JUDGE_MODEL
```

In Helm, set `proxy.localJudgeTypedLo`, `proxy.localJudgeTypedHi` and, optionally,
`litellm.typedJudgeModel`.

The typed stage is on only when both bounds are set, are numbers, and `LO` is below `HI`.
Anything else logs one warning and leaves it off. There is no default band.

**Measure your own band.** `-4` and `2.461` are the values validated for Qwen3.6-27B, the SaaS
judge's model. They are the only measured example. Another model scores differently, so these
numbers are a starting point, not a setting to copy. Run a labelled set of your own responses
through your model and pick the band from those scores.

**The model must return log-probabilities.** The typed calls send `logprobs: true` and
`top_logprobs: 5` with `max_tokens: 1`. vLLM, Ollama and OpenAI return them. A model or server
that does not return them makes every typed call fall back to the free-text judge, so the typed
stage only adds latency. Above or inside the band, a request makes three judge calls in place of one;
`JUDGE_FINALIZE_DEADLINE_MS` covers all of them.

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
