import { describe, expect, it } from "vitest";

import {
  collectEnvironmentMap,
  detectDeterministicSignals,
  summarizeEnvironmentMap
} from "../src/reproguard/scanners.js";

describe("reproguard deterministic scanners", () => {
  it("maps the fixture environment", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 7,
      changedFiles: ["src/billing.js"]
    });

    expect(environmentMap.localRuntimes.node?.value).toBe("20.11.0");
    expect(environmentMap.ciRuntimes.node?.value).toBe("18-alpine");
    expect(environmentMap.envExampleKeys).not.toContain("REDIS_URL");
    expect(environmentMap.codeVariableReferences.some((reference) => reference.variable === "REDIS_URL")).toBe(true);
    expect(summarizeEnvironmentMap(environmentMap)).toContain("MR !7");
  });

  it("detects the fixture runtime mismatch and ghost variable", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 7,
      changedFiles: ["src/billing.js"]
    });

    const signals = detectDeterministicSignals(environmentMap);

    expect(signals.some((signal) => signal.type === "RUNTIME_MISMATCH")).toBe(true);
    expect(signals.some((signal) => signal.type === "GHOST_VARIABLE")).toBe(true);
  });
});
