//! WASM plugin system — hosts wasmtime for Layer 1 governance rules.
//!
//! Phase 1: Rust→WASM only. AssemblyScript user rules deferred to Phase 3 (TD-004).

pub mod context;
pub mod host;
pub mod registry;
pub mod runner;
