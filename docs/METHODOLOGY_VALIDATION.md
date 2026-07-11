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

`Severity` is now a response-priority label only. It does not silently scale both R0 and CFR; those two epidemiologically distinct quantities are entered explicitly.

### Spatial mixing

For destination `i` and source `j`, the imported infection-pressure share is row-normalized:

`C(i,j) = OD(j->i) / sum_j OD(j->i)`.

The force of infection is:

`lambda_i = (1-m) * beta_i * I_i/N_i + m * beta_i * sum_j C(i,j) * I_j/N_j`.

`m` is the user-selected interregional mixing share. For a destination with observed OD corridors, the model uses those normalized corridors directly. A population-distance gravity kernel is a transparent fallback only for a destination with no observed inbound OD (or when no OD data are available); it is never mixed into observed OD. The map animation shows daily expected imported exposures from this equation, not radial decoration.

This is compatible with established metapopulation and mobility-network epidemic modelling, including [Balcan et al., PNAS (2009)](https://pmc.ncbi.nlm.nih.gov/articles/PMC2793313/) and [Chang et al., Nature (2020)](https://www.nature.com/articles/s41586-020-2923-3). It is a deliberately compact decision-support model, not an individual-based mobility simulation.

### Mobility data provenance

The collector creates `multimodal_mobility_by_region.json` and preserves each mode's observation type.

| Mode | Current public source | Treatment in model |
| --- | --- | --- |
| Expressway | Korea Expressway Corporation tollgate OD | observed traffic OD |
| KORAIL | [KORAIL main-line passenger transport statistics](https://www.data.go.kr/data/15125733/openapi.do?recommendDataYn=Y) | observed passenger OD only when station-pair passenger counts are returned |
| Domestic air | [KAC domestic flight schedule API](https://www.data.go.kr/data/15160195/openapi.do) | current schedule count × configurable representative seats; capacity proxy, not observed passengers |

Domestic-flight schedule-capacity proxies are automatically down-weighted. Intercity/express buses are not added separately because their road movement is already represented in highway traffic. The output retains mode metadata so a reviewer can see whether a corridor includes observed OD or a proxy. Railway may provide the data.go.kr key as `MOBILITY_API_KEY`, `DATA_GO_KR_API_KEY`, `KORAIL_API_KEY`, or the existing `HIGHWAY_API_KEY`; no key is stored in source.

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
