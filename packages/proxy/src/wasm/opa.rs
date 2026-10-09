//! Rego policies compiled by OPA (`opa build -t wasm`), run as WASM rules.
//!
//! An OPA module speaks a different ABI from a native Intutic rule. It
//! *imports* its linear memory (`env.memory`) instead of exporting it, imports
//! `opa_abort` and the `opa_builtinN` dispatchers for builtins it cannot run
//! itself, and is driven through `opa_eval` rather than `evaluate(offset,
//! len)`. This module is that host: it recognises an OPA build, refuses at load
//! one it cannot run, builds the policy's `input` from the request, evaluates
//! the entrypoint and maps its result to a verdict.
//!
//! Rego rules load from the same places as native ones (the local rules
//! directory and the control plane) and are on wherever WASM rules are.
//! `INTUTIC_DISABLE_REGO_RULES=1` switches them off: an OPA module is then
//! refused at load, as before this host existed.
//!
//! # The contract with a policy
//!
//! **Input** (`input.v = 1`), built per tool call by [`policy_input`]:
//! `tool`, `args`, `session`, `request` and `truncated`. The guide page
//! "Rego policies" documents every field; the MCP proxy builds the same shape.
//!
//! **Result** of the entrypoint, mapped by [`decision`]:
//! - `true` denies, `false` allows;
//! - a set or array of messages denies with the first when non-empty;
//! - an object `{"decision": "allow"|"deny"|"hold"|"reask", "reason", "risk_tier"}`;
//! - undefined allows;
//! - anything else is no verdict, and the request is refused.
//!
//! **Packaging**: `intutic rules build --rego` appends an `intutic.rule`
//! custom section with the entrypoint and a default risk tier. A module
//! without one is accepted when it has exactly one entrypoint.
//!
//! **Limits**: [`limits::REGO`] — a separate fuel and time budget, still
//! bounded — and the same 16 MB of memory as every rule. A rule stopped by
//! either reaches no verdict, and the request is refused.

use super::context::{RequestContext, RiskLevel, ToolCall, Verdict};
use super::limits::{self, Failure};
use super::opa_builtins::{self, Builtin, EvalCtx};
use super::runner::sanitize_reason;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};
use wasmtime::{
    Caller, Engine, ExternType, Instance, Linker, Memory, MemoryType, Module, Store, StoreLimits,
    StoreLimitsBuilder,
};

/// Set to `1` to refuse Rego rules on this host.
pub const DISABLE_ENV: &str = "INTUTIC_DISABLE_REGO_RULES";

/// The custom section `intutic rules build` writes the rule's metadata into.
pub const METADATA_SECTION: &str = "intutic.rule";

/// `input.v`: bumped only for a change a policy could observe.
pub const INPUT_VERSION: u64 = 1;

/// Largest policy input, in bytes. Long strings in `args` are cut to fit.
///
/// 99.97% of 82,401 real coding-agent tool calls fit untouched; the rest are
/// mostly whole files passed to `Write`. See [`limits::REGO`].
pub const MAX_INPUT_BYTES: usize = 64 * 1024;

/// String lengths `args` is cut to, in turn, until the input fits.
const TRUNCATION_STEPS: [usize; 4] = [16 * 1024, 4 * 1024, 1024, 256];

/// Largest JSON a builtin may hand back to the policy. A builtin runs on the
/// host, outside fuel and the deadline, so its output is bounded here.
const MAX_BUILTIN_RESULT_BYTES: usize = 1024 * 1024;

const WASM_PAGE: usize = 64 * 1024;
const MAX_MEMORY_PAGES: u64 = (limits::MAX_MEMORY_BYTES / WASM_PAGE) as u64;

/// Whether Rego rules may load on this host.
pub fn enabled() -> bool {
    std::env::var(DISABLE_ENV).map_or(true, |v| v != "1")
}

/// What `intutic rules build` records about a rule.
#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct RuleMetadata {
    pub v: u64,
    pub abi: String,
    #[serde(default)]
    pub entrypoint: Option<String>,
    #[serde(default)]
    pub risk_tier: Option<String>,
}

/// A loaded Rego rule: what evaluation needs, resolved once at load.
#[derive(Debug, Clone)]
pub struct OpaRule {
    pub entrypoint: String,
    entrypoint_id: i32,
    /// Indexed by the module's own builtin ids.
    builtins: Vec<Option<Builtin>>,
    /// Applied to a decision that does not name its own.
    pub risk_tier: Option<RiskLevel>,
}

/// Whether `module` was produced by `opa build -t wasm`: it imports its memory
/// and exports OPA's evaluation entry point and ABI version.
pub fn is_opa_module(module: &Module) -> bool {
    let imports_memory = module
        .imports()
        .any(|i| i.module() == "env" && i.name() == "memory");
    let exports = |name: &str| module.exports().any(|e| e.name() == name);
    imports_memory && exports("opa_eval") && exports("opa_wasm_abi_version")
}

/// The payload of the custom section `name`, if the module has one.
///
/// Walks the binary's sections directly: wasmtime does not expose custom
/// sections, and the format is a byte, a length and a payload per section.
pub fn custom_section<'a>(bytes: &'a [u8], name: &str) -> Option<&'a [u8]> {
    let mut rest = bytes.strip_prefix(b"\0asm")?.get(4..)?;
    while let Some((&id, tail)) = rest.split_first() {
        let (size, tail) = leb128(tail)?;
        let payload = tail.get(..size)?;
        rest = &tail[size..];
        if id == 0 {
            let (len, inner) = leb128(payload)?;
            if inner.get(..len)? == name.as_bytes() {
                return Some(&inner[len..]);
            }
        }
    }
    None
}

fn leb128(bytes: &[u8]) -> Option<(usize, &[u8])> {
    let mut value: usize = 0;
    for (i, &b) in bytes.iter().enumerate().take(5) {
        value |= ((b & 0x7f) as usize) << (7 * i);
        if b & 0x80 == 0 {
            return Some((value, &bytes[i + 1..]));
        }
    }
    None
}

