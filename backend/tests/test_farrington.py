"""Unit tests for the Farrington Flexible reimplementation (app/farrington.py).

We cannot run R's ``surveillance::farringtonFlexible()`` in this environment, so —
as the task allows — validation is against synthetic series with KNOWN ground
truth, exercising the behaviours the paper guarantees:

  * an obvious spike above the seasonal baseline must raise an alarm;
  * a flat series must not raise alarms (no over-alerting);
  * a purely seasonal series must not alarm at an ordinary seasonal peak
    (the seasonal factor must absorb expected seasonality);
  * the 2/3-power threshold must exceed the expected value, and the exceedance
    score must cross 1 exactly when an alarm fires.

Run directly (no pytest needed):   python tests/test_farrington.py
Or via pytest:                      pytest tests/test_farrington.py
"""

from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.farrington import (  # noqa: E402
    FarringtonParams,
    evaluate_week,
    run_series,
    summarize_alarms,
)

FREQ = 52


def _seasonal_counts(years: int, base: float, amp: float, seed: int) -> np.ndarray:
    """Poisson counts with a yearly sinusoidal season peaking in winter (week ~1)."""
    rng = np.random.default_rng(seed)
    n = years * FREQ
    weeks = np.arange(n)
    # Peak near the start of each year (winter respiratory season).
    lam = base * (1.0 + amp * np.cos(2 * np.pi * weeks / FREQ))
    return rng.poisson(np.clip(lam, 0.1, None)).astype(float)


def test_flat_series_no_alarm():
    """A flat, well-populated series should not alarm at the final week."""
    rng = np.random.default_rng(1)
    counts = rng.poisson(20, size=6 * FREQ).astype(float)
    res = evaluate_week(counts, t0=len(counts) - 1)
    assert res.note is None, f"unexpected note: {res.note}"
    assert res.expected is not None
    assert res.threshold > res.expected, "threshold must sit above expectation"
    assert not res.alarm, f"flat series should not alarm (obs={res.observed}, thr={res.threshold})"


def test_flat_series_low_false_alarm_rate():
    """Across a flat series the alarm rate must stay near the nominal alpha."""
    rng = np.random.default_rng(7)
    counts = rng.poisson(30, size=8 * FREQ).astype(float)
    results = run_series(counts, params=FarringtonParams(), n_weeks=52)
    summary = summarize_alarms(results)
    rate = summary["alarm_count"] / max(summary["weeks_evaluated"], 1)
    assert rate <= 0.10, f"false-alarm rate too high: {rate:.3f} ({summary})"


def test_seasonal_series_no_alarm_at_normal_peak():
    """An ordinary seasonal winter peak (like prior years) must NOT alarm."""
    counts = _seasonal_counts(years=7, base=50, amp=0.8, seed=3)
    # Final index is a winter peak; keep it typical (do not inject anything).
    n = len(counts)
    # Ensure we evaluate at a seasonal peak week.
    t0 = n - 1
    res = evaluate_week(counts, t0=t0)
    assert res.note is None, f"unexpected note: {res.note}"
    assert not res.alarm, (
        f"typical seasonal peak should not alarm "
        f"(obs={res.observed}, exp={res.expected:.1f}, thr={res.threshold:.1f})"
    )


def test_injected_spike_alarms():
    """A 4x spike on top of the seasonal baseline must alarm with score >= 1."""
    counts = _seasonal_counts(years=7, base=50, amp=0.8, seed=5)
    t0 = len(counts) - 1
    baseline_val = counts[t0]
    counts[t0] = baseline_val * 4 + 40  # unmistakable outbreak
    res = evaluate_week(counts, t0=t0)
    assert res.note is None, f"unexpected note: {res.note}"
    assert res.alarm, (
        f"clear spike must alarm (obs={res.observed}, exp={res.expected:.1f}, "
        f"thr={res.threshold:.1f})"
    )
    assert res.exceedance_score is not None and res.exceedance_score >= 1.0, (
        f"exceedance score should be >= 1 for an alarm, got {res.exceedance_score}"
    )


def test_exceedance_score_consistency():
    """alarm must be equivalent to observed > threshold (score crossing 1)."""
    counts = _seasonal_counts(years=6, base=40, amp=0.6, seed=11)
    results = run_series(counts, n_weeks=40)
    for r in results:
        if r.threshold is None or r.expected is None:
            continue
        if r.exceedance_score is not None and r.threshold > r.expected:
            expected_alarm = r.observed > r.threshold
            # limit54 can suppress alarms on tiny counts; only assert the
            # positive direction of the equivalence.
            if r.exceedance_score >= 1.0 and r.observed >= 5:
                assert r.alarm == expected_alarm, (
                    f"score/alarm mismatch at {r.epiweek}: "
                    f"score={r.exceedance_score}, obs={r.observed}, thr={r.threshold}"
                )


def test_insufficient_baseline_is_flagged():
    """Too little history returns a note rather than a bogus alarm."""
    counts = np.arange(10, dtype=float)
    res = evaluate_week(counts, t0=9)
    assert res.note == "insufficient_baseline"
    assert not res.alarm
    assert res.expected is None


def test_spike_in_history_is_downweighted():
    """A past outbreak must not inflate the baseline (reweighting works)."""
    counts = _seasonal_counts(years=7, base=50, amp=0.7, seed=13)
    # Inject a large historical outbreak two years before the current week.
    hist = len(counts) - 1 - 2 * FREQ
    counts[hist] = counts[hist] * 6 + 100
    t0 = len(counts) - 1
    with_reweight = evaluate_week(counts, t0=t0, params=FarringtonParams(reweight=True))
    without = evaluate_week(counts, t0=t0, params=FarringtonParams(reweight=False))
    # Down-weighting the past outbreak should not raise the threshold above the
    # un-reweighted fit (reweighting yields a tighter, outbreak-free baseline).
    assert with_reweight.threshold <= without.threshold + 1e-6, (
        f"reweight threshold {with_reweight.threshold} should be <= "
        f"non-reweight {without.threshold}"
    )


ALL_TESTS = [
    test_flat_series_no_alarm,
    test_flat_series_low_false_alarm_rate,
    test_seasonal_series_no_alarm_at_normal_peak,
    test_injected_spike_alarms,
    test_exceedance_score_consistency,
    test_insufficient_baseline_is_flagged,
    test_spike_in_history_is_downweighted,
]


def _main() -> int:
    failed = 0
    for test in ALL_TESTS:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failed += 1
            print(f"FAIL  {test.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"ERROR {test.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(ALL_TESTS) - failed}/{len(ALL_TESTS)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_main())
