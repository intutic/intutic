"""Asserts that a run takes time linear in its input, on any machine.

An absolute bound (under 200 ms on 200 KB) failed a linear matcher on a busy
CI runner and would pass a quadratic one on a fast laptop. So this times the
input at size n and at 4n, the best of three runs each, and asserts the ratio:
about 4 for a linear implementation, 16 for a quadratic one. The smaller time
is floored, so timer noise on a sub-millisecond run cannot fail it, and a 2 s
ceiling still catches anything pathological. CPU time, not wall time: on a
saturated runner a run longer than a scheduler slice is descheduled and a
shorter one is not, which inflated the ratio of a linear matcher to 9 under
load. The twin of linearTime.ts in the TypeScript packages.
"""

from __future__ import annotations

import time
from typing import Callable

#: Above this, 4x the input took more than linear time (linear: 4, quadratic: 16).
LINEAR_TIME_RATIO = 6
#: The time at n is counted as at least this, so noise on a fast run cannot fail
#: it: a saturated machine thrashes the caches a 4n run needs more of. A
#: quadratic matcher is still caught, since at these sizes its time at n is far
#: above it.
LINEAR_TIME_FLOOR_MS = 5
#: No input of these sizes may take this long, however the ratio comes out.
LINEAR_TIME_CEILING_MS = 2000


def assert_linear_time(label: str, run: Callable[[int], object]) -> None:
    """run(scale) runs the input built at scale times the base size (1 or 4)."""

    def best(scale: int) -> float:
        run(scale)
        ms = None
        for _ in range(3):
            t0 = time.process_time()
            run(scale)
            took = (time.process_time() - t0) * 1000
            ms = took if ms is None else min(ms, took)
        return ms

    small = best(1)
    large = best(4)
    why = f"{label}: {small:.1f} ms at n, {large:.1f} ms at 4n"
    assert large < LINEAR_TIME_CEILING_MS, why
    assert large / max(small, LINEAR_TIME_FLOOR_MS) < LINEAR_TIME_RATIO, why