/// The rule's metadata section, parsed. A section that does not parse is an
/// error, not an absence: the module claims something it does not say.
pub fn metadata(bytes: &[u8]) -> anyhow::Result<Option<RuleMetadata>> {
    let Some(section) = custom_section(bytes, METADATA_SECTION) else {
        return Ok(None);
    };
    let meta: RuleMetadata = serde_json::from_slice(section)
        .map_err(|e| anyhow::anyhow!("unreadable `{METADATA_SECTION}` section: {e}"))?;
    if meta.v != 1 {
        anyhow::bail!(
            "`{METADATA_SECTION}` version {} is not supported (1 is)",
            meta.v
        );
    }
    Ok(Some(meta))
}

fn parse_risk_tier(tier: &str) -> Option<RiskLevel> {
    match tier.to_ascii_lowercase().as_str() {
        "low" => Some(RiskLevel::Low),
        "medium" => Some(RiskLevel::Medium),
        "high" => Some(RiskLevel::High),
        "critical" => Some(RiskLevel::Critical),
        _ => None,
    }
}

/// Load a module as a Rego rule: `Ok(None)` for a native rule, an error for an
/// OPA build this host cannot run, naming what is missing.
pub fn load(engine: &Engine, module: &Module, bytes: &[u8]) -> anyhow::Result<Option<OpaRule>> {
    load_if(enabled(), engine, module, bytes)
}

fn load_if(
    enabled: bool,
    engine: &Engine,
    module: &Module,
    bytes: &[u8],
) -> anyhow::Result<Option<OpaRule>> {
    let meta = metadata(bytes)?;
    let claims_opa = meta.as_ref().is_some_and(|m| m.abi == "opa");
    if !is_opa_module(module) {
        if claims_opa {
            anyhow::bail!("the metadata says abi `opa`, but the module is not an OPA build");
        }
        return Ok(None);
    }
    if let Some(m) = meta.as_ref().filter(|m| m.abi != "opa") {
        anyhow::bail!("an OPA build whose metadata says abi `{}`", m.abi);
    }
    if !enabled {
        anyhow::bail!("Rego rules are switched off on this host ({DISABLE_ENV}=1)");
    }
    for import in module.imports() {
        let ok = import.module() == "env"
            && (import.name() == "memory"
                || import.name() == "opa_abort"
                || import.name() == "opa_println"
                || import.name().starts_with("opa_builtin"));
        if !ok {
            anyhow::bail!(
                "the OPA module imports `{}.{}`, which the host does not provide",
                import.module(),
                import.name()
            );
        }
    }

    let (mut store, instance, memory) = instantiate(engine, module, Vec::new(), limits::REGO)?;
    let abi = |store: &mut Store<OpaState>, name: &str| -> anyhow::Result<i32> {
        instance
            .get_global(&mut *store, name)
            .and_then(|g| g.get(&mut *store).i32())
            .ok_or_else(|| anyhow::anyhow!("missing ABI global `{name}`"))
    };
    let (major, minor) = (
        abi(&mut store, "opa_wasm_abi_version")?,
        abi(&mut store, "opa_wasm_abi_minor_version")?,
    );
    if major != 1 || minor < 2 {
        anyhow::bail!("OPA WASM ABI {major}.{minor}; the host needs 1.2 or later (opa_eval)");
    }

    let wanted = dump_export(&mut store, &instance, &memory, "builtins")?;
    let wanted = wanted
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("the `builtins` export is not an object"))?;
    let mut builtins: Vec<Option<Builtin>> = Vec::new();
    let mut missing = Vec::new();
    for (name, id) in wanted {
        let id = id
            .as_u64()
            .and_then(|i| usize::try_from(i).ok())
            .ok_or_else(|| anyhow::anyhow!("builtin `{name}` has no numeric id"))?;
        match opa_builtins::lookup(name) {
            Some(f) => {
                if builtins.len() <= id {
                    builtins.resize(id + 1, None);
                }
                builtins[id] = Some(f);
            }
            None => missing.push(name.clone()),
        }
    }
    if !missing.is_empty() {
        missing.sort();
        let supported: Vec<&str> = opa_builtins::SUPPORTED.iter().map(|(n, _)| *n).collect();
        anyhow::bail!(
            "the policy uses builtins this host does not provide: {}. Host-provided builtins: \
             {}; most others are compiled into the module by OPA",
            missing.join(", "),
            supported.join(", ")
        );
    }

    let entrypoints = dump_export(&mut store, &instance, &memory, "entrypoints")?;
    let entrypoints = entrypoints
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("the `entrypoints` export is not an object"))?;
    let entrypoint = match meta.as_ref().and_then(|m| m.entrypoint.clone()) {
        Some(name) => name,
        None if entrypoints.len() == 1 => entrypoints.keys().next().cloned().unwrap_or_default(),
        None => anyhow::bail!(
            "the module has {} entrypoints and no metadata naming one; build it with \
             `intutic rules build --rego <path> --entrypoint <package/rule>`",
            entrypoints.len()
        ),
    };
    let entrypoint_id = entrypoints
        .get(&entrypoint)
        .and_then(Value::as_i64)
        .and_then(|v| i32::try_from(v).ok())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "no `{entrypoint}` entrypoint in the module (it has {}); build with \
                 `opa build -t wasm -e {entrypoint}`",
                entrypoints.keys().cloned().collect::<Vec<_>>().join(", ")
            )
        })?;

    let risk_tier = match meta.as_ref().and_then(|m| m.risk_tier.as_deref()) {
        Some(tier) => Some(
            parse_risk_tier(tier)
                .ok_or_else(|| anyhow::anyhow!("unknown risk tier `{tier}` in the metadata"))?,
        ),
        None => None,
    };

    Ok(Some(OpaRule {
        entrypoint,
        entrypoint_id,
        builtins,
        risk_tier,
    }))
}

/// Store state for one OPA evaluation.
pub struct OpaState {
    limits: StoreLimits,
    builtins: Vec<Option<Builtin>>,
    eval: EvalCtx,
}

