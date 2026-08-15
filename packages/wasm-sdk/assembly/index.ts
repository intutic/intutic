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

export class RequestContext {
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
  /**
   * Which parts of the request contributed at least one injection match:
   * "user_prompt", "system_prompt", "tool_result", or "tool_description".
   * Deduplicated by source, not paired 1:1 with injection_findings above --
   * a rule wanting to treat a tool_result-sourced match more seriously than
   * a user typing "ignore my previous message" checks this, not the count.
   */
  injection_sources: string[] = [];
  /** Harness this request came through. Resolved from the route, not claimed. */
  harness: string = "";
  /** Harnesses the SOPs permit. Empty = unrestricted. */
  allowed_harnesses: string[] = [];
  /**
   * Did this session's sandbox prove it resolves the proxy as its only
   * egress path? Server-derived, like `harness` above — not claimed by the
   * caller, so it is trustworthy enough to gate on.
   *
   * Session-scoped, not node-scoped: every node claiming membership in an
   * attested session's graph reads `true` identically, regardless of its
   * claimed `node_id`/`agent_role`. This does NOT verify agent identity — a
   * compromised node inside an already-attested session can still claim any
   * `node_id`/`agent_role` string it wants. Combining this with `agent_role`
   * in a rule still trusts an unverifiable role claim.
   */
  sandbox_attested: bool = false;
  /** Cost of the loop run this belongs to, and its ceiling. `-1` = unknown. */
  workflow_spend_usd: f64 = -1;
  workflow_budget_usd: f64 = -1;

  // ── Declared SOP policy ─────────────────────────────────────────────────
  //
  // The rules the operator wrote in SOP front matter, as the proxy resolved
  // them for this node. The proxy's own detectors already enforce these; they
  // are here so a rule can *refine* a declaration rather than restate it —
  // "the operator forbade this succession, and I also want it at High risk".
  //
  // Empty means the operator declared nothing under that key. For
  // `requires_before` and `forbid_after` that does NOT mean "no rule": the
  // proxy falls back to its built-in floor, which a rule here cannot see.

  /** Steps the SOP's task should consist of. Drift outside them is steered. */
  plan_steps: string[] = [];
  /** Paths the work should stay within. */
  scope_paths: string[] = [];
  /** Tokens whose call holds the run for human review. */
  review_before: string[] = [];
  /** `A -> B`: A must precede B. Third element is true for `~>` (adjacent). */
  requires_before: OrderingRule[] = [];
  /** `A -> B`: B must not follow A. Third element is true for `~>`. */
  forbid_after: OrderingRule[] = [];
  /** `A <= N`: at most N calls of A. */
  max_calls: CallCeiling[] = [];
  /** `taint(), token`: the two must not appear in one request. */
  forbid_with: TaintRule[] = [];

  // ── This turn, and what changed ─────────────────────────────────────────

  // `tools` is declared at the top of this class already — it existed as a
  // field the whole time and simply had no parser, which is why the parity
  // test flagged it. Only the parsing was missing.
  /**
   * Only the calls new since the previous turn, in order.
   *
   * `tool_sequence` is cumulative, so a rule keyed on it re-fires on every
   * subsequent turn for a call that already happened — which is how a hold
   * that has been approved gets re-held forever. Key on this instead when the
   * question is "did it just do X".
   */
  new_tool_calls: string[] = [];
  /** File/resource changes this turn, as the manifest resolved them. */
  changes: ChangeEntry[] = [];
  /** A tool's schema changed mid-session — the rug-pull signal. */
  tool_contract_changed: bool = false;
  /** How many nodes the graph has seen. `-1` = unknown. */
  graph_node_count: i32 = -1;

  // `transition_baseline` is deliberately NOT parsed. It is a
  // map of transition -> frequency that the guest would have to walk under a
  // 5 ms budget, for a statistic a rule has no business re-deriving. The host
  // acts on it. `__tests__/contextParity.test.ts` records the exemption so its
  // absence is a decision rather than the oversight the other twelve were.
}

/** `A -> B` with `adjacent` true when written `A ~> B`. */
class OrderingRule {
  from: string = "";
  to: string = "";
  adjacent: bool = false;
}

/** `A <= N`. */
class CallCeiling {
  token: string = "";
  limit: i32 = 0;
}

/** `taint(), token` — `secrets()` or `pii()` paired with a tool or action. */
class TaintRule {
  taint: string = "";
  token: string = "";
}

/** One entry from the change manifest. */
class ChangeEntry {
  tool: string = "";
  op: string = "";
  target: string = "";
  target_kind: string = "";
  risk: string = "";
  bytes: i32 = 0;
}

let activeBuffer: Uint8Array | null = null;

