# Azure OpenAI <Badge type="tip" text="Open-Core" />

The proxy serves Azure OpenAI and Azure AI Foundry deployments directly, through Azure's OpenAI v1 API, and applies the same governance it applies to OpenAI — DLP and PII scanning in both directions, SOP gates, WASM and Rego rules, the response gate, cost metering and budgets, traces and the response cache.

## Naming a deployment

Prefix the deployment name with `azure/`: a deployment called `gpt4o-prod` is `azure/gpt4o-prod`. The proxy sends it to `<endpoint>/openai/v1/chat/completions` or `/openai/v1/responses` with the deployment as `model`, so no `api-version` is involved. Foundry models deployed on the same resource (`*.services.ai.azure.com`) are named the same way.

To serve a model name your client already sends, alias it in `config.yaml`:

```yaml
model_list:
  - model_name: gpt-4o
    litellm_params:
      model: azure/gpt4o-prod
```

## Endpoint and credentials

**A workspace's own credential.** Provision it under Settings → Provider Keys, with `intutic credentials set`, the SDKs' `setProviderCredential`, or the Terraform `intutic_provider_credential` resource. It takes the resource endpoint and an API key:

```bash
intutic credentials set azure_openai \
  --field endpoint=https://my-resource.openai.azure.com --field apiKey=<API_KEY>
```

The endpoint must be an `https` address on `*.openai.azure.com`, `*.services.ai.azure.com` or `*.cognitiveservices.azure.com`: the gateway sends the key wherever the endpoint points, so it only points at Azure. Requests made with an Intutic key (`vk_…`) use the workspace's credential; on a gateway that requires provisioned keys, a workspace without one is refused with `402 byok_required`.

**A self-hosted proxy's own credentials.** Set `AZURE_OPENAI_ENDPOINT` or `intutic_settings.providers.azure.endpoint` — any `http(s)` address, so an API gateway or private endpoint in front of Azure works — and authenticate with one of:

1. an API key: `AZURE_OPENAI_API_KEY`, or `providers.azure.api_key: os.environ/<NAME>`;
2. Microsoft Entra ID client credentials: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` (or the matching `providers.azure` settings);
3. the host's managed identity: `providers.azure.managed_identity: true`, with `client_id` for a user-assigned identity.

Entra ID tokens are requested for `https://cognitiveservices.azure.com/.default` and cached until five minutes before they expire; the identity needs the Cognitive Services OpenAI User role on the resource.

## What you can send

Send Azure deployments through `/v1/chat/completions` or `/v1/responses` — the OpenAI formats Azure speaks. Requests and answers, streaming and tool calls included, pass through as OpenAI's; Azure's extra content-filter chunks are forwarded as they arrive. A request to `/v1/messages` naming an Azure deployment is refused with `400 unsupported_route`.

## Errors, retries and cost

Azure's errors are OpenAI's and reach the client unchanged. A `429` carries `retry-after-ms`, which the proxy's [retries](/guide/intelligent-routing#retries-and-fallbacks) honour; a `400 content_filter` refusal is final.

Cost is priced by the deployment name, so `azure/gpt-4o` costs what `gpt-4o` costs. A deployment named after nothing in the price list is charged at the conservative estimate; name deployments after their model, or alias them as above, to price them exactly.
