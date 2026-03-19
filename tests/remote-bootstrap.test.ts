import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  buildRemoteBootstrapSession,
  executeApprovedCommands,
  formatRemoteBootstrapSession,
  parseRepositorySource
} from "../src/index.js";

describe("remote bootstrap session", () => {
  it("parses github and gitlab repository URLs", () => {
    const github = parseRepositorySource("https://github.com/openai/openai-cookbook");
    const gitlab = parseRepositorySource("https://gitlab.com/gitlab-org/gitlab");

    expect(github.provider).toBe("github");
    expect(github.owner).toBe("openai");
    expect(github.name).toBe("openai-cookbook");
    expect(gitlab.provider).toBe("gitlab");
    expect(gitlab.owner).toBe("gitlab-org");
    expect(gitlab.name).toBe("gitlab");
  });

  it("creates an approval-gated session before clone", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "itwh-session-"));

    try {
      const session = buildRemoteBootstrapSession({
        repoUrl: "https://github.com/openai/openai-cookbook",
        workspaceRoot
      });

      expect(session.cloneRequired).toBe(true);
      expect(session.commandRequests[0]?.id).toBe("clone");
      expect(formatRemoteBootstrapSession(session)).toContain("approval required");
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("can clone a local git repository after clone approval", async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "itwh-source-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "itwh-clones-"));

    try {
      writeFileSync(join(sourceRoot, "README.md"), [
        "# Local Demo",
        "",
        "```bash",
        "npm install",
        "npm run dev",
        "npm test",
        "```"
      ].join("\n"));
      writeFileSync(join(sourceRoot, ".env.example"), "PORT=3000\n");
      writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({
        name: "local-demo",
        private: true,
        scripts: {
          dev: "node server.js",
          test: "node --test"
        }
      }, null, 2));
      writeFileSync(join(sourceRoot, "server.js"), "console.log(process.env.PORT);");

      execFileSync("git", ["init"], { cwd: sourceRoot });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sourceRoot });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: sourceRoot });
      execFileSync("git", ["add", "."], { cwd: sourceRoot });
      execFileSync("git", ["commit", "-m", "init"], { cwd: sourceRoot });

      const session = buildRemoteBootstrapSession({
        repoUrl: sourceRoot,
        workspaceRoot
      });

      const executed = await executeApprovedCommands({
        session,
        approvals: ["clone"]
      });

      expect(executed.cloneRequired).toBe(false);
      expect(executed.localSetupPlan?.installCommands[0]?.command).toBe("npm install");
      expect(executed.commandRequests.some((request) => request.id === "clone" && request.status === "completed")).toBe(true);
      expect(executed.commandRequests.some((request) => request.id.startsWith("install-"))).toBe(true);
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it("can continue into approved follow-up commands after clone", async () => {
    const sourceRoot = mkdtempSync(join(tmpdir(), "itwh-source-install-"));
    const workspaceRoot = mkdtempSync(join(tmpdir(), "itwh-clones-install-"));

    try {
      writeFileSync(join(sourceRoot, "README.md"), [
        "# Local Demo",
        "",
        "```bash",
        "npm install",
        "npm test",
        "```"
      ].join("\n"));
      writeFileSync(join(sourceRoot, "package.json"), JSON.stringify({
        name: "local-demo",
        private: true,
        scripts: {
          test: "node --test"
        }
      }, null, 2));
      writeFileSync(join(sourceRoot, "package-lock.json"), JSON.stringify({
        name: "local-demo",
        lockfileVersion: 3,
        requires: true,
        packages: {
          "": {
            name: "local-demo",
            private: true
          }
        }
      }, null, 2));
      writeFileSync(join(sourceRoot, "index.test.js"), "console.log('ok');");

      execFileSync("git", ["init"], { cwd: sourceRoot });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: sourceRoot });
      execFileSync("git", ["config", "user.name", "Test User"], { cwd: sourceRoot });
      execFileSync("git", ["add", "."], { cwd: sourceRoot });
      execFileSync("git", ["commit", "-m", "init"], { cwd: sourceRoot });

      const session = buildRemoteBootstrapSession({
        repoUrl: sourceRoot,
        workspaceRoot
      });

      const executed = await executeApprovedCommands({
        session,
        approvals: ["clone", "install-npm-install"]
      });

      const installRequest = executed.commandRequests.find((request) => request.id === "install-npm-install");
      expect(installRequest?.status).toBe("completed");
    } finally {
      rmSync(sourceRoot, { recursive: true, force: true });
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
