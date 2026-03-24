import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildPreventionNote,
  buildRiskReport,
  collectEnvironmentMap,
  detectDeterministicSignals,
  formatPreventionComment
} from "../src/index.js";

describe("reproguard reasoning", () => {
  it("turns deterministic signals into structured hypotheses", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 8,
      changedFiles: ["src/billing.js"]
    });

    const mergeRequestDiff = readFileSync(
      "fixtures/billing-service/scenarios/runtime-mismatch-mr.patch",
      "utf8"
    );

    const riskReport = buildRiskReport({
      rootDir: "fixtures/billing-service",
      mergeRequestDiff,
      environmentMap,
      signals: detectDeterministicSignals(environmentMap)
    });

    expect(riskReport.hypotheses).toHaveLength(2);
    expect(riskReport.summary.hypothesisCount).toBe(2);
    expect(riskReport.hypotheses[0].title).toContain("Node 20 API introduced");
    expect(riskReport.hypotheses[0].expectedFailureMode).toContain("TypeError");
    expect(riskReport.hypotheses[1].category).toBe("GHOST_VARIABLE");
  });

  it("formats a prevention note as a predictive reasoning report", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 8,
      changedFiles: ["src/billing.js"]
    });

    const mergeRequestDiff = readFileSync(
      "fixtures/billing-service/scenarios/runtime-mismatch-mr.patch",
      "utf8"
    );

    const riskReport = buildRiskReport({
      rootDir: "fixtures/billing-service",
      mergeRequestDiff,
      environmentMap,
      signals: detectDeterministicSignals(environmentMap)
    });

    const comment = formatPreventionComment(riskReport);
    const note = buildPreventionNote(riskReport);

    expect(comment).toContain("DevGuard Causal Reliability Report");
    expect(comment).toContain("Hypothesis table");
    expect(comment).toContain("Verification hooks");
    expect(note).toContain("<!-- DEVGUARD_PREVENTION_REPORT");
  });

  it("emits a valid zero-hypothesis payload when no risks are present", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-zero-risk-"));

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

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "safe-app",
        mrIid: 11,
        changedFiles: ["index.js"]
      });

      const riskReport = buildRiskReport({
        rootDir,
        mergeRequestDiff: "+console.log('safe');",
        environmentMap,
        signals: detectDeterministicSignals(environmentMap)
      });

      expect(riskReport.hypotheses).toHaveLength(0);
      expect(riskReport.summary.hypothesisCount).toBe(0);
      expect(buildPreventionNote(riskReport)).toContain("No evidence-backed pre-merge hypothesis");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
