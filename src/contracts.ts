import { randomUUID } from "node:crypto";

import { z } from "zod";

export const riskTypes = [
  "RUNTIME_MISMATCH",
  "LOCKFILE_MISMATCH",
  "GHOST_VARIABLE",
  "LOCAL_RUN_CONFIGURATION",
  "TIMEZONE_ASSUMPTION",
  "DOCKER_IMAGE_DRIFT",
  "SECURITY_LEAK",
  "UNKNOWN"
] as const;

export const failureSignalCategories = [...riskTypes] as const;

export const hypothesisEvaluationStatuses = [
  "CONFIRMED",
  "PARTIALLY_CONFIRMED",
  "NOT_SUPPORTED",
  "IRRELEVANT"
] as const;

export const predictionStatuses = [
  "CONFIRMED",
  "PARTIALLY_CONFIRMED",
  "UNPREDICTED"
] as const;

export const workflowLabels = {
  warned: "reproguard:warned",
  confirmed: "reproguard:confirmed",
  fixed: "itworkshere:fixed",
  needsReview: "itworkshere:needs-review"
} as const;

const confidenceSchema = z.number().min(0).max(1);
const severitySchema = z.enum(["LOW", "MEDIUM", "HIGH"]);

const runtimeSchema = z.object({
  source: z.string(),
  value: z.string().nullable()
});

const fileEvidenceSchema = z.object({
  path: z.string(),
  line: z.number().int().positive().optional(),
  excerpt: z.string().optional(),
  source: z.string().optional()
});

const variableReferenceSchema = z.object({
  variable: z.string(),
  path: z.string(),
  line: z.number().int().positive().optional()
});

const reasoningContextSchema = z.object({
  evidenceCount: z.number().int().nonnegative(),
  changedFileOverlap: z.boolean(),
  signalSources: z.array(z.string()).default([])
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
  declaredRuntimeEngines: z.object({
    node: runtimeSchema.optional(),
    python: runtimeSchema.optional()
  }).default({}),
  ciRuntimes: z.object({
    node: runtimeSchema.optional(),
    python: runtimeSchema.optional()
  }),
  packageManager: runtimeSchema.optional(),
  ciInstallCommands: z.array(z.object({
    path: z.string(),
    line: z.number().int().positive(),
    command: z.string()
  })).default([]),
  lockfiles: z.array(z.string()).default([]),
  envExampleKeys: z.array(z.string()),
  ciVariableKeys: z.array(z.string()),
  codeVariableReferences: z.array(variableReferenceSchema),
  changedFiles: z.array(z.string()),
  dockerfilePinned: z.boolean(),
  lockfilePresent: z.boolean()
});

export const hypothesisSchema = z.object({
  hypothesisId: z.string(),
  category: z.enum(riskTypes),
  title: z.string(),
  claim: z.string(),
  severity: severitySchema,
  confidence: confidenceSchema,
  affectedFiles: z.array(z.string()),
  evidence: z.array(fileEvidenceSchema).default([]),
  expectedFailureMode: z.string(),
  confirmatorySignal: z.string(),
  weakeningSignal: z.string(),
  suggestedMitigation: z.string(),
  reasoningContext: reasoningContextSchema.default({
    evidenceCount: 0,
    changedFileOverlap: false,
    signalSources: []
  })
});

export const executiveSummarySchema = z.object({
  hypothesisCount: z.number().int().nonnegative(),
  topConcern: z.string().nullable(),
  ciFailureLikelihood: confidenceSchema,
  reliabilityScore: z.number().int().min(0).max(100),
  summary: z.string()
});

export const preventionReportSchema = z.object({
  reportVersion: z.string(),
  runId: z.string(),
  projectPath: z.string(),
  mergeRequestId: z.number().int().nonnegative(),
  mrIid: z.number().int().nonnegative(),
  pipelineId: z.number().int().nonnegative().nullable().optional(),
  generatedAt: z.string(),
  summary: executiveSummarySchema,
  executiveSummary: z.string(),
  hypotheses: z.array(hypothesisSchema),
  labelsToApply: z.array(z.string()).default([workflowLabels.warned])
});

const legacyRiskSchema = z.object({
  riskId: z.string(),
  type: z.enum(riskTypes),
  severity: severitySchema,
  confidence: confidenceSchema,
  title: z.string(),
  description: z.string(),
  affectedFiles: z.array(z.string()),
  evidence: z.array(fileEvidenceSchema).default([]),
  suggestedFix: z.string()
});

