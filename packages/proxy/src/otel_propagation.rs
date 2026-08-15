//! Global W3C trace-context propagator registration.
//!
//! Split out of `main.rs` into the lib crate purely so it is unit-testable —
//! `main.rs` is a binary entry point and integration tests link against the
//! lib crate, not the binary.
//!
//! ## The bug this exists to prevent recurring
//!
//! `handle_proxy` (proxy.rs) inherits the upstream harness's span via
//! `opentelemetry::global::get_text_map_propagator(|p| p.extract(&extractor))`.
//! That call reads whatever propagator was last registered with
//! `global::set_text_map_propagator`. Nothing called it anywhere in this
//! codebase until this module: the library default is `NoopTextMapPropagator`,
//! whose `extract` always returns an empty `Context` regardless of what
//! headers are present. `set_parent` on an empty context attaches nothing, so
//! every proxy span was silently orphaned from the caller's trace — in every
//! deployment, independent of whether OTLP export itself was enabled — and the
//! warning proxy.rs logs on a *failed* `set_parent` never fired, because an
//! empty-but-valid context is not a failure.
use opentelemetry::propagation::TextMapCompositePropagator;
use opentelemetry_sdk::propagation::{BaggagePropagator, TraceContextPropagator};

/// Register the W3C trace-context + baggage propagators as the process-wide
/// default. Must run before the first inbound request — call once at startup.
///
/// Safe to call more than once (each call simply replaces the global), which
/// is what makes it safe to exercise directly from tests without needing to
/// coordinate with `main`.
pub fn install_default_propagator() {
    opentelemetry::global::set_text_map_propagator(TextMapCompositePropagator::new(vec![
        Box::new(TraceContextPropagator::new()),
        Box::new(BaggagePropagator::new()),
    ]));
}

#[cfg(test)]
mod tests {
    use super::install_default_propagator;
    use opentelemetry::propagation::Extractor;
    use opentelemetry::trace::TraceContextExt;

    struct SingleHeader<'a>(&'a str, &'a str);
    impl<'a> Extractor for SingleHeader<'a> {
        fn get(&self, key: &str) -> Option<&str> {
            (key == self.0).then_some(self.1)
        }
        fn keys(&self) -> Vec<&str> {
            vec![self.0]
        }
    }

    /// This is the regression the module exists to prevent: before this fix,
    /// nothing ever called `global::set_text_map_propagator`, so the process
    /// default was `NoopTextMapPropagator` and extraction always returned an
    /// empty context — a valid `traceparent` header or not. Assert the exact
    /// call `handle_proxy` makes (`global::get_text_map_propagator(...).extract`)
    /// actually recovers the trace and span ids the header encodes.
    #[test]
    fn a_valid_traceparent_header_yields_a_real_parent_span_after_install() {
        install_default_propagator();

        // version-traceid-spanid-flags, per W3C Trace Context.
        let trace_id = "4bf92f3577b34da6a3ce929d0e0e4736";
        let parent_span_id = "00f067aa0ba902b7";
        let header_value = format!("00-{trace_id}-{parent_span_id}-01");

        let cx = opentelemetry::global::get_text_map_propagator(|propagator| {
            propagator.extract(&SingleHeader("traceparent", &header_value))
        });

        let span_cx = cx.span().span_context().clone();
        assert!(
            span_cx.is_valid(),
            "extraction produced an invalid/empty span context — this is exactly the \
             silent-orphan bug: a well-formed traceparent header must not be discarded"
        );
        assert_eq!(span_cx.trace_id().to_string(), trace_id);
        assert_eq!(span_cx.span_id().to_string(), parent_span_id);
    }

    /// A missing/absent header must still yield an *empty* (not invalid-but-
    /// crashing) context — the propagator should degrade gracefully, not
    /// require a header to function at all.
    #[test]
    fn a_missing_traceparent_header_yields_an_empty_context() {
        install_default_propagator();

        let cx = opentelemetry::global::get_text_map_propagator(|propagator| {
            propagator.extract(&SingleHeader("some-other-header", "irrelevant"))
        });

        assert!(!cx.span().span_context().is_valid());
    }
}