/// Create the store, the imported memory and the host imports, and
/// instantiate, under the Rego budget.
fn instantiate(
    engine: &Engine,
    module: &Module,
    builtins: Vec<Option<Builtin>>,
    budget: limits::Budget,
) -> anyhow::Result<(Store<OpaState>, Instance, Memory)> {
    let now_ns = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as i64)
        .unwrap_or_default();
    let mut store = Store::new(
        engine,
        OpaState {
            limits: StoreLimitsBuilder::new()
                .memory_size(limits::MAX_MEMORY_BYTES)
                .build(),
            builtins,
            eval: EvalCtx { now_ns },
        },
    );
    store.limiter(|state| &mut state.limits);
    budget.arm(&mut store)?;

    let minimum = module
        .imports()
        .find_map(|i| match (i.module(), i.name(), i.ty()) {
            ("env", "memory", ExternType::Memory(m)) => Some(m.minimum()),
            _ => None,
        })
        .ok_or_else(|| anyhow::anyhow!("not an OPA module: no env.memory import"))?;
    if minimum > MAX_MEMORY_PAGES {
        anyhow::bail!(
            "the module asks for {minimum} pages of memory; the cap is {MAX_MEMORY_PAGES}"
        );
    }
    let memory = Memory::new(
        &mut store,
        MemoryType::new(u32::try_from(minimum)?, Some(MAX_MEMORY_PAGES as u32)),
    )?;

    let mut linker: Linker<OpaState> = Linker::new(engine);
    linker.define(&store, "env", "memory", memory)?;
    linker.func_wrap("env", "opa_abort", |_: i32| -> anyhow::Result<()> {
        anyhow::bail!("the OPA policy aborted")
    })?;
    linker.func_wrap("env", "opa_println", |_: i32| {})?;
    linker.func_wrap(
        "env",
        "opa_builtin0",
        |mut c: Caller<'_, OpaState>, id: i32, _ctx: i32| call_builtin(&mut c, id, &[]),
    )?;
    linker.func_wrap(
        "env",
        "opa_builtin1",
        |mut c: Caller<'_, OpaState>, id: i32, _ctx: i32, a: i32| call_builtin(&mut c, id, &[a]),
    )?;
    linker.func_wrap(
        "env",
        "opa_builtin2",
        |mut c: Caller<'_, OpaState>, id: i32, _ctx: i32, a: i32, b: i32| {
            call_builtin(&mut c, id, &[a, b])
        },
    )?;
    linker.func_wrap(
        "env",
        "opa_builtin3",
        |mut c: Caller<'_, OpaState>, id: i32, _ctx: i32, a: i32, b: i32, d: i32| {
            call_builtin(&mut c, id, &[a, b, d])
        },
    )?;
    linker.func_wrap(
        "env",
        "opa_builtin4",
        |mut c: Caller<'_, OpaState>, id: i32, _ctx: i32, a: i32, b: i32, d: i32, e: i32| {
            call_builtin(&mut c, id, &[a, b, d, e])
        },
    )?;

    let instance = linker.instantiate(&mut store, module)?;
    Ok((store, instance, memory))
}

/// Run one host builtin: dump its operands to JSON through the module, call
/// the Rust implementation, and parse the result back in. `0` is OPA's
/// "undefined", returned when the builtin fails.
fn call_builtin(caller: &mut Caller<'_, OpaState>, id: i32, args: &[i32]) -> anyhow::Result<i32> {
    let builtin = usize::try_from(id)
        .ok()
        .and_then(|i| caller.data().builtins.get(i).copied().flatten())
        .ok_or_else(|| anyhow::anyhow!("the policy called builtin {id}, which was not provided"))?;
    let func = |caller: &mut Caller<'_, OpaState>, name: &str| {
        caller
            .get_export(name)
            .and_then(|e| e.into_func())
            .ok_or_else(|| anyhow::anyhow!("the OPA module does not export `{name}`"))
    };
    let memory = caller
        .get_export("memory")
        .and_then(|e| e.into_memory())
        .ok_or_else(|| anyhow::anyhow!("the OPA module does not export its memory"))?;
    let dump = func(caller, "opa_json_dump")?.typed::<i32, i32>(&*caller)?;
    let mut values = Vec::with_capacity(args.len());
    for &addr in args {
        let json = dump.call(&mut *caller, addr)?;
        values.push(serde_json::from_slice::<Value>(&read_c_string(
            memory.data(&*caller),
            json,
        )?)?);
    }

    let eval = caller.data().eval;
    let encoded = builtin(&eval, &values)
        .and_then(|v| serde_json::to_vec(&v).map_err(|e| e.to_string()))
        .and_then(|bytes| {
            if bytes.len() > MAX_BUILTIN_RESULT_BYTES {
                Err(format!("result of {} bytes is over the cap", bytes.len()))
            } else {
                Ok(bytes)
            }
        });
    let bytes = match encoded {
        Ok(bytes) => bytes,
        Err(e) => {
            tracing::debug!(
                builtin = id,
                "OPA builtin failed; its result is undefined: {e}"
            );
            return Ok(0);
        }
    };
    let len = i32::try_from(bytes.len())?;
    let addr = func(caller, "opa_malloc")?
        .typed::<i32, i32>(&*caller)?
        .call(&mut *caller, len)?;
    memory.write(&mut *caller, usize::try_from(addr)?, &bytes)?;
    func(caller, "opa_json_parse")?
        .typed::<(i32, i32), i32>(&*caller)?
        .call(&mut *caller, (addr, len))
}

/// Call a no-argument export that returns the address of an OPA value and dump
/// it as JSON (`builtins`, `entrypoints`).
fn dump_export(
    store: &mut Store<OpaState>,
    instance: &Instance,
    memory: &Memory,
    name: &str,
) -> anyhow::Result<Value> {
    let value = instance
        .get_typed_func::<(), i32>(&mut *store, name)?
        .call(&mut *store, ())?;
    let json = instance
        .get_typed_func::<i32, i32>(&mut *store, "opa_json_dump")?
        .call(&mut *store, value)?;
    Ok(serde_json::from_slice(&read_c_string(
        memory.data(&*store),
        json,
    )?)?)
}

/// The NUL-terminated string OPA wrote at `addr`, bounded by memory.
fn read_c_string(data: &[u8], addr: i32) -> anyhow::Result<Vec<u8>> {
    let start = usize::try_from(addr)?;
    let rest = data
        .get(start..)
        .ok_or_else(|| anyhow::anyhow!("string address {addr} is outside memory"))?;
    let len = rest
        .iter()
        .position(|&b| b == 0)
        .ok_or_else(|| anyhow::anyhow!("unterminated string at {addr}"))?;
    Ok(rest[..len].to_vec())
}