const legacyRiskReportSchema = z.object({
  runId: z.string(),
  projectPath: z.string(),
  mrIid: z.number().int().nonnegative(),
  generatedAt: z.string(),
  summary: z.string(),
  risks: z.array(legacyRiskSchema),
  labelsToApply: z.array(z.string()).default([workflowLabels.warned])
});

export const riskReportSchema = preventionReportSchema;

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
  priorRiskReport: preventionReportSchema.nullable()
});

export const predictionMatchSchema = z.object({
  status: z.enum(predictionStatuses),
  confidence: confidenceSchema,
  matchedHypothesisId: z.string().nullable(),
  rationale: z.string(),
  predictedBeforeFailure: z.boolean()
});

export const failureSignalSchema = z.object({
  signalId: z.string(),
  category: z.enum(failureSignalCategories),
  summary: z.string(),
  source: z.enum(["job_log", "pipeline_summary", "config_correlation"]),
  directEvidence: z.string(),
  line: z.number().int().positive().nullable(),
  confidence: confidenceSchema,
  keywords: z.array(z.string()).default([])
});

export const predictionAuditEntrySchema = z.object({
  hypothesisId: z.string(),
  title: z.string(),
  category: z.enum(riskTypes),
  status: z.enum(hypothesisEvaluationStatuses),
  priorConfidence: confidenceSchema,
  revisedConfidence: confidenceSchema,
  rationale: z.string(),
  matchedSignalIds: z.array(z.string()).default([]),
  observedEvidence: z.array(z.string()).default([])
});

export const rankedExplanationSchema = z.object({
  rank: z.number().int().positive(),
  explanationId: z.string(),
  title: z.string(),
  category: z.enum(failureSignalCategories),
  summary: z.string(),
  confidence: confidenceSchema,
  predictedBeforeFailure: z.boolean(),
  basedOnHypothesisId: z.string().nullable(),
  evidence: z.array(z.string()),
  whyRankedHere: z.string(),
  counterfactual: z.string().optional()
});

export const causalChainStepSchema = z.object({
  step: z.number().int().positive(),
  statement: z.string(),
  evidence: z.string().optional()
});

export const recommendedFixSchema = z.object({
  highConfidenceFix: z.string(),
  possibleNextChecks: z.array(z.string()).default([])
});

export const incidentSummarySchema = z.object({
  likelyRootCause: z.string(),
  confidence: confidenceSchema,
  affectedJob: z.string(),
  predictedBeforeFailure: z.boolean(),
  basedOnHypothesisId: z.string().nullable(),
  explanationStatus: z.enum(predictionStatuses)
});

export const beliefUpdateSchema = z.object({
  predicted: z.string(),
  observed: z.string(),
  validated: z.array(z.string()),
  learned: z.string(),
  confidenceDelta: z.string()
});

export const reactiveReportSchema = z.object({
  reportVersion: z.string(),
  runId: z.string(),
  projectPath: z.string(),
  mergeRequestId: z.number().int().nonnegative(),
  mrIid: z.number().int().nonnegative(),
  pipelineId: z.number().int().nonnegative(),
  generatedAt: z.string(),
  incidentSummary: incidentSummarySchema,
  failureSignals: z.array(failureSignalSchema),
  predictionAudit: z.array(predictionAuditEntrySchema),
  rankedExplanations: z.array(rankedExplanationSchema),
  causalChain: z.array(causalChainStepSchema),
  recommendedFix: recommendedFixSchema,
  beliefUpdate: beliefUpdateSchema,
  labelsToApply: z.array(z.string()).default([]),
  humanReviewRequired: z.boolean()
});

export const causalAnalysisSchema = reactiveReportSchema;

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
  confidence: confidenceSchema
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
export type Hypothesis = z.infer<typeof hypothesisSchema>;
export type PreventionReport = z.infer<typeof preventionReportSchema>;
export type FailureContext = z.infer<typeof failureContextSchema>;
export type PredictionMatch = z.infer<typeof predictionMatchSchema>;
export type FailureSignal = z.infer<typeof failureSignalSchema>;
export type PredictionAuditEntry = z.infer<typeof predictionAuditEntrySchema>;
export type RankedExplanation = z.infer<typeof rankedExplanationSchema>;
export type CausalChainStep = z.infer<typeof causalChainStepSchema>;
export type RecommendedFix = z.infer<typeof recommendedFixSchema>;
export type IncidentSummary = z.infer<typeof incidentSummarySchema>;
export type BeliefUpdate = z.infer<typeof beliefUpdateSchema>;
export type ReactiveReport = z.infer<typeof reactiveReportSchema>;
export type FixBundle = z.infer<typeof fixBundleSchema>;
export type LocalSetupPlan = z.infer<typeof localSetupPlanSchema>;
export type RepositorySource = z.infer<typeof repositorySourceSchema>;
export type TerminalCommandRequest = z.infer<typeof terminalCommandRequestSchema>;
export type RemoteBootstrapSession = z.infer<typeof remoteBootstrapSessionSchema>;

