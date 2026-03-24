/**
 * Tests for the DevGuard autonomous runner and service dependency detection.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { run, formatRunReport } from "../src/itworkshere/runner.js";
import { detectServiceDependencies } from "../src/itworkshere/services.js";

// ---------------------------------------------------------------------------
// Service dependency detection
// ---------------------------------------------------------------------------

describe("detectServiceDependencies", () => {
  it("detects Redis from ioredis in package.json", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-svc-"));
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "my-app",
        dependencies: { ioredis: "^5.0.0", express: "^4.0.0" }
      }));

      const services = detectServiceDependencies(rootDir);
      const redis = services.find((s) => s.type === "redis");
      expect(redis).toBeDefined();
      expect(redis!.defaultPort).toBe(6379);
      expect(redis!.coveredByDockerCompose).toBe(false);
      expect(redis!.suggestion).toContain("redis");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("detects Postgres from pg in package.json", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-pg-"));
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "my-app",
        dependencies: { pg: "^8.0.0" }
      }));

      const services = detectServiceDependencies(rootDir);
      const pg = services.find((s) => s.type === "postgres");
      expect(pg).toBeDefined();
      expect(pg!.defaultPort).toBe(5432);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("marks a service as coveredByDockerCompose when docker-compose.yml defines it", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-dc-"));
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "my-app",
        dependencies: { ioredis: "^5.0.0" }
      }));
      writeFileSync(join(rootDir, "docker-compose.yml"), [
        "services:",
        "  redis:",
        "    image: redis:alpine",
        "    ports:",
        "      - '6379:6379'"
      ].join("\n"));

      const services = detectServiceDependencies(rootDir);
      const redis = services.find((s) => s.type === "redis");
      expect(redis).toBeDefined();
      expect(redis!.coveredByDockerCompose).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("returns empty array when no services are needed", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-no-svc-"));
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "my-app",
        dependencies: { lodash: "^4.0.0" }
      }));

      const services = detectServiceDependencies(rootDir);
      expect(services).toHaveLength(0);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Autonomous runner — local path mode
// ---------------------------------------------------------------------------

describe("run() with local repository", () => {
  it("runs install and verify on a minimal Node project", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-run-"));
    try {
      writeFileSync(join(rootDir, "README.md"), [
        "# Test app",
        "",
        "```bash",
        "npm install",
        "npm test",
        "```"
      ].join("\n"));
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "test-app",
        private: true,
        scripts: { test: "node -e \"console.log('ok')\"" }
      }, null, 2));
      writeFileSync(join(rootDir, "package-lock.json"), JSON.stringify({
        name: "test-app",
        lockfileVersion: 3,
        packages: {}
      }, null, 2));

      const report = await run({ repoUrl: rootDir, runVerify: true });

      expect(report.overallStatus).toBe("ready");
      expect(report.steps.some((s) => s.id.startsWith("install"))).toBe(true);
      expect(report.steps.some((s) => s.id.startsWith("verify"))).toBe(true);
      expect(report.steps.every((s) => s.status === "success" || s.status === "recovered")).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("surfaces missing required env vars in requiredFromUser", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-env-"));
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "env-test",
        private: true,
        scripts: { test: "node -e \"console.log('ok')\"" }
      }, null, 2));
      writeFileSync(join(rootDir, "package-lock.json"), JSON.stringify({
        name: "env-test", lockfileVersion: 3, packages: {}
      }, null, 2));
      writeFileSync(join(rootDir, "index.js"), "const key = process.env.STRIPE_SECRET_KEY;\n");
      // No .env.example — so STRIPE_SECRET_KEY is undeclared

      const report = await run({ repoUrl: rootDir, runVerify: false });

      const stripeInput = report.requiredFromUser.find((r) => r.name === "STRIPE_SECRET_KEY");
      expect(stripeInput).toBeDefined();
      expect(stripeInput!.type).toBe("secret");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("copies .env.example to .env automatically", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-envcp-"));
    const { existsSync } = await import("node:fs");
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "env-copy-test", private: true, scripts: { test: "node -e \"process.exit(0)\"" }
      }, null, 2));
      writeFileSync(join(rootDir, "package-lock.json"), JSON.stringify({
        name: "env-copy-test", lockfileVersion: 3, packages: {}
      }, null, 2));
      writeFileSync(join(rootDir, ".env.example"), "PORT=3000\nNODE_ENV=development\n");

      await run({ repoUrl: rootDir, runVerify: false });

      expect(existsSync(join(rootDir, ".env"))).toBe(true);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("injects providedEnv values into .env before running", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-inject-"));
    const { readFileSync, existsSync } = await import("node:fs");
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "inject-test", private: true, scripts: { test: "node -e \"process.exit(0)\"" }
      }, null, 2));
      writeFileSync(join(rootDir, "package-lock.json"), JSON.stringify({
        name: "inject-test", lockfileVersion: 3, packages: {}
      }, null, 2));
      writeFileSync(join(rootDir, ".env.example"), "PORT=3000\n");
      writeFileSync(join(rootDir, "index.js"), "const key = process.env.API_KEY;\n");

      await run({
        repoUrl: rootDir,
        runVerify: false,
        providedEnv: { API_KEY: "test-key-123" }
      });

      const envContent = existsSync(join(rootDir, ".env"))
        ? readFileSync(join(rootDir, ".env"), "utf8")
        : "";
      expect(envContent).toContain("API_KEY=test-key-123");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("formatRunReport produces readable markdown", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-fmt-"));
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "fmt-test", private: true, scripts: { test: "node -e \"process.exit(0)\"" }
      }, null, 2));
      writeFileSync(join(rootDir, "package-lock.json"), JSON.stringify({
        name: "fmt-test", lockfileVersion: 3, packages: {}
      }, null, 2));

      const report = await run({ repoUrl: rootDir, runVerify: true });
      const formatted = formatRunReport(report);

      expect(formatted).toContain("## DevGuard Run Report");
      expect(formatted).toContain("Status:");
      expect(formatted).toContain("Steps");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("report includes codebase context with project name and framework", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-ctx-"));
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "my-express-api",
        description: "A REST API built with Express",
        private: true,
        scripts: { test: "node -e \"process.exit(0)\"" },
        dependencies: { express: "^4.18.0" }
      }, null, 2));
      writeFileSync(join(rootDir, "package-lock.json"), JSON.stringify({
        name: "my-express-api", lockfileVersion: 3, packages: {}
      }, null, 2));

      const report = await run({ repoUrl: rootDir, runVerify: false });

      expect(report.context.projectName).toBe("my-express-api");
      expect(report.context.description).toBe("A REST API built with Express");
      expect(report.context.framework).toBe("Express");
      expect(report.context.stack).toBe("node");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("report includes readiness score with breakdown", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-score-"));
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "score-test", private: true, scripts: { test: "node -e \"process.exit(0)\"" }
      }, null, 2));
      writeFileSync(join(rootDir, "package-lock.json"), JSON.stringify({
        name: "score-test", lockfileVersion: 3, packages: {}
      }, null, 2));
      writeFileSync(join(rootDir, ".env.example"), "PORT=3000\n");

      const report = await run({ repoUrl: rootDir, runVerify: false });

      expect(report.readiness.score).toBeGreaterThan(0);
      expect(report.readiness.score).toBeLessThanOrEqual(100);
      expect(report.readiness.total).toBeGreaterThan(0);
      expect(report.readiness.breakdown.length).toBe(report.readiness.total);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("formatRunReport includes readiness bar and project section", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "devguard-bar-"));
    try {
      writeFileSync(join(rootDir, "package.json"), JSON.stringify({
        name: "bar-test",
        description: "Test project",
        private: true,
        scripts: { test: "node -e \"process.exit(0)\"" }
      }, null, 2));
      writeFileSync(join(rootDir, "package-lock.json"), JSON.stringify({
        name: "bar-test", lockfileVersion: 3, packages: {}
      }, null, 2));

      const report = await run({ repoUrl: rootDir, runVerify: false });
      const formatted = formatRunReport(report);

      expect(formatted).toContain("### Project");
      expect(formatted).toContain("### Readiness");
      expect(formatted).toContain("%");
      expect(formatted).toContain("bar-test");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  }, 30_000);
});
