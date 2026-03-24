import {
  causalAnalysisSchema,
  predictionMatchSchema,
  workflowLabels,
  type CausalAnalysis,
  type FailureContext,
  type FailureSignal,
  type Hypothesis,
  type PredictionAuditEntry,
  type PredictionMatch,
  type RankedExplanation
} from "../contracts.js";
import { extractFailureSignature, extractFailureSignals, logLooksPartial } from "./failure-intake.js";

type ScoredExplanation = RankedExplanation & {
  score: number;
};

type FailureAnalysisState = {
  failureSignals: FailureSignal[];
  predictionAudit: PredictionAuditEntry[];
  rankedExplanations: ScoredExplanation[];
  predictionMatch: PredictionMatch;
  humanReviewRequired: boolean;
};

export function matchPrediction(failureContext: FailureContext): PredictionMatch {
  return analyzeFailure(failureContext).predictionMatch;
}

export function createCausalAnalysis(
  failureContext: FailureContext,
  predictionMatch: PredictionMatch
): CausalAnalysis {
  const analysis = analyzeFailure(failureContext);
  const primaryExplanation = analysis.rankedExplanations[0];
  const matchedAudit = primaryExplanation?.basedOnHypothesisId
    ? analysis.predictionAudit.find((audit) => audit.hypothesisId === primaryExplanation.basedOnHypothesisId)
    : null;

  return causalAnalysisSchema.parse({
    reportVersion: "2.0",
    runId: failureContext.runId,
    projectPath: failureContext.projectPath,
    mergeRequestId: failureContext.mrIid,
    mrIid: failureContext.mrIid,
    pipelineId: failureContext.pipelineId,
    generatedAt: new Date().toISOString(),
    incidentSummary: {
      likelyRootCause: buildIncidentRootCause(failureContext, primaryExplanation),
      confidence: primaryExplanation?.confidence ?? predictionMatch.confidence,
      affectedJob: failureContext.failedJobName,
      predictedBeforeFailure: primaryExplanation?.predictedBeforeFailure ?? predictionMatch.predictedBeforeFailure,
      basedOnHypothesisId: primaryExplanation?.basedOnHypothesisId ?? predictionMatch.matchedHypothesisId,
      explanationStatus: matchedAudit
        ? auditStatusToPredictionStatus(matchedAudit.status)
        : predictionMatch.status
    },
    failureSignals: analysis.failureSignals,
    predictionAudit: analysis.predictionAudit,
    rankedExplanations: analysis.rankedExplanations.map(({ score: _score, ...explanation }) => explanation),
    causalChain: buildCausalChain(failureContext, primaryExplanation, analysis.failureSignals),
    recommendedFix: buildRecommendedFix(failureContext, primaryExplanation, analysis.predictionAudit),
    beliefUpdate: buildBeliefUpdate(primaryExplanation, analysis.predictionAudit),
    labelsToApply: analysis.humanReviewRequired
      ? [workflowLabels.needsReview]
      : [workflowLabels.confirmed],
    humanReviewRequired: analysis.humanReviewRequired
  });
}

export function summarizeCausalAnalysis(causalAnalysis: CausalAnalysis) {
  return `${causalAnalysis.incidentSummary.explanationStatus}: ${causalAnalysis.incidentSummary.likelyRootCause}`;
}

