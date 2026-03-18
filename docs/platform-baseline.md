# Platform Baseline

## Goal

Turn this repository into a GitLab Duo Agent Platform managing project that can validate and sync custom agents and flows, while also housing local implementation and tests for the reproducibility demo.

## Initial decisions

- GitLab target: GitLab.com 18.9+
- First delivery mode: hackathon demo
- Local implementation language: TypeScript on Node.js 20-compatible runtime
- AI Catalog sync mode: validate on commits, sync on tags
- Enablement mode: disabled in CI by default until final group and project IDs are known

## Required GitLab setup

1. Add `CATALOG_SYNC_TOKEN` with `api` scope to project CI/CD variables.
2. Push normal commits to validate agent and flow definitions.
3. Push a tag when ready to sync the catalog items.
4. Enable the resulting agents and flows in the target project or group through GitLab.

## Major managed assets

- `agents/reproguard-advisor.yml`
- `agents/itworkshere-responder.yml`
- `flows/reproguard-prevention.yml`
- `flows/itworkshere-reactive.yml`