/// A risk tier as the policy input and hold records spell it.
pub fn risk_tier_name(tier: RiskLevel) -> &'static str {
    match tier {
        RiskLevel::Low => "low",
        RiskLevel::Medium => "medium",
        RiskLevel::High => "high",
        RiskLevel::Critical => "critical",
    }
}

/// The policy's `input` for one tool call (`None` when the request carries
/// none), version 1, at most [`MAX_INPUT_BYTES`].
pub fn policy_input(ctx: &RequestContext, call: Option<&ToolCall>) -> Vec<u8> {
    let mut session = json!({
        "id": ctx.session_id,
        "workspace_id": ctx.workspace_id,
        "model": ctx.model,
        "risk_tier": risk_tier_name(ctx.risk_tier),
        "tool_sequence": ctx.tool_sequence,
        "calls_last_60s": ctx.calls_last_60s,
    });
    if !ctx.node.agent_role.is_empty() {
        session["agent_role"] = json!(ctx.node.agent_role);
    }
    if !ctx.harness.is_empty() {
        session["harness"] = json!(ctx.harness);
    }
    let input = json!({
        "v": INPUT_VERSION,
        "host": "proxy",
        "tool": call.map(|c| c.name.as_str()),
        "args": call.map(|c| &c.arguments),
        "session": session,
        "request": {
            "estimated_input_tokens": ctx.estimated_input_tokens,
            "budget_remaining_usd": ctx.budget_remaining_usd,
            "dlp_findings": ctx.dlp_findings.iter().map(|f| json!({
                "category": f.category,
                "pattern_name": f.pattern_name,
                "action": f.action,
            })).collect::<Vec<_>>(),
            "injection_findings": ctx.injection_findings,
        },
        "truncated": false,
    });
    bounded(input)
}

/// Serialise `input`, cutting long strings in `args` until it fits.
fn bounded(mut input: Value) -> Vec<u8> {
    let encode = |v: &Value| serde_json::to_vec(v).unwrap_or_default();
    let bytes = encode(&input);
    if bytes.len() <= MAX_INPUT_BYTES {
        return bytes;
    }
    input["truncated"] = Value::Bool(true);
    for limit in TRUNCATION_STEPS {
        if let Some(args) = input.get_mut("args") {
            truncate_strings(args, limit);
        }
        let bytes = encode(&input);
        if bytes.len() <= MAX_INPUT_BYTES {
            return bytes;
        }
    }
    input["args"] = Value::Null;
    encode(&input)
}

/// Cut every string in `v` to at most `limit` bytes, at a character boundary.
fn truncate_strings(v: &mut Value, limit: usize) {
    match v {
        Value::String(s) if s.len() > limit => {
            let mut end = limit;
            while !s.is_char_boundary(end) {
                end -= 1;
            }
            s.truncate(end);
        }
        Value::Array(items) => items.iter_mut().for_each(|i| truncate_strings(i, limit)),
        Value::Object(map) => map.values_mut().for_each(|i| truncate_strings(i, limit)),
        _ => {}
    }
}

/// Evaluate `rule` once against an already-built input under `budget`
/// ([`limits::REGO`] on the request path), returning the raw `opa_eval` result
/// (`[{"result": …}]`, or `[]` when undefined) and the fuel it used.
pub fn evaluate_input(
    engine: &Engine,
    module: &Module,
    rule: &OpaRule,
    input: &[u8],
    budget: limits::Budget,
) -> anyhow::Result<(Value, u64)> {
    let (mut store, instance, memory) = instantiate(engine, module, rule.builtins.clone(), budget)?;

    // `data` is the empty document: Intutic passes everything as `input`.
    let malloc = instance.get_typed_func::<i32, i32>(&mut store, "opa_malloc")?;
    let parse = instance.get_typed_func::<(i32, i32), i32>(&mut store, "opa_json_parse")?;
    let doc = malloc.call(&mut store, 2)?;
    memory.write(&mut store, usize::try_from(doc)?, b"{}")?;
    let data = parse.call(&mut store, (doc, 2))?;

    // ABI 1.2 one-shot eval: the input is written at the heap pointer and the
    // heap continues after it.
    let heap = instance
        .get_typed_func::<(), i32>(&mut store, "opa_heap_ptr_get")?
        .call(&mut store, ())?;
    let start = usize::try_from(heap)?;
    let end = start + input.len();
    if end > memory.data_size(&store) {
        let pages = (end - memory.data_size(&store)).div_ceil(WASM_PAGE) as u64;
        memory.grow(&mut store, pages)?;
    }
    memory.write(&mut store, start, input)?;
    let len = i32::try_from(input.len())?;
    let result = instance
        .get_typed_func::<(i32, i32, i32, i32, i32, i32, i32), i32>(&mut store, "opa_eval")?
        .call(
            &mut store,
            (0, rule.entrypoint_id, data, heap, len, heap + len, 0),
        )?;
    let json = read_c_string(memory.data(&store), result)?;
    let used = budget.fuel - store.get_fuel()?;
    Ok((serde_json::from_slice(&json)?, used))
}

/// What a policy decided about one call.
#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Allow,
    Deny(String),
    Hold(String),
    Reask(String),
}

/// Map an `opa_eval` result to a decision and the risk tier it names.
///
/// A result in none of the documented shapes is no decision: a [`Failure`],
/// which the registry turns into a refusal, as for a native rule returning a
/// code that is not a verdict.
pub fn decision(
    result: &Value,
    entrypoint: &str,
) -> Result<(Decision, Option<RiskLevel>), Failure> {
    let default_reason = || format!("Denied by Rego policy {entrypoint}");
    let reason_of = |v: Option<&Value>, fallback: String| {
        v.and_then(Value::as_str)
            .and_then(sanitize_reason)
            .unwrap_or(fallback)
    };
    let Some(value) = result.get(0).and_then(|r| r.get("result")) else {
        return Ok((Decision::Allow, None));
    };
    match value {
        Value::Bool(true) => Ok((Decision::Deny(default_reason()), None)),
        Value::Bool(false) => Ok((Decision::Allow, None)),
        Value::Array(items) if items.is_empty() => Ok((Decision::Allow, None)),
        Value::Array(items) => Ok((
            Decision::Deny(reason_of(items.first(), default_reason())),
            None,
        )),
        Value::Object(obj) => {
            let tier = obj
                .get("risk_tier")
                .and_then(Value::as_str)
                .and_then(parse_risk_tier);
            let reason = |verb: &str| {
                reason_of(
                    obj.get("reason"),
                    format!("{verb} by Rego policy {entrypoint}"),
                )
            };
            let decision = match obj.get("decision").and_then(Value::as_str) {
                Some("allow") => Decision::Allow,
                Some("deny") => Decision::Deny(reason("Denied")),
                Some("hold") => Decision::Hold(reason("Held for approval")),
                Some("reask") => Decision::Reask(reason("Refused")),
                _ => {
                    return Err(Failure::result(
                        "it returned an object without a known `decision` (allow, deny, hold, \
                         reask)",
                    ))
                }
            };
            Ok((decision, tier))
        }
        _ => Err(Failure::result(
            "it returned neither a boolean, a set of messages nor a decision object",
        )),
    }
}

