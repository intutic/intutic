# Standalone Cloud Proxy Integration Guide

Intutic's proxy engine (`intutic-proxy`) is a high-performance, OpenAI-compatible proxy gateway written in Rust. It can be deployed in the cloud (such as on GKE) to audit, cache, and govern agent model traffic centrally without installing any workstation shims or developer daemons.

---

## 🚀 Deployment Topologies

Intutic Proxy supports two primary self-hosted deployment topologies depending on whether you require multi-provider LLM gateway translation (via LiteLLM) or direct model provider routing:

```
                            [ Option A: Dual Self-Hosted Proxy ]

   Developer IDE / CLI                                           Upstream LLM Providers
  (Claude Code, Cursor,  ──────►  Intutic Proxy  ──────►  LiteLLM Proxy  ──────►  (Anthropic, OpenAI,
       LangGraph)               (Rust — :4000)          (Python — :4001)        Bedrock, Vertex, Ollama)
                                       │                        │
                                       ▼                        ▼
                                Governance & PCAS        Model Translation &
                                WASM Policy Engine         Unified API Gateway


                            [ Option B: Standalone Intutic Proxy ]

   Developer IDE / CLI           Intutic Proxy                                   Upstream LLM Providers
  (Claude Code, Cursor,  ──────► (Rust — :4000) ─────────────────────────────►   (api.anthropic.com,
       LangGraph)                      │                                          api.openai.com)
                                       ▼
                                Governance & PCAS
                                WASM Policy Engine


                            [ Option C: Native NPM Binary Execution ]

   Developer / CI               npx @intutic/proxy                              Upstream LLM Providers
  (Node.js / Terminal)   ──────► (Native Rust Gateway) ────────────────────►    (api.anthropic.com,
                                       │                                          api.openai.com)
                                       ▼
                                Governance & PCAS
                                WASM Policy Engine
```

### Option A: Dual Self-Hosted Proxy (Intutic + LiteLLM Gateway)
* **How it works:** Intutic Proxy (Rust `:4000`) sits in front of LiteLLM (`:4001`). Intutic enforces security SOPs, WASM policies, and PCAS primitives in `<5ms`, then forwards clean requests to LiteLLM to translate and route across 100+ model providers (Bedrock, Azure, Vertex, Ollama).
* **Docker Compose Snippet:**
  ```yaml
  services:
    intutic-proxy:
      image: intutic/proxy:latest
      ports:
        - "4000:4000"
      environment:
        - UPSTREAM_URL=http://litellm:4000
        - CONTROL_PLANE_URL=http://control-plane:3001

    litellm:
      image: ghcr.io/berriai/litellm:main-latest
      ports:
        - "4001:4000"
      volumes:
        - ./config.yaml:/app/config.yaml
  ```

### Option B: Standalone Intutic Proxy (Direct Provider Connection)
* **How it works:** Run Intutic Proxy standalone without LiteLLM. Route traffic directly to upstream provider endpoints (`api.anthropic.com` or `api.openai.com`).
* **Environment Setup:**
  ```bash
  export ANTHROPIC_BASE_URL="http://localhost:4000/v1"
  intutic connect --upstream-url "https://api.anthropic.com"
  ```

### Option C: Native NPM Binary Runner (`npx @intutic/proxy`)
* **How it works:** Execute the native high-performance Rust proxy binary directly via npm without needing Docker or Kubernetes:
  ```bash
  # Run directly via npx
  npx @intutic/proxy

  # Or install globally as a native daemon
  npm install -g @intutic/proxy
  intutic-proxy
  ```

---

## 🛠️ Framework Integration

Connecting any standard LLM framework to the standalone proxy is simple. Just override the `base_url` parameter and pass your Intutic API key.

### 1. LangGraph (Python)
In LangGraph, configure the chat model instance to point to the Intutic proxy URL:

