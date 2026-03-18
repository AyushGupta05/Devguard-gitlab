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
  it("confirms the predicted Node runtime mismatch", () => {
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

    const failureContext = createFailureContext({
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

    const predictionMatch = matchPrediction(failureContext);
    const causalAnalysis = createCausalAnalysis(failureContext, predictionMatch);

    expect(predictionMatch.status).toBe("CONFIRMED");
    expect(causalAnalysis.rootCause).toContain("Node 18");
    expect(summarizeCausalAnalysis(causalAnalysis)).toContain("CONFIRMED");
  });

  it("falls back to uninvestigated for unrelated failures", () => {
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

    expect(predictionMatch.status).toBe("UNINVESTIGATED");
    expect(causalAnalysis.humanReviewRequired).toBe(true);
  });
});
