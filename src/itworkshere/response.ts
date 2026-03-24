import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  embedPayloadInNote,
  fixBundleSchema,
  noteEnvelopeMarkers,
  type CausalAnalysis,
  type FailureContext,
  type FixBundle,
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
  const matchedRisk = options.failureContext.priorRiskReport?.risks.find(
    (r) => r.riskId === options.predictionMatch.matchedRiskId
  );

  if (options.predictionMatch.status === "CONFIRMED" && matchedRisk?.type === "RUNTIME_MISMATCH") {
    return buildRuntimeMismatchFixBundle(options, matchedRisk.title);
  }

  if (options.predictionMatch.status === "CONFIRMED" && matchedRisk?.type === "GHOST_VARIABLE") {
    return buildGhostVariableFixBundle(options, matchedRisk.title);
  }

  return buildTriageBundle(options);
}

function buildRuntimeMismatchFixBundle(
  options: BuildFixBundleOptions,
  riskTitle: string
): FixBundle {
  // Extract versions from risk title: "Node runtime mismatch: local 20.11.0 vs CI 18-alpine"
  const titleMatch = riskTitle.match(/local ([\d.]+) vs CI (.+)/);
  const localFull = titleMatch?.[1] ?? "20";
  const ciTag = titleMatch?.[2] ?? "18-alpine";
  const localMajor = localFull.match(/^(\d+)/)?.[1] ?? "20";

  const ciYmlPath = join(options.rootDir, ".gitlab-ci.yml");
  const currentCiYml = existsSync(ciYmlPath) ? readFileSync(ciYmlPath, "utf8") : "";
  const updatedCi = currentCiYml.replace(`node:${ciTag}`, `node:${localMajor}-alpine`);

  const envExamplePath = join(options.rootDir, ".env.example");
  const currentEnvExample = existsSync(envExamplePath) ? readFileSync(envExamplePath, "utf8") : "";

  // Also include any ghost variable fixes alongside the runtime fix
  const ghostRisks = options.failureContext.priorRiskReport?.risks.filter(
    (r) => r.type === "GHOST_VARIABLE"
  ) ?? [];
  const updatedEnvExample = ghostRisks.reduce(
    (acc, risk) => ensureVarDeclared(acc, extractVarName(risk.title)),
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
    },
    {
      path: "setup.sh",
      content: [
        "#!/usr/bin/env sh",
        "set -eu",
        "node --version",
        "npm ci",
        "npm test"
      ].join("\n"),
      language: "sh"
    }
  );

  return fixBundleSchema.parse({
    runId: options.failureContext.runId,
    projectPath: options.failureContext.projectPath,
    mrIid: options.failureContext.mrIid,
    pipelineId: options.failureContext.pipelineId,
    summary: `Generated a minimal fix bundle for the confirmed Node runtime mismatch (${ciTag} → ${localMajor}-alpine).`,
    labelsToApply: [workflowLabels.confirmed, workflowLabels.fixed],
    artifacts,
    applyCommand: existsSync(scenariosPatchPath)
      ? "git apply reproguard-fix.patch"
      : `# Update .gitlab-ci.yml: replace node:${ciTag} with node:${localMajor}-alpine`
  });
}

function buildGhostVariableFixBundle(
  options: BuildFixBundleOptions,
  riskTitle: string
): FixBundle {
  const varName = extractVarName(riskTitle);

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
          "1. Add it to `.env.example` (done — see artifact)",
          "2. Go to **Settings → CI/CD → Variables** in GitLab and add the real value",
          "3. Re-run the failed pipeline"
        ].join("\n"),
        language: "md"
      }
    ],
    applyCommand: `# Copy .env.example and set ${varName} in GitLab CI/CD variables`
  });
}

function buildTriageBundle(options: BuildFixBundleOptions): FixBundle {
  return fixBundleSchema.parse({
    runId: options.failureContext.runId,
    projectPath: options.failureContext.projectPath,
    mrIid: options.failureContext.mrIid,
    pipelineId: options.failureContext.pipelineId,
    summary: "Generated a triage bundle that requires human review before applying changes.",
    labelsToApply: [workflowLabels.needsReview],
    artifacts: [
      {
        path: "triage.md",
        content: [
          "# Manual triage required",
          "",
          options.causalAnalysis.rootCause,
          "",
          "Review the failed job log and apply a targeted fix."
        ].join("\n"),
        language: "md"
      }
    ],
    applyCommand: "Review triage.md before applying any changes."
  });
}

export function formatReactiveComment(
  predictionMatch: PredictionMatch,
  causalAnalysis: CausalAnalysis,
  fixBundle: FixBundle
) {
  const lines = ["## ItWorksHere - CI Failure Analysis", ""];

  if (predictionMatch.status === "CONFIRMED") {
    lines.push("### Prediction confirmed");
    lines.push("ReproGuard warned about this exact failure before merge.");
  } else if (predictionMatch.status === "PARTIAL") {
    lines.push("### Partial match");
    lines.push("The failure overlaps with an earlier warning, but the match is not definitive.");
  } else {
    lines.push("### New failure");
    lines.push("No prior prediction clearly matched this failure, so the result needs review.");
  }

  lines.push("");
  lines.push(`Root cause: ${causalAnalysis.rootCause}`);
  lines.push(`Confidence: ${(causalAnalysis.confidence * 100).toFixed(0)}%`);
  lines.push("");
  lines.push("Evidence:");

  for (const item of causalAnalysis.evidence) {
    lines.push(`- ${item}`);
  }

  lines.push("");
  lines.push("Fix bundle:");

  for (const artifact of fixBundle.artifacts) {
    lines.push(`- ${artifact.path}`);
  }

  lines.push(`Apply with: ${fixBundle.applyCommand}`);

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
    noteEnvelopeMarkers.causalAnalysisStart,
    noteEnvelopeMarkers.causalAnalysisEnd
  );

  return `${comment}\n\n${payload}`;
}

function ensureVarDeclared(envExample: string, varName: string): string {
  if (!varName || envExample.includes(`${varName}=`)) {
    return envExample;
  }
  const normalized = envExample.endsWith("\n") ? envExample : `${envExample}\n`;
  const placeholder = varName.toLowerCase().includes("url") ? `${varName}=` : `${varName}=`;
  return `${normalized}${placeholder}\n`;
}

function extractVarName(riskTitle: string): string {
  const match = riskTitle.match(/Undeclared environment variable:\s*(.+)/);
  return match?.[1]?.trim() ?? "";
}
