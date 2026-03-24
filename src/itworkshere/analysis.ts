import {
  causalAnalysisSchema,
  predictionMatchSchema,
  type CausalAnalysis,
  type FailureContext,
  type PredictionMatch,
  type Risk
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

  // Match runtime mismatch: any TypeError/ReferenceError when a runtime gap was predicted
  const runtimeRisk = priorRiskReport.risks.find((risk) => risk.type === "RUNTIME_MISMATCH");
  if (runtimeRisk && isRuntimeFailureSignature(signature)) {
    return predictionMatchSchema.parse({
      status: "CONFIRMED",
      confidence: 0.98,
      matchedRiskId: runtimeRisk.riskId,
      rationale: "The failure signature matches the runtime API mismatch predicted before merge."
    });
  }

  // Match ghost variable: find the specific ghost risk whose variable appears in the error log
  const ghostRisk = findMatchingGhostRisk(priorRiskReport.risks, signature);
  if (ghostRisk) {
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
  const matchedRisk = failureContext.priorRiskReport?.risks.find(
    (r) => r.riskId === predictionMatch.matchedRiskId
  );

  if (predictionMatch.status === "CONFIRMED" && matchedRisk?.type === "RUNTIME_MISMATCH") {
    const { ciVersion, localMajor } = extractVersionsFromRisk(matchedRisk);
    return causalAnalysisSchema.parse({
      runId: failureContext.runId,
      projectPath: failureContext.projectPath,
      mrIid: failureContext.mrIid,
      pipelineId: failureContext.pipelineId,
      status: predictionMatch.status,
      matchedRiskId: predictionMatch.matchedRiskId,
      confidence: 0.98,
      rootCause: `CI is running Node ${ciVersion} while the merge request introduces APIs that require Node ${localMajor}.`,
      evidence: [
        `Failed job log contains: ${signature}`,
        `The stored ReproGuard report warned: ${matchedRisk.title}`,
        ...matchedRisk.evidence.map((e) => `${e.path}: ${e.excerpt}`)
      ],
      fixDirection: `Update .gitlab-ci.yml to node:${localMajor}-alpine to match the local runtime.`,
      humanReviewRequired: false
    });
  }

  if (predictionMatch.status === "CONFIRMED" && matchedRisk?.type === "GHOST_VARIABLE") {
    const varName = extractVarNameFromGhostRisk(matchedRisk);
    return causalAnalysisSchema.parse({
      runId: failureContext.runId,
      projectPath: failureContext.projectPath,
      mrIid: failureContext.mrIid,
      pipelineId: failureContext.pipelineId,
      status: predictionMatch.status,
      matchedRiskId: predictionMatch.matchedRiskId,
      confidence: 0.95,
      rootCause: `The application requires ${varName} at runtime, but the variable is not declared in the example environment or CI.`,
      evidence: [
        `Failed job log references ${varName}`,
        `The stored ReproGuard report warned that ${varName} was undeclared`
      ],
      fixDirection: `Add ${varName} to .env.example and define it in GitLab CI/CD variables.`,
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

function isRuntimeFailureSignature(signature: string): boolean {
  return /TypeError:.+is not a function/i.test(signature) ||
    /TypeError:.+is not a constructor/i.test(signature) ||
    /ReferenceError:.+is not defined/i.test(signature) ||
    /TypeError: Cannot read propert/i.test(signature);
}

function findMatchingGhostRisk(risks: Risk[], signature: string): Risk | undefined {
  return risks.find((risk) => {
    if (risk.type !== "GHOST_VARIABLE") return false;
    const varName = extractVarNameFromGhostRisk(risk);
    if (!varName) return false;
    const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(escaped, "i").test(signature);
  });
}

function extractVarNameFromGhostRisk(risk: Risk): string {
  // Primary: use evidence excerpt which stores the variable name directly
  const excerpt = risk.evidence[0]?.excerpt;
  if (excerpt) return excerpt;
  // Fallback: parse from title "Undeclared environment variable: VAR_NAME"
  const match = risk.title.match(/Undeclared environment variable:\s*(.+)/);
  return match?.[1]?.trim() ?? "";
}

function extractVersionsFromRisk(risk: Risk): { ciVersion: string; localMajor: string } {
  // Risk title format: "Node runtime mismatch: local 20.11.0 vs CI 18-alpine"
  const titleMatch = risk.title.match(/local ([\d.]+) vs CI (.+)/);
  const localFull = titleMatch?.[1] ?? risk.evidence[0]?.excerpt ?? "20";
  const ciTag = titleMatch?.[2] ?? risk.evidence[1]?.excerpt ?? "18-alpine";

  const localMajor = localFull.match(/^(\d+)/)?.[1] ?? localFull;
  // Extract numeric major from CI tag like "18-alpine" → "18"
  const ciVersion = ciTag.match(/^(\d+)/)?.[1] ?? ciTag;

  return { ciVersion, localMajor };
}