function analyzeFailure(failureContext: FailureContext): FailureAnalysisState {
  const failureSignals = extractFailureSignals(failureContext.errorLog);
  const priorHypotheses = failureContext.priorRiskReport?.hypotheses ?? [];
  const partialLog = logLooksPartial(failureContext.errorLog);
  const strongestSignal = failureSignals.find(isStrongDirectSignal) ?? failureSignals[0];

  const predictionAudit = priorHypotheses.map((hypothesis) =>
    evaluateHypothesis(hypothesis, failureSignals, strongestSignal?.category ?? "UNKNOWN", partialLog)
  );

  const rankedExplanations = rankExplanations(
    failureContext,
    priorHypotheses,
    predictionAudit,
    failureSignals,
    strongestSignal,
    partialLog
  );

  const primaryExplanation = rankedExplanations[0];
  const matchedAudit = primaryExplanation?.basedOnHypothesisId
    ? predictionAudit.find((audit) => audit.hypothesisId === primaryExplanation.basedOnHypothesisId)
    : null;

  const predictionMatch = predictionMatchSchema.parse({
    status: matchedAudit
      ? auditStatusToPredictionStatus(matchedAudit.status)
      : "UNPREDICTED",
    confidence: primaryExplanation?.confidence ?? 0.32,
    matchedHypothesisId: primaryExplanation?.basedOnHypothesisId ?? null,
    rationale: primaryExplanation?.whyRankedHere ?? "No prior hypothesis cleanly matched the observed failure evidence.",
    predictedBeforeFailure: primaryExplanation?.predictedBeforeFailure ?? false
  });

  const strongSignalCategories = new Set(
    failureSignals.filter(isStrongDirectSignal).map((signal) => signal.category)
  );

  const confidence = primaryExplanation?.confidence ?? 0;
  const confirmedHighConfidence = predictionMatch.status === "CONFIRMED" &&
    confidence >= 0.8 &&
    primaryExplanation?.category === "GHOST_VARIABLE";

  return {
    failureSignals,
    predictionAudit,
    rankedExplanations,
    predictionMatch,
    humanReviewRequired: (partialLog && !confirmedHighConfidence) ||
      strongSignalCategories.size > 1 ||
      confidence < 0.72 ||
      predictionMatch.status !== "CONFIRMED"
  };
}

function evaluateHypothesis(
  hypothesis: Hypothesis,
  failureSignals: FailureSignal[],
  strongestCategory: FailureSignal["category"],
  partialLog: boolean
): PredictionAuditEntry {
  const exactSignals = failureSignals.filter((signal) => signalExactlyMatchesHypothesis(signal, hypothesis));
  const relatedSignals = failureSignals.filter((signal) => signalRelatesToHypothesis(signal, hypothesis));

  if (exactSignals.length > 0) {
    return {
      hypothesisId: hypothesis.hypothesisId,
      title: hypothesis.title,
      category: hypothesis.category,
      status: "CONFIRMED",
      priorConfidence: hypothesis.confidence,
      revisedConfidence: clamp(Math.max(hypothesis.confidence, averageConfidence(exactSignals))),
      rationale: `Observed failure evidence directly matches the predicted ${hypothesis.category.toLowerCase().replace(/_/g, " ")} hypothesis.`,
      matchedSignalIds: exactSignals.map((signal) => signal.signalId),
      observedEvidence: exactSignals.map((signal) => signal.directEvidence)
    };
  }

  if (relatedSignals.length > 0) {
    return {
      hypothesisId: hypothesis.hypothesisId,
      title: hypothesis.title,
      category: hypothesis.category,
      status: "PARTIALLY_CONFIRMED",
      priorConfidence: hypothesis.confidence,
      revisedConfidence: clamp(Math.max(0.42, hypothesis.confidence - (partialLog ? 0.18 : 0.1))),
      rationale: "Observed evidence overlaps with the predicted failure category, but the job log does not confirm the exact predicted mechanism.",
      matchedSignalIds: relatedSignals.map((signal) => signal.signalId),
      observedEvidence: relatedSignals.map((signal) => signal.directEvidence)
    };
  }

  if (isStrongCategory(strongestCategory) && strongestCategory !== hypothesis.category) {
    return {
      hypothesisId: hypothesis.hypothesisId,
      title: hypothesis.title,
      category: hypothesis.category,
      status: "IRRELEVANT",
      priorConfidence: hypothesis.confidence,
      revisedConfidence: clamp(Math.min(0.22, hypothesis.confidence * 0.35)),
      rationale: `Another failure mode surfaced first (${strongestCategory.toLowerCase().replace(/_/g, " ")}), and the job log never reached evidence that would test this hypothesis.`,
      matchedSignalIds: [],
      observedEvidence: []
    };
  }

  return {
    hypothesisId: hypothesis.hypothesisId,
    title: hypothesis.title,
    category: hypothesis.category,
    status: "NOT_SUPPORTED",
    priorConfidence: hypothesis.confidence,
    revisedConfidence: clamp(Math.min(0.28, hypothesis.confidence * 0.4)),
    rationale: "The observed failure evidence does not support this pre-merge hypothesis.",
    matchedSignalIds: [],
    observedEvidence: []
  };
}