export type Risk = Hypothesis;
export type RiskReport = PreventionReport;
export type CausalAnalysis = ReactiveReport;

export const noteEnvelopeMarkers = {
  preventionReportStart: "<!-- DEVGUARD_PREVENTION_REPORT",
  preventionReportEnd: "DEVGUARD_PREVENTION_REPORT_END -->",
  riskReportStart: "<!-- DEVGUARD_PREVENTION_REPORT",
  riskReportEnd: "DEVGUARD_PREVENTION_REPORT_END -->",
  reactiveReportStart: "<!-- DEVGUARD_REACTIVE_REPORT",
  reactiveReportEnd: "DEVGUARD_REACTIVE_REPORT_END -->",
  causalAnalysisStart: "<!-- DEVGUARD_REACTIVE_REPORT",
  causalAnalysisEnd: "DEVGUARD_REACTIVE_REPORT_END -->",
  legacyRiskReportStart: "<!-- reproguard:risk-report:start -->",
  legacyRiskReportEnd: "<!-- reproguard:risk-report:end -->",
  legacyReactiveReportStart: "<!-- itworkshere:causal-analysis:start -->",
  legacyReactiveReportEnd: "<!-- itworkshere:causal-analysis:end -->"
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
  payload: PreventionReport | ReactiveReport,
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
  const json = extractEmbeddedJson(noteBody, startMarker, endMarker);

  if (!json) {
    return null;
  }

  return schema.parse(JSON.parse(json));
}

export function extractPreventionReportFromNote(noteBody: string) {
  const modern = tryParseEmbeddedPayload(
    noteBody,
    noteEnvelopeMarkers.preventionReportStart,
    noteEnvelopeMarkers.preventionReportEnd,
    preventionReportSchema
  );

  if (modern) {
    return modern;
  }

  const legacy = tryParseEmbeddedPayload(
    noteBody,
    noteEnvelopeMarkers.legacyRiskReportStart,
    noteEnvelopeMarkers.legacyRiskReportEnd,
    legacyRiskReportSchema
  ) ?? tryParseEmbeddedPayload(
    noteBody,
    noteEnvelopeMarkers.preventionReportStart,
    noteEnvelopeMarkers.preventionReportEnd,
    legacyRiskReportSchema
  );

  return legacy ? normalizeLegacyRiskReport(legacy) : null;
}

export function normalizeLegacyRiskReport(
  report: PreventionReport | z.infer<typeof legacyRiskReportSchema>
) {
  if ("hypotheses" in report) {
    return preventionReportSchema.parse(report);
  }

  const hypotheses = report.risks.map((risk) => legacyRiskToHypothesis(risk));
  const ciFailureLikelihood = inferFailureLikelihood(hypotheses.map((hypothesis) => hypothesis.confidence));

  return preventionReportSchema.parse({
    reportVersion: "2",
    runId: report.runId,
    projectPath: report.projectPath,
    mergeRequestId: report.mrIid,
    mrIid: report.mrIid,
    generatedAt: report.generatedAt,
    summary: {
      hypothesisCount: hypotheses.length,
      topConcern: hypotheses[0]?.title ?? null,
      ciFailureLikelihood,
      reliabilityScore: Math.round((1 - ciFailureLikelihood) * 100),
      summary: report.summary
    },
    executiveSummary: report.summary,
    hypotheses,
    labelsToApply: report.labelsToApply
  });
}

