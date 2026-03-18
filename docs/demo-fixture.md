# Demo Fixture

## Purpose

The `fixtures/billing-service` directory is a self-contained stand-in for the separate target repository used in the hackathon demo.

It intentionally contains three reproducibility landmines:

1. local Node.js runtime is pinned to 20 while CI runs Node 18
2. `REDIS_URL` is referenced in code but missing from `.env.example`
3. a timezone-sensitive helper formats dates using the local machine timezone

## Golden-path story

- The merge request introduces `Array.prototype.toSorted()` in billing code.
- ReproGuard should warn that CI still runs Node 18.
- The merge request is merged anyway.
- CI fails with `TypeError: invoices.toSorted is not a function`.
- ItWorksHere confirms the earlier warning and proposes the minimal fix:
  - change CI to Node 20
  - add `REDIS_URL=` to `.env.example`

## Fixture assets

- `scenarios/runtime-mismatch-mr.patch` contains the intended “bad MR” diff.
- `scenarios/runtime-mismatch-fix.patch` contains the intended “good fix” diff.