function rankExplanations(
  failureContext: FailureContext,
  hypotheses: Hypothesis[],
  predictionAudit: PredictionAuditEntry[],
  failureSignals: FailureSignal[],
  strongestSignal: FailureSignal | undefined,
  partialLog: boolean
) {
  const candidates: ScoredExplanation[] = predictionAudit.map((audit) => {
    const hypothesis = hypotheses.find((item) => item.hypothesisId === audit.hypothesisId);
    const exactSignals = failureSignals.filter((signal) => audit.matchedSignalIds.includes(signal.signalId));
    const score = scorePredictedExplanation(audit, hypothesis, partialLog, failureSignals);

    return {
      rank: 0,
      explanationId: `E-${audit.hypothesisId}`,
      title: hypothesis?.title ?? audit.title,
      category: audit.category,
      summary: summarizePredictedExplanation(hypothesis, audit, exactSignals),
      confidence: clamp(score / 100),
      predictedBeforeFailure: true,
      basedOnHypothesisId: audit.hypothesisId,
      evidence: buildExplanationEvidence(hypothesis, audit, exactSignals),
      whyRankedHere: explanationRankingReason(audit),
      counterfactual: counterfactualForCategory(audit.category, hypothesis || null),
      score
    };
  });

  if (strongestSignal && !candidates.some((candidate) =>
    candidate.category === strongestSignal.category && candidate.score >= 55
  )) {
    const score = scoreObservedExplanation(strongestSignal, partialLog, failureSignals);
    candidates.push({
      rank: 0,
      explanationId: `E-${strongestSignal.signalId}`,
      title: `Observed ${strongestSignal.category.toLowerCase().replace(/_/g, " ")}`,
      category: strongestSignal.category,
      summary: summarizeObservedExplanation(strongestSignal),
      confidence: clamp(score / 100),
      predictedBeforeFailure: false,
      basedOnHypothesisId: null,
      evidence: [strongestSignal.directEvidence],
      whyRankedHere: strongestSignal.category === "UNKNOWN"
        ? "Ranks highest among unpredicted explanations because it is the strongest direct evidence available, but the log signal is still ambiguous."
        : "Ranks highly because the job log provides direct evidence for this failure mode even though no prior hypothesis predicted it.",
      counterfactual: counterfactualForCategory(strongestSignal.category, null),
      score
    });
  }

  if (candidates.length === 0) {
    candidates.push({
      rank: 0,
      explanationId: "E-triage",
      title: "Manual triage required",
      category: "UNKNOWN",
      summary: "The available evidence is too weak to promote any single explanation above manual investigation.",
      confidence: 0.24,
      predictedBeforeFailure: false,
      basedOnHypothesisId: null,
      evidence: [extractFailureSignature(failureContext.errorLog)],
      whyRankedHere: "No prior hypothesis or direct log signal is strong enough to justify an automated causal conclusion.",
      counterfactual: "With fuller job logs, DevGuard could rank the competing causes more confidently.",
      score: 24
    });
  }

  return candidates
    .sort((left, right) => right.score - left.score || right.confidence - left.confidence)
    .slice(0, 3)
    .map((candidate, index) => ({
      ...candidate,
      rank: index + 1
    }));
}

