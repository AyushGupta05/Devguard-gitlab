import { type EnvironmentMap, type LocalSetupPlan, type Risk } from "../contracts.js";

export function buildLocalRunConfigurationRisk(
  plan: LocalSetupPlan,
  environmentMap: EnvironmentMap,
  riskId: string
): Risk | null {
  if (plan.blockers.length === 0) {
    return null;
  }

  return {
    riskId,
    type: "LOCAL_RUN_CONFIGURATION",
    severity: plan.blockers.length > 1 ? "HIGH" : "MEDIUM",
    confidence: Math.max(0.7, plan.confidence),
    title: "Local setup and run configuration is incomplete",
    description: `This repository still has local run blockers that will make onboarding or local verification unreliable: ${plan.blockers.join(" ")}`,
    affectedFiles: environmentMap.changedFiles.length > 0 ? environmentMap.changedFiles : ["README.md"],
    evidence: plan.blockers.map((blocker) => ({
      path: plan.readmePath ?? "README.md",
      excerpt: blocker
    })),
    suggestedFix: "Add or update README setup steps, provide a .env.example template, and make sure install/start commands are discoverable."
  };
}
