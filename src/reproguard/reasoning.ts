import { readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

import {
  noteEnvelopeMarkers,
  riskReportSchema,
  type EnvironmentMap,
  type LocalSetupPlan,
  type RiskReport,
  type Risk
} from "../contracts.js";
import { embedPayloadInNote } from "../contracts.js";
import { buildLocalRunConfigurationRisk } from "./local-run.js";
import { type PreventionSignal } from "./scanners.js";

type BuildRiskReportOptions = {
  rootDir: string;
  mergeRequestDiff: string;
  environmentMap: EnvironmentMap;
  signals: PreventionSignal[];
  localSetupPlan?: LocalSetupPlan;
};

export function buildRiskReport(options: BuildRiskReportOptions): RiskReport {
  const risks: Risk[] = [];
  let counter = 1;

  for (const signal of options.signals) {
    if (signal.type === "RUNTIME_MISMATCH") {
      const runtimeRisk = buildRuntimeMismatchRisk(options, signal, counter);

      if (runtimeRisk) {
        risks.push(runtimeRisk);
        counter += 1;
      }

      continue;
    }

    if (signal.type === "GHOST_VARIABLE" && isGhostVariableRelevant(options.rootDir, options.environmentMap.changedFiles, signal.affectedFiles[0])) {
      risks.push({
        riskId: `R${counter}`,
        ...signal,
        confidence: 0.92
      });
      counter += 1;
    }
  }

  if (options.localSetupPlan) {
    const localRunRisk = buildLocalRunConfigurationRisk(
      options.localSetupPlan,
      options.environmentMap,
      `R${counter}`
    );

    if (localRunRisk) {
      risks.push(localRunRisk);
      counter += 1;
    }
  }

  const summary =
    risks.length === 0
      ? "No medium or high-confidence reproducibility risks found."
      : `Found ${risks.length} reproducibility risk${risks.length === 1 ? "" : "s"} that may break CI or a clean developer environment.`;

  return riskReportSchema.parse({
    runId: options.environmentMap.runId,
    projectPath: options.environmentMap.projectPath,
    mrIid: options.environmentMap.mrIid,
    generatedAt: new Date().toISOString(),
    summary,
    risks,
    labelsToApply: risks.length > 0 ? ["reproguard:warned"] : []
  });
}

export function formatPreventionComment(riskReport: RiskReport) {
  const lines = [
    "## ReproGuard - Reproducibility Risk Report",
    "",
    riskReport.summary
  ];

  if (riskReport.risks.length === 0) {
    return lines.join("\n");
  }

  for (const risk of riskReport.risks) {
    lines.push("");
    lines.push(`### [${risk.severity}] ${risk.title}`);
    lines.push(risk.description);
    lines.push("");
    lines.push(`Confidence: ${(risk.confidence * 100).toFixed(0)}%`);

    if (risk.affectedFiles.length > 0) {
      lines.push(`Affected files: ${risk.affectedFiles.join(", ")}`);
    }

    lines.push(`Suggested fix: ${risk.suggestedFix}`);
  }

  lines.push("");
  lines.push("_These predictions are stored so ItWorksHere can compare them against a failed pipeline later._");

  return lines.join("\n");
}

export function buildPreventionNote(riskReport: RiskReport) {
  const comment = formatPreventionComment(riskReport);
  const payload = embedPayloadInNote(
    riskReport,
    noteEnvelopeMarkers.riskReportStart,
    noteEnvelopeMarkers.riskReportEnd
  );

  return `${comment}\n\n${payload}`;
}

function buildRuntimeMismatchRisk(
  options: BuildRiskReportOptions,
  signal: PreventionSignal,
  counter: number
) {
  const ciMajor = extractMajor(options.environmentMap.ciRuntimes.node?.value ?? "");

  if (options.mergeRequestDiff.includes("toSorted(") && ciMajor !== null && ciMajor < 20) {
    return {
      riskId: `R${counter}`,
      ...signal,
      confidence: 0.97,
      title: "Node 20 API introduced while CI still runs Node 18",
      description: "The merge request introduces Array.prototype.toSorted(), which is available in Node 20 but not in the current CI runtime. This change is very likely to fail after merge.",
      evidence: [
        ...signal.evidence,
        {
          path: options.environmentMap.changedFiles[0] ?? "unknown",
          excerpt: "toSorted("
        }
      ],
      suggestedFix: "Update .gitlab-ci.yml to node:20-alpine before merging this change."
    } satisfies Risk;
  }

  if (signal.affectedFiles.some((filePath) => options.environmentMap.changedFiles.includes(filePath))) {
    return {
      riskId: `R${counter}`,
      ...signal
    } satisfies Risk;
  }

  return null;
}

function extractMajor(runtime: string) {
  const match = runtime.match(/(\d{1,2})/);
  return match ? Number(match[1]) : null;
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