function scorePredictedExplanation(
  audit: PredictionAuditEntry,
  hypothesis: Hypothesis | undefined,
  partialLog: boolean,
  failureSignals: FailureSignal[]
) {
  const baseByStatus = {
    CONFIRMED: 84,
    PARTIALLY_CONFIRMED: 66,
    NOT_SUPPORTED: 28,
    IRRELEVANT: 18
  } satisfies Record<PredictionAuditEntry["status"], number>;

  const ambiguityPenalty = new Set(
    failureSignals.filter(isStrongDirectSignal).map((signal) => signal.category)
  ).size > 1 ? 12 : 0;
  const partialPenalty = partialLog ? 10 : 0;
  const priorBonus = Math.round((hypothesis?.confidence ?? audit.priorConfidence) * 10);

  return clampScore(baseByStatus[audit.status] + priorBonus - ambiguityPenalty - partialPenalty);
}

function scoreObservedExplanation(
  strongestSignal: FailureSignal,
  partialLog: boolean,
  failureSignals: FailureSignal[]
) {
  const ambiguityPenalty = new Set(
    failureSignals.filter(isStrongDirectSignal).map((signal) => signal.category)
  ).size > 1 ? 12 : 0;
  const partialPenalty = partialLog ? 10 : 0;

  return clampScore(62 + Math.round(strongestSignal.confidence * 18) - ambiguityPenalty - partialPenalty);
}

function summarizePredictedExplanation(
  hypothesis: Hypothesis | undefined,
  audit: PredictionAuditEntry,
  exactSignals: FailureSignal[]
) {
  if (!hypothesis) {
    return audit.rationale;
  }

  if (audit.status === "CONFIRMED") {
    return `${hypothesis.claim} Observed evidence: ${exactSignals[0]?.directEvidence ?? audit.rationale}`;
  }

  if (audit.status === "PARTIALLY_CONFIRMED") {
    return `${hypothesis.claim} The observed failure overlaps with this hypothesis, but the precise predicted mechanism is not fully evidenced.`;
  }

  if (audit.status === "IRRELEVANT") {
    return `${hypothesis.claim} Another failure surfaced earlier, so this hypothesis was not exercised by the failing job.`;
  }

  return `${hypothesis.claim} The current pipeline failure does not support this prediction.`;
}

function summarizeObservedExplanation(strongestSignal: FailureSignal) {
  switch (strongestSignal.category) {
    case "RUNTIME_MISMATCH":
      return "The job log is most consistent with a Node runtime mismatch between the repository expectation and the CI image.";
    case "GHOST_VARIABLE":
      return "The job log is most consistent with a missing runtime variable in CI.";
    case "LOCKFILE_MISMATCH":
      return "The job log is most consistent with dependency installation failing because the CI package-manager path does not match the committed lockfile.";
    default:
      return `The strongest direct evidence currently available is: ${strongestSignal.directEvidence}`;
  }
}

function buildExplanationEvidence(
  hypothesis: Hypothesis | undefined,
  audit: PredictionAuditEntry,
  exactSignals: FailureSignal[]
) {
  const hypothesisEvidence = hypothesis?.evidence.map((item) =>
    item.excerpt
      ? `${item.path}${item.line ? `:${item.line}` : ""}: ${item.excerpt}`
      : `${item.path}${item.line ? `:${item.line}` : ""}`
  ) ?? [];

  return Array.from(
    new Set(
      [...audit.observedEvidence, ...exactSignals.map((signal) => signal.directEvidence), ...hypothesisEvidence]
        .filter(Boolean)
    )
  ).slice(0, 4);
}

