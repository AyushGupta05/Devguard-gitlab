# DevGuard – GitLab AI Hackathon Project


This project was developed for the GitLab AI Hackathon. Unfortunately, it was not completed in time for submission due to time constraints.

It has been added to GitHub as part of my portfolio.

**Actual project link:**  
https://gitlab.com/gitlab-ai-hackathon/participants/35383169


DevGuard is a GitLab Duo Agent Platform managing project for a causal reliability agent with three connected modes:

- `Bootstrap` takes a repo URL or local path, builds an approval-gated local setup plan, and identifies missing env vars or services.
- `Prevention` forms pre-merge hypotheses about what is likely to fail in CI.
- `Reactive` audits those earlier hypotheses against the failed pipeline and generates the smallest credible fix bundle.


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