export function allocate(size: i32): i32 {
  const buf = new Uint8Array(size);
  activeBuffer = buf;
  return changetype<i32>(buf.dataStart);
}

/**
 * Reads the host's payload out of guest memory and parses it.
 *
 * Factored out of `evaluate` so a standalone rule — one of the drop-in
 * directories under `rules/` — can reuse the buffer handling without copying
 * it. The `activeBuffer` fallback below is load-bearing: `allocate` hands the
 * host a pointer into a guest-owned array, and if that array has been collected
 * or resized the bytes must be read back out of linear memory directly.
 */
export function readContext(offset: i32, len: i32): RequestContext {
  let jsonBytes = activeBuffer;
  if (jsonBytes === null || jsonBytes.length != len) {
    trace("WASM: activeBuffer is null or size mismatch, copying from memory");
    jsonBytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      jsonBytes[i] = load<u8>(offset + i);
    }
  }
  return parseRequestContext(jsonBytes);
}

/**
 * Main evaluation entry point called by the proxy.
 *
 * Verdict codes: **0 allow · 1 block · 3 reask**. This docblock used to name 2
 * as a redaction rung. The guest is handed the RequestContext, never the request
 * body, so redaction was never expressible — the proxy maps 2 to a block, and a
 * rule returning it believing otherwise is blocking. `intutic policy install`
 * refuses any code outside {0,1,2,3} and warns on 2, which it still accepts so
 * that rules which already shipped keep their meaning.
 */
export function evaluate(offset: i32, len: i32): i32 {
  trace("WASM: Starting evaluation");
  const ctx = readContext(offset, len);
  trace("WASM: parsed RequestContext");
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

/**
 * Reads a numeric field whichever JSON form it arrived in.
 *
 * `getFloat` returns null for a value the parser typed as an Integer, and JSON
 * has no way to mark `50` as a float — so every WHOLE-NUMBER budget, spend and
 * cost silently read as the -1 unknown sentinel. A rule gating on
 * `workflow_budget_usd` did nothing whenever the budget happened to be a round
 * number, which is most of the time someone sets one by hand.
 *
 * Returns `NaN` when the field is genuinely absent, so the caller keeps its own
 * default rather than being handed a 0 that means "unset".
 */
function numberOf(obj: JSON.Obj, key: string): f64 {
  const f = obj.getFloat(key);
  if (f != null) return f.valueOf();
  const i = obj.getInteger(key);
  if (i != null) return f64(i.valueOf());
  return NaN;
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

  const budget_remaining_usd = numberOf(jsonObj, "budget_remaining_usd");
  if (!isNaN(budget_remaining_usd)) ctx.budget_remaining_usd = budget_remaining_usd;

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
  const graph_spend_usd = numberOf(jsonObj, "graph_spend_usd");
  if (!isNaN(graph_spend_usd)) ctx.graph_spend_usd = graph_spend_usd;

  const graph_budget_usd = numberOf(jsonObj, "graph_budget_usd");
  if (!isNaN(graph_budget_usd)) ctx.graph_budget_usd = graph_budget_usd;

  const parent_alive = jsonObj.getBool("parent_alive");
  if (parent_alive) ctx.parent_alive = parent_alive.valueOf() ? 1 : 0;

  const harness = jsonObj.getString("harness");
  if (harness) ctx.harness = harness.toString();

  const sandbox_attested = jsonObj.getBool("sandbox_attested");
  if (sandbox_attested) ctx.sandbox_attested = sandbox_attested.valueOf();

  const workflow_spend_usd = numberOf(jsonObj, "workflow_spend_usd");
  if (!isNaN(workflow_spend_usd)) ctx.workflow_spend_usd = workflow_spend_usd;

  const workflow_budget_usd = numberOf(jsonObj, "workflow_budget_usd");
  if (!isNaN(workflow_budget_usd)) ctx.workflow_budget_usd = workflow_budget_usd;

  ctx.denied_tools = parseStringArray(jsonObj, "denied_tools");
  ctx.injection_findings = parseStringArray(jsonObj, "injection_findings");
  ctx.injection_sources = parseStringArray(jsonObj, "injection_sources");
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

  // ── Declared SOP policy, this turn's delta, and the change manifest ──────
  //
  // All of this was sent by the host and unreadable by a rule until now. The
  // failure was silent: a field the guest does not parse reads as its default,
  // and for a policy list the default is empty, which is indistinguishable
  // from "the operator declared nothing".

  ctx.plan_steps = parseStringArray(jsonObj, "plan_steps");
  ctx.scope_paths = parseStringArray(jsonObj, "scope_paths");
  ctx.review_before = parseStringArray(jsonObj, "review_before");
  ctx.new_tool_calls = parseStringArray(jsonObj, "new_tool_calls");

  ctx.requires_before = parseOrderingRules(jsonObj, "requires_before");
  ctx.forbid_after = parseOrderingRules(jsonObj, "forbid_after");

  // `max_calls` and `forbid_with` are arrays of 2-tuples. AssemblyScript has no
  // tuple type, so they arrive positionally: [token, limit] and [taint, token].
  const ceilings = jsonObj.getArr("max_calls");
  if (ceilings) {
    const rows = ceilings.valueOf();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === null || !row.isArr) continue;
      const pair = (<JSON.Arr>row).valueOf();
      if (pair.length < 2) continue;
      const c = new CallCeiling();
      c.token = pair[0].toString();
      const lim = pair[1];
      c.limit = lim.isInteger ? i32(parseInt(lim.toString())) : 0;
      ctx.max_calls.push(c);
    }
  }

  const taints = jsonObj.getArr("forbid_with");
  if (taints) {
    const rows = taints.valueOf();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === null || !row.isArr) continue;
      const pair = (<JSON.Arr>row).valueOf();
      if (pair.length < 2) continue;
      const t = new TaintRule();
      t.taint = pair[0].toString();
      t.token = pair[1].toString();
      ctx.forbid_with.push(t);
    }
  }

  const changesArr = jsonObj.getArr("changes");
  if (changesArr) {
    const rows = changesArr.valueOf();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === null || !row.isObj) continue;
      const o = <JSON.Obj>row;
      const c = new ChangeEntry();
      const tool = o.getString("tool");
      if (tool) c.tool = tool.valueOf();
      const op = o.getString("op");
      if (op) c.op = op.valueOf();
      const target = o.getString("target");
      if (target) c.target = target.valueOf();
      const kind = o.getString("target_kind");
      if (kind) c.target_kind = kind.valueOf();
      const risk = o.getString("risk");
      if (risk) c.risk = risk.valueOf();
      const bytes = o.getInteger("bytes");
      if (bytes) c.bytes = i32(bytes.valueOf());
      ctx.changes.push(c);
    }
  }

  const contractChanged = jsonObj.getBool("tool_contract_changed");
  if (contractChanged) ctx.tool_contract_changed = contractChanged.valueOf();

  const nodeCount = jsonObj.getInteger("graph_node_count");
  if (nodeCount) ctx.graph_node_count = i32(nodeCount.valueOf());

  const toolsArr = jsonObj.getArr("tools");
  if (toolsArr) {
    const rows = toolsArr.valueOf();
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (row === null || !row.isObj) continue;
      const o = <JSON.Obj>row;
      const ts = new ToolSchema();
      const name = o.getString("name");
      if (name) ts.name = name.valueOf();
      const desc = o.getString("description");
      if (desc) ts.description = desc.valueOf();
      ctx.tools.push(ts);
    }
  }

  return ctx;
}

