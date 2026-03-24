import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { diagnose, scan } from "../src/devguard.js";

const FIXTURE = "fixtures/billing-service";
const RUNTIME_MISMATCH_DIFF = readFileSync(`${FIXTURE}/scenarios/runtime-mismatch-mr.patch`, "utf8");
const RUNTIME_MISMATCH_LOG = readFileSync(`${FIXTURE}/scenarios/runtime-mismatch-failed-job.log`, "utf8");

describe("DevGuard end-to-end", () => {
  it("predicts runtime mismatch and ghost variable hypotheses before merge", () => {
    const result = scan({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 12,
      changedFiles: ["src/billing.js"],
      mergeRequestDiff: RUNTIME_MISMATCH_DIFF
    });

    expect(result.riskReport.hypotheses.length).toBeGreaterThanOrEqual(2);
    expect(result.riskReport.hypotheses.some((hypothesis) => hypothesis.category === "RUNTIME_MISMATCH")).toBe(true);
    expect(result.riskReport.hypotheses.some((hypothesis) => hypothesis.category === "GHOST_VARIABLE")).toBe(true);
    expect(result.preventionNote).toContain("<!-- DEVGUARD_PREVENTION_REPORT");
    expect(result.preventionNote).toContain("Hypothesis table");
  });

  it("audits the prediction against the failed pipeline and explains the causal chain", () => {
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
    expect(result.causalAnalysis.predictionAudit.some((audit) => audit.status === "CONFIRMED")).toBe(true);
    expect(result.causalAnalysis.rankedExplanations[0].category).toBe("RUNTIME_MISMATCH");
    expect(result.causalAnalysis.causalChain.length).toBeGreaterThanOrEqual(3);
    expect(result.causalAnalysis.beliefUpdate.learned).toContain("updated confidence");
    expect(result.reactiveNote).toContain("Prediction audit");
    expect(result.reactiveNote).toContain("Ranked explanations");
    expect(result.reactiveNote).toContain("What changed in my belief");
    expect(result.fixBundle.labelsToApply).toContain("reproguard:confirmed");
  });

  it("keeps continuity deterministic across reruns", () => {
    const { riskReport } = scan({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 12,
      changedFiles: ["src/billing.js"],
      mergeRequestDiff: RUNTIME_MISMATCH_DIFF
    });

    const first = diagnose({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 12,
      pipelineId: 105,
      failedJobName: "test:unit",
      errorLog: RUNTIME_MISMATCH_LOG,
      changedFiles: ["src/billing.js"],
      priorRiskReport: riskReport
    });
    const second = diagnose({
      rootDir: FIXTURE,
      projectPath: FIXTURE,
      mrIid: 12,
      pipelineId: 105,
      failedJobName: "test:unit",
      errorLog: RUNTIME_MISMATCH_LOG,
      changedFiles: ["src/billing.js"],
      priorRiskReport: riskReport
    });

    expect(first.causalAnalysis.rankedExplanations.map((item) => item.summary)).toEqual(
      second.causalAnalysis.rankedExplanations.map((item) => item.summary)
    );
    expect(first.causalAnalysis.predictionAudit.map((item) => item.status)).toEqual(
      second.causalAnalysis.predictionAudit.map((item) => item.status)
    );
  });

  it("concludes that a later failure was unpredicted when prevention found no hypotheses", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-zero-risk-"));

    try {
      writeFileSync(join(rootDir, ".nvmrc"), "20.11.0\n");
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "safe-app",
        private: true,
        engines: {
          node: ">=20"
        }
      }, null, 2));
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), [
        "image: node:20-alpine",
        "test:",
        "  script:",
        "    - npm ci"
      ].join("\n"));
      writeFileSync(join(rootDir, "package-lock.json"), "{}");
      writeFileSync(join(rootDir, ".env.example"), "API_URL=https://example.com\n");
      writeFileSync(join(rootDir, "index.js"), "console.log('safe');\n");

      const prevention = scan({
        rootDir,
        projectPath: "safe-app",
        mrIid: 99,
        changedFiles: ["index.js"],
        mergeRequestDiff: "+console.log('safe');"
      });
      const diagnosis = diagnose({
        rootDir,
        projectPath: "safe-app",
        mrIid: 99,
        pipelineId: 501,
        failedJobName: "test",
        errorLog: "Error: database is offline",
        changedFiles: ["index.js"],
        priorRiskReport: prevention.riskReport
      });

      expect(prevention.riskReport.hypotheses).toHaveLength(0);
      expect(diagnosis.predictionMatch.status).toBe("UNPREDICTED");
      expect(diagnosis.causalAnalysis.incidentSummary.predictedBeforeFailure).toBe(false);
      expect(diagnosis.reactiveNote).toContain("No prior hypotheses were available to audit against the failure");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
