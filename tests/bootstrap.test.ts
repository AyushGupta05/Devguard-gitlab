import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildLocalSetupPlan,
  formatLocalSetupGuide
} from "../src/index.js";

describe("itworkshere bootstrap planning", () => {
  it("builds a local setup plan from README and repository files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "itworkshere-readme-"));

    try {
      writeFileSync(join(rootDir, "README.md"), [
        "# Demo App",
        "",
        "```bash",
        "npm install",
        "cp .env.example .env",
        "npm run dev",
        "npm test",
        "```"
      ].join("\n"));
      writeFileSync(join(rootDir, ".nvmrc"), "20.11.0\n");
      writeFileSync(join(rootDir, ".env.example"), "PORT=3000\nAPI_BASE_URL=http://localhost:4000\n");
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "demo-app",
        private: true,
        scripts: {
          dev: "node server.js",
          test: "node --test"
        },
        engines: {
          node: ">=20"
        }
      }, null, 2));
      writeFileSync(join(rootDir, "server.js"), "console.log(process.env.PORT);");

      const plan = buildLocalSetupPlan({
        rootDir,
        projectPath: "demo-app"
      });

      expect(plan.detectedStack).toBe("node");
      expect(plan.installCommands[0]?.command).toBe("npm install");
      expect(plan.startCommands[0]?.command).toBe("npm run dev");
      expect(plan.verificationCommands[0]?.command).toBe("npm test");
      expect(plan.environmentVariables.some((variable) => variable.name === "PORT")).toBe(true);
      expect(plan.blockers).toHaveLength(0);
      expect(formatLocalSetupGuide(plan)).toContain("ItWorksHere - Local Setup Plan");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("surfaces blockers when a repository is missing local setup guidance", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "itworkshere-blockers-"));

    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "broken-app",
        private: true,
        scripts: {
          test: "node --test"
        }
      }, null, 2));
      writeFileSync(join(rootDir, "server.js"), "console.log(process.env.SECRET_KEY);");

      const plan = buildLocalSetupPlan({
        rootDir,
        projectPath: "broken-app"
      });

      expect(plan.blockers.some((blocker) => blocker.includes("README.md"))).toBe(true);
      expect(plan.blockers.some((blocker) => blocker.includes(".env.example"))).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
