import { describe, expect, it } from "vitest";

import {
  createRunId,
  embedPayloadInNote,
  environmentMapSchema,
  extractEmbeddedPayload,
  noteEnvelopeMarkers,
  riskReportArtifactPath,
  riskReportSchema,
  workflowLabels
} from "../src/contracts.js";

describe("shared contracts", () => {
  it("validates an environment map shape", () => {
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
      ciRuntimes: {
        node: {
          source: ".gitlab-ci.yml",
          value: "18-alpine"
        }
      },
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
      dockerfilePinned: false,
      lockfilePresent: true
    });

    expect(parsed.localRuntimes.node?.value).toBe("20.11.0");
  });

  it("round-trips a risk report through note embedding", () => {
    const payload = riskReportSchema.parse({
      runId: createRunId("reproguard"),
      projectPath: "demo/billing-service",
      mrIid: 42,
      generatedAt: "2026-03-18T13:00:00.000Z",
      summary: "Found one likely CI failure.",
      risks: [
        {
          riskId: "R1",
          type: "RUNTIME_MISMATCH",
          severity: "HIGH",
          confidence: 0.97,
          title: "Node mismatch between local and CI",
          description: "Local Node is 20.11.0 while CI is node:18-alpine.",
          affectedFiles: ["src/billing.js"],
          evidence: [
            {
              path: ".gitlab-ci.yml",
              excerpt: "image: node:18-alpine"
            }
          ],
          suggestedFix: "Update CI to node:20-alpine."
        }
      ],
      labelsToApply: [workflowLabels.warned]
    });

    const note = embedPayloadInNote(
      payload,
      noteEnvelopeMarkers.riskReportStart,
      noteEnvelopeMarkers.riskReportEnd
    );

    const extracted = extractEmbeddedPayload(
      note,
      noteEnvelopeMarkers.riskReportStart,
      noteEnvelopeMarkers.riskReportEnd,
      riskReportSchema
    );

    expect(extracted?.risks[0].riskId).toBe("R1");
    expect(riskReportArtifactPath(42)).toBe("artifacts/reproguard/mr-42/risk-report.json");
  });
});
