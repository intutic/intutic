# AWS Bedrock <Badge type="tip" text="Open-Core" />

The proxy serves models hosted on Amazon Bedrock directly: it signs each request with your AWS credentials, translates where Bedrock's API differs from the one your client speaks, and applies the same governance it applies to Anthropic or OpenAI — DLP and PII scanning in both directions, SOP gates, WASM and Rego rules, the response gate, cost metering and budgets, traces and the response cache.

## Naming a Bedrock model

Prefix the Bedrock model id with `bedrock/`:

| Model | Name it as | Bedrock API the proxy calls |
| :--- | :--- | :--- |
| Claude Opus 4.7 and later (`anthropic.claude-opus-4-7`, `anthropic.claude-sonnet-5`, …) | `bedrock/anthropic.claude-opus-4-7` | Claude in Amazon Bedrock, the Messages API at `bedrock-mantle.<region>.api.aws` |
| Earlier Claude models, as an inference profile (`us.anthropic.claude-sonnet-4-5-20250929-v1:0`) or model id | `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` | `InvokeModel` / `InvokeModelWithResponseStream` |
| Any other model (`meta.llama3-1-70b-instruct-v1:0`, `amazon.nova-pro-v1:0`, `mistral.…`), or an application inference profile ARN | `bedrock/amazon.nova-pro-v1:0` | `Converse` / `ConverseStream` |

To serve a model name your client already sends, alias it in `config.yaml`:

```yaml
model_list:
  - model_name: claude-sonnet-4-5-20250929
    litellm_params:
      model: bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0
```

## Credentials

**A workspace's own credential.** Provision it under Settings → Provider Keys, with `intutic credentials set`, the SDKs' `setProviderCredential`, or the Terraform `intutic_provider_credential` resource. It takes a region and either an access key pair or a Bedrock API key:

```bash
intutic credentials set bedrock --field awsRegion=us-east-1 \
  --field awsAccessKeyId=<ACCESS_KEY_ID> --field awsSecretAccessKey=<SECRET_ACCESS_KEY>
```

Requests made with an Intutic key (`vk_…`) use it. On a gateway that requires provisioned keys, a workspace without one is refused with `402 byok_required`.

**A self-hosted proxy's own credentials.** Set the region with `AWS_REGION` or `intutic_settings.providers.bedrock.region`. The proxy then authenticates with, in order:

1. a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK` (or `providers.bedrock.api_key: os.environ/<NAME>`);
2. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_SESSION_TOKEN` for temporary credentials;
3. static keys for `AWS_PROFILE` in the shared credentials file;
4. web identity — `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN`, as on EKS with IAM roles for service accounts;
5. container credentials, as on ECS and EKS Pod Identity;
6. the EC2 instance role (`AWS_EC2_METADATA_DISABLED=true` skips it).

Temporary credentials are cached until five minutes before they expire. Profiles that need AWS IAM Identity Center sign-in are not read; export the credentials or use a role.

The credentials need `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` on the models you use, and `bedrock-mantle:CreateInference` for Claude Opus 4.7 and later.

`providers.bedrock.runtime_endpoint` and `mantle_endpoint` point the proxy at a VPC interface endpoint instead of the public ones.

## What you can send

Send Bedrock models through `/v1/messages`, `/v1/chat/completions` or `/v1/responses`. The proxy speaks the Anthropic Messages API to every Bedrock model; an OpenAI-format request is translated to it and the answer back, as for Anthropic models.

- **Streaming.** Bedrock's binary event stream is turned into server-sent events before the proxy reads it, so the DLP holdback and the response gate act on exactly what the client receives.
- **Tools.** Tool definitions, tool calls and tool results map one to one, including `tool_choice`.
- **Prompt caching and thinking.** Passed through for Claude; `Converse` cache points are placed where `cache_control` marks a block.
- **Beta flags.** For `InvokeModel`, the flags Bedrock documents (`interleaved-thinking-2025-05-14`, `context-1m-2025-08-07`, `context-management-2025-06-27`, `effort-2025-11-24`, …) move from the `anthropic-beta` header into the request body; flags Bedrock does not accept are dropped, because Bedrock refuses a request that names one.
- **Not available.** URL image sources on `Converse` (send images as base64), and Anthropic's server-side tools (web search, code execution), which Bedrock does not run.

## Errors, retries and fallbacks

Bedrock errors reach the client as Anthropic errors with the matching status: throttling and quota errors as `429 rate_limit_error`, an unavailable or not-ready model as `529 overloaded_error`, a validation error as `400 invalid_request_error`, bad credentials as `401 authentication_error`, missing permissions as `403 permission_error`. The proxy's [retries](/guide/intelligent-routing#retries-and-fallbacks) treat the transient ones as retryable and re-sign every attempt.

A fallback target that names only a provider sends the same model there, so Anthropic's API, Bedrock and Vertex AI can back each other up:

```yaml
intutic_settings:
  routing:
    fallbacks:
      claude-sonnet-4-5-20250929:
        - provider: bedrock
        - provider: vertex_ai
```

## Cost

Usage is metered from the counts Bedrock returns and priced as the model it wraps: `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` costs what `claude-sonnet-4-5-20250929` costs, cache reads and writes included. Bedrock's regional-endpoint premium is not added. A model missing from the price list is charged at the conservative estimate, so budgets err high.

## Agents that call Bedrock directly

An agent that uses the AWS SDK against `bedrock-runtime` itself does not go through these routes, and the proxy does not intercept that traffic: a SigV4 signature covers the request body, so a governed — redacted — request could not be forwarded under the agent's signature. Point the agent at the proxy with a `bedrock/` model name instead. With [egress enforcement](/reference/configuration#egress-control) on, direct connections to AWS hosts are refused unless you allow them.
