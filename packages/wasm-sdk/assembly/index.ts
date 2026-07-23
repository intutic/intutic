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
import { evaluateSequenceAnomaly } from "./onnx_rules";

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

  // Rule 4: Kill if ML sequence autoencoder detects sequence anomaly
  if (evaluateSequenceAnomaly(ctx.tool_sequence)) {
    return 1; // Block/Kill
  }

  return 0; // Bypass/Allow
}