function explanationRankingReason(audit: PredictionAuditEntry) {
  switch (audit.status) {
    case "CONFIRMED":
      return "Ranks highest because the observed failure directly validates the pre-merge prediction.";
    case "PARTIALLY_CONFIRMED":
      return "Ranks as a plausible alternative because the failure category overlaps with the earlier hypothesis, but the evidence is incomplete.";
    case "IRRELEVANT":
      return "Ranks lower because the failing job surfaced another issue before this hypothesis could be exercised.";
    case "NOT_SUPPORTED":
      return "Ranks lower because the log evidence does not support this earlier prediction.";
  }
}

function buildCausalChain(
  failureContext: FailureContext,
  primaryExplanation: ScoredExplanation | undefined,
  failureSignals: FailureSignal[]
) {
  const primarySignal = failureSignals[0];

  if (!primaryExplanation) {
    return [
      {
        step: 1,
        statement: "The pipeline failed, but the available evidence is too weak to construct a reliable causal chain."
      }
    ];
  }

  if (primaryExplanation.category === "RUNTIME_MISMATCH") {
    const hypothesis = failureContext.priorRiskReport?.hypotheses.find(
      (item) => item.hypothesisId === primaryExplanation.basedOnHypothesisId
    );
    const { ciVersion, localMajor } = extractVersionsFromHypothesis(hypothesis);

    return [
      {
        step: 1,
        statement: `The repository expects Node ${localMajor}, while CI still runs Node ${ciVersion}.`,
        evidence: hypothesis?.evidence[0]?.path
      },
      {
        step: 2,
        statement: `The failing job \`${failureContext.failedJobName}\` executed under the older CI runtime.`,
        evidence: failureContext.failedJobName
      },
      {
        step: 3,
        statement: "The job hit a code path that depends on a newer runtime API.",
        evidence: primarySignal?.directEvidence
      },
      {
        step: 4,
        statement: "That runtime mismatch raised a TypeError and caused the pipeline to fail.",
        evidence: primarySignal?.directEvidence
      }
    ];
  }

  if (primaryExplanation.category === "GHOST_VARIABLE") {
    const varName = extractVarName(primaryExplanation, failureContext);

    return [
      {
        step: 1,
        statement: `${varName} is referenced by the application but is not declared for CI use.`,
        evidence: varName
      },
      {
        step: 2,
        statement: `The failing job \`${failureContext.failedJobName}\` reached the code path that requires ${varName}.`
      },
      {
        step: 3,
        statement: "Runtime initialization failed because the variable was missing or undefined.",
        evidence: primarySignal?.directEvidence
      },
      {
        step: 4,
        statement: "The job exited non-zero, which failed the pipeline.",
        evidence: primarySignal?.directEvidence
      }
    ];
  }

  return [
    {
      step: 1,
      statement: `The failing job \`${failureContext.failedJobName}\` emitted the strongest available signal: ${primarySignal?.directEvidence ?? extractFailureSignature(failureContext.errorLog)}.`
    },
    {
      step: 2,
      statement: "That signal is the main evidence DevGuard used to rank the current explanation above the alternatives."
    },
    {
      step: 3,
      statement: "Confidence remains limited where the log does not prove the exact underlying configuration cause."
    }
  ];
}

