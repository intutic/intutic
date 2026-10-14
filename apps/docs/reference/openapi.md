---
aside: false
outline: false
---

# OpenAPI Reference <Badge type="tip" text="Cloud" />

Every control plane route as an OpenAPI 3.1 document: [`openapi.json`](/openapi.json). Load it into an API client or a code generator, or browse it below.

It is generated from the route source together with the [REST API Reference](/reference/api#route-catalog), and CI fails while either is stale, so the two list the same routes with the same auth and plan. The [REST API Reference](/reference/api) covers authentication, rate limits, list responses and worked examples; this page adds what the code states about each request:

- **Request bodies and query strings** come from the schema the handler validates them with. Every route that reads a JSON body or a query parameter validates it and refuses a request that does not match, with a `400` (the Slack install callback redirects back with an error instead, and the sync WebSocket closes). The generator refuses a handler that reads either without a schema, so a new route cannot leave its request undescribed.
- **Path parameters** come from the route path.
- **Responses** list the status codes the handler returns itself, plus `401` where a credential is checked first, `403` where a role or plan narrows the route, and `400` where a schema validates the request.
- **Response bodies** are described where the handler declares the schema it answers with, marked `x-intutic-response-schema: zod`. Every operation the SDKs (`@intutic/clawde`, `intutic-clawde`, `@intutic/gate`), the CLI and the Terraform provider call declares one, apart from the SOC 2 evidence download, which answers with a file; the counts are at the top of the document. CI holds each schema to its route: a test makes a real request to every route that declares one and fails when the answer lacks a field the schema requires, has one of another type, or carries a field the schema does not list. A schema lists every field the route sends and stays open to fields added later, so a client should ignore fields it does not know. The other operations list status codes only: routes only the dashboard calls (settings pages, billing, plans), machine-to-machine routes (harness hooks and telemetry, gateway heartbeats, the MCP daemon and sync daemon reports), identity-provider and chat-app callbacks (SSO, SAML, OAuth, SCIM, Slack), and the admin routes.
- **Auth** and **Plan** head each operation's description, with the same labels as the route catalog. Every route needs a control plane; a plan other than Cloud is the first plan on sale that unlocks it.

<script setup>
import { withBase } from 'vitepress'
</script>

<ClientOnly>
  <ApiReference :spec-url="withBase('/openapi.json')" />
</ClientOnly>
