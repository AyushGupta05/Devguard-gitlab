import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  embedPayloadInNote,
  fixBundleSchema,
  noteEnvelopeMarkers,
  type CausalAnalysis,
  type FailureContext,
  type FixBundle,
  type Hypothesis,
  type PredictionMatch,
  workflowLabels
} from "../contracts.js";

type BuildFixBundleOptions = {
  rootDir: string;
  failureContext: FailureContext;
  predictionMatch: PredictionMatch;
  causalAnalysis: CausalAnalysis;
};

export function buildFixBundle(options: BuildFixBundleOptions): FixBundle {
  const matchedHypothesis = options.failureContext.priorRiskReport?.hypotheses.find(
    (hypothesis) => hypothesis.hypothesisId === options.predictionMatch.matchedHypothesisId
  );

  if (options.predictionMatch.status === "CONFIRMED" && matchedHypothesis?.category === "RUNTIME_MISMATCH") {
    return buildRuntimeMismatchFixBundle(options, matchedHypothesis);
  }

  if (options.predictionMatch.status === "CONFIRMED" && matchedHypothesis?.category === "GHOST_VARIABLE") {
    return buildGhostVariableFixBundle(options, matchedHypothesis);
  }

  return buildTriageBundle(options);
}

export function formatReactiveComment(
  predictionMatch: PredictionMatch,
  causalAnalysis: CausalAnalysis,
  fixBundle: FixBundle
) {
  const lines = [
    "## DevGuard Incident Analysis",
    "",
    "### Incident summary",
    `- Likely root cause: ${causalAnalysis.incidentSummary.likelyRootCause}`,
    `- Confidence: ${formatPercent(causalAnalysis.incidentSummary.confidence)}`,
    `- Affected job: ${causalAnalysis.incidentSummary.affectedJob}`,
    `- Predicted before failure: ${formatPredictionFlag(causalAnalysis.incidentSummary.predictedBeforeFailure, causalAnalysis.incidentSummary.basedOnHypothesisId)}`,
    ""
  ];

  lines.push("### Prediction audit");
  lines.push("");
  lines.push("| Hypothesis | Outcome | Prior confidence | Revised confidence | Why |");
  lines.push("|---|---|---|---|---|");

  if (causalAnalysis.predictionAudit.length === 0) {
    lines.push("| None | UNPREDICTED | - | - | No prior hypotheses were available to audit against the failure. |");
  } else {
    for (const audit of causalAnalysis.predictionAudit) {
      lines.push([
        `| ${sanitizeCell(audit.hypothesisId)} ${sanitizeCell(audit.title)}`,
        audit.status,
        formatPercent(audit.priorConfidence),
        formatPercent(audit.revisedConfidence),
        sanitizeCell(audit.rationale)
      ].join(" | ") + " |");
    }
  }

  lines.push("");
  lines.push("### Ranked explanations");

  for (const explanation of causalAnalysis.rankedExplanations) {
    lines.push("");
    lines.push(`${explanation.rank}. ${explanation.title} (${formatPercent(explanation.confidence)})`);
    lines.push(explanation.summary);
    lines.push(`Why ranked here: ${explanation.whyRankedHere}`);

    if (explanation.evidence.length > 0) {
      lines.push(`Evidence: ${explanation.evidence.join(" | ")}`);
    }

    if (explanation.counterfactual) {
      lines.push(`Counterfactual: ${explanation.counterfactual}`);
    }
  }

  lines.push("");
  lines.push("### Causal chain");

  for (const step of causalAnalysis.causalChain) {
    lines.push(`${step.step}. ${step.statement}`);
  }

  lines.push("");
  lines.push("### Recommended fix");
  lines.push(`High-confidence fix: ${causalAnalysis.recommendedFix.highConfidenceFix}`);

  if (causalAnalysis.recommendedFix.possibleNextChecks.length > 0) {
    lines.push(`Possible next checks: ${causalAnalysis.recommendedFix.possibleNextChecks.join(" ")}`);
  }

  lines.push("");
  lines.push("### What changed in my belief");
  lines.push(`Predicted: ${causalAnalysis.beliefUpdate.predicted}`);
  lines.push(`Observed: ${causalAnalysis.beliefUpdate.observed}`);
  lines.push(`Validated: ${causalAnalysis.beliefUpdate.validated.length > 0 ? causalAnalysis.beliefUpdate.validated.join(", ") : "none"}`);
  lines.push(`Learned: ${causalAnalysis.beliefUpdate.learned}`);
  lines.push(`Confidence shift: ${causalAnalysis.beliefUpdate.confidenceDelta}`);

  lines.push("");
  lines.push("### Fix bundle");

  for (const artifact of fixBundle.artifacts) {
    lines.push(`- ${artifact.path}`);
  }

  lines.push(`Apply with: ${fixBundle.applyCommand}`);

  if (predictionMatch.status !== "CONFIRMED") {
    lines.push("");
    lines.push("Human review recommended.");
  }

  return lines.join("\n");
}

export function buildReactiveNote(
  predictionMatch: PredictionMatch,
  causalAnalysis: CausalAnalysis,
  fixBundle: FixBundle
) {
  const comment = formatReactiveComment(predictionMatch, causalAnalysis, fixBundle);
  const payload = embedPayloadInNote(
    causalAnalysis,
    noteEnvelopeMarkers.reactiveReportStart,
    noteEnvelopeMarkers.reactiveReportEnd
  );

  return `${comment}\n\n${payload}`;
}

