import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildFixBundle,
  buildReactiveNote,
  buildRiskReport,
  collectEnvironmentMap,
  createCausalAnalysis,
  createFailureContext,
  detectDeterministicSignals,
  formatReactiveComment,
  matchPrediction
} from "../src/index.js";

describe("itworkshere response", () => {
  it("builds the minimal fix bundle for the confirmed runtime mismatch", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 11,
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
      mrIid: 11,
      pipelineId: 104,
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
    const fixBundle = buildFixBundle({
      rootDir: "fixtures/billing-service",
      failureContext,
      predictionMatch,
      causalAnalysis
    });

    expect(fixBundle.labelsToApply).toContain("reproguard:confirmed");
    expect(fixBundle.artifacts.some((artifact) => artifact.path === "reproguard-fix.patch")).toBe(true);
    expect(fixBundle.applyCommand).toBe("git apply reproguard-fix.patch");
  });

  it("formats the final reactive note", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 11,
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
      mrIid: 11,
      pipelineId: 104,
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
    const fixBundle = buildFixBundle({
      rootDir: "fixtures/billing-service",
      failureContext,
      predictionMatch,
      causalAnalysis
    });

    const comment = formatReactiveComment(predictionMatch, causalAnalysis, fixBundle);
    const note = buildReactiveNote(predictionMatch, causalAnalysis, fixBundle);

    expect(comment).toContain("Prediction confirmed");
    expect(comment).toContain("git apply reproguard-fix.patch");
    expect(note).toContain("<!-- itworkshere:causal-analysis:start -->");
  });
});
