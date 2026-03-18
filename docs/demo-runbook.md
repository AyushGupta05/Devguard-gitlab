# Demo Runbook

## Golden path

1. Start from the billing-service fixture scenario where CI still uses Node 18.
2. Show the merge request patch that introduces `toSorted()`.
3. Show the ReproGuard warning with the runtime mismatch and ghost variable.
4. Ignore the warning and move to the failed pipeline log.
5. Show ItWorksHere confirming the prediction and the generated fix bundle.
6. Open the dashboard to replay the same sequence visually.

## Reset steps

1. Ensure the fixture still matches `fixtures/billing-service`.
2. Use `fixtures/billing-service/scenarios/runtime-mismatch-mr.patch` as the “bad MR”.
3. Use `fixtures/billing-service/scenarios/runtime-mismatch-fix.patch` as the “good fix”.
4. Run `npm run demo:golden-path` from the managing project to regenerate the story in the terminal.
5. Serve the `public/` directory through GitLab Pages or any static file server for the dashboard.

## Live fallback

- If the dashboard fails, use `npm run demo:golden-path`.
- If fix application is awkward live, show `reproguard-fix.patch` and the reactive note instead of applying the patch.
- If prediction matching fails unexpectedly, fall back to the `UNINVESTIGATED` example and explain that the system degrades to evidence-based triage.

## Timing

- Problem framing: 20 to 30 seconds
- Prediction and warning: 30 to 45 seconds
- Failed pipeline and confirmation: 45 to 60 seconds
- Fix bundle and close: 30 to 45 seconds
- Dashboard recap: 20 to 30 seconds
