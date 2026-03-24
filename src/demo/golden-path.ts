import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { diagnose, scan } from "../devguard.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const defaultFixtureRoot = join(__dirname, "..", "..", "fixtures", "billing-service");
const runtimeMismatchDiffPath = join(defaultFixtureRoot, "scenarios", "runtime-mismatch-mr.patch");
const runtimeMismatchLogPath = join(defaultFixtureRoot, "scenarios", "runtime-mismatch-failed-job.log");

export type GoldenPathDemoResult = {
  preventionNote: string;
  reactiveNote: string;
  predictionStatus: string;
  rootCause: string;
};

export function buildGoldenPathDemo(fixtureRoot = defaultFixtureRoot): GoldenPathDemoResult {
  const mergeRequestDiff = readFileSync(runtimeMismatchDiffPath, "utf8");
  const errorLog = readFileSync(runtimeMismatchLogPath, "utf8");

  const prevention = scan({
    rootDir: fixtureRoot,
    projectPath: "demo/billing-service",
    mrIid: 12,
    changedFiles: ["src/billing.js"],
    mergeRequestDiff
  });

  const reactive = diagnose({
    rootDir: fixtureRoot,
    projectPath: "demo/billing-service",
    mrIid: 12,
    pipelineId: 105,
    failedJobName: "test:unit",
    errorLog,
    changedFiles: ["src/billing.js"],
    priorRiskReport: prevention.riskReport
  });

  return {
    preventionNote: prevention.preventionNote,
    reactiveNote: reactive.reactiveNote,
    predictionStatus: reactive.predictionMatch.status,
    rootCause: reactive.causalAnalysis.incidentSummary.likelyRootCause
  };
}

export function formatGoldenPathDemo(result: GoldenPathDemoResult) {
  return [
    "# DevGuard Golden Path Demo",
    "",
    `Prediction status: ${result.predictionStatus}`,
    `Root cause: ${result.rootCause}`,
    "",
    "## Prevention output",
    "",
    result.preventionNote,
    "",
    "## Reactive output",
    "",
    result.reactiveNote
  ].join("\n");
}

const invokedPath = process.argv[1];

if (invokedPath && __filename === invokedPath) {
  process.stdout.write(`${formatGoldenPathDemo(buildGoldenPathDemo())}\n`);
}
