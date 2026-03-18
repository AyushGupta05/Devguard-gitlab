import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildRiskReport,
  collectEnvironmentMap,
  createFailureContext,
  detectDeterministicSignals,
  extractFailureSignature,
  summarizeFailureContext
} from "../src/index.js";

describe("itworkshere failure intake", () => {
  it("normalizes a failed pipeline into a failure context", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 9,
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
      mrIid: 9,
      pipelineId: 101,
      failedJobName: "test:unit",
      errorLog: readFileSync(
        "fixtures/billing-service/scenarios/runtime-mismatch-failed-job.log",
        "utf8"
      ),
      changedFiles: ["src/billing.js"],
      priorRiskReport
    });

    expect(failureContext.priorRiskReport?.risks).toHaveLength(2);
    expect(extractFailureSignature(failureContext.errorLog)).toContain("toSorted");
    expect(summarizeFailureContext(failureContext)).toContain("pipeline 101");
  });
});
