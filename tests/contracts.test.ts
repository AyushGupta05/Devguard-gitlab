import { describe, expect, it } from "vitest";

import {
  createRunId,
  embedPayloadInNote,
  environmentMapSchema,
  extractEmbeddedPayload,
  extractPreventionReportFromNote,
  noteEnvelopeMarkers,
  preventionReportSchema,
  riskReportArtifactPath,
  workflowLabels
} from "../src/contracts.js";

describe("shared contracts", () => {
  it("validates the richer environment map shape", () => {
    const parsed = environmentMapSchema.parse({
      runId: createRunId("reproguard"),
      projectPath: "demo/billing-service",
      mrIid: 42,
      pipelineId: null,
      generatedAt: "2026-03-18T13:00:00.000Z",
      localRuntimes: {
        node: {
          source: ".nvmrc",
          value: "20.11.0"
        }
      },
      declaredRuntimeEngines: {
        node: {
          source: "package.json#engines.node",
          value: ">=20"
        }
      },
      ciRuntimes: {
        node: {
          source: ".gitlab-ci.yml",
          value: "18-alpine"
        }
      },
      packageManager: {
        source: "package.json#packageManager",
        value: "npm@10.0.0"
      },
      ciInstallCommands: [
        {
          path: ".gitlab-ci.yml",
          line: 8,
          command: "npm ci"
        }
      ],
      lockfiles: ["package-lock.json"],
      envExampleKeys: ["DATABASE_URL", "STRIPE_API_KEY"],
      ciVariableKeys: ["DATABASE_URL"],
      codeVariableReferences: [
        {
          variable: "REDIS_URL",
          path: "src/cache.js",
          line: 2
        }
      ],
      changedFiles: ["src/billing.js"],
      dockerfilePinned: true,
      lockfilePresent: true
    });

    expect(parsed.declaredRuntimeEngines.node?.value).toBe(">=20");
    expect(parsed.ciInstallCommands[0].command).toBe("npm ci");
  });

  it("round-trips a prevention report through the new DevGuard note markers", () => {
    const payload = preventionReportSchema.parse({
      reportVersion: "2.0",
      runId: createRunId("reproguard"),
      projectPath: "demo/billing-service",
      mergeRequestId: 42,
      mrIid: 42,
      generatedAt: "2026-03-18T13:00:00.000Z",
      summary: {
        hypothesisCount: 1,
        topConcern: "Node mismatch between local and CI",
        ciFailureLikelihood: 0.94,
        reliabilityScore: 6,
        summary: "DevGuard formed one evidence-backed hypothesis."
      },
      executiveSummary: "DevGuard formed one evidence-backed hypothesis.",
      hypotheses: [
        {
          hypothesisId: "H1",
          category: "RUNTIME_MISMATCH",
          severity: "HIGH",
          confidence: 0.97,
          title: "Node mismatch between local and CI",
          claim: "Local Node is 20.11.0 while CI is node:18-alpine.",
          affectedFiles: ["src/billing.js"],
          evidence: [
            {
              path: ".gitlab-ci.yml",
              excerpt: "image: node:18-alpine",
              source: "config"
            }
          ],
          expectedFailureMode: "Tests fail because CI does not support the runtime API used by the merge request.",
          confirmatorySignal: "The job log shows a Node runtime API mismatch.",
          weakeningSignal: "The pipeline succeeds under the current CI image.",
          suggestedMitigation: "Update CI to node:20-alpine.",
          reasoningContext: {
            evidenceCount: 1,
            changedFileOverlap: true,
            signalSources: [".gitlab-ci.yml"]
          }
        }
      ],
      labelsToApply: [workflowLabels.warned]
    });

    const note = embedPayloadInNote(
      payload,
      noteEnvelopeMarkers.preventionReportStart,
      noteEnvelopeMarkers.preventionReportEnd
    );

    const extracted = extractEmbeddedPayload(
      note,
      noteEnvelopeMarkers.preventionReportStart,
      noteEnvelopeMarkers.preventionReportEnd,
      preventionReportSchema
    );

    expect(extracted?.hypotheses[0].hypothesisId).toBe("H1");
    expect(riskReportArtifactPath(42)).toContain("risk-report.json");
  });

  it("normalizes a legacy risk payload into hypotheses", () => {
    const legacyNote = [
      noteEnvelopeMarkers.legacyRiskReportStart,
      JSON.stringify({
        runId: createRunId("reproguard"),
        projectPath: "demo/billing-service",
        mrIid: 77,
        generatedAt: "2026-03-18T13:00:00.000Z",
        summary: "Found one likely CI failure.",
        risks: [
          {
            riskId: "R1",
            type: "GHOST_VARIABLE",
            severity: "HIGH",
            confidence: 0.9,
            title: "Undeclared environment variable: STRIPE_API_KEY",
            description: "STRIPE_API_KEY is referenced in code but not declared.",
            affectedFiles: ["src/billing.js"],
            evidence: [
              {
                path: "src/billing.js",
                line: 4,
                excerpt: "STRIPE_API_KEY"
              }
            ],
            suggestedFix: "Declare STRIPE_API_KEY in .env.example."
          }
        ],
        labelsToApply: [workflowLabels.warned]
      }, null, 2),
      noteEnvelopeMarkers.legacyRiskReportEnd
    ].join("\n");

    const extracted = extractPreventionReportFromNote(legacyNote);

    expect(extracted?.hypotheses).toHaveLength(1);
    expect(extracted?.hypotheses[0].category).toBe("GHOST_VARIABLE");
    expect(extracted?.hypotheses[0].expectedFailureMode).toContain("Runtime failure");
  });
});