function buildRecommendedFix(
  failureContext: FailureContext,
  primaryExplanation: ScoredExplanation | undefined,
  predictionAudit: PredictionAuditEntry[]
) {
  if (primaryExplanation?.category === "RUNTIME_MISMATCH") {
    const hypothesis = failureContext.priorRiskReport?.hypotheses.find(
      (item) => item.hypothesisId === primaryExplanation.basedOnHypothesisId
    );
    const { localMajor } = extractVersionsFromHypothesis(hypothesis);
    const ghostFollowUps = predictionAudit
      .filter((audit) => audit.category === "GHOST_VARIABLE" && audit.status !== "CONFIRMED")
      .map((audit) => `After the runtime fix, verify ${extractVarNameFromTitle(audit.title)} is declared in GitLab CI/CD variables.`);

    return {
      highConfidenceFix: `Update .gitlab-ci.yml to use \`image: node:${localMajor}-alpine\`, then rerun the failed pipeline.`,
      possibleNextChecks: ghostFollowUps
    };
  }

  if (primaryExplanation?.category === "GHOST_VARIABLE") {
    const varName = extractVarName(primaryExplanation, failureContext);
    return {
      highConfidenceFix: `Declare \`${varName}\` in .env.example and in GitLab CI/CD variables before rerunning the pipeline.`,
      possibleNextChecks: ["Confirm the failing job actually reaches the runtime path that requires this variable."]
    };
  }

  if (primaryExplanation?.category === "LOCKFILE_MISMATCH") {
    return {
      highConfidenceFix: "Commit the lockfile that matches the package manager CI uses, or update CI to the package manager already committed in the repository.",
      possibleNextChecks: ["Verify .gitlab-ci.yml install commands and package.json packageManager field point to the same tool."]
    };
  }

  if (primaryExplanation?.category === "TIMEZONE_ASSUMPTION") {
    return {
      highConfidenceFix: "Make the affected formatting code pass an explicit timezone such as UTC, then rerun the failing test.",
      possibleNextChecks: ["Check whether CI snapshots or locale-sensitive tests differ from local output."]
    };
  }

  return {
    highConfidenceFix: "Use the direct job-log evidence to inspect the failing step manually before applying changes.",
    possibleNextChecks: [
      "Retrieve the full failing job log if only a partial excerpt was available.",
      "Re-run the job after reproducing the failure locally or in the same CI image."
    ]
  };
}

function buildBeliefUpdate(
  primaryExplanation: ScoredExplanation | undefined,
  predictionAudit: PredictionAuditEntry[]
) {
  const validated = predictionAudit
    .filter((audit) => audit.status === "CONFIRMED" || audit.status === "PARTIALLY_CONFIRMED")
    .map((audit) => `${audit.hypothesisId} (${audit.status})`);

  const priorConfidence = primaryExplanation?.basedOnHypothesisId
    ? predictionAudit.find((audit) => audit.hypothesisId === primaryExplanation.basedOnHypothesisId)?.priorConfidence ?? 0
    : 0;

  return {
    predicted: primaryExplanation?.predictedBeforeFailure
      ? primaryExplanation.title
      : "No prior high-confidence hypothesis captured this failure before CI ran.",
    observed: primaryExplanation?.summary ?? "Observed failure evidence remained ambiguous.",
    validated,
    learned: primaryExplanation?.predictedBeforeFailure
      ? "DevGuard updated confidence based on whether the observed log directly validated the earlier claim."
      : "This incident appears to be new relative to the stored pre-merge hypotheses.",
    confidenceDelta: `${Math.round(priorConfidence * 100)}% -> ${Math.round((primaryExplanation?.confidence ?? 0) * 100)}%`
  };
}

function buildIncidentRootCause(
  failureContext: FailureContext,
  primaryExplanation: ScoredExplanation | undefined
) {
  if (!primaryExplanation) {
    return extractFailureSignature(failureContext.errorLog);
  }

  if (primaryExplanation.category === "RUNTIME_MISMATCH") {
    const hypothesis = primaryExplanation.basedOnHypothesisId
      ? failureContext.priorRiskReport?.hypotheses.find((item) => item.hypothesisId === primaryExplanation.basedOnHypothesisId)
      : null;
    const { ciVersion, localMajor } = extractVersionsFromHypothesis(hypothesis ?? undefined);

    return `CI is running Node ${ciVersion} while the merge request expects Node ${localMajor}, so the failing job hits an unsupported runtime path.`;
  }

  if (primaryExplanation.category === "GHOST_VARIABLE") {
    const varName = extractVarName(primaryExplanation, failureContext);
    return `${varName} is required by the failing code path, but CI does not provide it at runtime.`;
  }

  return primaryExplanation.summary;
}