/** Parse `[[from, to, adjacent], …]` — the wire shape of an ordering rule. */
function parseOrderingRules(obj: JSON.Obj, key: string): OrderingRule[] {
  const out: OrderingRule[] = [];
  const arr = obj.getArr(key);
  if (!arr) return out;
  const rows = arr.valueOf();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === null || !row.isArr) continue;
    const parts = (<JSON.Arr>row).valueOf();
    if (parts.length < 2) continue;
    const r = new OrderingRule();
    r.from = parts[0].toString();
    r.to = parts[1].toString();
    // The third element is the `~>` adjacency flag. Absent on an older host,
    // where every rule was the non-adjacent form.
    if (parts.length > 2 && parts[2].isBool) {
      r.adjacent = (<JSON.Bool>parts[2]).valueOf();
    }
    out.push(r);
  }
  return out;
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

  // ── Starter rules ───────────────────────────────────────────────────────
  //
  // Six rules covering the context fields with no other consumer, so each is
  // simultaneously a worked example and the coverage test for the family it
  // reads. Every one has a `mocks/<name>.block.json` and
  // `mocks/<name>.allow.json` beside it, asserted in both directions by
  // `__tests__/starterRules.test.ts` — which is the discipline SKILL.md asks
  // of you, so the library models it rather than only describing it.
  //
  // Delete the ones you do not want. They are ordered cheapest-first: each
  // returns before the next runs, and the whole file shares one 5 ms budget.

  const contract = ruleToolContractPinned(ctx);
  if (contract != 0) return contract;

  const orphan = ruleOrphanedNode(ctx);
  if (orphan != 0) return orphan;

  const graphBudget = ruleGraphBudgetGuard(ctx);
  if (graphBudget != 0) return graphBudget;

  const harness = ruleHarnessAllowlist(ctx);
  if (harness != 0) return harness;

  const exfil = ruleInjectionThenEgress(ctx);
  if (exfil != 0) return exfil;

  const tier = ruleRiskTierCeiling(ctx);
  if (tier != 0) return tier;

  return 0; // Bypass/Allow
}

