/**
 * DevGuard — unified developer environment guard.
 *
 * Three entry points:
 *   run()      → Give it a URL. It clones, installs, and tells you exactly what it can't do alone.
 *   scan()     → Prevention. Runs at MR creation. Predicts what will break in CI.
 *   diagnose() → Reaction.   Runs after pipeline failure. Confirms the prediction and generates a fix.
 */
export { run, formatRunReport } from "./itworkshere/runner.js";
export type { RunOptions, RunReport, RunStep, RunStepStatus, RequiredInput } from "./itworkshere/runner.js";
export { detectServiceDependencies } from "./itworkshere/services.js";
export type { ServiceRequirement } from "./itworkshere/services.js";

import { buildLocalSetupPlan } from "./itworkshere/bootstrap.js";
import { createCausalAnalysis, matchPrediction } from "./itworkshere/analysis.js";
import { createFailureContext } from "./itworkshere/failure-intake.js";
import { buildFixBundle, buildReactiveNote } from "./itworkshere/response.js";
import { buildRiskReport, buildPreventionNote } from "./reproguard/reasoning.js";
import { collectEnvironmentMap, detectDeterministicSignals } from "./reproguard/scanners.js";
import {
  type CausalAnalysis,
  type EnvironmentMap,
  type FailureContext,
  type FixBundle,
  type LocalSetupPlan,
  type PredictionMatch,
  type RiskReport
} from "./contracts.js";

// ---------------------------------------------------------------------------
// Scan (prevention phase)
// ---------------------------------------------------------------------------

export type ScanOptions = {
  /** Absolute or relative path to the repository root */
  rootDir: string;
  /** GitLab project path, e.g. "my-group/my-project" */
  projectPath: string;
  /** Merge request internal ID */
  mrIid: number;
  /** Files changed in this MR (relative paths from rootDir) */
  changedFiles: string[];
  /** Raw unified diff of the MR — enables diff-aware risk reasoning */
  mergeRequestDiff?: string;
  /** Optional pipeline ID to associate with this scan */
  pipelineId?: number;
  /** Whether to include a local bootstrap plan in the risk report */
  includeBootstrapPlan?: boolean;
};

export type ScanResult = {
  environmentMap: EnvironmentMap;
  riskReport: RiskReport;
  /** Ready-to-post MR comment with embedded JSON payload */
  preventionNote: string;
  localSetupPlan?: LocalSetupPlan;
};

export function scan(options: ScanOptions): ScanResult {
  const environmentMap = collectEnvironmentMap({
    rootDir: options.rootDir,
    projectPath: options.projectPath,
    mrIid: options.mrIid,
    changedFiles: options.changedFiles,
    pipelineId: options.pipelineId
  });

  const signals = detectDeterministicSignals(environmentMap);

  const localSetupPlan = options.includeBootstrapPlan
    ? buildLocalSetupPlan({ rootDir: options.rootDir, projectPath: options.projectPath })
    : undefined;

  const riskReport = buildRiskReport({
    rootDir: options.rootDir,
    mergeRequestDiff: options.mergeRequestDiff ?? "",
    environmentMap,
    signals,
    localSetupPlan
  });

  const preventionNote = buildPreventionNote(riskReport);

  return { environmentMap, riskReport, preventionNote, localSetupPlan };
}

// ---------------------------------------------------------------------------
// Diagnose (reaction phase)
// ---------------------------------------------------------------------------

export type DiagnoseOptions = {
  rootDir: string;
  projectPath: string;
  mrIid: number;
  pipelineId: number;
  jobId?: number;
  failedJobName: string;
  /** Full text of the failed CI job log */
  errorLog: string;
  changedFiles: string[];
  /** The RiskReport produced by scan() for this MR, if available */
  priorRiskReport: RiskReport | null;
  runner?: {
    executor?: string | null;
    os?: string | null;
    architecture?: string | null;
  };
};

export type DiagnoseResult = {
  failureContext: FailureContext;
  predictionMatch: PredictionMatch;
  causalAnalysis: CausalAnalysis;
  fixBundle: FixBundle;
  /** Ready-to-post MR comment with embedded causal analysis */
  reactiveNote: string;
};

export function diagnose(options: DiagnoseOptions): DiagnoseResult {
  const failureContext = createFailureContext({
    projectPath: options.projectPath,
    mrIid: options.mrIid,
    pipelineId: options.pipelineId,
    jobId: options.jobId,
    failedJobName: options.failedJobName,
    errorLog: options.errorLog,
    changedFiles: options.changedFiles,
    priorRiskReport: options.priorRiskReport,
    runner: options.runner
  });

  const predictionMatch = matchPrediction(failureContext);
  const causalAnalysis = createCausalAnalysis(failureContext, predictionMatch);
  const fixBundle = buildFixBundle({
    rootDir: options.rootDir,
    failureContext,
    predictionMatch,
    causalAnalysis
  });
  const reactiveNote = buildReactiveNote(predictionMatch, causalAnalysis, fixBundle);

  return { failureContext, predictionMatch, causalAnalysis, fixBundle, reactiveNote };
}

// ---------------------------------------------------------------------------
// Bootstrap (local setup planning)
// ---------------------------------------------------------------------------

export type BootstrapOptions = {
  rootDir: string;
  projectPath: string;
};

export { buildLocalSetupPlan as bootstrap };

export const DEVGUARD_VERSION = "1.0.0";
