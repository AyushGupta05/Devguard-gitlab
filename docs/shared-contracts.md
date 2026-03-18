# Shared Contracts

The local implementation and the GitLab-side comments/artifacts share the same core payloads.

## Primary payloads

- `EnvironmentMap`: normalized repository, runtime, and environment metadata gathered before CI
- `RiskReport`: reproducibility risks predicted from the merge request diff and repository state
- `FailureContext`: failed job evidence, runner details, MR linkage, and prior predictions
- `CausalAnalysis`: classification, evidence, confidence, and root-cause summary for a failure
- `FixBundle`: the smallest useful remediation artifacts for the confirmed or investigated failure

## Persistence

Preferred storage:

- MR-scoped artifact JSON using a stable file path per MR

Fallback storage:

- a machine-readable JSON payload embedded in a merge request note inside HTML comment markers

## Lifecycle labels

- `reproguard:warned`
- `reproguard:confirmed`
- `itworkshere:fixed`
- `itworkshere:needs-review`
