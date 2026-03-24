import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import {
  embedPayloadInNote,
  noteEnvelopeMarkers,
  preventionReportSchema,
  type EnvironmentMap,
  type Hypothesis,
  type LocalSetupPlan,
  type PreventionReport,
  workflowLabels
} from "../contracts.js";
import { buildLocalRunConfigurationRisk } from "./local-run.js";
import { type PreventionSignal } from "./scanners.js";

type BuildRiskReportOptions = {
  rootDir: string;
  mergeRequestDiff: string;
  environmentMap: EnvironmentMap;
  signals: PreventionSignal[];
  localSetupPlan?: LocalSetupPlan;
};

export function buildRiskReport(options: BuildRiskReportOptions): PreventionReport {
  const hypotheses: Hypothesis[] = [];
  let counter = 1;

  for (const signal of options.signals) {
    if (signal.category === "RUNTIME_MISMATCH") {
      const hypothesis = buildRuntimeMismatchHypothesis(options, signal, counter);

      if (hypothesis) {
        hypotheses.push(hypothesis);
        counter += 1;
      }

      continue;
    }

    if (signal.category === "GHOST_VARIABLE") {
      const hypothesis = buildGhostVariableHypothesis(options, signal, counter);

      if (hypothesis) {
        hypotheses.push(hypothesis);
        counter += 1;
      }

      continue;
    }

    if (isDirectlyRelevant(signal, options.environmentMap.changedFiles)) {
      hypotheses.push(createHypothesisFromSignal(signal, `H${counter}`, options.environmentMap.changedFiles));
      counter += 1;
    }
  }

  if (options.localSetupPlan) {
    const localRunHypothesis = buildLocalRunConfigurationRisk(
      options.localSetupPlan,
      options.environmentMap,
      `H${counter}`
    );

    if (localRunHypothesis) {
      hypotheses.push(localRunHypothesis);
    }
  }

  const orderedHypotheses = hypotheses.sort(compareHypotheses);
  const ciFailureLikelihood = estimateFailureLikelihood(orderedHypotheses);
  const topConcern = orderedHypotheses[0]?.title ?? null;

  return preventionReportSchema.parse({
    reportVersion: "2.0",
    runId: options.environmentMap.runId,
    projectPath: options.environmentMap.projectPath,
    mergeRequestId: options.environmentMap.mrIid,
    mrIid: options.environmentMap.mrIid,
    pipelineId: options.environmentMap.pipelineId ?? null,
    generatedAt: new Date().toISOString(),
    summary: {
      hypothesisCount: orderedHypotheses.length,
      topConcern,
      ciFailureLikelihood,
      reliabilityScore: Math.max(0, Math.round((1 - ciFailureLikelihood) * 100)),
      summary: buildExecutiveSummary(orderedHypotheses.length, topConcern, ciFailureLikelihood)
    },
    executiveSummary: buildExecutiveSummary(orderedHypotheses.length, topConcern, ciFailureLikelihood),
    hypotheses: orderedHypotheses,
    labelsToApply: orderedHypotheses.length > 0 ? [workflowLabels.warned] : []
  });
}

