/**
 * Tests for the generalized paths introduced to remove hardcoded single-scenario assumptions.
 * These tests validate that the system works beyond the Node 18→20 / REDIS_URL golden path.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildFixBundle,
  buildRiskReport,
  collectEnvironmentMap,
  createCausalAnalysis,
  createFailureContext,
  detectDeterministicSignals,
  extractFailureSignature,
  matchPrediction
} from "../src/index.js";

// ---------------------------------------------------------------------------
// 1. Generalized ghost variable matching — not just REDIS_URL
// ---------------------------------------------------------------------------

describe("generalized ghost variable matching", () => {
  it("confirms ghost variable match for STRIPE_API_KEY in failure log", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-stripe-"));

    try {
      writeFileSync(join(rootDir, ".env.example"), "PORT=3000\n");
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), [
        "image: node:20-alpine",
        "variables: {}",
        "test:",
        "  script: npm test"
      ].join("\n"));
      writeFileSync(join(rootDir, "index.js"), "const key = process.env.STRIPE_API_KEY;\n");

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "stripe-test",
        mrIid: 50,
        changedFiles: ["index.js"]
      });

      const priorRiskReport = buildRiskReport({
        rootDir,
        mergeRequestDiff: "+const key = process.env.STRIPE_API_KEY;",
        environmentMap,
        signals: detectDeterministicSignals(environmentMap)
      });

      // Should detect STRIPE_API_KEY as ghost variable
      const ghostRisk = priorRiskReport.risks.find((r) => r.type === "GHOST_VARIABLE");
      expect(ghostRisk).toBeDefined();
      expect(ghostRisk!.title).toContain("STRIPE_API_KEY");

      // Failure log references STRIPE_API_KEY — should match
      const failureContext = createFailureContext({
        projectPath: "stripe-test",
        mrIid: 50,
        pipelineId: 200,
        failedJobName: "test",
        errorLog: "Error: STRIPE_API_KEY is required but was not provided",
        changedFiles: ["index.js"],
        priorRiskReport
      });

      const predictionMatch = matchPrediction(failureContext);
      const causalAnalysis = createCausalAnalysis(failureContext, predictionMatch);
      const fixBundle = buildFixBundle({ rootDir, failureContext, predictionMatch, causalAnalysis });

      expect(predictionMatch.status).toBe("CONFIRMED");
      expect(causalAnalysis.rootCause).toContain("STRIPE_API_KEY");
      expect(causalAnalysis.humanReviewRequired).toBe(false);
      expect(fixBundle.labelsToApply).toContain("reproguard:confirmed");
      // Fix bundle should include an updated .env.example with STRIPE_API_KEY
      const envArtifact = fixBundle.artifacts.find((a) => a.path === ".env.example");
      expect(envArtifact).toBeDefined();
      expect(envArtifact!.content).toContain("STRIPE_API_KEY=");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Generalized runtime mismatch — any Node version pair
// ---------------------------------------------------------------------------

describe("generalized runtime mismatch analysis", () => {
  it("confirms a Node 16→18 runtime mismatch and builds a targeted fix", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-node16-"));

    try {
      writeFileSync(join(rootDir, ".nvmrc"), "18.19.0\n");
      writeFileSync(join(rootDir, ".env.example"), "PORT=3000\n");
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), [
        "image: node:16-alpine",
        "test:",
        "  script: npm test"
      ].join("\n"));
      writeFileSync(join(rootDir, "app.js"), "console.log('hello');");

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "my-app",
        mrIid: 60,
        changedFiles: ["app.js"]
      });

      const priorRiskReport = buildRiskReport({
        rootDir,
        mergeRequestDiff: "+console.log('hello');",
        environmentMap,
        signals: detectDeterministicSignals(environmentMap)
      });

      const runtimeRisk = priorRiskReport.risks.find((r) => r.type === "RUNTIME_MISMATCH");
      expect(runtimeRisk).toBeDefined();
      expect(runtimeRisk!.title).toContain("18");
      expect(runtimeRisk!.title).toContain("16");

      // Simulate a Node API failure
      const failureContext = createFailureContext({
        projectPath: "my-app",
        mrIid: 60,
        pipelineId: 300,
        failedJobName: "test",
        errorLog: "TypeError: someFeature is not a function\n  at app.js:1",
        changedFiles: ["app.js"],
        priorRiskReport
      });

      const predictionMatch = matchPrediction(failureContext);
      const causalAnalysis = createCausalAnalysis(failureContext, predictionMatch);
      const fixBundle = buildFixBundle({ rootDir, failureContext, predictionMatch, causalAnalysis });

      expect(predictionMatch.status).toBe("CONFIRMED");
      // Root cause should reference Node 16 (the CI version)
      expect(causalAnalysis.rootCause).toContain("16");
      // Fix direction should target Node 18 (the local version)
      expect(causalAnalysis.fixDirection).toContain("18");
      // CI yml artifact should update to node:18-alpine
      const ciArtifact = fixBundle.artifacts.find((a) => a.path === ".gitlab-ci.yml");
      expect(ciArtifact).toBeDefined();
      expect(ciArtifact!.content).toContain("node:18-alpine");
      expect(ciArtifact!.content).not.toContain("node:16-alpine");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Broadened env var detection — bracket notation and import.meta.env
// ---------------------------------------------------------------------------

describe("broadened env var detection", () => {
  it("detects bracket notation process.env['VAR_NAME']", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-bracket-"));

    try {
      writeFileSync(join(rootDir, ".env.example"), "PORT=3000\n");
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), "image: node:20-alpine\ntest:\n  script: npm test\n");
      writeFileSync(join(rootDir, "config.js"), [
        "// Bracket notation — should still be detected",
        "const secret = process.env['API_SECRET'];",
        "const other = process.env[\"DATABASE_HOST\"];"
      ].join("\n"));

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "bracket-app",
        mrIid: 70,
        changedFiles: ["config.js"]
      });

      const varNames = environmentMap.codeVariableReferences.map((r) => r.variable);
      expect(varNames).toContain("API_SECRET");
      expect(varNames).toContain("DATABASE_HOST");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("detects import.meta.env.VAR_NAME at root level", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-vite2-"));

    try {
      writeFileSync(join(rootDir, ".env.example"), "PORT=3000\n");
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), "image: node:20-alpine\ntest:\n  script: npm test\n");
      writeFileSync(join(rootDir, "api.js"), "export const base = import.meta.env.VITE_API_URL;\n");

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "vite-app",
        mrIid: 71,
        changedFiles: ["api.js"]
      });

      const varNames = environmentMap.codeVariableReferences.map((r) => r.variable);
      expect(varNames).toContain("VITE_API_URL");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Improved failure signature extraction
// ---------------------------------------------------------------------------

describe("improved failure signature extraction", () => {
  it("extracts TypeError signatures", () => {
    const sig = extractFailureSignature("npm test\nTypeError: x.sort is not a function\n  at index.js:10");
    expect(sig).toBe("TypeError: x.sort is not a function");
  });

  it("extracts ReferenceError signatures", () => {
    const sig = extractFailureSignature("ReferenceError: someVar is not defined\n  at app.js:5");
    expect(sig).toBe("ReferenceError: someVar is not defined");
  });

  it("extracts module-not-found errors", () => {
    const sig = extractFailureSignature("Error: Cannot find module 'express'\n  at loader.js:12");
    expect(sig).toBe("Error: Cannot find module 'express'");
  });

  it("extracts ENOENT file errors", () => {
    const sig = extractFailureSignature("Error: ENOENT: no such file or directory, open '.env'");
    expect(sig).toBe("Error: ENOENT: no such file or directory, open '.env'");
  });

  it("prefers TypeError over a generic Error in the same log", () => {
    const sig = extractFailureSignature([
      "Error: something went wrong",
      "TypeError: invoices.toSorted is not a function"
    ].join("\n"));
    expect(sig).toBe("TypeError: invoices.toSorted is not a function");
  });
});

// ---------------------------------------------------------------------------
// 5. Timezone assumption detection in changed files
// ---------------------------------------------------------------------------

describe("timezone assumption detection", () => {
  it("flags Intl.DateTimeFormat without timeZone in a changed file", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-tz-"));

    try {
      writeFileSync(join(rootDir, ".env.example"), "");
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), "image: node:20-alpine\ntest:\n  script: npm test\n");
      writeFileSync(join(rootDir, "format.js"), [
        "export function fmt(d) {",
        "  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(d);",
        "}"
      ].join("\n"));

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "tz-app",
        mrIid: 80,
        changedFiles: ["format.js"]
      });

      const signals = detectDeterministicSignals(environmentMap);
      const tzSignal = signals.find((s) => s.type === "TIMEZONE_ASSUMPTION");
      expect(tzSignal).toBeDefined();
      expect(tzSignal!.affectedFiles).toContain("format.js");
      expect(tzSignal!.suggestedFix).toContain("UTC");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("flags toLocaleString() without timezone in a changed file", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-tz2-"));

    try {
      writeFileSync(join(rootDir, ".env.example"), "");
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), "image: node:20-alpine\ntest:\n  script: npm test\n");
      writeFileSync(join(rootDir, "dates.js"), "const s = new Date().toLocaleString();\n");

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "tz-app2",
        mrIid: 81,
        changedFiles: ["dates.js"]
      });

      const signals = detectDeterministicSignals(environmentMap);
      const tzSignal = signals.find((s) => s.type === "TIMEZONE_ASSUMPTION");
      expect(tzSignal).toBeDefined();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does NOT flag timezone patterns in unchanged files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-tz3-"));

    try {
      writeFileSync(join(rootDir, ".env.example"), "");
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), "image: node:20-alpine\ntest:\n  script: npm test\n");
      writeFileSync(join(rootDir, "format.js"), "const s = new Date().toLocaleString();\n");
      writeFileSync(join(rootDir, "safe.js"), "console.log('no tz issues');\n");

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "tz-app3",
        mrIid: 82,
        changedFiles: ["safe.js"]  // format.js is NOT in changedFiles
      });

      const signals = detectDeterministicSignals(environmentMap);
      const tzSignal = signals.find((s) => s.type === "TIMEZONE_ASSUMPTION");
      expect(tzSignal).toBeUndefined();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
