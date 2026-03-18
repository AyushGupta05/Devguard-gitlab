# ReproGuard + ItWorksHere

ReproGuard + ItWorksHere is a GitLab Duo Agent Platform managing project for a two-layer reproducibility demo:

- `ReproGuard` predicts merge request risks before CI runs.
- `ItWorksHere` confirms a predicted failure after a pipeline breaks and proposes the smallest useful fix.

This repository is intentionally focused on the managing-project side of the implementation:

- custom agents
- custom flows
- shared TypeScript logic for local validation and fixture-driven testing
- CI configuration for AI Catalog validation
- demo assets and scripts

## Current Status

The project is being built in feature stages on the `codex/reproguard-itworkshere` branch. The first implementation target is a single polished Node.js golden path:

1. warn on a Node runtime mismatch before merge
2. ignore the warning
3. fail the pipeline on the same mismatch
4. confirm the prediction and propose a fix

## Repository Layout

- `agents/` custom agent definitions for AI Catalog sync
- `flows/` custom flow definitions for AI Catalog sync
- `src/` shared local implementation used for fixtures, tests, and demo support
- `tests/` local validation coverage for contracts and scanners
- `docs/` setup and architecture notes

## Local Development

```bash
npm install
npm test
```

## GitLab Setup

This project is designed to work with the AI Catalog Sync component. The pipeline validates agents and flows on normal commits and can sync them to the AI Catalog on tag pipelines.

Required CI/CD variable for sync:

- `CATALOG_SYNC_TOKEN` with `api` scope

Recommended first pass:

- keep `enable_in_project: 'false'` until final project and group IDs are known
- sync definitions first
- enable flows and agents explicitly in GitLab after validation

## Implementation Notes

- The managing project stays narrow and hackathon-friendly.
- The target demo application is represented by local fixtures first and can later move into a separate GitLab project.
- `AGENTS.md` captures project-wide behavior expectations for future agentic work.
