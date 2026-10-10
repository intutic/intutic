//! WASM plugin system — hosts wasmtime for Layer 1 governance rules.
//!
//! Hosts both first-party rules and AssemblyScript user rules — authored with
//! `packages/wasm-sdk` and compiled/installed via `intutic policy compile` /
//! `intutic policy install` — and Rego policies compiled by
//! OPA (`intutic rules build --rego`, see [`opa`]).

pub mod context;
pub mod hold;
pub mod host;
pub mod limits;
pub mod local_loader;
pub mod opa;
pub mod opa_builtins;
pub mod referenced_files;
pub mod registry;
pub mod runner;
