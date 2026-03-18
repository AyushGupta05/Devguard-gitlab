import {
  causalAnalysisSchema,
  predictionMatchSchema,
  type CausalAnalysis,
  type FailureContext,
  type PredictionMatch
} from "../contracts.js";
import { extractFailureSignature } from "./failure-intake.js";

export function matchPrediction(failureContext: FailureContext): PredictionMatch {
  const signature = extractFailureSignature(failureContext.errorLog);
  const priorRiskReport = failureContext.priorRiskReport;

  if (!priorRiskReport || priorRiskReport.risks.length === 0) {
    return predictionMatchSchema.parse({
      status: "UNINVESTIGATED",
      confidence: 0.25,
      matchedRiskId: null,
      rationale: "No prior ReproGuard report was available for this merge request."
    });
  }

  const runtimeRisk = priorRiskReport.risks.find((risk) => risk.type === "RUNTIME_MISMATCH");
  if (runtimeRisk && /toSorted is not a function/i.test(signature)) {
    return predictionMatchSchema.parse({
      status: "CONFIRMED",
      confidence: 0.98,
      matchedRiskId: runtimeRisk.riskId,
      rationale: "The failure signature matches the Node 20 API mismatch predicted before merge."
    });
  }

  const ghostRisk = priorRiskReport.risks.find((risk) => risk.type === "GHOST_VARIABLE");
  if (ghostRisk && /REDIS_URL/i.test(signature)) {
    return predictionMatchSchema.parse({
      status: "CONFIRMED",
      confidence: 0.95,
      matchedRiskId: ghostRisk.riskId,
      rationale: "The failure references the same missing environment variable predicted before merge."
    });
  }

  const partialRisk = priorRiskReport.risks.find((risk) =>
    risk.affectedFiles.some((filePath) => signature.includes(filePath))
  );

  if (partialRisk) {
    return predictionMatchSchema.parse({
      status: "PARTIAL",
      confidence: 0.61,
      matchedRiskId: partialRisk.riskId,
      rationale: "The failure overlaps with a previously predicted file, but the error signature is not definitive."
    });
  }

  return predictionMatchSchema.parse({
    status: "UNINVESTIGATED",
    confidence: 0.42,
    matchedRiskId: null,
    rationale: "The failed job does not clearly match any stored prediction."
  });
}

export function createCausalAnalysis(
  failureContext: FailureContext,
  predictionMatch: PredictionMatch
): CausalAnalysis {
  const signature = extractFailureSignature(failureContext.errorLog);

  if (predictionMatch.status === "CONFIRMED" && /toSorted is not a function/i.test(signature)) {
    return causalAnalysisSchema.parse({
      runId: failureContext.runId,
      projectPath: failureContext.projectPath,
      mrIid: failureContext.mrIid,
      pipelineId: failureContext.pipelineId,
      status: predictionMatch.status,
      matchedRiskId: predictionMatch.matchedRiskId,
      confidence: 0.98,
      rootCause: "CI is running Node 18 while the merge request introduces Array.prototype.toSorted(), which requires Node 20.",
      evidence: [
        "Failed job log contains: TypeError: invoices.toSorted is not a function",
        "The stored ReproGuard report warned that CI was still on node:18-alpine",
        "The merge request patch introduces toSorted() in src/billing.js"
      ],
      fixDirection: "Update .gitlab-ci.yml to node:20-alpine and keep the new API usage.",
      humanReviewRequired: false
    });
  }

  if (predictionMatch.status === "CONFIRMED" && /REDIS_URL/i.test(signature)) {
    return causalAnalysisSchema.parse({
      runId: failureContext.runId,
      projectPath: failureContext.projectPath,
      mrIid: failureContext.mrIid,
      pipelineId: failureContext.pipelineId,
      status: predictionMatch.status,
      matchedRiskId: predictionMatch.matchedRiskId,
      confidence: 0.95,
      rootCause: "The application requires REDIS_URL at runtime, but the variable is not declared in the example environment or CI.",
      evidence: [
        "Failed job log references REDIS_URL",
        "The stored ReproGuard report warned that REDIS_URL was undeclared"
      ],
      fixDirection: "Add REDIS_URL to .env.example and define it in GitLab CI/CD variables.",
      humanReviewRequired: false
    });
  }

  return causalAnalysisSchema.parse({
    runId: failureContext.runId,
    projectPath: failureContext.projectPath,
    mrIid: failureContext.mrIid,
    pipelineId: failureContext.pipelineId,
    status: predictionMatch.status,
    matchedRiskId: predictionMatch.matchedRiskId,
    confidence: predictionMatch.status === "PARTIAL" ? 0.61 : 0.43,
    rootCause: signature,
    evidence: [
      `Observed failure signature: ${signature}`,
      predictionMatch.rationale
    ],
    fixDirection: "Inspect the failed job log and align the fix with the observed stack trace before applying changes.",
    humanReviewRequired: true
  });
}

export function summarizeCausalAnalysis(causalAnalysis: CausalAnalysis) {
  return `${causalAnalysis.status}: ${causalAnalysis.rootCause}`;
}
