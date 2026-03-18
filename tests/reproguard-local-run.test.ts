import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLocalSetupPlan,
  buildRiskReport,
  collectEnvironmentMap,
  detectDeterministicSignals
} from "../src/index.js";

describe("reproguard local run diagnostics", () => {
  it("adds a local run configuration risk when merge requests leave setup blockers", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-local-run-"));

    try {
      writeFileSync(join(rootDir, "README.md"), "# Broken app\n");
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "broken-app",
        private: true,
        scripts: {
          test: "node --test"
        }
      }, null, 2));
      writeFileSync(join(rootDir, "src.js"), "console.log(process.env.SECRET_KEY);");

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "broken-app",
        mrIid: 14,
        changedFiles: ["package.json"]
      });
      const localSetupPlan = buildLocalSetupPlan({
        rootDir,
        projectPath: "broken-app"
      });

      const riskReport = buildRiskReport({
        rootDir,
        mergeRequestDiff: "diff --git a/package.json b/package.json",
        environmentMap,
        signals: detectDeterministicSignals(environmentMap),
        localSetupPlan
      });

      expect(riskReport.risks.some((risk) => risk.type === "LOCAL_RUN_CONFIGURATION")).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
