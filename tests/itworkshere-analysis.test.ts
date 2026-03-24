import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildRiskReport,
  collectEnvironmentMap,
  createCausalAnalysis,
  createFailureContext,
  detectDeterministicSignals,
  matchPrediction,
  summarizeCausalAnalysis
} from "../src/index.js";

describe("itworkshere analysis", () => {
  it("confirms the predicted Node runtime mismatch and audits prior hypotheses", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 10,
      changedFiles: ["src/billing.js"]
    });

    const priorRiskReport = buildRiskReport({
      rootDir: "fixtures/billing-service",
      mergeRequestDiff: readFileSync(
        "fixtures/billing-service/scenarios/runtime-mismatch-mr.patch",
        "utf8"
      ),
      environmentMap,
      signals: detectDeterministicSignals(environmentMap)
    });

    const fullLog = readFileSync(
      "fixtures/billing-service/scenarios/runtime-mismatch-failed-job.log",
      "utf8"
    );

    const failureContext = createFailureContext({
      projectPath: "fixtures/billing-service",
      mrIid: 10,
      pipelineId: 102,
      failedJobName: "test:unit",
      errorLog: fullLog,
      changedFiles: ["src/billing.js"],
      priorRiskReport
    });

    const predictionMatch = matchPrediction(failureContext);
    const causalAnalysis = createCausalAnalysis(failureContext, predictionMatch);

    expect(predictionMatch.status).toBe("CONFIRMED");
    expect(causalAnalysis.predictionAudit.some((audit) => audit.status === "CONFIRMED")).toBe(true);
    expect(causalAnalysis.rankedExplanations[0].predictedBeforeFailure).toBe(true);
    expect(causalAnalysis.incidentSummary.predictedBeforeFailure).toBe(true);
    expect(causalAnalysis.causalChain.length).toBeGreaterThanOrEqual(3);
    expect(summarizeCausalAnalysis(causalAnalysis)).toContain("CONFIRMED");
  });

  it("downgrades confidence when only a partial log is available", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 10,
      changedFiles: ["src/billing.js"]
    });

    const priorRiskReport = buildRiskReport({
      rootDir: "fixtures/billing-service",
      mergeRequestDiff: readFileSync(
        "fixtures/billing-service/scenarios/runtime-mismatch-mr.patch",
        "utf8"
      ),
      environmentMap,
      signals: detectDeterministicSignals(environmentMap)
    });

    const fullFailure = createFailureContext({
      projectPath: "fixtures/billing-service",
      mrIid: 10,
      pipelineId: 102,
      failedJobName: "test:unit",
      errorLog: readFileSync(
        "fixtures/billing-service/scenarios/runtime-mismatch-failed-job.log",
        "utf8"
      ),
      changedFiles: ["src/billing.js"],
      priorRiskReport
    });
    const partialFailure = createFailureContext({
      projectPath: "fixtures/billing-service",
      mrIid: 10,
      pipelineId: 103,
      failedJobName: "test:unit",
      errorLog: "TypeError: invoices.toSorted is not a function",
      changedFiles: ["src/billing.js"],
      priorRiskReport
    });

    const fullAnalysis = createCausalAnalysis(fullFailure, matchPrediction(fullFailure));
    const partialAnalysis = createCausalAnalysis(partialFailure, matchPrediction(partialFailure));

    expect(partialAnalysis.incidentSummary.confidence).toBeLessThan(fullAnalysis.incidentSummary.confidence);
    expect(partialAnalysis.incidentSummary.explanationStatus).toBe("CONFIRMED");
  });

  it("falls back to an unpredicted explanation for unrelated failures", () => {
    const failureContext = createFailureContext({
      projectPath: "fixtures/billing-service",
      mrIid: 10,
      pipelineId: 103,
      failedJobName: "test:unit",
      errorLog: "Error: database is offline",
      changedFiles: ["src/billing.js"],
      priorRiskReport: null
    });

    const predictionMatch = matchPrediction(failureContext);
    const causalAnalysis = createCausalAnalysis(failureContext, predictionMatch);

    expect(predictionMatch.status).toBe("UNPREDICTED");
    expect(causalAnalysis.humanReviewRequired).toBe(true);
    expect(causalAnalysis.rankedExplanations[0].predictedBeforeFailure).toBe(false);
  });
});
