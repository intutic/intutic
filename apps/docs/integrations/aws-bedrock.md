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

The credential is checked as soon as it is saved, and again from **Test** on the Provider Keys card: an access key pair with STS `GetCallerIdentity`, which proves the key but not its Bedrock permissions (the first model call checks those); a Bedrock API key with `ListFoundationModels`. A key AWS does not recognise is reported as rejected; a key that authenticates but may not list models is reported as not verified.

**A self-hosted proxy's own credentials.** Set the region with `AWS_REGION` or `intutic_settings.providers.bedrock.region`. The proxy then authenticates with, in order:

1. a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK` (or `providers.bedrock.api_key: os.environ/<NAME>`);
2. `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with `AWS_SESSION_TOKEN` for temporary credentials;
3. static keys for `AWS_PROFILE` in the shared credentials file;
4. an IAM Identity Center (SSO) profile for `AWS_PROFILE` in the config file (`AWS_CONFIG_FILE`, default `~/.aws/config`), in either the `sso_session` form or the legacy `sso_start_url` form, using the sign-in `aws sso login` cached under `~/.aws/sso/cache`;
5. web identity — `AWS_WEB_IDENTITY_TOKEN_FILE` and `AWS_ROLE_ARN`, as on EKS with IAM roles for service accounts;
6. container credentials, as on ECS and EKS Pod Identity;
7. the EC2 instance role (`AWS_EC2_METADATA_DISABLED=true` skips it).

Temporary credentials are cached until five minutes before they expire. When an SSO profile's cached sign-in has expired, the proxy renews it with the cached refresh token (`sso_session` profiles) without writing the cache back; when it cannot, the error says to run `aws sso login --profile <name>`. Profiles that assume a role (`role_arn` with `source_profile`) are not read; export the credentials or use a workload role.

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

## Behaviour not confirmed by AWS's documentation

Two details are implemented from Anthropic's SDKs and issue reports rather than from AWS's documentation. If either is wrong for your account, the request fails with a clear error rather than being sent somewhere else:

- **An error inside an `InvokeModel` or `ConverseStream` stream.** The proxy reads an exception frame's name from `:exception-type` and its text from a `message` field in the payload, and passes it on as an Anthropic SSE `error` event. AWS documents the exception names but not the payload's shape.
- **A Bedrock API key on Claude Opus 4.7 and later.** The `bedrock-mantle` endpoint is sent the key in `x-api-key`, as Anthropic's documentation shows; Anthropic's SDK sends `Authorization: Bearer`. Access key pairs are SigV4-signed and unaffected.

## Cost

Usage is metered from the counts Bedrock returns and priced as the model it wraps: `bedrock/us.anthropic.claude-sonnet-4-5-20250929-v1:0` costs what `claude-sonnet-4-5-20250929` costs, cache reads and writes included. Bedrock's regional-endpoint premium is not added. A model missing from the price list is charged at the conservative estimate, so budgets err high.

## Agents that call Bedrock directly

An agent that uses the AWS SDK against `bedrock-runtime` itself does not go through these routes, and the proxy does not intercept that traffic: a SigV4 signature covers the request body, so a governed — redacted — request could not be forwarded under the agent's signature. Point the agent at the proxy with a `bedrock/` model name instead. With [egress enforcement](/reference/configuration#egress-control) on, direct connections to AWS hosts are refused unless you allow them.
