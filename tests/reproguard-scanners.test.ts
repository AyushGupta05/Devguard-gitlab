import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  collectEnvironmentMap,
  detectDeterministicSignals,
  summarizeEnvironmentMap
} from "../src/reproguard/scanners.js";

describe("reproguard deterministic scanners", () => {
  it("maps the billing fixture environment", () => {
    const environmentMap = collectEnvironmentMap({
      rootDir: "fixtures/billing-service",
      projectPath: "fixtures/billing-service",
      mrIid: 7,
      changedFiles: ["src/billing.js"]
    });

    expect(environmentMap.localRuntimes.node?.value).toBe("20.11.0");
    expect(environmentMap.declaredRuntimeEngines.node?.value).toBe(">=20");
    expect(environmentMap.ciRuntimes.node?.value).toBe("18-alpine");
    expect(environmentMap.ciInstallCommands[0].command).toBe("npm ci");
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

    expect(signals.some((signal) => signal.category === "RUNTIME_MISMATCH")).toBe(true);
    expect(signals.some((signal) => signal.category === "GHOST_VARIABLE")).toBe(true);
  });

  it("detects a lockfile mismatch when CI and package manager disagree", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "reproguard-lockfile-"));

    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "lockfile-app",
        private: true,
        packageManager: "pnpm@9.0.0",
        engines: {
          node: ">=20"
        }
      }, null, 2));
      writeFileSync(join(rootDir, "package-lock.json"), "{}");
      writeFileSync(join(rootDir, ".gitlab-ci.yml"), [
        "image: node:20-alpine",
        "test:",
        "  script:",
        "    - npm ci"
      ].join("\n"));
      writeFileSync(join(rootDir, "index.js"), "console.log('ok');\n");

      const environmentMap = collectEnvironmentMap({
        rootDir,
        projectPath: "lockfile-app",
        mrIid: 9,
        changedFiles: ["index.js"]
      });

      const signals = detectDeterministicSignals(environmentMap);
      const lockfileSignal = signals.find((signal) => signal.category === "LOCKFILE_MISMATCH");

      expect(lockfileSignal).toBeDefined();
      expect(lockfileSignal?.expectedFailureMode).toContain("Dependency installation fails");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
