/**
 * End-to-end acceptance tests for DevGuard.
 * These tests exercise the full scan → diagnose pipeline using the billing-service fixture.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { scan, diagnose } from "../src/devguard.js";

const FIXTURE = "fixtures/billing-service";
const RUNTIME_MISMATCH_DIFF = readFileSync(`${FIXTURE}/scenarios/runtime-mismatch-mr.patch`, "utf8");
const RUNTIME_MISMATCH_LOG = readFileSync(`${FIXTURE}/scenarios/runtime-mismatch-failed-job.log`, "utf8");

describe("DevGuard end-to-end", () => {
  it("scan() detects the Node mismatch and ghost variable before merge", () => {
    const result = scan({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 12,
      changedFiles: ["src/billing.js"],
      mergeRequestDiff: RUNTIME_MISMATCH_DIFF
    });

    expect(result.riskReport.risks.length).toBeGreaterThanOrEqual(2);
    expect(result.riskReport.risks.some((r) => r.type === "RUNTIME_MISMATCH")).toBe(true);
    expect(result.riskReport.risks.some((r) => r.type === "GHOST_VARIABLE")).toBe(true);
    expect(result.preventionNote).toContain("<!-- reproguard:risk-report:start -->");
  });

  it("diagnose() confirms the predicted failure and returns a ready-to-apply fix bundle", () => {
    const { riskReport } = scan({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 12,
      changedFiles: ["src/billing.js"],
      mergeRequestDiff: RUNTIME_MISMATCH_DIFF
    });

    const result = diagnose({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 12,
      pipelineId: 105,
      failedJobName: "test:unit",
      errorLog: RUNTIME_MISMATCH_LOG,
      changedFiles: ["src/billing.js"],
      priorRiskReport: riskReport
    });

    expect(result.predictionMatch.status).toBe("CONFIRMED");
    expect(result.causalAnalysis.humanReviewRequired).toBe(false);
    expect(result.fixBundle.applyCommand).toBe("git apply reproguard-fix.patch");
    expect(result.fixBundle.labelsToApply).toContain("reproguard:confirmed");
    expect(result.reactiveNote).toContain("<!-- itworkshere:causal-analysis:start -->");
  });

  it("diagnose() falls back to human-review for unrelated failures", () => {
    const { riskReport } = scan({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 13,
      changedFiles: ["src/billing.js"],
      mergeRequestDiff: RUNTIME_MISMATCH_DIFF
    });

    const result = diagnose({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 13,
      pipelineId: 106,
      failedJobName: "test:unit",
      errorLog: "Error: upstream API timed out",
      changedFiles: ["src/billing.js"],
      priorRiskReport: riskReport
    });

    expect(result.predictionMatch.status).toBe("UNINVESTIGATED");
    expect(result.causalAnalysis.humanReviewRequired).toBe(true);
    expect(result.fixBundle.labelsToApply).toContain("itworkshere:needs-review");
  });

  it("scan() flags timezone assumptions when a changed file uses toLocaleString()", () => {
    const result = scan({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 14,
      changedFiles: ["src/timezone.js"]
    });

    expect(result.riskReport.risks.some((r) => r.type === "TIMEZONE_ASSUMPTION")).toBe(true);
  });

  it("scan() with includeBootstrapPlan surfaces setup blockers in the risk report", () => {
    const result = scan({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 15,
      changedFiles: ["src/billing.js"],
      includeBootstrapPlan: true
    });

    expect(result.localSetupPlan).toBeDefined();
  });
});
