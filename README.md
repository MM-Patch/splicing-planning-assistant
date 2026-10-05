# Splicing Planning Assistant v15

Generalized, hosting-ready build.

## Run locally on Windows
1. Extract the ZIP.
2. Double-click the top-level Windows launcher.
3. If browser does not open, go to `http://127.0.0.1:8787`.

## What changed in v15
- Removed person/project-specific workflow bubbles from the main navigation.
- Generalized saved workflows: assigned/open work, readiness blockers, upcoming RFS, schedule board, Tuesday update prep, source bridge.
- Renamed Kyle Notes to Reviewer Notes so any tester can use it.
- Added hosting guide and Render deployment config.
- Retained v14 features: simplified schedule board, field service mode, KPI, source bridge, meeting capture, queue/audit, copy/export fallback.

## Live sync
Local work-computer API calls may still be blocked. For real Monday sync, deploy the `SplicingPlanningAssistant` folder to Render/GitHub and set `MONDAY_API_KEY` as an environment variable.

## R20 workflow update
See [HANDOFF.md](HANDOFF.md) for implemented behavior, test commands, manual Tuesday requests, deployment acceptance and explicit remaining limitations.
