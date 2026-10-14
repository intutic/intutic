//! Token intelligence module — pre-prompt cost prediction and
//! per-tool-call token breakdown. Reasoning tokens come from the provider's
//! own usage report (`crate::usage::TokenUsage::reasoning_output`).

pub mod counter;
pub mod prediction;
pub mod tool_breakdown;
