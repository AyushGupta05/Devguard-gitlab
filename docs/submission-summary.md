# Submission Summary

## One-line pitch

ReproGuard + ItWorksHere predicts reproducibility failures before merge, then confirms and fixes the same failure after CI breaks.

## What makes it different

- It does not wait for CI to fail before adding value.
- It stores a prediction and later proves that the prediction was right.
- It uses GitLab Duo agents and flows as the product surface instead of a generic standalone bot.

## Demo narrative

1. A merge request introduces a Node 20-only API.
2. ReproGuard warns that CI still runs Node 18.
3. The warning is ignored and the merge request is merged.
4. The pipeline fails with the exact predicted error.
5. ItWorksHere confirms the warning and proposes a minimal fix bundle.

## GitLab Duo platform usage

- custom agents for prevention and reactive analysis
- custom flows for the merge request and pipeline paths
- AI Catalog-ready agent and flow definitions
- GitLab Pages-ready dashboard for replayable demo output