/// SHA-256 of `args` as JSON with sorted keys: the hold's bypass key, so the
/// same arguments in another key order are the same call.
pub fn target_hash(args: &Value) -> String {
    fn canonical(v: &Value) -> Value {
        match v {
            Value::Object(map) => {
                let mut entries: Vec<_> = map.iter().collect();
                entries.sort_by(|a, b| a.0.cmp(b.0));
                Value::Object(
                    entries
                        .into_iter()
                        .map(|(k, v)| (k.clone(), canonical(v)))
                        .collect(),
                )
            }
            Value::Array(items) => Value::Array(items.iter().map(canonical).collect()),
            other => other.clone(),
        }
    }
    hex::encode(Sha256::digest(
        serde_json::to_vec(&canonical(args)).unwrap_or_default(),
    ))
}

/// Evaluate `rule` against the request: once per call in its latest turn
/// (`RequestContext::turn_tool_calls`), or once with no call when it has none.
///
/// The most restrictive decision wins — a deny ends it, a hold outranks a
/// reask. A call the rule reached no verdict on is skipped and returned as
/// the [`Failure`], with the verdict the other calls reached: the registry
/// refuses on the failure, unless a deny elsewhere in the turn already does.
pub fn evaluate(
    engine: &Engine,
    module: &Module,
    rule: &OpaRule,
    ctx: &RequestContext,
) -> (Verdict, Option<Failure>) {
    let calls: Vec<Option<&ToolCall>> = if ctx.turn_tool_calls.is_empty() {
        vec![None]
    } else {
        ctx.turn_tool_calls.iter().map(Some).collect()
    };
    let mut held: Option<Verdict> = None;
    let mut reasked: Option<Verdict> = None;
    let mut failure: Option<Failure> = None;
    for call in calls {
        let input = policy_input(ctx, call);
        let decided = evaluate_input(engine, module, rule, &input, limits::REGO)
            .map_err(|e| limits::REGO.failure(&e))
            .and_then(|(result, _)| decision(&result, &rule.entrypoint));
        let (decision, tier) = match decided {
            Ok(decided) => decided,
            Err(f) => {
                failure.get_or_insert(f);
                continue;
            }
        };
        let risk_tier = tier.or(rule.risk_tier);
        match decision {
            Decision::Allow => {}
            Decision::Deny(reason) => {
                return (
                    Verdict::Kill {
                        reason,
                        policy_id: None,
                    },
                    None,
                )
            }
            Decision::Hold(reason) if held.is_none() => {
                held = Some(Verdict::Hold {
                    reason,
                    policy_id: None,
                    risk_tier,
                    tool: call.map(|c| c.name.clone()).unwrap_or_default(),
                    target_hash: target_hash(call.map_or(&Value::Null, |c| &c.arguments)),
                });
            }
            Decision::Reask(reason) if reasked.is_none() => {
                reasked = Some(Verdict::Reask {
                    reason,
                    attempts_remaining: 0,
                    policy_id: None,
                });
            }
            Decision::Hold(_) | Decision::Reask(_) => {}
        }
    }
    (held.or(reasked).unwrap_or(Verdict::Bypass), failure)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A raw `opa build` (no metadata, one entrypoint) exercising every
    /// host-provided builtin; see `tests/fixtures/rego/conformance.rego`.
    const CONFORMANCE: &[u8] = include_bytes!("../../tests/fixtures/rego/conformance.wasm");
    const SHELL: &[u8] =
        include_bytes!("../../tests/fixtures/rego/examples/block_destructive_shell.wasm");
    const DEPLOY: &[u8] =
        include_bytes!("../../tests/fixtures/rego/examples/hold_prod_deploys.wasm");
    const PATHS: &[u8] =
        include_bytes!("../../tests/fixtures/rego/examples/deny_writes_outside_repo.wasm");

    fn engine() -> Engine {
        limits::engine().expect("engine")
    }

    fn rule(engine: &Engine, bytes: &[u8]) -> (Module, OpaRule) {
        let module = Module::new(engine, bytes).expect("compiles");
        let rule = load(engine, &module, bytes)
            .expect("loads")
            .expect("is OPA");
        (module, rule)
    }

    /// The verdict a rule reached, asserting it reached one on every call.
    fn verdict(engine: &Engine, module: &Module, rule: &OpaRule, ctx: &RequestContext) -> Verdict {
        let (verdict, failure) = evaluate(engine, module, rule, ctx);
        assert_eq!(failure, None, "the rule reached no verdict on a call");
        verdict
    }

    fn ctx(calls: Value) -> RequestContext {
        let mut ctx: RequestContext = serde_json::from_value(json!({
            "session_id": "ses_1",
            "workspace_id": "ws_1",
            "virtual_key_prefix": "vk_1",
            "model": "claude-sonnet-4",
            "tools": [],
            "tool_calls": [],
            "estimated_input_tokens": 10,
            "budget_remaining_usd": 1.0,
            "risk_tier": "High",
            "dlp_findings": [],
            "tool_sequence": ["Read", "Bash"]
        }))
        .expect("fixture context");
        ctx.turn_tool_calls = serde_json::from_value(calls).expect("calls");
        ctx
    }

    fn call(tool: &str, args: Value) -> Value {
        json!([{ "id": "call_1", "name": tool, "arguments": args }])
    }

    fn bash(command: &str) -> Value {
        call("Bash", json!({ "command": command }))
    }

    /// Every host builtin, against `opa eval` on the same input. The expected
    /// file is `opa eval`'s output, unedited.
    #[test]
    fn host_builtins_match_opa_eval() {
        let engine = engine();
        let (module, rule) = rule(&engine, CONFORMANCE);
        let input = include_bytes!("../../tests/fixtures/rego/conformance.input.json");
        let expected: Value = serde_json::from_slice(include_bytes!(
            "../../tests/fixtures/rego/conformance.expected.json"
        ))
        .unwrap();
        // A semantic check, not a budget one: dozens of regular expressions
        // and host calls in one evaluation, in a debug build, alongside every
        // other test.
        let generous = limits::Budget {
            fuel: u64::MAX / 2,
            deadline: std::time::Duration::from_secs(30),
        };
        let (result, _) = evaluate_input(&engine, &module, &rule, input, generous).unwrap();
        let got = &result[0]["result"];
        for (builtin, cases) in expected.as_object().unwrap() {
            assert_eq!(&got[builtin], cases, "{builtin}");
        }
        assert_eq!(got, &expected);
    }

    #[test]
    fn a_raw_opa_build_with_one_entrypoint_loads_without_metadata() {
        let engine = engine();
        let (module, rule) = rule(&engine, CONFORMANCE);
        assert_eq!(rule.entrypoint, "conformance/results");
        assert_eq!(rule.risk_tier, None);
        // Not loadable through the native rule ABI: it imports its memory.
        assert!(super::super::host::check_imports_resolvable(&module).is_err());
    }

    #[test]
    fn a_native_rule_is_not_mistaken_for_an_opa_build() {
        let engine = engine();
        let bytes = wat::parse_str(
            r#"(module (memory (export "memory") 1)
                 (func (export "evaluate") (param i32 i32) (result i32) i32.const 0))"#,
        )
        .unwrap();
        let module = Module::new(&engine, &bytes).unwrap();
        assert!(!is_opa_module(&module));
        assert!(load(&engine, &module, &bytes).unwrap().is_none());
    }

    #[test]
    fn metadata_claiming_opa_on_a_native_module_is_refused() {
        let engine = engine();
        let mut bytes = wat::parse_str(
            r#"(module (memory (export "memory") 1)
                 (func (export "evaluate") (param i32 i32) (result i32) i32.const 0))"#,
        )
        .unwrap();
        append_section(&mut bytes, br#"{"v":1,"abi":"opa","entrypoint":"x/y"}"#);
        let module = Module::new(&engine, &bytes).unwrap();
        let err = load(&engine, &module, &bytes).unwrap_err().to_string();
        assert!(err.contains("not an OPA build"), "{err}");
    }

    /// The custom section `intutic rules build` appends.
    fn append_section(bytes: &mut Vec<u8>, payload: &[u8]) {
        let name = METADATA_SECTION.as_bytes();
        let mut body = vec![name.len() as u8];
        body.extend_from_slice(name);
        body.extend_from_slice(payload);
        bytes.push(0);
        let mut size = body.len();
        loop {
            let byte = (size & 0x7f) as u8;
            size >>= 7;
            bytes.push(if size == 0 { byte } else { byte | 0x80 });
            if size == 0 {
                break;
            }
        }
        bytes.extend_from_slice(&body);
    }

    #[test]
    fn metadata_names_the_entrypoint_and_the_risk_tier() {
        let engine = engine();
        let mut bytes = CONFORMANCE.to_vec();
        append_section(
            &mut bytes,
            br#"{"v":1,"abi":"opa","entrypoint":"conformance/results","risk_tier":"critical"}"#,
        );
        assert_eq!(
            metadata(&bytes).unwrap().unwrap().entrypoint.as_deref(),
            Some("conformance/results")
        );
        let (_, loaded) = rule(&engine, &bytes);
        assert_eq!(loaded.risk_tier, Some(RiskLevel::Critical));

        let mut wrong = CONFORMANCE.to_vec();
        append_section(
            &mut wrong,
            br#"{"v":1,"abi":"opa","entrypoint":"conformance/nope"}"#,
        );
        let module = Module::new(&engine, &wrong).unwrap();
        let err = load(&engine, &module, &wrong).unwrap_err().to_string();
        assert!(err.contains("no `conformance/nope` entrypoint"), "{err}");

        let mut tier = CONFORMANCE.to_vec();
        append_section(&mut tier, br#"{"v":1,"abi":"opa","risk_tier":"severe"}"#);
        let module = Module::new(&engine, &tier).unwrap();
        let err = load(&engine, &module, &tier).unwrap_err().to_string();
        assert!(err.contains("unknown risk tier `severe`"), "{err}");
    }

    /// The conformance policy calls every builtin the host provides, so a
    /// builtin added to the host without a conformance case fails here.
    #[test]
    fn the_conformance_policy_covers_every_host_builtin() {
        let engine = engine();
        let module = Module::new(&engine, CONFORMANCE).unwrap();
        let (mut store, instance, memory) =
            instantiate(&engine, &module, Vec::new(), limits::REGO).unwrap();
        let wanted = dump_export(&mut store, &instance, &memory, "builtins").unwrap();
        let mut names: Vec<&str> = wanted
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect();
        names.sort_unstable();
        let mut supported: Vec<&str> = opa_builtins::SUPPORTED.iter().map(|(n, _)| *n).collect();
        supported.sort_unstable();
        assert_eq!(names, supported);
    }

    #[test]
    fn the_kill_switch_refuses_rego_rules_at_load() {
        let engine = engine();
        let module = Module::new(&engine, CONFORMANCE).unwrap();
        let err = load_if(false, &engine, &module, CONFORMANCE)
            .unwrap_err()
            .to_string();
        assert!(err.contains(DISABLE_ENV), "{err}");
    }

    #[test]
    fn the_shell_example_blocks_destructive_commands_and_allows_the_rest() {
        let engine = engine();
        let (module, rule) = rule(&engine, SHELL);
        for command in [
            "rm -rf /",
            "sudo rm -rf / --no-preserve-root",
            "rm -fr ~",
            "rm -r -f ..",
            "mkfs.ext4 /dev/sda1",
            "dd if=/dev/zero of=/dev/sda bs=1M",
            "git push --force origin main",
        ] {
            match verdict(&engine, &module, &rule, &ctx(bash(command))) {
                Verdict::Kill { reason, .. } => assert_eq!(
                    reason,
                    format!("destructive shell command blocked: {command}")
                ),
                other => panic!("{command}: expected a block, got {other:?}"),
            }
        }
        for command in [
            "ls -la",
            "rm -rf ./build",
            "rm -rf /tmp/scratch",
            "git push origin main",
        ] {
            assert_eq!(
                verdict(&engine, &module, &rule, &ctx(bash(command))),
                Verdict::Bypass,
                "{command}"
            );
        }
        // Another tool, and no call at all: evaluated, and allowed.
        assert_eq!(
            verdict(
                &engine,
                &module,
                &rule,
                &ctx(call("Read", json!({"file_path": "/"})))
            ),
            Verdict::Bypass
        );
        assert_eq!(
            verdict(&engine, &module, &rule, &ctx(json!([]))),
            Verdict::Bypass
        );
    }

    #[test]
    fn the_deploy_example_holds_production_deploys() {
        let engine = engine();
        let (module, rule) = rule(&engine, DEPLOY);
        let command = "helm upgrade api ./chart -n prod";
        match verdict(&engine, &module, &rule, &ctx(bash(command))) {
            Verdict::Hold {
                reason,
                risk_tier,
                tool,
                target_hash: hash,
                ..
            } => {
                assert_eq!(
                    reason,
                    format!("production deploy needs approval: {command}")
                );
                assert_eq!(risk_tier, Some(RiskLevel::High));
                assert_eq!(tool, "Bash");
                assert_eq!(hash, target_hash(&json!({ "command": command })));
            }
            other => panic!("expected a hold, got {other:?}"),
        }
        assert_eq!(
            verdict(
                &engine,
                &module,
                &rule,
                &ctx(bash("helm upgrade api ./chart -n staging"))
            ),
            Verdict::Bypass
        );
    }

    #[test]
    fn the_paths_example_denies_writes_outside_the_repo() {
        let engine = engine();
        let (module, rule) = rule(&engine, PATHS);
        let write = |path: &str| ctx(call("Write", json!({ "file_path": path, "content": "x" })));
        assert_eq!(
            verdict(
                &engine,
                &module,
                &rule,
                &write("/workspace/app/src/main.rs")
            ),
            Verdict::Bypass
        );
        for path in [
            "/etc/passwd",
            "/workspace/app/../other/x",
            "/workspace/application/x",
        ] {
            assert!(
                matches!(
                    verdict(&engine, &module, &rule, &write(path)),
                    Verdict::Kill { .. }
                ),
                "{path}"
            );
        }
        assert!(matches!(
            verdict(
                &engine,
                &module,
                &rule,
                &ctx(call(
                    "NotebookEdit",
                    json!({ "notebook_path": "/tmp/n.ipynb" })
                ))
            ),
            Verdict::Kill { .. }
        ));
        // Reads are not writes.
        assert_eq!(
            verdict(
                &engine,
                &module,
                &rule,
                &ctx(call("Read", json!({"file_path": "/etc/passwd"})))
            ),
            Verdict::Bypass
        );
    }

    /// Of several calls in one turn, the most restrictive decision wins.
    #[test]
    fn every_call_in_the_turn_is_evaluated() {
        let engine = engine();
        let (module, rule) = rule(&engine, SHELL);
        let calls = json!([
            { "id": "a", "name": "Bash", "arguments": { "command": "ls" } },
            { "id": "b", "name": "Bash", "arguments": { "command": "rm -rf /" } }
        ]);
        assert!(matches!(
            verdict(&engine, &module, &rule, &ctx(calls)),
            Verdict::Kill { .. }
        ));
    }

    #[test]
    fn the_input_is_the_documented_v1_shape() {
        let c = ctx(bash("ls"));
        let input: Value =
            serde_json::from_slice(&policy_input(&c, c.turn_tool_calls.first())).unwrap();
        assert_eq!(input["v"], 1);
        assert_eq!(input["host"], "proxy");
        assert_eq!(input["tool"], "Bash");
        assert_eq!(input["args"]["command"], "ls");
        assert_eq!(input["session"]["risk_tier"], "high");
        assert_eq!(input["session"]["tool_sequence"], json!(["Read", "Bash"]));
        assert_eq!(input["truncated"], false);
        assert!(
            input.get("tools").is_none(),
            "declared tool schemas stay out"
        );
        let none: Value = serde_json::from_slice(&policy_input(&c, None)).unwrap();
        assert_eq!(none["tool"], Value::Null);
        assert_eq!(none["args"], Value::Null);
    }

    /// A `Write` of a large file is the realistic way to exceed the input cap.
    /// It is cut to fit, flagged, and a policy on the other arguments still
    /// sees them.
    #[test]
    fn an_oversized_input_is_cut_to_fit_and_flagged() {
        let c = ctx(call(
            "Write",
            json!({ "file_path": "/repo/big.txt", "content": "x".repeat(500_000) }),
        ));
        let bytes = policy_input(&c, c.turn_tool_calls.first());
        assert!(bytes.len() <= MAX_INPUT_BYTES, "{}", bytes.len());
        let input: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(input["truncated"], true);
        assert_eq!(input["args"]["file_path"], "/repo/big.txt");
        assert_eq!(
            input["args"]["content"].as_str().unwrap().len(),
            TRUNCATION_STEPS[0]
        );
    }

    /// The largest input the builder produces evaluates well inside the fuel
    /// budget, with room left for a policy heavier than the example.
    #[test]
    fn the_rego_budget_covers_the_largest_input() {
        let engine = engine();
        let (module, rule) = rule(&engine, SHELL);
        // Chained commands, the realistic shape of a long one, and costlier to
        // match than a run of one character.
        let unit = "cd /workspace/app && npm test; ";
        let c = ctx(bash(&unit.repeat((MAX_INPUT_BYTES - 1024) / unit.len())));
        let input = policy_input(&c, c.turn_tool_calls.first());
        assert!(input.len() > MAX_INPUT_BYTES - 1024, "{}", input.len());
        let (_, fuel) =
            evaluate_input(&engine, &module, &rule, &input, limits::REGO).expect("within budget");
        assert!(
            fuel < limits::REGO.fuel / 2,
            "{fuel} fuel for a {} byte input leaves too little margin",
            input.len()
        );
    }

    /// The examples' case files are the ones `intutic rules test` runs in the
    /// TypeScript host: the same inputs, the same expected decisions here.
    #[test]
    fn every_example_case_gets_its_expected_decision_in_this_host_too() {
        let engine = engine();
        for (bytes, cases) in [
            (
                SHELL,
                include_str!(
                    "../../tests/fixtures/rego/examples/block_destructive_shell.cases.json"
                ),
            ),
            (
                DEPLOY,
                include_str!("../../tests/fixtures/rego/examples/hold_prod_deploys.cases.json"),
            ),
            (
                PATHS,
                include_str!(
                    "../../tests/fixtures/rego/examples/deny_writes_outside_repo.cases.json"
                ),
            ),
        ] {
            let (module, rule) = rule(&engine, bytes);
            let cases: Vec<Value> = serde_json::from_str(cases).unwrap();
            for case in cases {
                let input = &case["input"];
                let verdict = verdict(
                    &engine,
                    &module,
                    &rule,
                    &ctx(call(input["tool"].as_str().unwrap(), input["args"].clone())),
                );
                let got = match verdict {
                    Verdict::Bypass => "allow",
                    Verdict::Kill { .. } => "deny",
                    Verdict::Hold { .. } => "hold",
                    Verdict::Reask { .. } => "reask",
                    other => panic!("{}: {other:?}", case["name"]),
                };
                assert_eq!(got, case["expect"], "{}", case["name"]);
            }
        }
    }

    /// Padding a call past the 64 KB input moves its end out of the policy's
    /// sight; every shipped example refuses the tools it governs then, rather
    /// than judging what is left.
    #[test]
    fn the_examples_refuse_a_call_padded_past_the_input_cap() {
        let engine = engine();
        let padding = "echo ok; ".repeat(8_000);
        for (bytes, tool, args) in [
            (
                SHELL,
                "Bash",
                json!({ "command": format!("{padding}rm -rf /") }),
            ),
            (
                DEPLOY,
                "Bash",
                json!({ "command": format!("{padding}helm upgrade api ./chart -n prod") }),
            ),
            (
                PATHS,
                "Write",
                json!({
                    "file_path": format!("/workspace/app/{}/../../../etc/passwd", "x".repeat(70_000)),
                    "content": ""
                }),
            ),
        ] {
            let (module, rule) = rule(&engine, bytes);
            let c = ctx(call(tool, args));
            let input: Value =
                serde_json::from_slice(&policy_input(&c, c.turn_tool_calls.first())).unwrap();
            assert_eq!(input["truncated"], true, "the padding must reach the cap");
            match verdict(&engine, &module, &rule, &c) {
                Verdict::Kill { reason, .. } => {
                    assert!(reason.contains("too long to check in full"), "{reason}")
                }
                other => panic!("{}: expected a refusal, got {other:?}", rule.entrypoint),
            }
        }
    }

    /// A call the rule reaches no verdict on comes back as the failure, with
    /// whatever the rule decided about the turn's other calls.
    #[test]
    fn a_call_without_a_verdict_is_returned_as_the_failure() {
        let engine = engine();
        let (module, rule) = rule(&engine, CONFORMANCE);
        let (verdict, failure) = evaluate(&engine, &module, &rule, &ctx(bash("ls")));
        assert_eq!(verdict, Verdict::Bypass);
        assert_eq!(failure.map(|f| f.stop), Some(limits::Stop::Result));

        // A budget the evaluation cannot fit in is a failure named for it.
        let c = ctx(bash("ls"));
        let tiny = limits::Budget {
            fuel: 1_000,
            deadline: std::time::Duration::from_secs(10),
        };
        let err = evaluate_input(
            &engine,
            &module,
            &rule,
            &policy_input(&c, c.turn_tool_calls.first()),
            tiny,
        )
        .unwrap_err();
        let failure = tiny.failure(&err);
        assert_eq!(failure.stop, limits::Stop::Fuel);
        assert_eq!(failure.reason, "it used up its budget of 1000 instructions");
    }

    #[test]
    fn results_map_to_decisions() {
        let ep = "p/r";
        assert_eq!(decision(&json!([]), ep).unwrap().0, Decision::Allow);
        assert_eq!(
            decision(&json!([{"result": false}]), ep).unwrap().0,
            Decision::Allow
        );
        assert_eq!(
            decision(&json!([{"result": true}]), ep).unwrap().0,
            Decision::Deny("Denied by Rego policy p/r".into())
        );
        assert_eq!(
            decision(&json!([{"result": []}]), ep).unwrap().0,
            Decision::Allow
        );
        assert_eq!(
            decision(&json!([{"result": ["no\nthanks"]}]), ep)
                .unwrap()
                .0,
            Decision::Deny("nothanks".into())
        );
        assert_eq!(
            decision(
                &json!([{"result": {"decision": "hold", "reason": "prod deploy", "risk_tier": "high"}}]),
                ep
            ),
            Ok((Decision::Hold("prod deploy".into()), Some(RiskLevel::High)))
        );
        assert_eq!(
            decision(&json!([{"result": {"decision": "reask"}}]), ep)
                .unwrap()
                .0,
            Decision::Reask("Refused by Rego policy p/r".into())
        );
        // Not a verdict: the rule reached none, and the request is refused.
        for result in [
            json!([{"result": {"decision": "maybe"}}]),
            json!([{"result": 7}]),
            json!([{"result": null}]),
        ] {
            let failure = decision(&result, ep).expect_err("not a verdict");
            assert_eq!(failure.stop, limits::Stop::Result, "{result}");
        }
    }

    #[test]
    fn the_hold_key_ignores_argument_order() {
        assert_eq!(
            target_hash(&json!({"a": 1, "b": [{"y": 2, "x": 1}]})),
            target_hash(&json!({"b": [{"x": 1, "y": 2}], "a": 1}))
        );
        assert_ne!(target_hash(&json!({"a": 1})), target_hash(&json!({"a": 2})));
    }

    #[test]
    fn custom_sections_are_found_by_name_only() {
        let mut bytes = wat::parse_str("(module)").unwrap();
        assert_eq!(custom_section(&bytes, METADATA_SECTION), None);
        append_section(&mut bytes, b"{}");
        assert_eq!(custom_section(&bytes, METADATA_SECTION), Some(&b"{}"[..]));
        assert_eq!(custom_section(&bytes, "name"), None);
        assert_eq!(custom_section(b"not wasm", METADATA_SECTION), None);
    }
}
