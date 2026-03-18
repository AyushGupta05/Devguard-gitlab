import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildPreventionNote,
  buildRiskReport,
  collectEnvironmentMap,
  detectDeterministicSignals,
  formatPreventionComment
} from "../src/index.js";

describe("reproguard reasoning", () => {
  it("turns deterministic signals into a diff-aware risk report", () => {
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

    expect(riskReport.risks).toHaveLength(2);
    expect(riskReport.risks[0].title).toContain("Node 20 API introduced");
    expect(riskReport.risks[1].type).toBe("GHOST_VARIABLE");
  });

  it("formats a clean prevention comment with embedded JSON", () => {
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

    expect(comment).toContain("ReproGuard - Reproducibility Risk Report");
    expect(comment).toContain("node:20-alpine");
    expect(note).toContain("<!-- reproguard:risk-report:start -->");
  });
});