function legacyRiskToHypothesis(risk: z.infer<typeof legacyRiskSchema>) {
  const mapping = legacyHypothesisGuidance(risk.type, risk.title);

  return hypothesisSchema.parse({
    hypothesisId: risk.riskId,
    category: risk.type,
    title: risk.title,
    claim: risk.description,
    severity: risk.severity,
    confidence: risk.confidence,
    affectedFiles: risk.affectedFiles,
    evidence: risk.evidence,
    expectedFailureMode: mapping.expectedFailureMode,
    confirmatorySignal: mapping.confirmatorySignal,
    weakeningSignal: mapping.weakeningSignal,
    suggestedMitigation: risk.suggestedFix,
    reasoningContext: {
      evidenceCount: risk.evidence.length,
      changedFileOverlap: risk.affectedFiles.length > 0,
      signalSources: risk.evidence.map((item) => item.path)
    }
  });
}

function legacyHypothesisGuidance(category: typeof riskTypes[number], title: string) {
  switch (category) {
    case "RUNTIME_MISMATCH":
      return {
        expectedFailureMode: "Install, build, or test failure caused by a Node runtime gap between local development and CI.",
        confirmatorySignal: "The failed job log cites an unsupported Node API, engine incompatibility, or a runtime TypeError under the older CI image.",
        weakeningSignal: "The pipeline succeeds under the current CI image or CI is upgraded to the local Node major."
      };
    case "GHOST_VARIABLE":
      return {
        expectedFailureMode: "Runtime failure when the code path reads a variable that is missing from CI or the example environment.",
        confirmatorySignal: "The failed job log mentions the same missing variable or a required-variable startup error.",
        weakeningSignal: "The pipeline succeeds with the current environment configuration or the variable is declared before rerun."
      };
    case "LOCKFILE_MISMATCH":
      return {
        expectedFailureMode: "Dependency installation fails because the lockfile or package manager does not match what CI runs.",
        confirmatorySignal: "The failed job log shows npm, pnpm, or yarn install errors tied to a missing or mismatched lockfile.",
        weakeningSignal: "The pipeline installs dependencies successfully with the committed lockfile and CI package manager."
      };
    case "TIMEZONE_ASSUMPTION":
      return {
        expectedFailureMode: "Test or snapshot failure caused by local timezone assumptions producing different output in CI.",
        confirmatorySignal: "The failed job log shows date, time, snapshot, or locale output diverging across environments.",
        weakeningSignal: "Tests pass consistently under the CI timezone or the code is updated to use an explicit timezone."
      };
    case "DOCKER_IMAGE_DRIFT":
      return {
        expectedFailureMode: "A previously stable pipeline becomes non-reproducible because the base image changed underneath the job.",
        confirmatorySignal: "The failed job log shows a dependency or runtime break that correlates with an unpinned image update.",
        weakeningSignal: "The image is pinned to a version or digest and the failure does not reproduce."
      };
    case "LOCAL_RUN_CONFIGURATION":
      return {
        expectedFailureMode: "Local verification or clean-room reproduction fails because setup instructions or required environment pieces are incomplete.",
        confirmatorySignal: "Bootstrap or local verification surfaces the same missing setup step or configuration gap.",
        weakeningSignal: "A clean setup succeeds with the documented steps and environment template."
      };
    case "SECURITY_LEAK":
      return {
        expectedFailureMode: "CI or deployment breaks after a leaked credential is revoked or blocked.",
        confirmatorySignal: "The failed job log shows authentication errors tied to the exposed credential path.",
        weakeningSignal: "The credential was rotated safely and the pipeline does not show downstream auth failures."
      };
    default:
      return {
        expectedFailureMode: `${title} causes a reproducibility failure in CI or a clean environment.`,
        confirmatorySignal: "Observed failure evidence matches the predicted configuration problem.",
        weakeningSignal: "Observed failure evidence points elsewhere or the pipeline succeeds."
      };
  }
}

function extractEmbeddedJson(noteBody: string, startMarker: string, endMarker: string) {
  const startIndex = noteBody.indexOf(startMarker);
  const endIndex = noteBody.indexOf(endMarker);

  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return null;
  }

  return noteBody
    .slice(startIndex + startMarker.length, endIndex)
    .trim();
}

function tryParseEmbeddedPayload<T>(
  noteBody: string,
  startMarker: string,
  endMarker: string,
  schema: z.ZodSchema<T>
) {
  const json = extractEmbeddedJson(noteBody, startMarker, endMarker);

  if (!json) {
    return null;
  }

  try {
    return schema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

function inferFailureLikelihood(confidences: number[]) {
  if (confidences.length === 0) {
    return 0.12;
  }

  const strongest = Math.max(...confidences);
  return clamp(strongest + Math.min(0.1, (confidences.length - 1) * 0.03));
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}
