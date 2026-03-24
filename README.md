# DevGuard

DevGuard is a GitLab Duo Agent Platform managing project for a causal reliability agent with three connected modes:

- `Bootstrap` takes a repo URL or local path, builds an approval-gated local setup plan, and identifies missing env vars or services.
- `Prevention` forms pre-merge hypotheses about what is likely to fail in CI.
- `Reactive` audits those earlier hypotheses against the failed pipeline and generates the smallest credible fix bundle.

## Repository Layout

- `agents/` GitLab Duo custom agent definitions
- `flows/` GitLab Duo custom flow definitions
- `src/` shared TypeScript implementation for bootstrap, scanning, reasoning, prediction audit, and response generation
- `tests/` automated coverage for bootstrap, prevention, and reactive paths
- `fixtures/billing-service/` the demo application with the intentional CI and runtime landmines

## What Is Implemented

- approval-gated bootstrap planning from a repo URL or local path
- local runtime, env var, and service dependency detection
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
npm run demo:bootstrap-plan -- fixtures/billing-service billing-service
npm run demo:remote-bootstrap -- fixtures/billing-service .tmp-bootstrap
npm run demo:golden-path
```

Full verification:

```bash
npm run verify:full
```

To try the approval-gated bootstrap UI:

```bash
npm run server
```

Then open [http://localhost:3000](http://localhost:3000).

## Product Behavior

For local setup bootstrap:

1. inspect the repository README and config
2. infer install, env, runtime, and verification steps
3. identify required secrets, config vars, and service dependencies
4. produce an approval-gated command session for local execution

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

1. Start with `npm run demo:bootstrap-plan -- fixtures/billing-service billing-service` to show the missing `REDIS_URL` and the setup blockers.
2. Show `npm run demo:remote-bootstrap -- fixtures/billing-service .tmp-bootstrap` to demonstrate the approval-gated execution session.
3. Show the merge request patch that introduces `toSorted()`.
4. Show the ReproGuard warning with the Node mismatch and missing env var.
5. Ignore the warning and move to the failed pipeline log.
6. Show ItWorksHere confirming the prediction and the generated fix bundle.
7. Run `npm run demo:golden-path` to replay the prevention-plus-reactive story.

## Submission Summary

DevGuard bootstraps local setup, predicts CI reliability failures before merge, then confirms and fixes the same failure after CI breaks.
