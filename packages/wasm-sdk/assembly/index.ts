import { JSON } from "assemblyscript-json/assembly";

class ToolSchema {
  name: string = "";
  description: string = "";
}

class ToolCall {
  id: string = "";
  name: string = "";
  arguments: string = "";
}

class DlpFinding {
  category: string = "";
  pattern_name: string = "";
  action: string = "";
  offset: i32 = 0;
  length: i32 = 0;
}

class RequestContext {
  session_id: string = "";
  workspace_id: string = "";
  virtual_key_prefix: string = "";
  model: string = "";
  tools: ToolSchema[] = [];
  tool_calls: ToolCall[] = [];
  estimated_input_tokens: i32 = 0;
  budget_remaining_usd: f64 = 0.0;
  risk_tier: string = "";
  dlp_findings: DlpFinding[] = [];
  tool_sequence: string[] = [];

  // ── Graph position ──────────────────────────────────────────────────────
  //
  // Where this request sits in a multi-agent graph. The proxy derives these
  // from W3C Baggage carrying OpenTelemetry GenAI attributes
  // (`gen_ai.agent.id`, `gen_ai.agent.name`, `gen_ai.conversation.id`) and from
  // `traceparent`, falling back to `X-Intutic-*` headers.
  //
  // For a single-agent session `node_id` and `graph_id` both equal
  // `session_id`, `depth` is 0 and the rest are empty — so a rule written
  // before these existed behaves identically.
  //
  // These values are client-supplied and unverifiable. Use them to observe the
  // graph, never to grant capability: an agent that can set a header can claim
  // any role.

  /** `gen_ai.agent.id` — this node's id. Defaults to `session_id`. */
  node_id: string = "";
  /** `gen_ai.agent.name` — this node's role. Empty when unset. */
  agent_role: string = "";
  /** `gen_ai.conversation.id` — shared by every node in one graph. */
  graph_id: string = "";
  /** Parent span from `traceparent`. Empty at the graph root. */
  parent_session_id: string = "";
  /** Distance from the graph root. 0 at the root. */
  depth: i32 = 0;

  // Graph-wide aggregates, read from shared storage by the proxy.
  //
  // AssemblyScript has no Option, and "unknown" genuinely differs from "zero"
  // here: a graph whose cost was never aggregated is not a graph that has
  // spent nothing. Unknown is therefore -1, and a rule that treats -1 as 0
  // will block graphs that have done nothing wrong.

  /** Total cost across every node in this graph. `-1` when unknown. */
  graph_spend_usd: f64 = -1;
  /** Per-node budget this graph is measured against. `-1` when unknown. */
  graph_budget_usd: f64 = -1;
  /** Is this node's parent still live? `1` yes, `0` no, `-1` unknown. */
  parent_alive: i32 = -1;

  // ── Policy and provenance ───────────────────────────────────────────────

  /** Tool names the SOPs in force forbid for this node. Empty = unrestricted. */
  denied_tools: string[] = [];
  /** Prompt-injection pattern names matched in this request. */
  injection_findings: string[] = [];
  /** Harness this request came through. Resolved from the route, not claimed. */
  harness: string = "";
  /** Harnesses the SOPs permit. Empty = unrestricted. */
  allowed_harnesses: string[] = [];
  /** Cost of the loop run this belongs to, and its ceiling. `-1` = unknown. */
  workflow_spend_usd: f64 = -1;
  workflow_budget_usd: f64 = -1;
}

let activeBuffer: Uint8Array | null = null;

export function allocate(size: i32): i32 {
  const buf = new Uint8Array(size);
  activeBuffer = buf;
  return changetype<i32>(buf.dataStart);
}

/**
 * Main evaluation entry point called by the proxy.
 * Maps to: evaluate(offset, len) -> i32 (0 = Bypass/Allow, 1 = Block/Kill, 2 = Redact)
 */
export function evaluate(offset: i32, len: i32): i32 {
  trace("WASM: Starting evaluation");
  
  // Retrieve or recreate the Uint8Array holding the JSON payload
  let jsonBytes = activeBuffer;
  if (jsonBytes === null || jsonBytes.length != len) {
    trace("WASM: activeBuffer is null or size mismatch, copying from memory");
    jsonBytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      jsonBytes[i] = load<u8>(offset + i);
    }
  }
  
  trace("WASM: read JSON bytes, length: " + jsonBytes.length.toString());
  
  // Parse RequestContext
  const ctx = parseRequestContext(jsonBytes);
  trace("WASM: parsed RequestContext");
  
  // Apply safety rules
  return runRules(ctx);
}

