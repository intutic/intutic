//! The limits every WASM rule runs under, and the engine that enforces them.
//!
//! Two bounds apply to every evaluation, native or Rego:
//!
//! - **Fuel** counts guest instructions. It is deterministic: the same module on
//!   the same input always stops at the same point, on any machine.
//! - **A wall-clock deadline**, enforced by wasmtime's epoch interruption. A
//!   ticker thread advances the engine's epoch every [`TICK`]; a store armed
//!   with a deadline traps the guest at the first epoch check past it, which
//!   wasmtime compiles into every loop header and function entry.
//!
//! The deadline used to be a `tokio::time::timeout` around the evaluation. An
//! evaluation is synchronous guest code with no await point inside it, so the
//! timer was only consulted after the guest had already returned: it never
//! fired for any rule, and fuel was the only real bound. Epoch interruption
//! stops a running guest, which is what the deadline was always meant to do.
//!
//! Either bound failing fails the evaluation open for that call, as every
//! other guest error does.

use std::time::Duration;
use wasmtime::{Config, Engine, Store, Trap};

/// How often the epoch advances. The deadline's resolution.
const TICK: Duration = Duration::from_millis(1);

/// Guest linear memory cap for every rule: 16 MB (256 pages).
pub const MAX_MEMORY_BYTES: usize = 16 * 1024 * 1024;

/// The fuel and wall-clock time one evaluation may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub fuel: u64,
    pub deadline: Duration,
}

/// A native (AssemblyScript) rule: 1,000,000 instructions and 5 ms.
pub const NATIVE: Budget = Budget {
    fuel: 1_000_000,
    deadline: Duration::from_millis(5),
};

/// A Rego rule compiled by OPA: 100,000,000 instructions and 20 ms.
///
/// Larger than [`NATIVE`] because OPA does in the sandbox what a native rule
/// leaves out: it parses its whole `input` (about 45 instructions a byte) and
/// compiles every regular expression a policy uses, on each evaluation (about
/// 500,000 instructions a pattern, then about 300 a byte matched). The
/// destructive-shell example uses 2,000,000 instructions on a typical call and
/// 21,000,000 on the largest input [`super::opa::policy_input`] builds
/// ([`super::opa::MAX_INPUT_BYTES`], above 99.97% of 82,401 real coding-agent
/// tool calls), in 1.3 ms. The budget is about five times that; the deadline,
/// fifteen times the time, leaves room for a slower or busier machine.
/// `benches/rego_bench.rs` measures it.
pub const REGO: Budget = Budget {
    fuel: 100_000_000,
    deadline: Duration::from_millis(20),
};

/// The engine every rule is compiled for: fuel metering and epoch interruption
/// on, and a ticker thread advancing the epoch.
///
/// The ticker holds only a weak reference, so it stops when the last clone of
/// the engine is dropped.
pub fn engine() -> anyhow::Result<Engine> {
    let mut config = Config::new();
    config.consume_fuel(true);
    config.epoch_interruption(true);
    let engine = Engine::new(&config)?;
    let weak = engine.weak();
    std::thread::Builder::new()
        .name("wasm-epoch".to_string())
        .spawn(move || loop {
            std::thread::sleep(TICK);
            match weak.upgrade() {
                Some(engine) => engine.increment_epoch(),
                None => return,
            }
        })?;
    Ok(engine)
}

impl Budget {
    /// Arm `store` for one evaluation under this budget.
    ///
    /// One tick more than the deadline divides into, because the tick in
    /// progress when the store is armed is already partly spent: the guest
    /// always gets at least `deadline`, and at most one [`TICK`] more.
    pub fn arm<T>(&self, store: &mut Store<T>) -> anyhow::Result<()> {
        store.set_fuel(self.fuel)?;
        let ticks = (self.deadline.as_micros() / TICK.as_micros()) as u64 + 1;
        store.set_epoch_deadline(ticks);
        Ok(())
    }
}

/// Why an evaluation stopped, for the log line that reports it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// The wall-clock deadline interrupted the guest.
    Deadline,
    /// The guest ran out of fuel.
    Fuel,
    /// Anything else: a trap, a missing export, a host error.
    Error,
}

impl Budget {
    /// Log why an evaluation under this budget failed open.
    pub fn log_fail_open(&self, what: &str, error: &anyhow::Error) {
        match Stop::of(error) {
            Stop::Deadline => tracing::warn!(
                deadline_ms = self.deadline.as_millis() as u64,
                "{what} interrupted at its deadline (fail-open)"
            ),
            Stop::Fuel => tracing::warn!(fuel = self.fuel, "{what} ran out of fuel (fail-open)"),
            Stop::Error => tracing::warn!("{what} execution error (fail-open): {error}"),
        }
    }
}

impl Stop {
    pub fn of(error: &anyhow::Error) -> Self {
        match error.downcast_ref::<Trap>() {
            Some(Trap::Interrupt) => Self::Deadline,
            Some(Trap::OutOfFuel) => Self::Fuel,
            _ => Self::Error,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;
    use wasmtime::{Linker, Module};

    /// Loops forever without spending much fuel per iteration, the shape that
    /// fuel alone takes longest to stop.
    const SPIN: &str = r#"(module
         (func (export "spin") (loop $l (br $l))))"#;

    #[test]
    fn the_deadline_interrupts_a_running_guest() {
        let engine = engine().unwrap();
        let module = Module::new(&engine, SPIN).unwrap();
        let mut store = Store::new(&engine, ());
        // Fuel far beyond what the deadline allows, so only the deadline can
        // be what stops it.
        let budget = Budget {
            fuel: u64::MAX / 2,
            deadline: Duration::from_millis(5),
        };
        budget.arm(&mut store).unwrap();
        let instance = Linker::new(&engine)
            .instantiate(&mut store, &module)
            .unwrap();
        let spin = instance
            .get_typed_func::<(), ()>(&mut store, "spin")
            .unwrap();

        let started = Instant::now();
        let err = spin.call(&mut store, ()).expect_err("must be interrupted");
        let elapsed = started.elapsed();

        assert_eq!(Stop::of(&err), Stop::Deadline, "{err:?}");
        assert!(
            elapsed >= Duration::from_millis(5),
            "stopped early: {elapsed:?}"
        );
        // Generous: a loaded CI machine can oversleep the ticker.
        assert!(
            elapsed < Duration::from_millis(500),
            "not interrupted: {elapsed:?}"
        );
    }

    #[test]
    fn fuel_still_stops_a_guest_first_when_it_is_the_tighter_bound() {
        let engine = engine().unwrap();
        let module = Module::new(&engine, SPIN).unwrap();
        let mut store = Store::new(&engine, ());
        Budget {
            fuel: 10_000,
            deadline: Duration::from_secs(10),
        }
        .arm(&mut store)
        .unwrap();
        let instance = Linker::new(&engine)
            .instantiate(&mut store, &module)
            .unwrap();
        let err = instance
            .get_typed_func::<(), ()>(&mut store, "spin")
            .unwrap()
            .call(&mut store, ())
            .expect_err("must run out of fuel");
        assert_eq!(Stop::of(&err), Stop::Fuel, "{err:?}");
    }

    #[test]
    fn the_ticker_stops_with_the_engine() {
        let engine = engine().unwrap();
        let weak = engine.weak();
        drop(engine);
        // The ticker's own upgrade is the only other strong reference, and it
        // is released within a tick.
        std::thread::sleep(Duration::from_millis(20));
        assert!(weak.upgrade().is_none());
    }
}
