# DevGuard

DevGuard is a GitLab Duo Agent Platform managing project for a causal reliability agent focused on CI, environment, and runtime failures.

- `ReproGuard` forms pre-merge hypotheses about what is likely to fail in CI.
- `ItWorksHere` audits those hypotheses against the failed pipeline and generates the smallest credible fix bundle.

## Repository Layout

- `agents/` GitLab Duo custom agent definitions
- `flows/` GitLab Duo custom flow definitions
- `src/` shared TypeScript implementation for scanning, reasoning, prediction audit, and response generation
- `tests/` automated coverage for the prevention and reactive paths
- `fixtures/billing-service/` the demo application with the intentional CI/runtime landmines

## What Is Implemented

- hypothesis-first prevention analysis
- structured prevention payloads with hidden machine-readable continuity data
- failed pipeline intake and signal extraction
- prediction audit with `CONFIRMED`, `PARTIALLY_CONFIRMED`, `NOT_SUPPORTED`, and `IRRELEVANT`
- ranked causal explanations with confidence calibration
- explicit causal chains and belief updates
- minimal fix synthesis for the confirmed Node runtime mismatch path

## Demo Fixture

The fixture app under `fixtures/billing-service/` intentionally contains these landmines:

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

## Product Behavior

For merge requests:

1. inspect the diff plus repo config
2. emit explicit CI failure hypotheses
3. store those hypotheses in a hidden payload for later audit

For failed pipelines:

1. read the failed job log
2. extract observable failure signals
3. compare them against stored hypotheses
4. rank the most plausible explanations
5. generate the smallest credible fix bundle when confidence is high enough

## Demo Runbook

1. Show the merge request patch that introduces `toSorted()`.
2. Show the ReproGuard warning with the Node mismatch and missing env var.
3. Ignore the warning and move to the failed pipeline log.
4. Show ItWorksHere confirming the prediction and the generated fix bundle.
5. Run `npm run demo:golden-path` to replay the full story.

## Submission Summary

DevGuard predicts CI reliability failures before merge, then confirms and fixes the same failure after CI breaks.
