//! WASM plugin system — hosts wasmtime for Layer 1 governance rules.
//!
//! Hosts both first-party rules and AssemblyScript user rules — authored with
//! `packages/wasm-sdk` and compiled/installed via `intutic policy compile` /
//! `intutic policy install` (TD-004, shipped).

pub mod context;
pub mod host;
pub mod local_loader;
pub mod referenced_files;
pub mod registry;
pub mod runner;