// Memory reader helper (retained for backward compatibility or debugging)
function readString(offset: i32, len: i32): string {
  let str = "";
  for (let i = 0; i < len; i++) {
    str += String.fromCharCode(load<u8>(offset + i));
  }
  return str;
}

/** Read a JSON string array, or an empty array when absent. */
function parseStringArray(obj: JSON.Obj, key: string): string[] {
  const out: string[] = [];
  const arr = obj.getArr(key);
  if (!arr) return out;
  const values = arr.valueOf();
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v.isString) out.push((<JSON.Str>v).valueOf());
  }
  return out;
}

function parseRequestContext(jsonBytes: Uint8Array): RequestContext {
  trace("WASM: parseRequestContext start");
  const ctx = new RequestContext();
  const jsonObj = <JSON.Obj>JSON.parse<Uint8Array>(jsonBytes);
  if (!jsonObj) {
    trace("WASM: parse returned null");
    return ctx;
  }
  trace("WASM: parsed to Obj successfully");

  const session_id = jsonObj.getString("session_id");
  if (session_id) ctx.session_id = session_id.toString();

  const workspace_id = jsonObj.getString("workspace_id");
  if (workspace_id) ctx.workspace_id = workspace_id.toString();

  const virtual_key_prefix = jsonObj.getString("virtual_key_prefix");
  if (virtual_key_prefix) ctx.virtual_key_prefix = virtual_key_prefix.toString();

  const model = jsonObj.getString("model");
  if (model) ctx.model = model.toString();

  const estimated_input_tokens = jsonObj.getInteger("estimated_input_tokens");
  if (estimated_input_tokens) ctx.estimated_input_tokens = i32(estimated_input_tokens.valueOf());

  const budget_remaining_usd = jsonObj.getFloat("budget_remaining_usd");
  if (budget_remaining_usd) ctx.budget_remaining_usd = budget_remaining_usd.valueOf();

  const risk_tier = jsonObj.getString("risk_tier");
  if (risk_tier) ctx.risk_tier = risk_tier.toString();

  // Graph position. Absent on a single-agent session, in which case node_id
  // and graph_id mirror the session id so rules can treat every session as a
  // graph of at least one node.
  const node_id = jsonObj.getString("node_id");
  ctx.node_id = node_id ? node_id.toString() : ctx.session_id;

  const agent_role = jsonObj.getString("agent_role");
  if (agent_role) ctx.agent_role = agent_role.toString();

  const graph_id = jsonObj.getString("graph_id");
  ctx.graph_id = graph_id ? graph_id.toString() : ctx.session_id;

  const parent_session_id = jsonObj.getString("parent_session_id");
  if (parent_session_id) ctx.parent_session_id = parent_session_id.toString();

  const depth = jsonObj.getInteger("depth");
  if (depth) ctx.depth = i32(depth.valueOf());

  // Absent or JSON null leaves the -1 sentinel in place, which is the
  // difference between "we did not measure" and "it measured zero".
  const graph_spend_usd = jsonObj.getFloat("graph_spend_usd");
  if (graph_spend_usd) ctx.graph_spend_usd = graph_spend_usd.valueOf();

  const graph_budget_usd = jsonObj.getFloat("graph_budget_usd");
  if (graph_budget_usd) ctx.graph_budget_usd = graph_budget_usd.valueOf();

  const parent_alive = jsonObj.getBool("parent_alive");
  if (parent_alive) ctx.parent_alive = parent_alive.valueOf() ? 1 : 0;

  const harness = jsonObj.getString("harness");
  if (harness) ctx.harness = harness.toString();

  const workflow_spend_usd = jsonObj.getFloat("workflow_spend_usd");
  if (workflow_spend_usd) ctx.workflow_spend_usd = workflow_spend_usd.valueOf();

  const workflow_budget_usd = jsonObj.getFloat("workflow_budget_usd");
  if (workflow_budget_usd) ctx.workflow_budget_usd = workflow_budget_usd.valueOf();

  ctx.denied_tools = parseStringArray(jsonObj, "denied_tools");
  ctx.injection_findings = parseStringArray(jsonObj, "injection_findings");
  ctx.allowed_harnesses = parseStringArray(jsonObj, "allowed_harnesses");

  trace("WASM: parsed primitive fields");

  // Parse tool calls
  const toolCallsArr = jsonObj.getArr("tool_calls");
  if (toolCallsArr) {
    trace("WASM: tool_calls array found");
    const values = toolCallsArr.valueOf();
    for (let i = 0; i < values.length; i++) {
      trace("WASM: tool_calls index " + i.toString());
      const val = values[i];
      if (val === null) {
        trace("WASM: tool_calls element is null");
        continue;
      }
      if (!val.isObj) {
        trace("WASM: tool_calls element is not an Obj");
        continue;
      }
      const callObj = <JSON.Obj>val;
      const tc = new ToolCall();
      const id = callObj.getString("id");
      if (id) tc.id = id.toString();
      const name = callObj.getString("name");
      if (name) tc.name = name.toString();
      const argsObj = callObj.get("arguments");
      if (argsObj) {
        tc.arguments = argsObj.toString();
      }
      ctx.tool_calls.push(tc);
    }
  }
  trace("WASM: tool_calls parsed successfully");

  // Parse DLP findings
  const dlpArr = jsonObj.getArr("dlp_findings");
  if (dlpArr) {
    const values = dlpArr.valueOf();
    for (let i = 0; i < values.length; i++) {
      const dlpObj = <JSON.Obj>values[i];
      const df = new DlpFinding();
      const cat = dlpObj.getString("category");
      if (cat) df.category = cat.toString();
      const pat = dlpObj.getString("pattern_name");
      if (pat) df.pattern_name = pat.toString();
      const act = dlpObj.getString("action");
      if (act) df.action = act.toString();
      const off = dlpObj.getInteger("offset");
      if (off) df.offset = i32(off.valueOf());
      const lenVal = dlpObj.getInteger("length");
      if (lenVal) df.length = i32(lenVal.valueOf());
      ctx.dlp_findings.push(df);
    }
  }

  // Parse tool sequence
  const seqArr = jsonObj.getArr("tool_sequence");
  if (seqArr) {
    const values = seqArr.valueOf();
    for (let i = 0; i < values.length; i++) {
      const val = values[i];
      if (val !== null && val.isString) {
        ctx.tool_sequence.push(val.toString());
      }
    }
  }

  return ctx;
}

