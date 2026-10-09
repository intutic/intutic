//! The limits every WASM rule runs under, and the engine that enforces them.
//!
//! Two bounds apply to every evaluation, native or Rego:
//!
//! - **Fuel** counts guest instructions. It is deterministic: the same module on
//!   the same input always stops at the same point, on any machine. It is the
//!   limit a rule is written against.
//! - **A wall-clock deadline**, enforced by wasmtime's epoch interruption. A
//!   ticker thread advances the engine's epoch every [`TICK`]; a store armed
//!   with a deadline traps the guest at the first epoch check past it, which
//!   wasmtime compiles into every loop header and function entry. It is a
//!   backstop for what fuel cannot see: a bulk `memory.fill` costs one
//!   instruction whatever its length, and a host call costs none.
//!
//! A rule that reaches no verdict refuses the call, so the deadline must never
//! be what stops a rule that is within its fuel on a busy machine. Wall time is
//! not the guest's own: a loaded machine deschedules the evaluating thread. On
//! a 14-core machine with 100 busy threads (about the oversubscription of a
//! 4-vCPU CI runner running every package's tests), an evaluation that takes
//! 0.8 ms idle took up to 260 ms. Each deadline is therefore set well above the
//! time it takes to use up the whole fuel budget on that loaded machine, so
//! fuel stops a runaway rule first, and only a stall fuel cannot see reaches
//! the deadline. (Both numbers were 5 ms and 20 ms, under which the loaded
//! machine refused legitimate calls.)
//!
//! The deadline used to be a `tokio::time::timeout` around the evaluation. An
//! evaluation is synchronous guest code with no await point inside it, so the
//! timer was only consulted after the guest had already returned: it never
//! fired for any rule, and fuel was the only real bound. Epoch interruption
//! stops a running guest, which is what the deadline was always meant to do.
//!
//! Either bound stopping a rule is a [`Failure`]: the rule reached no verdict.
//! The registry refuses the request for it.

use std::time::Duration;
use wasmtime::{Config, Engine, Store, Trap};

/// How often the epoch advances. The deadline's resolution: fine against
/// deadlines of a second or two, and a hundred wake-ups a second rather than a
/// thousand.
const TICK: Duration = Duration::from_millis(10);

/// Guest linear memory cap for every rule: 16 MB (256 pages).
pub const MAX_MEMORY_BYTES: usize = 16 * 1024 * 1024;

/// The fuel and wall-clock time one evaluation may use.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budget {
    pub fuel: u64,
    pub deadline: Duration,
}

/// A native (AssemblyScript) rule: 1,000,000 instructions, and a 1 s backstop.
///
/// Using up the instructions takes 0.5 ms idle and at most 91 ms on the loaded
/// machine described above; the deadline is ten times that.
pub const NATIVE: Budget = Budget {
    fuel: 1_000_000,
    deadline: Duration::from_millis(1_000),
};

/// A Rego rule compiled by OPA: 100,000,000 instructions, and a 2 s backstop.
///
/// Larger than [`NATIVE`] because OPA does in the sandbox what a native rule
/// leaves out: it parses its whole `input` (about 45 instructions a byte) and
/// compiles every regular expression a policy uses, on each evaluation (about
/// 500,000 instructions a pattern, then about 300 a byte matched). The
/// destructive-shell and production-deploy examples use 2,000,000 instructions
/// on a typical call and 21,000,000 on the largest input
/// [`super::opa::policy_input`] builds ([`super::opa::MAX_INPUT_BYTES`], above
/// 99.97% of 82,401 real coding-agent tool calls); the deny-writes and
/// conformance policies 2,900,000. That takes 0.8 ms idle, and up to 260 ms on
/// the loaded machine. The budget is about five times the largest, so a
/// heavier policy still fits.
///
/// Using up the whole budget takes 50 ms idle and at most 590 ms loaded; the
/// deadline is over three times that. `benches/rego_bench.rs` measures the
/// example.
pub const REGO: Budget = Budget {
    fuel: 100_000_000,
    deadline: Duration::from_millis(2_000),
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
        // One increment per wake-up. On a loaded machine this thread oversleeps,
        // so the deadline runs late, never early: catching up to wall time
        // would advance the epoch past a store armed while the ticker lagged,
        // and stop that guest before its time — a refusal caused by load.
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
    /// One tick more than the deadline spans, rounded up, because the tick in
    /// progress when the store is armed is already partly spent: the guest
    /// always gets at least `deadline`, and at most two [`TICK`]s more.
    pub fn arm<T>(&self, store: &mut Store<T>) -> anyhow::Result<()> {
        store.set_fuel(self.fuel)?;
        let ticks = self.deadline.as_micros().div_ceil(TICK.as_micros()) as u64 + 1;
        store.set_epoch_deadline(ticks);
        Ok(())
    }
}

/// Why an evaluation reached no verdict.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    /// The wall-clock deadline interrupted the guest.
    Deadline,
    /// The guest ran out of fuel.
    Fuel,
    /// Anything else that stopped it: a trap, a missing export, a host error.
    Error,
    /// The rule finished, but what it returned is not a verdict: a native
    /// code outside 0–3, or a Rego result in none of the documented shapes.
    Result,
}

impl Stop {
    pub fn of(error: &anyhow::Error) -> Self {
        match error.downcast_ref::<Trap>() {
            Some(Trap::Interrupt) => Self::Deadline,
            Some(Trap::OutOfFuel) => Self::Fuel,
            _ => Self::Error,
        }
    }

    /// The one word a refusal and a log line use for it.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Deadline => "deadline",
            Self::Fuel => "budget",
            Self::Error => "error",
            Self::Result => "result",
        }
    }
}

/// A rule that ran and reached no verdict, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Failure {
    pub stop: Stop,
    /// One line, for the refusal the agent reads and the log the operator
    /// reads: "it ran past its 5 ms deadline".
    pub reason: String,
}

impl Failure {
    /// A rule whose result is not a verdict.
    pub fn result(reason: impl Into<String>) -> Self {
        Self {
            stop: Stop::Result,
            reason: reason.into(),
        }
    }
}

impl Budget {
    /// The failure an evaluation under this budget stopped with.
    pub fn failure(&self, error: &anyhow::Error) -> Failure {
        let stop = Stop::of(error);
        let reason = match stop {
            Stop::Deadline => format!("it ran past its {} ms deadline", self.deadline.as_millis()),
            Stop::Fuel => format!("it used up its budget of {} instructions", self.fuel),
            // The first line only: a trap's display continues with a
            // multi-line wasm backtrace, which belongs in neither a refusal
            // nor a single log line.
            Stop::Error | Stop::Result => format!(
                "it failed while running: {}",
                error.to_string().lines().next().unwrap_or("unknown error")
            ),
        };
        Failure { stop, reason }
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
        // The ticker runs late on a loaded machine, never early; fuel alone
        // would let this run for hours.
        assert!(
            elapsed < Duration::from_secs(5),
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
