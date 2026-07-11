# Sentinel Forecasting & Simulation: methodology validation

Last reviewed: 2026-07-11

## What this feature is

`Epidemic simulation` is a 28-day, intervention-free **scenario simulation**. It is not a calibrated forecast of reported Korean cases. It answers a conditional question: *given the selected natural-history parameters, import seed, and mobility scenario, how does a metapopulation SEIR-D model distribute infections and deaths?*

`Disease forecasting` projects surveillance series over four weeks. It is decision support, not a diagnostic or a causal model. Gemini is constrained to summarize model outputs and draft response options; it is not used to fit, choose, or overwrite any statistical forecast.

## Epidemic simulation

### State update and output semantics

Each of the 17 Korean provinces/metropolitan cities is one population compartment with `S, E, I, R, D`. The parameterization is internally consistent:

- `beta = R0 / infectious_days`
- `sigma = 1 / incubation_days`
- `gamma = 1 / infectious_days`
- daily deaths are `CFR * exits from I`; the remainder enters `R`.

The displayed 28-day totals are calculated from these exact same daily state snapshots:

- **Model cumulative infections** = `N - S`, not laboratory-confirmed case counts.
- **Cumulative deaths** = the model's `D` compartment.
- **28-day death ratio** = `D / model cumulative infections` at day 28. It is intentionally not labelled CFR, because unresolved exposed/infectious people and a simplified death delay censor this ratio.
- **Input CFR** is shown separately and is the model parameter used on exits from `I`.
- Every map frame, curve, table value, and animated edge is sourced from the same 0--28 day simulation run.

There is no `Severity` control. R0 and CFR — epidemiologically distinct quantities — are entered explicitly (auto-filled from a disease preset, editable for a novel pathogen), so a coarse severity label that scaled both would be redundant.

### Spatial mixing

For destination `i` and source `j`, the imported infection-pressure share is row-normalized:

`C(i,j) = OD(j->i) / sum_j OD(j->i)`.

The force of infection is:

`lambda_i = (1-m) * beta_i * I_i/N_i + m * beta_i * sum_j C(i,j) * I_j/N_j`.

`m` is the user-selected interregional mixing share. With **measured OD calibration ON**, each destination's observed inbound OD is blended with a population-distance gravity baseline (observed share `od_blend`≈0.7); a destination with no observed inbound falls back to the gravity baseline. No region is isolated, because real Korean interregional travel is never exactly zero — a sparse OD sample is not evidence that unobserved pairs have zero flow. This is the standard "observed corridors + gravity fill" treatment used when only a partial OD sample is available. With calibration OFF, the same nonzero `m` is applied through the gravity baseline alone. Each animated edge is still labelled by provenance (`observed_od` vs `gravity_estimate`), so a measured corridor is never conflated with a modelled one.

The UI also shows a side-by-side **comparison**: the same scenario run under (A) measured-OD-only with unobserved regions isolated (`C(i,i)=1`) versus (B) the observed-plus-gravity default. Because a sparse sample systematically under-connects the network, (A) tends to under-estimate national spread; (B) is the more realistic default, and both are shown so the modelling choice is transparent rather than hidden.

Severity is no longer an input: transmission (R0) and fatality (CFR) are entered explicitly, so a coarse severity label would only duplicate them.

