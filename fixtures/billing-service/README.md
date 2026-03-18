# Billing Service Fixture

This fixture represents the target application repository for the ReproGuard + ItWorksHere demo.

## Intentional landmines

- `.nvmrc` requires Node `20.11.0`
- `.gitlab-ci.yml` still uses `node:18-alpine`
- `src/cache.js` requires `REDIS_URL`, but `.env.example` does not define it
- `src/timezone.js` formats dates with the local machine timezone instead of UTC

## Golden-path trigger

The merge request patch in `scenarios/runtime-mismatch-mr.patch` introduces `toSorted()`, which works locally on Node 20 and breaks in CI on Node 18.
