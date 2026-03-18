# ReproGuard + ItWorksHere

ReproGuard + ItWorksHere is a GitLab Duo Agent Platform managing project for a two-layer reproducibility demo:

- `ReproGuard` predicts merge request risks before CI runs.
- `ItWorksHere` confirms a predicted pipeline failure and proposes the smallest useful fix bundle.

The current implementation is optimized for one polished Node.js golden path:

1. a merge request introduces `Array.prototype.toSorted()`
2. ReproGuard warns that local Node is 20 while CI still runs Node 18
3. the warning is ignored and the merge request is merged
4. the pipeline fails with `TypeError: invoices.toSorted is not a function`
5. ItWorksHere confirms the prediction and generates a minimal patch, CI fix, env update, and setup script

## Repository Layout

- `agents/` GitLab Duo custom agent definitions
- `flows/` GitLab Duo custom flow definitions
- `src/` shared TypeScript implementation for scanners, reasoning, matching, and response generation
- `tests/` fixture-driven automated coverage for the prevention and reactive paths
- `fixtures/billing-service/` the target demo application with the deliberate reproducibility landmines
- `public/dashboard/` static replay dashboard for GitLab Pages

## What Is Implemented

- AI Catalog-ready custom agents for prevention and reactive analysis
- custom flows for the ReproGuard and ItWorksHere paths
- shared contracts for `EnvironmentMap`, `RiskReport`, `FailureContext`, `CausalAnalysis`, and `FixBundle`
- deterministic prevention scanners for runtime mismatch and ghost environment variables
- diff-aware prevention reasoning and merge request note generation
- failed pipeline intake, prediction matching, causal analysis, and reactive note generation
- minimal fix synthesis for the confirmed Node runtime mismatch case
- a replayable golden-path dashboard and submission/demo assets

## Demo Fixture

The fixture app under `fixtures/billing-service/` intentionally contains three landmines:

- `.nvmrc` pins Node `20.11.0`
- `.gitlab-ci.yml` still uses `node:18-alpine`
- `REDIS_URL` is referenced in code but missing from `.env.example`
- `src/timezone.js` uses local-machine timezone formatting

Golden-path scenario files:

- `fixtures/billing-service/scenarios/runtime-mismatch-mr.patch`
- `fixtures/billing-service/scenarios/runtime-mismatch-fix.patch`
- `fixtures/billing-service/scenarios/runtime-mismatch-failed-job.log`

## Local Development

```bash
npm install
npm run build
npm test
npm run demo:golden-path
```

Full verification:

```bash
npm run verify:full
```

## GitLab Setup

This repository is set up as a managing project for GitLab Duo Agent Platform assets.

Required CI/CD variable:

- `CATALOG_SYNC_TOKEN` with `api` scope

The pipeline:

- validates the project on normal commits
- includes AI Catalog sync wiring
- publishes the static dashboard from `public/` through GitLab Pages on the default branch

## Demo Runbook

1. Show the merge request patch that introduces `toSorted()`.
2. Show the ReproGuard warning with the Node mismatch and missing env var.
3. Ignore the warning and move to the failed pipeline log.
4. Show ItWorksHere confirming the prediction and the generated fix bundle.
5. Open the dashboard or run `npm run demo:golden-path` to replay the full story.

Fallbacks:

- if the dashboard is unavailable, use `npm run demo:golden-path`
- if live patch application is awkward, show `reproguard-fix.patch` and the reactive comment instead
- if a failure does not match a stored prediction, the project falls back to evidence-based human triage

## Submission Summary

One-line pitch:

ReproGuard + ItWorksHere predicts reproducibility failures before merge, then confirms and fixes the same failure after CI breaks.

Why it is different:

- it adds value before CI fails
- it stores a prediction and later proves that the prediction was right
- it uses GitLab Duo custom agents and flows as the product surface, not a generic standalone bot