This is compatible with established metapopulation and mobility-network epidemic modelling, including [Balcan et al., PNAS (2009)](https://pmc.ncbi.nlm.nih.gov/articles/PMC2793313/) and [Chang et al., Nature (2020)](https://www.nature.com/articles/s41586-020-2923-3). It is a deliberately compact decision-support model, not an individual-based mobility simulation.

### Mobility data provenance

The collector creates `multimodal_mobility_by_region.json` and preserves each mode's observation type. A mode contributes in one of two distinct ways, which the model never conflates:

- **Pairwise OD edges** — measured directed origin→destination flows that seed the observed part of `C(i,j)` (blended with the gravity baseline at `od_blend`≈0.7).
- **Connectivity marginals** — per-region activity totals (not pairs) that shape each region's gravity connectivity `conn`. Region connectivity is built as `conn = 0.60·road + 0.25·rail + 0.15·air` from each mode's normalized regional activity, so rail/air adjust *how strongly the gravity fill connects a region* even where no station-pair OD exists.

| Mode | Public source | Role | Treatment in model |
| --- | --- | --- | --- |
| Expressway | Korea Expressway Corporation tollgate OD | OD edge | observed vehicle OD (`stn` traffic), aggregated across sampled peaks |
| SRT | [SR SRT passenger movement type](https://www.data.go.kr/data/15108353/openapi.do) | OD edge | observed route corridor (`ROUTE_NM`/`TKCAR_NMPR_CNT`), e.g. 수서↔부산; symmetric |
| KORAIL | [KORAIL train transport statistics](https://www.data.go.kr/data/15125733/openapi.do) | conn marginal | per-station 승차+하차 (`stn_nm`/`abrd_nope`/`goff_nope`) → regional rail activity |
| Domestic flight | [KAC aircraft operation schedule GW](https://www.data.go.kr/data/15158949/openapi.do) | OD edge (proxy) | scheduled-flight count × representative seats; capacity proxy, down-weighted |
| Airport passengers | [KAC 전국공항 수송실적통계](https://www.data.go.kr/data/3034194/openapi.do) | conn marginal | monthly per-airport 도착+출발 여객 (`Airport`/`subpassenger`) → regional air activity |

**Live status (verified against data.go.kr, 2026-07).** Expressway OD (45 corridors) and SRT (4 route corridors, e.g. 수서↔부산) are reflected as observed edges; KORAIL boardings/alightings (311 rows → 16 regions) and airport passengers (13 airports) are reflected as the rail and air connectivity marginals. The air marginal replaced the discontinued daily expected-passenger API with real monthly transport statistics (`airport-transport-stats`, verified 제주 4.46M/month, 김포 2.95M). This is what corrects 제주: an island with no expressway OD, it now takes a data-backed air connectivity (highest of all regions) instead of a flat fallback. The domestic-flight schedule remains a down-weighted capacity proxy for air OD edges and scans a small date window (today ± a few days) to survive same-day emptiness.

Every simulation response carries a runtime-derived `data_sources` block (surfaced in the UI's "데이터 출처 · 반영 방식" panel) reporting, per mode, whether it was collected and actually reflected — so an unavailable mode reads as "미반영" rather than silently appearing as coverage. Intercity/express buses are not added separately because their road movement is already represented in highway traffic. The public-data service key must be registered for each dataset and supplied to Railway as `MOBILITY_API_KEY`; the `data.ex.co.kr` `HIGHWAY_API_KEY` is not used as a substitute.
### Aviation and weather

- Aviation uses Incheon arriving-passenger signals to scale the **initial import seed**, not domestic transmission.
- Weather is a short-horizon transmission sensitivity modifier. It is not presented as a universal causal effect, and the public example uses the cached forecast deterministically rather than performing a live API call on each click. Evidence for humidity/temperature sensitivity is strongest for influenza and is disease- and context-dependent; see [Shaman & Kohn, PNAS (2009)](https://pubmed.ncbi.nlm.nih.gov/19204283/).

### Required interpretation limits

1. Death timing is simplified. A disease-specific onset-to-death/hospitalization delay distribution should be added before using hospital demand projections.
2. The model is not assimilated to KDCA case, ILI, positivity, admission, or genomic data. Its outputs must remain labelled **scenario simulation**, not a case forecast.
3. Transport flows are regional aggregates. They do not model age, occupation, within-city mixing, interventions, or behavioral response.
4. Before operational use, calibrate or bound R0, import seed, `m`, and CFR using historical Korean outbreaks, then report uncertainty ensembles rather than a single trace.

## Disease and regional forecasting

### Disease series

The transparent EMA + momentum model remains a benchmark. Its band is labelled a heuristic uncertainty band, not a calibrated confidence interval. It now reports rolling-origin one-week MAE on the latest up-to-six holdouts.

The second model is no longer mislabelled SARIMAX when there is no seasonal term. For current 17--34 weekly points, it fits candidate `ARIMA(p,1,q)` models on `log1p(y)`, selects among `(0,1,1), (1,1,0), (1,1,1)` by rolling-origin one-week MAE, and returns a 90% model prediction interval. Annual seasonality is not fitted until at least 104 weekly observations are available. This follows the forecasting principle that models should be evaluated out-of-sample; CDC's forecasting program similarly uses prospective scoring and evaluation rather than in-sample fit alone: [CDC FluSight evaluation](https://www.cdc.gov/flu-forecasting/evaluation/2023-2024-report.html).

### Regional alert-score projection

A regional forecast projects a bounded 0--1 composite alert score, not disease incidence. The ARIMA pathway therefore models `logit(score)` and inverse-transforms the forecast so it cannot leave the 0--1 range. It also uses rolling-origin MAE. If the last eight input scores are essentially unchanged, the UI warns that repeating the last value is not evidence of forecast accuracy.

### Lead--Lag

Lead--Lag now first-differences each signal to reduce shared trend, scans lags only with at least six paired observations, and calculates a circular-shift p-value for the **maximum** correlation across all tested lags. Results are explicitly marked exploratory/non-causal; a non-significant result is not promoted as an operational trigger.

## Statistical aberration detection (Farrington Flexible)

### What this is and why it was added

Before this addition Sentinel collected surveillance signals, produced an AI digest, and rendered maps/reports, but it had **no statistical layer that judged whether this week's reported count is significantly high** relative to history. `Farrington Flexible` (Noufaily et al., *Statistics in Medicine* 2013; 32(7):1206–1222) fills that gap. It is the standard aberration-detection algorithm run weekly by UKHSA and ECDC, and in the 2019 *Bioinformatics* benchmark it outperformed the ML methods tested. The reference implementation is R's `surveillance::farringtonFlexible()`.

To avoid adding an R runtime to the deployment we **reimplemented the method in pure Python** on top of `statsmodels` (`backend/app/farrington.py`). It is exposed through `aberration_router.py` (`/aberration/*`) and injected into the FINAL report as the "통계적 이상징후 탐지" section.

### Data source and scope (what is real)

- Input is `backend/data/processed/kdca_notifiable_timeseries.json`, built by `scripts/fetch_kdca_timeseries.py` from **KDCA EIDAPIService/PeriodRegion** (`data.go.kr/1790387`). Verified live against the API: it returns weekly notifiable counts per disease from **2016 to the current year** (≈3,550 rows/year), giving ~10 years of history per disease — enough for Farrington's multi-year seasonal baseline.
- These are **real** counts. There is **no synthetic data** in the production path (`is_synthetic: false` is carried through the artifact, the API responses, and the report note).
- **National only.** The endpoint's "region" axis is domestic vs. imported (`dmstcVal`/`outnatnVal`), **not the 17 sido provinces**. KDCA does not publish weekly per-sido counts (the historical sido endpoint is annual). Therefore per-region weekly aberration detection is **not possible with real data**, and none is fabricated. The map is deliberately **not** wired to Farrington; results appear in the report only.

### Algorithm and parameter choices

For each evaluation week `t0` the Python implementation reproduces the Noufaily pipeline:

1. **Baseline window** — all weeks within `b = 5` years back of `t0`, excluding the most recent `pastWeeksNotIncluded = 26` weeks so an emerging outbreak does not contaminate its own baseline.
2. **Seasonality** — a `noPeriods = 10`-level factor (Noufaily's recommendation): the `±w = 3` weeks around the anniversary of `t0` form the reference level; the rest of the year is banded by circular distance. This is the "flexible" generalisation of Farrington's original narrow ±3-week window and is what lets the baseline use whole years of data rather than a handful of weeks.
3. **Quasi-Poisson GLM** — `log(μ) = β₀ + β₁·t + seasonal factor`, fit with a Poisson family and an **overdispersion** parameter `φ = max(1, Pearson/df)` estimated from weighted Pearson residuals (quasi-Poisson).
4. **Trend** — kept only if significant (`p < 0.05`) **and** the fitted current-week value does not exceed the maximum observed baseline count (the same extrapolation guard as `surveillance`); otherwise the model is refit without a trend.
5. **Reweighting** — past outbreaks are down-weighted using standardized **Anscombe residuals** with the Noufaily outlier threshold `2.58` (the classic Farrington used 1); weights are renormalised to preserve effective sample size and the GLM is refit once.
6. **Threshold** — a one-sided upper prediction bound at `α = 0.05` via the **2/3-power (Farrington) delta method**: prediction variance `φ·μ₀ + μ₀²·Var(η₀)` is propagated through `y^{2/3}` and back-transformed. `alarm` iff `observed > threshold`.
7. **Exceedance score** = `(observed − expected)/(threshold − expected)`; a value ≥ 1 is exactly an alarm.
8. **`limit54`** — alarms are suppressed unless there were ≥ 5 cases in the last 4 weeks, so tiny counts do not trigger alerts.
9. **Sparse fallback** — for near-zero diseases (SARS, MERS, novel influenza, etc.) a GLM is not identifiable; the code falls back to a plain Poisson(mean) upper quantile and labels the row `sparse_baseline` rather than emitting a spurious fit.

Parameters live in `FarringtonParams` and are all overridable via the API.

### Validation

Because R cannot be run in this environment, validation is against (a) synthetic series with known ground truth and (b) the real KDCA history — as follows.

- **Synthetic unit tests** (`backend/tests/test_farrington.py`, run with `python tests/test_farrington.py`, no pytest required — 7/7 pass):
  - a clear 4× spike on a seasonal baseline **alarms** with exceedance ≥ 1;
  - a flat series does **not** alarm and its empirical false-alarm rate stays ≤ 10% (near the nominal `α`);
  - a **purely seasonal** series does **not** alarm at an ordinary winter peak (the seasonal factor absorbs expected seasonality — the key Farrington property);
  - a large **historical** outbreak is down-weighted (reweighted threshold ≤ non-reweighted);
  - insufficient history is flagged rather than fit.
- **Real-data check** — on the actual KDCA pertussis (백일해) series the algorithm, using only the pre-outbreak 2016–2023 baseline, **alarmed on all 21 weeks of the real 2024 outbreak growth phase** (observed 11 → 2,819 vs expected ≈ 0.1–2.4). This is direct evidence the method fires exactly when a genuine Korean epidemic began.

### Known limitations

1. **Baseline over-adaptation after a multi-year epidemic.** Farrington's baseline is the past 5 years. A sustained epidemic left in that window inflates the expected value and threshold long after it subsides — e.g. after the 2024–2025 pertussis surge, pertussis shows `expected ≈ 2,000` against an observed ~12 in mid-2026. This is an inherent property of the method, not a coding error (R behaves the same). It does **not** cause false alarms (the current low count is correctly below threshold). Such rows are flagged with `†` in the report and `baseline_elevated: true` in the API.
2. **Short recent history for some series.** A few diseases only entered the KDCA notifiable list recently; where `< min_baseline` history exists the week is returned as `insufficient_baseline` rather than guessed.
3. **National granularity only.** As above, no real weekly sido-level series exists, so alarms cannot be localised on the map. This is a data limitation, reported honestly rather than mocked.
4. **Reporting delays / revisions.** The most recent 1–2 KDCA weeks are provisional; `pastWeeksNotIncluded` protects the baseline but the current-week count itself may be revised upward later.

## Release gates for the competition demo

- The precomputed example cache has a schema/data fingerprint. It regenerates automatically when simulator code version or aviation/highway/weather/multimodal input file metadata changes.
- The public H5N1 example uses the same national simulator, daily snapshots, edge generation, parameters, and labels as an interactive run.
- The UI displays model/input definitions separately from reported outcomes, and warns on flat forecasting inputs.
- Build and API smoke tests must pass before deployment.

## Recommended next additions

1. Add a scenario ensemble (e.g., low/central/high parameter quantiles) and display median plus 50/90% bands.
2. Add disease-specific infection-to-hospitalization and infection-to-death delay distributions, then show hospital/ICU demand separately from deaths.
3. Add a data-quality card for every modal source: collection timestamp, observed/proxy label, corridor count, and mode weight.
4. Store rolling forecast predictions and score them prospectively with MAE and weighted interval score (WIS); publish the score by disease and horizon.
5. Require a minimum prospective validation threshold before Gemini-generated recommendations are shown as high confidence.
