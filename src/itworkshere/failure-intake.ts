import {
  failureContextSchema,
  type FailureContext,
  type RiskReport
} from "../contracts.js";

type FailureIntakeOptions = {
  projectPath: string;
  mrIid: number;
  pipelineId: number;
  jobId?: number | null;
  failedJobName: string;
  errorLog: string;
  changedFiles: string[];
  priorRiskReport: RiskReport | null;
  runner?: {
    executor?: string | null;
    os?: string | null;
    architecture?: string | null;
  };
};

export function createFailureContext(options: FailureIntakeOptions): FailureContext {
  return failureContextSchema.parse({
    runId: options.priorRiskReport?.runId ?? `itworkshere-${options.pipelineId}`,
    projectPath: options.projectPath,
    mrIid: options.mrIid,
    pipelineId: options.pipelineId,
    jobId: options.jobId ?? null,
    failedJobName: options.failedJobName,
    errorLog: options.errorLog,
    runner: {
      executor: options.runner?.executor ?? "docker",
      os: options.runner?.os ?? "linux",
      architecture: options.runner?.architecture ?? "amd64"
    },
    changedFiles: options.changedFiles,
    priorRiskReport: options.priorRiskReport
  });
}

export function extractFailureSignature(errorLog: string) {
  const match = errorLog.match(/TypeError: .+/);

  if (match) {
    return match[0];
  }

  const firstMeaningfulLine = errorLog
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstMeaningfulLine ?? "Unknown failure";
}

export function summarizeFailureContext(failureContext: FailureContext) {
  return `${failureContext.failedJobName} failed in pipeline ${failureContext.pipelineId} for MR !${failureContext.mrIid}: ${extractFailureSignature(failureContext.errorLog)}`;
}
