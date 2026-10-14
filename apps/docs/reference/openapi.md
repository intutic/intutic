---
aside: false
outline: false
---

# OpenAPI Reference <Badge type="tip" text="Cloud" />

Every control plane route as an OpenAPI 3.1 document: [`openapi.json`](/openapi.json). Load it into an API client or a code generator, or browse it below.

It is generated from the route source together with the [REST API Reference](/reference/api#route-catalog), and CI fails while either is stale, so the two list the same routes with the same auth and plan. The [REST API Reference](/reference/api) covers authentication, rate limits, list responses and worked examples; this page adds what the code states about each request:

- **Request bodies and query strings** come from the schema the handler validates them with. Where no schema validates a body the handler reads, the operation says so instead of guessing a shape.
- **Path parameters** come from the route path, and query parameters a handler reads without a schema are listed as strings.
- **Responses** list the status codes the handler returns itself, plus `401` where a credential is checked first, `403` where a role or plan narrows the route, and `400` where a schema validates the request. No route declares a response schema yet, so no response body is described.
- **Auth** and **Plan** head each operation's description, with the same labels as the route catalog. Every route needs a control plane; a plan other than Cloud is the first plan on sale that unlocks it.

<script setup>
import { withBase } from 'vitepress'
</script>

<ClientOnly>
  <ApiReference :spec-url="withBase('/openapi.json')" />
</ClientOnly>
