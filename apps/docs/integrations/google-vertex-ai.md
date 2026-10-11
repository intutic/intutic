# Google Vertex AI <Badge type="tip" text="Open-Core" />

The proxy serves Claude and Gemini models on Vertex AI directly: it authenticates each call with a Google OAuth token, translates where Vertex's API differs from the one your client speaks, and applies the same governance it applies to Anthropic or OpenAI — DLP and PII scanning in both directions, SOP gates, WASM and Rego rules, the response gate, cost metering and budgets, traces and the response cache.

## Naming a Vertex AI model

Prefix the Vertex model name with `vertex/` (`vertex_ai/` works too):

| Model | Name it as | Vertex API the proxy calls |
| :--- | :--- | :--- |
| Claude (`claude-opus-4-7`, `claude-sonnet-4-5@20250929`, …) | `vertex/claude-sonnet-4-5@20250929` | `rawPredict` / `streamRawPredict` on `publishers/anthropic` |
| Gemini (`gemini-2.5-pro`, `gemini-2.5-flash`, …) | `vertex/gemini-2.5-pro` | `generateContent` / `streamGenerateContent` on `publishers/google` |

Other model families are refused with `400 invalid_request_error`. To serve a model name your client already sends, alias it in `config.yaml`:

```yaml
model_list:
  - model_name: claude-sonnet-4-5-20250929
    litellm_params:
      model: vertex/claude-sonnet-4-5@20250929
```

## Project, location and credentials

**A workspace's own credential.** Provision it under Settings → Provider Keys, with `intutic credentials set`, the SDKs' `setProviderCredential`, or the Terraform `intutic_provider_credential` resource. It takes the project, an optional location (default `global`) and a service-account key:

```bash
intutic credentials set vertex_ai --field projectId=my-project --field location=global \
  --field-file serviceAccountJson=./service-account.json
```

Requests made with an Intutic key (`vk_…`) use it. On a gateway that requires provisioned keys, a workspace without one is refused with `402 byok_required`.

The key is checked as soon as it is saved, and again from **Test** on the Provider Keys card, by asking Google for an access token with it. A key Google refuses is reported as rejected; project access and the enabled models are checked on the first model call. A stored credential must be a service-account key (or an `authorized_user` file); a workload identity federation file is accepted only from a self-hosted proxy's own configuration, below.

**A self-hosted proxy's own credentials.** Set the project with `GOOGLE_CLOUD_PROJECT` (or `ANTHROPIC_VERTEX_PROJECT_ID`, as Claude Code uses) or `intutic_settings.providers.vertex.project`, and the location with `GOOGLE_CLOUD_LOCATION` or `CLOUD_ML_REGION`. The proxy then finds credentials as Application Default Credentials do:

1. `providers.vertex.credentials_file`, else the file in `GOOGLE_APPLICATION_CREDENTIALS` — a service-account key, an `authorized_user` file, or a workload identity federation configuration (`external_account`, below);
2. gcloud's `application-default` login;
3. the metadata server, as on Compute Engine, Google Kubernetes Engine with Workload Identity, and Cloud Run.

Access tokens are cached until five minutes before they expire.

**Workload identity federation.** A credential configuration from `gcloud iam workload-identity-pools create-cred-config` works as the credentials file. The proxy reads the subject token it names — from a file, from a URL (with the configured headers, as text or a named JSON field), or, for `environment_id: aws1`, by signing an STS `GetCallerIdentity` request with the host's AWS credentials — exchanges it at Google's Security Token Service, and, with `service_account_impersonation_url`, for the service account's token. `token_url` and the impersonation URL must be `https` Google API addresses. Executable-sourced configurations are refused: the proxy does not run commands a credential file names.

The account needs the Vertex AI User role (`roles/aiplatform.user`) on the project, and the Claude models enabled in Model Garden.

The location picks the host: `global` uses `aiplatform.googleapis.com`, `us` and `eu` the multi-region endpoints, and a region such as `us-east5` its own `us-east5-aiplatform.googleapis.com`. `providers.vertex.endpoint` points the proxy at a Private Service Connect endpoint instead.

## What you can send

Send Vertex AI models through `/v1/messages`, `/v1/chat/completions` or `/v1/responses`. The proxy speaks the Anthropic Messages API to both families; an OpenAI-format request is translated to it and the answer back.

- **Claude.** The request goes as the Messages API body, with `anthropic_version: vertex-2023-10-16` in place of `model`; beta flags travel in the `anthropic-beta` header. Answers, streaming included, are the Messages API's own.
- **Gemini.** Messages, tools, tool results, images and PDFs (as base64), `tool_choice`, stop sequences and thinking budgets are translated to `generateContent`; tool schemas go as JSON Schema (`parametersJsonSchema`). Streamed answers become server-sent Messages events, so the DLP holdback and the response gate act on what the client receives.
- **Thought signatures.** Gemini 3 refuses a conversation whose tool calls come back without the signature they were issued with. The proxy carries each signature inside the tool call's id, so a client that only echoes ids — as every Anthropic client does — sends it back intact. A tool call from another model's history gets Google's documented placeholder signature.
- **Not available on Gemini.** URL image sources (send base64), and Anthropic's server-side tools.

## Errors, retries and fallbacks

Vertex errors reach the client as Anthropic errors with the matching status: `RESOURCE_EXHAUSTED` as `429 rate_limit_error`, `UNAVAILABLE` as `529 overloaded_error`, `INVALID_ARGUMENT` as `400 invalid_request_error`, `UNAUTHENTICATED` as `401`, `PERMISSION_DENIED` as `403`, `NOT_FOUND` as `404`. The proxy's [retries](/guide/intelligent-routing#retries-and-fallbacks) treat the transient ones as retryable, and a fallback target that names only `vertex_ai` serves the same Claude model there when Anthropic's API or Bedrock is exhausted (see [AWS Bedrock](/integrations/aws-bedrock#errors-retries-and-fallbacks)).

## Behaviour not confirmed by Google's documentation

Claude's beta flags (`anthropic-beta`) are sent to Vertex AI as the `anthropic-beta` header, as Anthropic's own Vertex SDK sends them; Google's Vertex documentation for Claude does not say how beta features are requested. A flag Vertex does not accept fails the request with Vertex's own error.

## Cost

Usage is metered from the counts Vertex returns and priced as the model it names: `vertex/claude-sonnet-4-5@20250929` costs what `claude-sonnet-4-5-20250929` costs. For Gemini, cached tokens are counted as cache reads and thinking tokens as output, as Vertex reports them; a model with no cache-read price in the price list is charged the full input rate for them.