function signalExactlyMatchesHypothesis(signal: FailureSignal, hypothesis: Hypothesis) {
  if (signal.category !== hypothesis.category) {
    return false;
  }

  if (signal.category === "GHOST_VARIABLE") {
    const variable = extractVarNameFromTitle(hypothesis.title);
    return variable
      ? new RegExp(variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(signal.directEvidence)
      : false;
  }

  return true;
}

function signalRelatesToHypothesis(signal: FailureSignal, hypothesis: Hypothesis) {
  if (signal.category === hypothesis.category) {
    return true;
  }

  if (hypothesis.category === "RUNTIME_MISMATCH") {
    return /TypeError|engine|node/i.test(signal.directEvidence);
  }

  if (hypothesis.category === "GHOST_VARIABLE") {
    return /required|undefined|missing/i.test(signal.directEvidence);
  }

  if (hypothesis.category === "LOCKFILE_MISMATCH") {
    return /npm ERR|install|lockfile/i.test(signal.directEvidence);
  }

  return false;
}

function extractVarName(primaryExplanation: ScoredExplanation, failureContext: FailureContext) {
  const hypothesis = primaryExplanation.basedOnHypothesisId
    ? failureContext.priorRiskReport?.hypotheses.find((item) => item.hypothesisId === primaryExplanation.basedOnHypothesisId)
    : null;

  return extractVarNameFromTitle(hypothesis?.title ?? primaryExplanation.title) || "the required variable";
}

function extractVarNameFromTitle(title: string) {
  const match = title.match(/Undeclared environment variable:\s*(.+)/);
  return match?.[1]?.trim() ?? "";
}

function extractVersionsFromHypothesis(hypothesis: Hypothesis | undefined) {
  const title = hypothesis?.title ?? "";
  const titleMatch = title.match(/local ([\d.]+) vs CI (.+)/);
  const localFull = titleMatch?.[1] ?? hypothesis?.evidence[0]?.excerpt ?? "20";
  const ciTag = titleMatch?.[2] ?? hypothesis?.evidence[1]?.excerpt ?? "18-alpine";

  return {
    localMajor: localFull.match(/^(\d+)/)?.[1] ?? localFull,
    ciVersion: ciTag.match(/^(\d+)/)?.[1] ?? ciTag
  };
}

function counterfactualForCategory(category: RankedExplanation["category"], hypothesis: Hypothesis | null) {
  switch (category) {
    case "RUNTIME_MISMATCH": {
      const { localMajor } = extractVersionsFromHypothesis(hypothesis ?? undefined);
      return `If CI had already been aligned to Node ${localMajor}, this failure likely would not have occurred.`;
    }
    case "GHOST_VARIABLE":
      return "If the missing variable had already been declared in CI, this failure path likely would not have triggered.";
    case "LOCKFILE_MISMATCH":
      return "If CI and the committed lockfile had been aligned, dependency installation likely would have succeeded.";
    default:
      return "With stronger corroborating evidence, this explanation could be promoted or demoted more decisively.";
  }
}

function auditStatusToPredictionStatus(status: PredictionAuditEntry["status"]): PredictionMatch["status"] {
  if (status === "CONFIRMED") {
    return "CONFIRMED";
  }

  if (status === "PARTIALLY_CONFIRMED") {
    return "PARTIALLY_CONFIRMED";
  }

  return "UNPREDICTED";
}

function averageConfidence(signals: FailureSignal[]) {
  return signals.reduce((sum, signal) => sum + signal.confidence, 0) / signals.length;
}

function isStrongDirectSignal(signal: FailureSignal) {
  return signal.category !== "UNKNOWN" && signal.confidence >= 0.78;
}

function isStrongCategory(category: FailureSignal["category"]) {
  return category !== "UNKNOWN";
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))));
}

function clampScore(value: number) {
  return Math.max(1, Math.min(99, value));
}
