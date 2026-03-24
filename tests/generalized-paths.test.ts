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

describe("generalized ghost variable matching", () => {
  it("confirms ghost variable match for STRIPE_API_KEY in the failure log", () => {
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

      const ghostHypothesis = priorRiskReport.hypotheses.find((hypothesis) => hypothesis.category === "GHOST_VARIABLE");
      expect(ghostHypothesis?.title).toContain("STRIPE_API_KEY");

      const failureContext = createFailureContext({
        projectPath: "stripe-test",
        mrIid: 50,
        pipelineId: 200,
        failedJobName: "test",
        errorLog: [
          "> stripe-test@1.0.0 test",
          "> node index.js",
          "Error: STRIPE_API_KEY is required but was not provided",
          "    at startServer (index.js:1:7)",
          "    at async main (index.js:5:3)",
          "npm ERR! Test failed due to missing runtime configuration"
        ].join("\n"),
        changedFiles: ["index.js"],
        priorRiskReport
      });

      const predictionMatch = matchPrediction(failureContext);
      const causalAnalysis = createCausalAnalysis(failureContext, predictionMatch);
      const fixBundle = buildFixBundle({ rootDir, failureContext, predictionMatch, causalAnalysis });

      expect(predictionMatch.status).toBe("CONFIRMED");
      expect(causalAnalysis.incidentSummary.likelyRootCause).toContain("STRIPE_API_KEY");
      expect(causalAnalysis.humanReviewRequired).toBe(false);
      expect(fixBundle.labelsToApply).toContain("reproguard:confirmed");
      expect(fixBundle.artifacts.find((artifact) => artifact.path === ".env.example")?.content).toContain("STRIPE_API_KEY=");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("generalized runtime mismatch analysis", () => {
  it("confirms a Node 16 to 18 runtime mismatch and builds a targeted fix", () => {
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

      const runtimeHypothesis = priorRiskReport.hypotheses.find((hypothesis) => hypothesis.category === "RUNTIME_MISMATCH");
      expect(runtimeHypothesis?.title).toContain("18");
      expect(runtimeHypothesis?.title).toContain("16");

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
      expect(causalAnalysis.incidentSummary.likelyRootCause).toContain("CI is running");
      expect(causalAnalysis.recommendedFix.highConfidenceFix).toContain("node");
      expect(fixBundle.artifacts.find((artifact) => artifact.path === ".gitlab-ci.yml")?.content).toContain("node:18-alpine");
      expect(fixBundle.artifacts.find((artifact) => artifact.path === ".gitlab-ci.yml")?.content).not.toContain("node:16-alpine");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("broadened env var detection", () => {
  it("detects bracket notation process.env['VAR_NAME']", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-bracket-"));

    try {
      writeFileSync(join(rootDir, ".env.example"), "PORT=3000\n");
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), "image: node:20-alpine\ntest:\n  script: npm test\n");
      writeFileSync(join(rootDir, "config.js"), [
        "const secret = process.env['API_SECRET'];",
        "const other = process.env[\"DATABASE_HOST\"];"
      ].join("\n"));

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "bracket-app",
        mrIid: 70,
        changedFiles: ["config.js"]
      });

      const variableNames = environmentMap.codeVariableReferences.map((reference) => reference.variable);
      expect(variableNames).toContain("API_SECRET");
      expect(variableNames).toContain("DATABASE_HOST");
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

      expect(environmentMap.codeVariableReferences.map((reference) => reference.variable)).toContain("VITE_API_URL");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("improved failure signature extraction", () => {
  it("extracts the most relevant signatures", () => {
    expect(extractFailureSignature("npm test\nTypeError: x.sort is not a function\n  at index.js:10"))
      .toContain("TypeError");
    expect(extractFailureSignature("ReferenceError: someVar is not defined\n  at app.js:5"))
      .toContain("ReferenceError");
    expect(extractFailureSignature("Error: Cannot find module 'express'\n  at loader.js:12"))
      .toContain("Cannot find module");
    expect(extractFailureSignature("Error: ENOENT: no such file or directory, open '.env'"))
      .toContain("ENOENT");
  });
});

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
      const tzSignal = signals.find((signal) => signal.category === "TIMEZONE_ASSUMPTION");

      expect(tzSignal).toBeDefined();
      expect(tzSignal?.affectedFiles).toContain("format.js");
      expect(tzSignal?.suggestedMitigation).toContain("UTC");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("does not flag timezone patterns in unchanged files", () => {
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
        changedFiles: ["safe.js"]
      });

      const signals = detectDeterministicSignals(environmentMap);
      expect(signals.find((signal) => signal.category === "TIMEZONE_ASSUMPTION")).toBeUndefined();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

describe("ranked explanations preserve alternatives under ambiguity", () => {
  it("keeps multiple plausible explanations and downgrades confidence", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-ambiguous-"));

    try {
      writeFileSync(join(rootDir, ".nvmrc"), "20.11.0\n");
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "ambiguous-app",
        private: true,
        engines: {
          node: ">=20"
        }
      }, null, 2));
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), [
        "image: node:18-alpine",
        "test:",
        "  script:",
        "    - npm ci"
      ].join("\n"));
      writeFileSync(join(rootDir, "app.js"), "console.log(process.env.API_SECRET);\n");

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "ambiguous-app",
        mrIid: 90,
        changedFiles: ["app.js"]
      });

      const priorRiskReport = buildRiskReport({
        rootDir,
        mergeRequestDiff: "+console.log(process.env.API_SECRET);",
        environmentMap,
        signals: detectDeterministicSignals(environmentMap)
      });

      const failureContext = createFailureContext({
        projectPath: "ambiguous-app",
        mrIid: 90,
        pipelineId: 700,
        failedJobName: "test",
        errorLog: [
          "npm ERR! npm ci can only install packages with an existing package-lock.json",
          "TypeError: invoices.toSorted is not a function"
        ].join("\n"),
        changedFiles: ["app.js"],
        priorRiskReport
      });

      const causalAnalysis = createCausalAnalysis(failureContext, matchPrediction(failureContext));

      expect(causalAnalysis.rankedExplanations.length).toBeGreaterThan(1);
      expect(causalAnalysis.incidentSummary.confidence).toBeLessThan(0.9);
      expect(causalAnalysis.humanReviewRequired).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
