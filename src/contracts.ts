import { randomUUID } from "node:crypto";

import { z } from "zod";

export const riskTypes = [
  "RUNTIME_MISMATCH",
  "GHOST_VARIABLE",
  "LOCAL_RUN_CONFIGURATION",
  "TIMEZONE_ASSUMPTION",
  "DOCKER_IMAGE_DRIFT",
  "UNKNOWN"
] as const;

export const matchStatuses = ["CONFIRMED", "PARTIAL", "UNINVESTIGATED"] as const;

export const workflowLabels = {
  warned: "reproguard:warned",
  confirmed: "reproguard:confirmed",
  fixed: "itworkshere:fixed",
  needsReview: "itworkshere:needs-review"
} as const;

const runtimeSchema = z.object({
  source: z.string(),
  value: z.string().nullable()
});

const fileEvidenceSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  excerpt: z.string().optional()
});

const variableReferenceSchema = z.object({
  variable: z.string(),
  path: z.string(),
  line: z.number().int().positive().optional()
});

export const environmentMapSchema = z.object({
  runId: z.string(),
  projectPath: z.string(),
  mrIid: z.number().int().nonnegative(),
  pipelineId: z.number().int().nonnegative().nullable(),
  generatedAt: z.string(),
  rootDir: z.string().optional(),
  localRuntimes: z.object({
    node: runtimeSchema.optional(),
    python: runtimeSchema.optional()
  }),
  ciRuntimes: z.object({
    node: runtimeSchema.optional(),
    python: runtimeSchema.optional()
  }),
  envExampleKeys: z.array(z.string()),
  ciVariableKeys: z.array(z.string()),
  codeVariableReferences: z.array(variableReferenceSchema),
  changedFiles: z.array(z.string()),
  dockerfilePinned: z.boolean(),
  lockfilePresent: z.boolean()
});

export const riskSchema = z.object({
  riskId: z.string(),
  type: z.enum(riskTypes),
  severity: z.enum(["LOW", "MEDIUM", "HIGH"]),
  confidence: z.number().min(0).max(1),
  title: z.string(),
  description: z.string(),
  affectedFiles: z.array(z.string()),
  evidence: z.array(fileEvidenceSchema).default([]),
  suggestedFix: z.string()
});

export const riskReportSchema = z.object({
  runId: z.string(),
  projectPath: z.string(),
  mrIid: z.number().int().nonnegative(),
  generatedAt: z.string(),
  summary: z.string(),
  risks: z.array(riskSchema),
  labelsToApply: z.array(z.string()).default([workflowLabels.warned])
});

export const failureContextSchema = z.object({
  runId: z.string(),
  projectPath: z.string(),
  mrIid: z.number().int().nonnegative(),
  pipelineId: z.number().int().nonnegative(),
  jobId: z.number().int().nonnegative().nullable(),
  failedJobName: z.string(),
  errorLog: z.string(),
  runner: z.object({
    executor: z.string().nullable(),
    os: z.string().nullable(),
    architecture: z.string().nullable()
  }),
  changedFiles: z.array(z.string()),
  priorRiskReport: riskReportSchema.nullable()
});

export const predictionMatchSchema = z.object({
  status: z.enum(matchStatuses),
  confidence: z.number().min(0).max(1),
  matchedRiskId: z.string().nullable(),
  rationale: z.string()
});

export const causalAnalysisSchema = z.object({
  runId: z.string(),
  projectPath: z.string(),
  mrIid: z.number().int().nonnegative(),
  pipelineId: z.number().int().nonnegative(),
  status: z.enum(matchStatuses),
  matchedRiskId: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  rootCause: z.string(),
  evidence: z.array(z.string()),
  fixDirection: z.string(),
  humanReviewRequired: z.boolean()
});

export const fixArtifactSchema = z.object({
  path: z.string(),
  content: z.string(),
  language: z.string()
});

export const fixBundleSchema = z.object({
  runId: z.string(),
  projectPath: z.string(),
  mrIid: z.number().int().nonnegative(),
  pipelineId: z.number().int().nonnegative(),
  summary: z.string(),
  labelsToApply: z.array(z.string()),
  artifacts: z.array(fixArtifactSchema),
  applyCommand: z.string()
});

export const localSetupCommandSchema = z.object({
  id: z.string().optional(),
  command: z.string(),
  purpose: z.enum(["install", "start", "verify", "environment"]),
  source: z.string()
});

