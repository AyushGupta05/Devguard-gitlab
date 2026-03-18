import { readFileSync } from "node:fs";
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
  if (
    options.predictionMatch.status === "CONFIRMED" &&
    /Node 18/i.test(options.causalAnalysis.rootCause)
  ) {
    const patch = readFileSync(
      join(options.rootDir, "scenarios", "runtime-mismatch-fix.patch"),
      "utf8"
    );
    const updatedEnvExample = ensureRedisUrl(
      readFileSync(join(options.rootDir, ".env.example"), "utf8")
    );
    const updatedCi = readFileSync(join(options.rootDir, ".gitlab-ci.yml"), "utf8").replace(
      "node:18-alpine",
      "node:20-alpine"
    );

    return fixBundleSchema.parse({
      runId: options.failureContext.runId,
      projectPath: options.failureContext.projectPath,
      mrIid: options.failureContext.mrIid,
      pipelineId: options.failureContext.pipelineId,
      summary: "Generated a minimal fix bundle for the confirmed Node runtime mismatch.",
      labelsToApply: [workflowLabels.confirmed, workflowLabels.fixed],
      artifacts: [
        {
          path: "reproguard-fix.patch",
          content: patch,
          language: "diff"
        },
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
      ],
      applyCommand: "git apply reproguard-fix.patch"
    });
  }

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

function ensureRedisUrl(envExample: string) {
  if (envExample.includes("REDIS_URL=")) {
    return envExample;
  }

  const normalized = envExample.endsWith("\n") ? envExample : `${envExample}\n`;
  return `${normalized}REDIS_URL=redis://localhost:6379\n`;
}
