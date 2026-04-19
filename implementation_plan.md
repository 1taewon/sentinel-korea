# Sentinel Korea Reframe Implementation Plan

## Product Summary
Sentinel Korea is a Korea-first respiratory early warning MVP. The current product scope is fixed to 17 Korean regions, weekly respiratory surveillance, and an explainable region-level composite alert built from three public surveillance sources: KDCA notifiable disease reporting, ILI/SARI surveillance, and wastewater monitoring.

## What Changed
- Reframed the MVP away from global-first expansion language and toward Korea-first respiratory intelligence.
- Treated the global layer as context only: imported-risk watch, regional benchmarking, and external corroboration.
- Repositioned CXR_AWARE as a future corroboration layer using aggregate-only hospital summaries.
- Prioritized detection and explanation over forecasting in the current release.
- Standardized the alert unit as `region_code + epiweek + pathogen`.

## Backend Shape
- Added a reframed scoring module with quality-adjusted scoring, independent-source confidence, and explanation generation.
- Added typed API schemas for alerts, timelines, region summaries, scoring config, and ingestion status.
- Added or aligned these read APIs:
  - `/regions`
  - `/alerts/{region}`
  - `/timeline/{region}`
  - `/ingestion/status`
- Preserved compatibility endpoints for the existing frontend:
  - `/alerts/korea`
  - `/alerts/combined`
  - `/signals/global`
  - `/alerts/korea/rescore`

## Frontend Shape
- Updated the app copy to emphasize Korea-first respiratory intelligence.
- Kept the global globe as a context layer rather than the main product story.
- Reworked the region panel around explanation, timeline replay, signal breakdown, confidence, and data quality.
- Updated the scoring panel to match the new respiratory-focused scoring model.
- Fixed region label and tooltip handling by using stable region codes rather than corrupted source strings.

## Validation Notes
- Backend Python files were syntax-checked and imported successfully.
- Frontend build could not be fully executed because `frontend/node_modules` is missing in this workspace, so `tsc` is not currently available.