export const localEnvironmentVariableSchema = z.object({
  name: z.string(),
  required: z.boolean(),
  source: z.string(),
  hasTemplate: z.boolean()
});

export const localSetupPlanSchema = z.object({
  runId: z.string(),
  projectPath: z.string(),
  readmePath: z.string().nullable(),
  detectedStack: z.enum(["node", "python", "unknown"]),
  runtimeHints: z.array(z.object({
    tool: z.string(),
    value: z.string(),
    source: z.string()
  })),
  installCommands: z.array(localSetupCommandSchema),
  startCommands: z.array(localSetupCommandSchema),
  verificationCommands: z.array(localSetupCommandSchema),
  environmentCommands: z.array(localSetupCommandSchema),
  environmentVariables: z.array(localEnvironmentVariableSchema),
  blockers: z.array(z.string()),
  assumptions: z.array(z.string()),
  confidence: z.number().min(0).max(1)
});

export const repositorySourceSchema = z.object({
  url: z.string(),
  provider: z.enum(["github", "gitlab", "unknown"]),
  owner: z.string(),
  name: z.string(),
  cloneUrl: z.string()
});

export const approvalScopeSchema = z.enum(["clone", "environment", "install", "start", "verify"]);

export const terminalCommandRequestSchema = z.object({
  id: z.string(),
  label: z.string(),
  command: z.string(),
  workdir: z.string(),
  purpose: approvalScopeSchema,
  source: z.string(),
  requiresApproval: z.boolean(),
  approved: z.boolean(),
  status: z.enum(["pending", "approved", "running", "completed", "blocked", "failed"]),
  exitCode: z.number().int().nullable(),
  stdout: z.string().default(""),
  stderr: z.string().default("")
});

export const remoteBootstrapSessionSchema = z.object({
  runId: z.string(),
  source: repositorySourceSchema,
  workspaceRoot: z.string(),
  repositoryRoot: z.string(),
  cloneRequired: z.boolean(),
  localSetupPlan: localSetupPlanSchema.nullable(),
  commandRequests: z.array(terminalCommandRequestSchema),
  blockers: z.array(z.string()),
  guidance: z.array(z.string())
});

export type EnvironmentMap = z.infer<typeof environmentMapSchema>;
export type Risk = z.infer<typeof riskSchema>;
export type RiskReport = z.infer<typeof riskReportSchema>;
export type FailureContext = z.infer<typeof failureContextSchema>;
export type PredictionMatch = z.infer<typeof predictionMatchSchema>;
export type CausalAnalysis = z.infer<typeof causalAnalysisSchema>;
export type FixBundle = z.infer<typeof fixBundleSchema>;
export type LocalSetupPlan = z.infer<typeof localSetupPlanSchema>;
export type RepositorySource = z.infer<typeof repositorySourceSchema>;
export type TerminalCommandRequest = z.infer<typeof terminalCommandRequestSchema>;
export type RemoteBootstrapSession = z.infer<typeof remoteBootstrapSessionSchema>;

export const noteEnvelopeMarkers = {
  riskReportStart: "<!-- reproguard:risk-report:start -->",
  riskReportEnd: "<!-- reproguard:risk-report:end -->",
  causalAnalysisStart: "<!-- itworkshere:causal-analysis:start -->",
  causalAnalysisEnd: "<!-- itworkshere:causal-analysis:end -->"
} as const;

export function createRunId(prefix: string) {
  return `${prefix}-${randomUUID()}`;
}

export function riskReportArtifactPath(mrIid: number) {
  return `artifacts/reproguard/mr-${mrIid}/risk-report.json`;
}

export function fixBundleArtifactPath(mrIid: number, pipelineId: number) {
  return `artifacts/itworkshere/mr-${mrIid}/pipeline-${pipelineId}/fix-bundle.json`;
}

export function embedPayloadInNote(
  payload: RiskReport | CausalAnalysis,
  startMarker: string,
  endMarker: string
) {
  return `${startMarker}\n${JSON.stringify(payload, null, 2)}\n${endMarker}`;
}

export function extractEmbeddedPayload<T>(
  noteBody: string,
  startMarker: string,
  endMarker: string,
  schema: z.ZodSchema<T>
) {
  const startIndex = noteBody.indexOf(startMarker);
  const endIndex = noteBody.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  const json = noteBody
    .slice(startIndex + startMarker.length, endIndex)
    .trim();

  return schema.parse(JSON.parse(json));
}
