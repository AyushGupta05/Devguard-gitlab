import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildFixBundle,
  buildGoldenPathDemoRun,
  buildRiskReport,
  collectEnvironmentMap,
  createCausalAnalysis,
  createFailureContext,
  detectDeterministicSignals,
  matchPrediction
} from "../src/index.js";

describe("end-to-end acceptance", () => {
  it("covers the full golden path under three core outputs", () => {
    const demoRun = buildGoldenPathDemoRun();

    expect(demoRun.riskReport.risks.length).toBeGreaterThanOrEqual(1);
    expect(demoRun.predictionMatch.status).toBe("CONFIRMED");
    expect(demoRun.fixBundle.applyCommand).toBe("git apply reproguard-fix.patch");
  });

  it("keeps a human-review fallback for unrelated failures", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 13,
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

    const unrelatedFailure = createFailureContext({
      projectPath: "fixtures/billing-service",
      mrIid: 13,
      pipelineId: 106,
      failedJobName: "test:unit",
      errorLog: "Error: upstream API timed out",
      changedFiles: ["src/billing.js"],
      priorRiskReport
    });

    const predictionMatch = matchPrediction(unrelatedFailure);
    const causalAnalysis = createCausalAnalysis(unrelatedFailure, predictionMatch);
    const fixBundle = buildFixBundle({
      rootDir: "fixtures/billing-service",
      failureContext: unrelatedFailure,
      predictionMatch,
      causalAnalysis
    });

    expect(predictionMatch.status).toBe("UNINVESTIGATED");
    expect(causalAnalysis.humanReviewRequired).toBe(true);
    expect(fixBundle.labelsToApply).toContain("itworkshere:needs-review");
  });
});
