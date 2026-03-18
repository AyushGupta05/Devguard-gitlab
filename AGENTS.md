# ReproGuard + ItWorksHere Agent Guidance

This repository manages GitLab Duo agents and flows for a reproducibility demo.

## Product intent

- Prioritize one golden-path narrative over broad feature coverage.
- Prefer evidence-backed risk detection over speculative warnings.
- Keep fixes minimal and local to the detected failure.

## Implementation rules

- Treat this repository as the managing project, not the target application.
- Keep flow prompts aligned with the local TypeScript contracts in `src/`.
- Prefer structured JSON or Markdown outputs that can be stored in GitLab notes or artifacts.
- Avoid noisy merge request comments. Post only when confidence is meaningful.
- Use labels to show lifecycle state: warned, confirmed, fixed.

## Demo rules

- The first demo path is Node runtime mismatch plus one ghost environment variable.
- If confidence is low, say so clearly instead of overstating certainty.
- Keep comments concise enough to read live during a demo.