function buildRuntimeMismatchFixBundle(
  options: BuildFixBundleOptions,
  hypothesis: Hypothesis
): FixBundle {
  const { ciTag, localMajor } = extractVersionsFromHypothesis(hypothesis);
  const ciYmlPath = join(options.rootDir, ".gitlab-ci.yml");
  const currentCiYml = existsSync(ciYmlPath) ? readFileSync(ciYmlPath, "utf8") : "";
  const updatedCi = currentCiYml.replace(`node:${ciTag}`, `node:${localMajor}-alpine`);

  const envExamplePath = join(options.rootDir, ".env.example");
  const currentEnvExample = existsSync(envExamplePath) ? readFileSync(envExamplePath, "utf8") : "";
  const ghostHypotheses = options.failureContext.priorRiskReport?.hypotheses.filter(
    (item) => item.category === "GHOST_VARIABLE"
  ) ?? [];
  const updatedEnvExample = ghostHypotheses.reduce(
    (contents, item) => ensureVarDeclared(contents, extractVarNameFromTitle(item.title)),
    currentEnvExample
  );

  const scenariosPatchPath = join(options.rootDir, "scenarios", "runtime-mismatch-fix.patch");
  const artifacts = [];

  if (existsSync(scenariosPatchPath)) {
    artifacts.push({
      path: "reproguard-fix.patch",
      content: readFileSync(scenariosPatchPath, "utf8"),
      language: "diff"
    });
  }

  artifacts.push(
    {
      path: ".gitlab-ci.yml",
      content: updatedCi,
      language: "yaml"
    },
    {
      path: ".env.example",
      content: updatedEnvExample,
      language: "dotenv"
    }
  );

  return fixBundleSchema.parse({
    runId: options.failureContext.runId,
    projectPath: options.failureContext.projectPath,
    mrIid: options.failureContext.mrIid,
    pipelineId: options.failureContext.pipelineId,
    summary: `Generated a minimal fix bundle for the confirmed runtime mismatch (${ciTag} -> ${localMajor}-alpine).`,
    labelsToApply: [workflowLabels.confirmed, workflowLabels.fixed],
    artifacts,
    applyCommand: existsSync(scenariosPatchPath)
      ? "git apply reproguard-fix.patch"
      : `Update .gitlab-ci.yml: replace node:${ciTag} with node:${localMajor}-alpine`
  });
}

function buildGhostVariableFixBundle(
  options: BuildFixBundleOptions,
  hypothesis: Hypothesis
): FixBundle {
  const varName = extractVarNameFromTitle(hypothesis.title);
  const envExamplePath = join(options.rootDir, ".env.example");
  const currentEnvExample = existsSync(envExamplePath) ? readFileSync(envExamplePath, "utf8") : "";
  const updatedEnvExample = ensureVarDeclared(currentEnvExample, varName);

  return fixBundleSchema.parse({
    runId: options.failureContext.runId,
    projectPath: options.failureContext.projectPath,
    mrIid: options.failureContext.mrIid,
    pipelineId: options.failureContext.pipelineId,
    summary: `Generated a fix bundle for the confirmed undeclared environment variable: ${varName}.`,
    labelsToApply: [workflowLabels.confirmed, workflowLabels.fixed],
    artifacts: [
      {
        path: ".env.example",
        content: updatedEnvExample,
        language: "dotenv"
      },
      {
        path: "ci-variable-instructions.md",
        content: [
          `# Add CI variable: ${varName}`,
          "",
          `The application requires \`${varName}\` at runtime.`,
          "",
          "1. Add it to `.env.example`.",
          "2. Add it to GitLab Settings > CI/CD > Variables.",
          "3. Re-run the failed pipeline."
        ].join("\n"),
        language: "md"
      }
    ],
    applyCommand: `Copy the updated .env.example and define ${varName} in GitLab CI/CD variables`
  });
}

function buildTriageBundle(options: BuildFixBundleOptions): FixBundle {
  return fixBundleSchema.parse({
    runId: options.failureContext.runId,
    projectPath: options.failureContext.projectPath,
    mrIid: options.failureContext.mrIid,
    pipelineId: options.failureContext.pipelineId,
    summary: "Generated a triage bundle because the available evidence does not support a high-confidence automatic fix.",
    labelsToApply: [workflowLabels.needsReview],
    artifacts: [
      {
        path: "triage.md",
        content: [
          "# Manual triage required",
          "",
          options.causalAnalysis.incidentSummary.likelyRootCause,
          "",
          `Primary evidence: ${options.causalAnalysis.failureSignals[0]?.directEvidence ?? "No direct signal extracted."}`
        ].join("\n"),
        language: "md"
      }
    ],
    applyCommand: "Review triage.md before applying any changes."
  });
}

function ensureVarDeclared(envExample: string, varName: string) {
  if (!varName || envExample.includes(`${varName}=`)) {
    return envExample;
  }

  const normalized = envExample.endsWith("\n") ? envExample : `${envExample}\n`;
  return `${normalized}${varName}=\n`;
}

function extractVarNameFromTitle(title: string) {
  const match = title.match(/Undeclared environment variable:\s*(.+)/);
  return match?.[1]?.trim() ?? "";
}

function extractVersionsFromHypothesis(hypothesis: Hypothesis) {
  const titleMatch = hypothesis.title.match(/local ([\d.]+) vs CI (.+)/);
  const localFull = titleMatch?.[1] ?? hypothesis.evidence[0]?.excerpt ?? "20";
  const ciTag = titleMatch?.[2] ?? hypothesis.evidence[1]?.excerpt ?? "18-alpine";

  return {
    localMajor: localFull.match(/^(\d+)/)?.[1] ?? localFull,
    ciTag
  };
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function sanitizeCell(value: string) {
  return value.replace(/\|/g, "\\|");
}

function formatPredictionFlag(predictedBeforeFailure: boolean, hypothesisId: string | null) {
  if (!predictedBeforeFailure) {
    return "no";
  }

  return hypothesisId ? `yes (${hypothesisId})` : "yes";
}
