import { readFileSync } from "node:fs";

import { createCausalAnalysis, matchPrediction } from "../itworkshere/analysis.js";
import { createFailureContext } from "../itworkshere/failure-intake.js";
import { buildFixBundle } from "../itworkshere/response.js";
import { buildRiskReport } from "../reproguard/reasoning.js";
import { collectEnvironmentMap, detectDeterministicSignals } from "../reproguard/scanners.js";

export type DemoStage = {
  key: string;
  title: string;
  detail: string;
  status: "completed";
};

export type DemoRun = {
  projectPath: string;
  mrIid: number;
  pipelineId: number;
  timeline: DemoStage[];
  riskReport: ReturnType<typeof buildRiskReport>;
  failureContext: ReturnType<typeof createFailureContext>;
  predictionMatch: ReturnType<typeof matchPrediction>;
  causalAnalysis: ReturnType<typeof createCausalAnalysis>;
  fixBundle: ReturnType<typeof buildFixBundle>;
};

export function buildGoldenPathDemoRun(): DemoRun {
  const rootDir = "fixtures/billing-service";
  const projectPath = "fixtures/billing-service";
  const mrIid = 12;
  const pipelineId = 105;
  const changedFiles = ["src/billing.js"];
  const mergeRequestDiff = readFileSync(
    "fixtures/billing-service/scenarios/runtime-mismatch-mr.patch",
    "utf8"
  );
  const errorLog = readFileSync(
    "fixtures/billing-service/scenarios/runtime-mismatch-failed-job.log",
    "utf8"
  );

  const environmentMap = collectEnvironmentMap({
    rootDir,
    projectPath,
    mrIid,
    changedFiles
  });
  const signals = detectDeterministicSignals(environmentMap);
  const riskReport = buildRiskReport({
    rootDir,
    mergeRequestDiff,
    environmentMap,
    signals
  });
  const failureContext = createFailureContext({
    projectPath,
    mrIid,
    pipelineId,
    failedJobName: "test:unit",
    errorLog,
    changedFiles,
    priorRiskReport: riskReport
  });
  const predictionMatch = matchPrediction(failureContext);
  const causalAnalysis = createCausalAnalysis(failureContext, predictionMatch);
  const fixBundle = buildFixBundle({
    rootDir,
    failureContext,
    predictionMatch,
    causalAnalysis
  });

  return {
    projectPath,
    mrIid,
    pipelineId,
    timeline: [
      {
        key: "mr_opened",
        title: "Merge request opened",
        detail: "The change introduces Array.prototype.toSorted() in billing code.",
        status: "completed"
      },
      {
        key: "reproguard_warned",
        title: "ReproGuard warning posted",
        detail: riskReport.summary,
        status: "completed"
      },
      {
        key: "merge_ignored_warning",
        title: "Warning ignored and merged",
        detail: "The risky merge request is merged without updating CI.",
        status: "completed"
      },
      {
        key: "pipeline_failed",
        title: "Pipeline failed",
        detail: "test:unit fails with invoices.toSorted is not a function.",
        status: "completed"
      },
      {
        key: "prediction_confirmed",
        title: "Prediction confirmed",
        detail: predictionMatch.rationale,
        status: "completed"
      },
      {
        key: "fix_generated",
        title: "Fix bundle generated",
        detail: fixBundle.summary,
        status: "completed"
      }
    ],
    riskReport,
    failureContext,
    predictionMatch,
    causalAnalysis,
    fixBundle
  };
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("/src/demo/golden-path.ts")) {
  console.log(JSON.stringify(buildGoldenPathDemoRun(), null, 2));
}
