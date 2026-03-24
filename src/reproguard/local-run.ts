import { type EnvironmentMap, type Hypothesis, type LocalSetupPlan } from "../contracts.js";

export function buildLocalRunConfigurationRisk(
  plan: LocalSetupPlan,
  environmentMap: EnvironmentMap,
  hypothesisId: string
): Hypothesis | null {
  if (plan.blockers.length === 0) {
    return null;
  }

  return {
    hypothesisId,
    category: "LOCAL_RUN_CONFIGURATION",
    severity: plan.blockers.length > 1 ? "HIGH" : "MEDIUM",
    confidence: Math.max(0.7, plan.confidence),
    title: "Local setup and run configuration is incomplete",
    claim: `This repository still has local run blockers that will make onboarding or local verification unreliable: ${plan.blockers.join(" ")}`,
    affectedFiles: environmentMap.changedFiles.length > 0 ? environmentMap.changedFiles : ["README.md"],
    evidence: plan.blockers.map((blocker) => ({
      path: plan.readmePath ?? "README.md",
      excerpt: blocker,
      source: "payload" as const
    })),
    expectedFailureMode: "Developers cannot reproduce the repository locally or validate the fix path before pushing CI changes.",
    confirmatorySignal: "Fresh setup attempts fail because required steps, variables, or services are not documented.",
    weakeningSignal: "The documented bootstrap path runs successfully from a clean checkout.",
    suggestedMitigation: "Add or update README setup steps, provide a .env.example template, and make sure install/start commands are discoverable.",
    reasoningContext: {
      evidenceCount: plan.blockers.length,
      changedFileOverlap: environmentMap.changedFiles.length > 0,
      signalSources: [plan.readmePath ?? "README.md"]
    }
  };
}