/**
 * User-extensible rules function.
 */
function runRules(ctx: RequestContext): i32 {
  // Rule 1: Kill if any critical DLP findings exist that must be blocked
  for (let i = 0; i < ctx.dlp_findings.length; i++) {
    if (ctx.dlp_findings[i].action == "block") {
      return 1; // Block/Kill
    }
  }

  // Rule 2: Kill if executing sensitive bash or shell commands containing destructive patterns
  for (let i = 0; i < ctx.tool_calls.length; i++) {
    const tc = ctx.tool_calls[i];
    if (tc.name == "execute_bash" || tc.name == "run_command" || tc.name == "bash") {
      const args = tc.arguments.toLowerCase();
      if (args.includes("rm ") || args.includes("drop ") || args.includes("delete ")) {
        return 1; // Block/Kill
      }
    }
  }

  // Rule 3: Kill if budget is exhausted
  if (ctx.budget_remaining_usd <= 0.0) {
    return 1; // Block/Kill
  }

  // Rule 4 was "Kill if ML sequence autoencoder detects sequence anomaly", backed by
  // onnx_rules.ts — a complete reconstruction-error scorer with a calibrated 0.35
  // threshold, advertised as a KILL. Its host function `runOnnxInference` returned the
  // input pointer unchanged, so the reconstruction always equalled the input, the mean
  // squared error was always exactly 0, and `0 > 0.35` was never true. The rule could
  // not fire, and never had.
  //
  // Deleted rather than implemented: sequence deviation is now scored by the proxy's
  // TransitionProbabilityDetector against a distribution fitted from each workspace's
  // successful runs — real data, no ONNX runtime on the hot path, and a score that can
  // be explained to an auditor, which a reconstruction error cannot.

  return 0; // Bypass/Allow
}