export function formatPreventionComment(report: PreventionReport) {
  const lines = [
    "## DevGuard Causal Reliability Report",
    "",
    "### Executive summary",
    `- Hypotheses: ${report.summary.hypothesisCount}`,
    `- Top concern: ${report.summary.topConcern ?? "none"}`,
    `- CI failure likelihood: ${formatPercent(report.summary.ciFailureLikelihood)}`,
    `- Reliability score: ${report.summary.reliabilityScore}/100`,
    "",
    report.executiveSummary
  ];

  if (report.hypotheses.length === 0) {
    lines.push("");
    lines.push("No evidence-backed pre-merge hypothesis is strong enough to warn on this merge request.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("### Hypothesis table");
  lines.push("");
  lines.push("| # | Hypothesis | Confidence | Severity | Expected failure mode | Supporting evidence | Recommended mitigation |");
  lines.push("|---|---|---|---|---|---|---|");

  report.hypotheses.forEach((hypothesis, index) => {
    lines.push([
      `| ${index + 1}`,
      sanitizeCell(hypothesis.title),
      formatPercent(hypothesis.confidence),
      hypothesis.severity,
      sanitizeCell(hypothesis.expectedFailureMode),
      sanitizeCell(summarizeEvidence(hypothesis)),
      sanitizeCell(hypothesis.suggestedMitigation)
    ].join(" | ") + " |");
  });

  lines.push("");
  lines.push("### Verification hooks");

  for (const hypothesis of report.hypotheses) {
    lines.push(`- ${hypothesis.hypothesisId}: confirm on ${hypothesis.confirmatorySignal}`);
    lines.push(`  weaken on ${hypothesis.weakeningSignal}`);
  }

  lines.push("");
  lines.push("_DevGuard stores these hypotheses so reactive analysis can compare prediction against outcome._");

  return lines.join("\n");
}

export function buildPreventionNote(report: PreventionReport) {
  const comment = formatPreventionComment(report);
  const payload = embedPayloadInNote(
    report,
    noteEnvelopeMarkers.preventionReportStart,
    noteEnvelopeMarkers.preventionReportEnd
  );

  return `${comment}\n\n${payload}`;
}

function buildRuntimeMismatchHypothesis(
  options: BuildRiskReportOptions,
  signal: PreventionSignal,
  counter: number
) {
  const ciMajor = extractMajor(options.environmentMap.ciRuntimes.node?.value ?? "");

  if (options.mergeRequestDiff.includes("toSorted(") && ciMajor !== null && ciMajor < 20) {
    return createHypothesisFromSignal(
      {
        ...signal,
        confidence: 0.97,
        title: "Node 20 API introduced while CI still runs Node 18",
        claim: "The merge request introduces Array.prototype.toSorted(), but the GitLab pipeline still runs Node 18. This is likely to fail in CI before merge fallout is visible elsewhere.",
        evidence: [
          ...signal.evidence,
          {
            path: options.environmentMap.changedFiles[0] ?? "unknown",
            excerpt: "toSorted(",
            source: "diff"
          }
        ],
        expectedFailureMode: "Tests fail with a TypeError because the CI runtime does not implement Array.prototype.toSorted().",
        confirmatorySignal: "The failed job log shows TypeError: invoices.toSorted is not a function or another Node 20 API gap.",
        weakeningSignal: "The same job passes under the current CI image without any runtime mismatch symptoms.",
        suggestedMitigation: "Update .gitlab-ci.yml to node:20-alpine before merging this change."
      },
      `H${counter}`,
      options.environmentMap.changedFiles
    );
  }

  if (!isDirectlyRelevant(signal, options.environmentMap.changedFiles)) {
    return null;
  }

  return createHypothesisFromSignal(signal, `H${counter}`, options.environmentMap.changedFiles);
}

function buildGhostVariableHypothesis(
  options: BuildRiskReportOptions,
  signal: PreventionSignal,
  counter: number
) {
  const ghostFile = signal.affectedFiles[0];

  if (!isGhostVariableRelevant(options.rootDir, options.environmentMap.changedFiles, ghostFile)) {
    return null;
  }

  return createHypothesisFromSignal(
    {
      ...signal,
      confidence: Math.max(signal.confidence, 0.84)
    },
    `H${counter}`,
    options.environmentMap.changedFiles
  );
}

function createHypothesisFromSignal(
  signal: PreventionSignal,
  hypothesisId: string,
  changedFiles: string[]
): Hypothesis {
  return {
    hypothesisId,
    ...signal,
    reasoningContext: {
      evidenceCount: signal.evidence.length,
      changedFileOverlap: signal.affectedFiles.some((filePath) => changedFiles.includes(filePath)),
      signalSources: Array.from(new Set(signal.evidence.map((item) => item.source ?? item.path)))
    }
  };
}

function compareHypotheses(left: Hypothesis, right: Hypothesis) {
  const severityDelta = severityRank(right.severity) - severityRank(left.severity);

  if (severityDelta !== 0) {
    return severityDelta;
  }

  if (right.confidence !== left.confidence) {
    return right.confidence - left.confidence;
  }

  return left.title.localeCompare(right.title);
}

function severityRank(severity: Hypothesis["severity"]) {
  if (severity === "HIGH") {
    return 3;
  }

  if (severity === "MEDIUM") {
    return 2;
  }

  return 1;
}

function estimateFailureLikelihood(hypotheses: Hypothesis[]) {
  if (hypotheses.length === 0) {
    return 0.08;
  }

  const strongest = Math.max(...hypotheses.map((hypothesis) => hypothesis.confidence));
  return Math.min(0.99, strongest + Math.min(0.08, (hypotheses.length - 1) * 0.03));
}

function buildExecutiveSummary(hypothesisCount: number, topConcern: string | null, likelihood: number) {
  if (hypothesisCount === 0) {
    return `DevGuard did not find evidence-backed CI failure hypotheses in this merge request. Residual failure likelihood is ${formatPercent(likelihood)}.`;
  }

  const hypothesisLabel = hypothesisCount === 1 ? "hypothesis" : "hypotheses";

  return `DevGuard formed ${hypothesisCount} evidence-backed ${hypothesisLabel}. Top concern: ${topConcern}. Estimated CI failure likelihood is ${formatPercent(likelihood)}.`;
}

function summarizeEvidence(hypothesis: Hypothesis) {
  return hypothesis.evidence
    .slice(0, 2)
    .map((item) => {
      const location = item.line ? `${item.path}:${item.line}` : item.path;
      return item.excerpt ? `${location} (${item.excerpt})` : location;
    })
    .join("; ");
}

function sanitizeCell(value: string) {
  return value.replace(/\|/g, "\\|");
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function extractMajor(runtime: string) {
  const match = runtime.match(/(\d{1,2})/);
  return match ? Number(match[1]) : null;
}

function isDirectlyRelevant(signal: PreventionSignal, changedFiles: string[]) {
  return signal.affectedFiles.some((filePath) => changedFiles.includes(filePath)) ||
    signal.category === "DOCKER_IMAGE_DRIFT" ||
    signal.category === "LOCKFILE_MISMATCH" ||
    signal.category === "SECURITY_LEAK";
}

function isGhostVariableRelevant(rootDir: string, changedFiles: string[], ghostFile: string) {
  if (!ghostFile) {
    return false;
  }

  if (changedFiles.includes(ghostFile)) {
    return true;
  }

  return changedFiles.some((changedFile) => importsFile(rootDir, changedFile, ghostFile));
}

function importsFile(rootDir: string, importerPath: string, targetPath: string) {
  const importerContents = readFileSync(join(rootDir, importerPath), "utf8");
  const importerDirectory = dirname(importerPath);
  const targetNormalized = normalize(targetPath);
  const importMatches = importerContents.matchAll(/from\s+["'](.+?)["']/g);

  for (const match of importMatches) {
    const importTarget = match[1];

    if (!importTarget.startsWith(".")) {
      continue;
    }

    const resolved = normalize(join(importerDirectory, importTarget));
    const candidatePaths = [resolved, `${resolved}.js`, `${resolved}.ts`];

    if (candidatePaths.includes(targetNormalized)) {
      return true;
    }
  }

  return false;
}