```python
from langgraph.graph import StateGraph, START, END
from langchain_openai import ChatOpenAI
from typing import TypedDict

# 1. Initialize LLM pointing to the Intutic proxy gateway
llm = ChatOpenAI(
    model="gpt-4o",
    base_url="https://proxy.intutic.ai/v1",  # GKE Proxy URL
    api_key="your-intutic-api-key"
)

class AgentState(TypedDict):
    input: str
    response: str

def call_model(state: AgentState):
    # This call is governed pre-flight by Intutic
    res = llm.invoke(state["input"])
    return {"response": res.content}

# Compile Graph
builder = StateGraph(AgentState)
builder.add_node("agent", call_model)
builder.add_edge(START, "agent")
builder.add_edge("agent", END)

graph = builder.compile()
```

### 2. LangGraph (TypeScript)
Configure the LangGraph state machine runnable context:

```typescript
import { StateGraph, START, END } from "@langchain/langgraph";
import { ChatOpenAI } from "@langchain/openai";

const model = new ChatOpenAI({
  model: "gpt-4o",
  configuration: {
    baseURL: "https://proxy.intutic.ai/v1", // GKE Proxy URL
    apiKey: "your-intutic-api-key",
  }
});
```

### 3. Amazon Bedrock AgentCore & Anthropic Managed Agents

Amazon Bedrock AgentCore and Anthropic Managed Agents connect to Intutic Proxy by configuring the provider gateway endpoint:

```python
import os
from langchain_community.chat_models import BedrockChat

# Route Amazon Bedrock traffic through Intutic Proxy (Option A: Intutic + LiteLLM)
os.environ["AWS_BEDROCK_RUNTIME_ENDPOINT"] = "https://proxy.intutic.ai/v1"

llm = BedrockChat(
    model_id="anthropic.claude-3-5-sonnet-20241022-v2:0",
    model_kwargs={"temperature": 0.1}
)
```

### 4. Custom & Proprietary Company Harnesses

Any internal, microservice-based, or custom company agent framework can be governed by Intutic with zero refactoring:

* **Standard HTTP Protocol Override**: Point `OPENAI_BASE_URL`, `ANTHROPIC_BASE_URL`, `HTTP_PROXY`, or `HTTPS_PROXY` to `https://proxy.your-company.com/v1`.
* **Native Package Suite**: Import `@intutic/clawde` (TypeScript SDK) or spawn `npx @intutic/proxy` directly inside microservice containers.
* **Custom Harness Config Adapters**: Intutic supports Markdown (`.md`), YAML (`.yml`), JSON (`.json`), and Env (`.env`) harness config formats.

---

## 🔒 Air-Gapped VPC & Offline Deployment

For strict security environments requiring zero data egress:

1. **100% Offline Local Operation**: Intutic Proxy, WASM policy engine, and Valkey memory cache operate entirely inside your private VPC or local workstation without sending telemetry to external clouds.
2. **Local Log & Spend Sharding**: Offline telemetry and prompt logs are written to sharded local files (`~/.intutic/logs/traces-YYYY-MM-DD.jsonl`).
3. **Automated Offline Sync**: When a VPC network connection is established (or during scheduled sync windows), the sync daemon reconciles spend back to your self-hosted Control Plane (`/api/v1/traces/sync-back`).

---

## ⚡ Interactive Slash Commands

Because the proxy intercepts prompt content *pre-flight*, developers can invoke interactive slash commands directly inside their chat prompts or agent sessions. 

If a prompt begins with `/intutic` or `@intutic`, the proxy will process the command immediately and return the output without calling the upstream provider:

```python
# Returns active session budget usage and audit compliance rating
response = llm.invoke("/intutic status")
print(response.content)
```

### Protocol Compliance
To prevent client-side SDK parser failures, the proxy automatically formats the slash command response content to match the requested protocol schema:
*   **OpenAI SDK:** Wraps the payload in a standard `chat.completion` Choice object.
*   **Anthropic SDK:** Wraps the payload in a standard `message` JSON block.
*   **Streaming Content:** Streams command outputs using Server-Sent Events (SSE) chunks if `stream: true` is configured.