// ─── Starter rule library ─────────────────────────────────────────────────
//
// Each returns 0 (allow), 1 (block) or 3 (reask). 2 is deprecated: the guest
// never receives the request body, so the REDACT it named was never expressible.

/**
 * A tool's schema changed mid-session — the rug-pull.
 *
 * An MCP server can serve one description at connect time and another later.
 * Nothing else in the SDK reads this flag, and no declarative rule can express
 * it, so without this rule the signal reaches nobody.
 *
 * Blocks rather than reasks: the agent cannot correct a server changing its
 * contract underneath it, so there is nothing to retry.
 */
export function ruleToolContractPinned(ctx: RequestContext): i32 {
  return ctx.tool_contract_changed ? 1 : 0;
}

/**
 * The parent of this node is gone.
 *
 * A node whose parent died is doing work nobody is waiting for, and is the
 * usual shape of a runaway fan-out that keeps spending.
 *
 * Note the tri-state: `-1` means unknown, and unknown is NOT dead. Treating it
 * as dead would block every single-agent session, since a root node has no
 * parent to be alive.
 */
export function ruleOrphanedNode(ctx: RequestContext): i32 {
  if (ctx.parent_alive == 0 && ctx.depth > 0) return 1;
  return 0;
}

/**
 * The graph as a whole has spent its budget.
 *
 * Per-node budgets do not bound a fan-out: ten nodes each under their own
 * ceiling can be far over the graph's.
 *
 * The same `-1` discipline, and it matters more here — a graph whose cost was
 * never aggregated is not a graph that has spent nothing, and treating unknown
 * as zero would block graphs that have done nothing wrong.
 */
export function ruleGraphBudgetGuard(ctx: RequestContext): i32 {
  if (ctx.graph_spend_usd < 0 || ctx.graph_budget_usd < 0) return 0; // unknown
  if (ctx.graph_budget_usd == 0) return 0;                          // unbounded
  return ctx.graph_spend_usd >= ctx.graph_budget_usd ? 1 : 0;
}

/**
 * This request arrived on a harness the SOPs do not permit for this role.
 *
 * `harness` is resolved from the route, not claimed by the caller, so it is one
 * of the few identity signals here that is trustworthy.
 *
 * Empty `allowed_harnesses` means unrestricted, not "permit nothing" — the
 * inversion would block every workspace that never declared the key.
 */
export function ruleHarnessAllowlist(ctx: RequestContext): i32 {
  if (ctx.allowed_harnesses.length == 0) return 0;
  if (ctx.harness.length == 0) return 0;
  for (let i = 0; i < ctx.allowed_harnesses.length; i++) {
    if (ctx.allowed_harnesses[i].toLowerCase() == ctx.harness.toLowerCase()) return 0;
  }
  return 1;
}

/**
 * A prompt-injection pattern matched, and this same turn is trying to egress.
 *
 * This is the conjunction `forbid_with:` cannot express — that key knows DLP
 * taint, not injection findings — and it is the clearest illustration of when
 * to reach for a WASM rule over front matter.
 *
 * Keyed on `new_tool_calls`, not `tool_sequence`. The latter is cumulative, so
 * a rule reading it re-fires every subsequent turn for an egress that already
 * happened, which is how an approved hold gets re-held forever.
 *
 * Reasks rather than blocks: injection findings are pattern matches on
 * untrusted text and do produce false positives, so the agent is told what it
 * tripped and given the chance to proceed without the egress.
 */
export function ruleInjectionThenEgress(ctx: RequestContext): i32 {
  if (ctx.injection_findings.length == 0) return 0;
  for (let i = 0; i < ctx.new_tool_calls.length; i++) {
    const t = ctx.new_tool_calls[i];
    if (t == "action:http_post" || t == "action:pii_export") return 3; // reask
  }
  return 0;
}

/**
 * Critical-risk work is held to a stricter bar.
 *
 * `risk_tier` has no consumer inside the proxy — it is delivered here and
 * nowhere else — so until this rule existed a workspace declaring it got a
 * startup warning saying nothing could act on it.
 *
 * Reasks: the tier describes the SOP, not the request, so the agent may well
 * have a legitimate reason to proceed and should get to say so.
 */
export function ruleRiskTierCeiling(ctx: RequestContext): i32 {
  if (ctx.risk_tier != "Critical") return 0;
  for (let i = 0; i < ctx.new_tool_calls.length; i++) {
    if (ctx.new_tool_calls[i] == "action:deploy") return 3; // reask
  }
  return 0;
}
