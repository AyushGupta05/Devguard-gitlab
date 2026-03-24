/**
 * DevGuard autonomous runner.
 *
 * Give it a URL (or local path). It clones the repo if needed, reads the codebase,
 * installs dependencies, and tells you exactly what it could not do automatically —
 * the env vars, secrets, and services you need to provide.
 *
 * It runs "safe" commands automatically (clone, install, copy .env template).
 * It stops only when it hits something that genuinely requires a human:
 *   - A required env var with no default or template value
 *   - A service that isn't running (Redis, Postgres, etc.)
 *   - A command that failed and could not be auto-recovered
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";

import { buildLocalSetupPlan } from "./bootstrap.js";
import { detectServiceDependencies, type ServiceRequirement } from "./services.js";
import { parseRepositorySource } from "./remote-bootstrap.js";

export type RunStepStatus = "success" | "failed" | "skipped" | "needs-input" | "recovered";

export type RunStep = {
  id: string;
  label: string;
  command: string;
  status: RunStepStatus;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  recoveryNote?: string;
};

export type RequiredInput = {
  /** What type of input is needed */
  type: "env_var" | "secret" | "service" | "manual";
  name: string;
  description: string;
  /** A safe example value (never the real secret) */
  example?: string;
  source: string;
};

export type CodebaseContext = {
  /** Project name from package.json / pyproject.toml */
  projectName: string;
  /** One-line description from package.json/pyproject.toml, or inferred */
  description: string;
  /** Primary framework detected (express, nextjs, fastapi, django, etc.) */
  framework: string | null;
  /** Main entry point file, if detectable */
  entryPoint: string | null;
  /** Detected language / runtime */
  stack: string;
};

export type ReadinessScore = {
  /** 0–100 */
  score: number;
  /** How many checks passed */
  passed: number;
  /** Total checks run */
  total: number;
  /** Short labels for what passed/failed */
  breakdown: Array<{ label: string; met: boolean }>;
};

export type RunReport = {
  runId: string;
  repoUrl: string;
  repositoryRoot: string;
  overallStatus: "ready" | "partial" | "blocked" | "failed";
  steps: RunStep[];
  /** Things DevGuard could not provide automatically — must come from the user */
  requiredFromUser: RequiredInput[];
  services: ServiceRequirement[];
  /** What the project is and what it uses */
  context: CodebaseContext;
  /** How complete the environment is (0–100) */
  readiness: ReadinessScore;
  /** Plain-English summary */
  summary: string;
};

export type RunOptions = {
  /** GitHub/GitLab URL or local path */
  repoUrl: string;
  /** Where to clone repos (default: ./clones) */
  workspaceRoot?: string;
  /** Env vars the user has already provided — DevGuard will write them to .env */
  providedEnv?: Record<string, string>;
  /** If true, also run the verify (test) command. Default: true */
  runVerify?: boolean;
};

const SAFE_COMMAND_PATTERNS = [
  /^git\s+clone\b/,
  /^npm\s+(install|ci|run\s+build)\b/,
  /^pnpm\s+(install|run\s+build)\b/,
  /^yarn\s+(install|build)\b/,
  /^pip\s+install\b/,
  /^pip3\s+install\b/,
  /^poetry\s+install\b/,
  /^cp\s+\.env\.example\s+\.env\b/,
  /^cp\s+\.env\.sample\s+\.env\b/,
  /^nvm\s+use\b/,
  /^pyenv\s+local\b/
];

function isSafeCommand(command: string): boolean {
  return SAFE_COMMAND_PATTERNS.some((p) => p.test(command.trim()));
}

export async function run(options: RunOptions): Promise<RunReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? "clones");
  const runVerify = options.runVerify !== false;
  const steps: RunStep[] = [];
  const requiredFromUser: RequiredInput[] = [];

  // -------------------------------------------------------------------------
  // 1. Clone (or use existing)
  // -------------------------------------------------------------------------
  const source = parseRepositorySource(options.repoUrl);
  const repositoryRoot = join(workspaceRoot, source.provider, source.owner, source.name);
  const isLocal = source.provider === "unknown";

  const effectiveRoot = isLocal
    ? resolve(source.cloneUrl)
    : repositoryRoot;

  if (!isLocal && !existsSync(join(effectiveRoot, ".git"))) {
    mkdirSync(workspaceRoot, { recursive: true });
    const cloneStep = await execStep({
      id: "clone",
      label: `Clone ${source.owner}/${source.name}`,
      command: `git clone ${source.cloneUrl} "${effectiveRoot}"`,
      workdir: workspaceRoot
    });
    steps.push(cloneStep);

    if (cloneStep.status === "failed") {
      const failContext: CodebaseContext = { projectName: source.name, description: "Repository could not be cloned", framework: null, entryPoint: null, stack: "unknown" };
      const failReadiness: ReadinessScore = { score: 0, passed: 0, total: 1, breakdown: [{ label: "Repository accessible", met: false }] };
      return makeReport({
        runId: makeRunId(),
        repoUrl: options.repoUrl,
        repositoryRoot: effectiveRoot,
        overallStatus: "failed",
        steps,
        requiredFromUser,
        services: [],
        context: failContext,
        readiness: failReadiness,
        summary: `Clone failed: ${extractError(cloneStep.stderr)}`
      });
    }
  }

  // -------------------------------------------------------------------------
  // 2. Read the repository — build setup plan + detect services + codebase context
  // -------------------------------------------------------------------------
  const plan = buildLocalSetupPlan({
    rootDir: effectiveRoot,
    projectPath: `${source.owner}/${source.name}`
  });

  const services = detectServiceDependencies(effectiveRoot);
  const context = readCodebaseContext(effectiveRoot, plan.detectedStack);

  // -------------------------------------------------------------------------
  // 3. Environment setup — copy .env.example if no .env exists
  // -------------------------------------------------------------------------
  const envFilePath = join(effectiveRoot, ".env");
  const envExamplePath = join(effectiveRoot, ".env.example");

  if (!existsSync(envFilePath) && existsSync(envExamplePath)) {
    try {
      writeFileSync(envFilePath, readFileSync(envExamplePath, "utf8"));
      steps.push({
        id: "env-copy",
        label: "Copy .env.example to .env",
        command: "(internal copy)",
        status: "success",
        stdout: ".env created from .env.example",
        stderr: "",
        exitCode: 0
      });
    } catch (err) {
      steps.push({
        id: "env-copy",
        label: "Copy .env.example to .env",
        command: "(internal copy)",
        status: "failed",
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1
      });
    }
  }

  // -------------------------------------------------------------------------
  // 4. Write user-provided env vars into .env
  // -------------------------------------------------------------------------
  if (options.providedEnv && Object.keys(options.providedEnv).length > 0) {
    try {
      const existing = existsSync(envFilePath)
        ? readFileSync(envFilePath, "utf8")
        : "";
      const additions = Object.entries(options.providedEnv)
        .filter(([k]) => !existing.includes(`${k}=`))
        .map(([k, v]) => `${k}=${v}`)
        .join("\n");
      if (additions) {
        writeFileSync(envFilePath, existing.trimEnd() + "\n" + additions + "\n");
      }
      steps.push({
        id: "env-inject",
        label: "Inject provided env vars into .env",
        command: "(internal)",
        status: "success",
        stdout: `Wrote: ${Object.keys(options.providedEnv).join(", ")}`,
        stderr: "",
        exitCode: 0
      });
    } catch (err) {
      steps.push({
        id: "env-inject",
        label: "Inject provided env vars into .env",
        command: "(internal)",
        status: "failed",
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        exitCode: 1
      });
    }
  }

  // -------------------------------------------------------------------------
  // 5. Collect missing required env vars before running anything
  // -------------------------------------------------------------------------
  const missingVars = plan.environmentVariables.filter((v) => {
    if (!v.required) return false;
    if (options.providedEnv?.[v.name]) return false;
    // Check if it's already in .env
    if (existsSync(envFilePath)) {
      const envContent = readFileSync(envFilePath, "utf8");
      // Only missing if the variable has no value (either missing or empty)
      const match = envContent.match(new RegExp(`^${v.name}=(.*)$`, "m"));
      if (match && match[1].trim() !== "") return false;
    }
    return true;
  });

  for (const v of missingVars) {
    requiredFromUser.push({
      type: guessVarType(v.name),
      name: v.name,
      description: `${v.name} is referenced in code but has no value in .env.`,
      example: buildVarExample(v.name),
      source: "code analysis"
    });
  }

  // Services not covered by docker-compose
  for (const svc of services) {
    if (!svc.coveredByDockerCompose) {
      requiredFromUser.push({
        type: "service",
        name: svc.name,
        description: `The application requires a running ${svc.type} instance (port ${svc.defaultPort ?? "unknown"}).`,
        source: svc.source,
        example: svc.suggestion
      });
    }
  }

  // -------------------------------------------------------------------------
  // 6. Proactive runtime version switching (before install)
  // -------------------------------------------------------------------------
  for (const hint of plan.runtimeHints) {
    let runtimeCmd: string | null = null;
    if (hint.tool === "node") {
      runtimeCmd = `nvm use ${hint.value} 2>/dev/null || nvm use --lts 2>/dev/null || true`;
    } else if (hint.tool === "python") {
      runtimeCmd = `pyenv local ${hint.value} 2>/dev/null || true`;
    }
    if (runtimeCmd) {
      const runtimeStep = await execStep({
        id: `runtime-${hint.tool}`,
        label: `Switch ${hint.tool} to ${hint.value} (from ${hint.source})`,
        command: runtimeCmd,
        workdir: effectiveRoot
      });
      // Runtime switch failures are non-fatal — we note them and continue
      steps.push({ ...runtimeStep, status: runtimeStep.exitCode === 0 ? "success" : "skipped" });
    }
  }

  // -------------------------------------------------------------------------
  // 7. Install dependencies
  // -------------------------------------------------------------------------
  for (const cmd of plan.installCommands) {
    if (!isSafeCommand(cmd.command)) {
      steps.push(makeSkippedStep(cmd.command, "not a recognized safe install command"));
      continue;
    }

    const installStep = await execStep({
      id: `install-${slugify(cmd.command)}`,
      label: cmd.command,
      command: cmd.command,
      workdir: effectiveRoot
    });

    if (installStep.status === "failed") {
      const recovery = attemptInstallRecovery(installStep, plan.runtimeHints);
      if (recovery) {
        const recoveryStep = await execStep({
          id: `${installStep.id}-recovery`,
          label: `Recovery: ${recovery.command}`,
          command: recovery.command,
          workdir: effectiveRoot
        });
        steps.push({ ...recoveryStep, recoveryNote: recovery.note });

        // Retry original install
        if (recoveryStep.status === "success") {
          const retryStep = await execStep({
            id: `${installStep.id}-retry`,
            label: `Retry: ${cmd.command}`,
            command: cmd.command,
            workdir: effectiveRoot
          });
          steps.push({ ...retryStep, recoveryNote: "Retried after recovery" });
          if (retryStep.status === "failed") {
            steps.push({ ...installStep, status: "failed" });
            break;
          }
          steps.push({ ...installStep, status: "recovered", recoveryNote: recovery.note });
        } else {
          steps.push({ ...installStep, status: "failed" });
          break;
        }
      } else {
        steps.push(installStep);
        // Don't abort entirely — report but continue to surface all issues
      }
    } else {
      steps.push(installStep);
    }
  }

  // -------------------------------------------------------------------------
  // 8. Verify (run tests) — only if no unresolved blockers for env vars
  // -------------------------------------------------------------------------
  if (runVerify && missingVars.length === 0) {
    for (const cmd of plan.verificationCommands) {
      const verifyStep = await execStep({
        id: `verify-${slugify(cmd.command)}`,
        label: cmd.command,
        command: cmd.command,
        workdir: effectiveRoot
      });

      if (verifyStep.status === "failed") {
        // Try once to recover: re-install then re-test
        const recovery = attemptVerifyRecovery(verifyStep);
        if (recovery) {
          const recoveryStep = await execStep({
            id: `${verifyStep.id}-recovery`,
            label: `Recovery: ${recovery.command}`,
            command: recovery.command,
            workdir: effectiveRoot
          });
          steps.push({ ...recoveryStep, recoveryNote: recovery.note });

          if (recoveryStep.status === "success") {
            const retryStep = await execStep({
              id: `${verifyStep.id}-retry`,
              label: `Retry: ${cmd.command}`,
              command: cmd.command,
              workdir: effectiveRoot
            });
            steps.push({ ...retryStep, recoveryNote: "Retried after recovery" });
          } else {
            steps.push({ ...verifyStep, status: "failed" });
          }
        } else {
          steps.push(verifyStep);
        }
      } else {
        steps.push(verifyStep);
      }
    }
  } else if (runVerify && missingVars.length > 0) {
    steps.push(makeSkippedStep(
      plan.verificationCommands[0]?.command ?? "npm test",
      `Skipped — ${missingVars.length} required env var(s) not set: ${missingVars.map((v) => v.name).join(", ")}`
    ));
  }

  // -------------------------------------------------------------------------
  // 9. Determine overall status, readiness score, and build report
  // -------------------------------------------------------------------------
  const failedSteps = steps.filter((s) => s.status === "failed");
  const needsInput = requiredFromUser.length > 0;

  const overallStatus = failedSteps.length > 0 && needsInput ? "blocked"
    : failedSteps.length > 0 ? "failed"
    : needsInput ? "partial"
    : "ready";

  const readiness = buildReadinessScore(steps, requiredFromUser, services, plan);
  const summary = buildSummary(overallStatus, steps, requiredFromUser, services, plan);

  return makeReport({
    runId: makeRunId(),
    repoUrl: options.repoUrl,
    repositoryRoot: effectiveRoot,
    overallStatus,
    steps,
    requiredFromUser,
    services,
    context,
    readiness,
    summary
  });
}

export function formatRunReport(report: RunReport): string {
  const lines: string[] = ["## DevGuard Run Report", ""];

  const statusIcon = {
    ready: "✅",
    partial: "⚠️",
    blocked: "🔴",
    failed: "❌"
  }[report.overallStatus];

  lines.push(`**Status:** ${statusIcon} ${report.overallStatus.toUpperCase()}`);
  lines.push(`**Repository:** ${report.repoUrl}`);
  lines.push(`**Local path:** ${report.repositoryRoot}`);
  lines.push("");
  lines.push(report.summary);

  // Codebase context
  lines.push("");
  lines.push("### Project");
  lines.push(`**${report.context.projectName}** — ${report.context.description}`);
  lines.push(`Stack: ${report.context.stack}${report.context.framework ? ` · ${report.context.framework}` : ""}${report.context.entryPoint ? ` · entry: ${report.context.entryPoint}` : ""}`);

  // Readiness score
  lines.push("");
  lines.push("### Readiness");
  const bar = buildProgressBar(report.readiness.score);
  lines.push(`${bar} **${report.readiness.score}%** (${report.readiness.passed}/${report.readiness.total} checks passed)`);
  for (const check of report.readiness.breakdown) {
    lines.push(`  ${check.met ? "✅" : "❌"} ${check.label}`);
  }

  if (report.requiredFromUser.length > 0) {
    lines.push("");
    lines.push("### Required from you");
    for (const item of report.requiredFromUser) {
      const icon = item.type === "secret" ? "🔑" : item.type === "service" ? "🗄" : "📋";
      lines.push(`${icon} **${item.name}** — ${item.description}`);
      if (item.example) lines.push(`   → ${item.example}`);
    }
  }

  if (report.services.length > 0) {
    lines.push("");
    lines.push("### Service dependencies detected");
    for (const svc of report.services) {
      const status = svc.coveredByDockerCompose ? "covered by docker-compose" : "⚠️ must be started manually";
      lines.push(`- **${svc.type}** (port ${svc.defaultPort ?? "unknown"}) — ${status} — from ${svc.source}`);
      if (!svc.coveredByDockerCompose) lines.push(`  ${svc.suggestion}`);
    }
  }

  if (report.steps.length > 0) {
    lines.push("");
    lines.push("### Steps");
    for (const step of report.steps) {
      const icon = { success: "✅", failed: "❌", skipped: "⏭", "needs-input": "⏸", recovered: "♻️" }[step.status];
      lines.push(`${icon} \`${step.command}\``);
      if (step.recoveryNote) lines.push(`   ↩️ ${step.recoveryNote}`);
      if (step.status === "failed" && step.stderr) {
        const shortErr = step.stderr.split("\n").find((l) => l.trim()) ?? step.stderr.slice(0, 120);
        lines.push(`   Error: ${shortErr}`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ExecOptions = { id: string; label: string; command: string; workdir: string };

async function execStep(opts: ExecOptions): Promise<RunStep> {
  return new Promise((resolve) => {
    const child = spawn(opts.command, {
      cwd: opts.workdir,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });

    child.on("error", (err) => {
      resolve({ id: opts.id, label: opts.label, command: opts.command, status: "failed", stdout, stderr: err.message, exitCode: 1 });
    });

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolve({
        id: opts.id,
        label: opts.label,
        command: opts.command,
        status: exitCode === 0 ? "success" : "failed",
        stdout,
        stderr,
        exitCode
      });
    });
  });
}

function makeSkippedStep(command: string, reason: string): RunStep {
  return { id: `skip-${slugify(command)}`, label: command, command, status: "skipped", stdout: "", stderr: reason, exitCode: null };
}

type RecoveryResult = { command: string; note: string } | null;

function attemptInstallRecovery(step: RunStep, runtimeHints: Array<{ tool: string; value: string; source: string }>): RecoveryResult {
  const combined = `${step.stdout}\n${step.stderr}`;

  // Missing module → re-install
  if (/cannot find module|module not found/i.test(combined)) {
    return { command: "npm install", note: "Retried install after module-not-found error" };
  }

  // Node version mismatch from engine check
  if (/unsupported engine|engine node/i.test(combined)) {
    const nodeHint = runtimeHints.find((h) => h.tool === "node");
    if (nodeHint) {
      return {
        command: `nvm use ${nodeHint.value} 2>/dev/null || true`,
        note: `Attempted to switch Node to ${nodeHint.value} per .nvmrc`
      };
    }
  }

  // EACCES permission error — try with --prefix workaround
  if (/EACCES/i.test(combined)) {
    return {
      command: "npm install --prefer-offline 2>/dev/null || npm install",
      note: "Permission error — retried with offline flag"
    };
  }

  return null;
}

function attemptVerifyRecovery(step: RunStep): RecoveryResult {
  const combined = `${step.stdout}\n${step.stderr}`;

  if (/cannot find module|module not found/i.test(combined)) {
    return { command: "npm install", note: "Re-installed dependencies before retrying tests" };
  }

  return null;
}

function extractError(stderr: string): string {
  return stderr.split("\n").find((l) => l.trim().length > 0) ?? "unknown error";
}

function guessVarType(name: string): RequiredInput["type"] {
  if (/key|secret|token|password|pwd|credential|private/i.test(name)) return "secret";
  return "env_var";
}

function buildVarExample(name: string): string {
  if (/url/i.test(name)) return `${name}=postgres://localhost:5432/mydb`;
  if (/port/i.test(name)) return `${name}=3000`;
  if (/key|token/i.test(name)) return `${name}=<your-key-here>`;
  if (/secret|password/i.test(name)) return `${name}=<your-secret-here>`;
  return `${name}=`;
}

function buildSummary(
  status: RunReport["overallStatus"],
  steps: RunStep[],
  required: RequiredInput[],
  services: ServiceRequirement[],
  plan: { detectedStack: string; confidence: number }
): string {
  const succeeded = steps.filter((s) => s.status === "success" || s.status === "recovered").length;
  const failed = steps.filter((s) => s.status === "failed").length;
  const secrets = required.filter((r) => r.type === "secret").length;
  const envVars = required.filter((r) => r.type === "env_var").length;
  const manualServices = services.filter((s) => !s.coveredByDockerCompose).length;

  if (status === "ready") {
    return `All ${succeeded} steps completed. Stack: ${plan.detectedStack}. Repository is ready to use.`;
  }
  if (status === "partial") {
    return `${succeeded} steps completed. Waiting on ${required.length} input(s) from you before the full setup can finish.`;
  }
  if (status === "blocked") {
    return `${failed} step(s) failed and ${required.length} input(s) are still needed. Provide the required values and re-run.`;
  }
  return [
    `${failed} step(s) failed.`,
    secrets > 0 ? `${secrets} secret(s) needed.` : "",
    envVars > 0 ? `${envVars} env var(s) needed.` : "",
    manualServices > 0 ? `${manualServices} service(s) must be started manually.` : ""
  ].filter(Boolean).join(" ");
}

function makeReport(data: RunReport): RunReport {
  return data;
}

function makeRunId() {
  return `devguard-run-${Date.now().toString(36)}`;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

// ---------------------------------------------------------------------------
// Codebase context
// ---------------------------------------------------------------------------

function readCodebaseContext(rootDir: string, stack: string): CodebaseContext {
  let projectName = "unknown";
  let description = "No description found";
  let framework: string | null = null;
  let entryPoint: string | null = null;

  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, unknown>;
      if (typeof pkg.name === "string") projectName = pkg.name;
      if (typeof pkg.description === "string" && pkg.description) description = pkg.description;

      const deps: Record<string, string> = {
        ...(typeof pkg.dependencies === "object" && pkg.dependencies !== null ? pkg.dependencies as Record<string, string> : {}),
        ...(typeof pkg.devDependencies === "object" && pkg.devDependencies !== null ? pkg.devDependencies as Record<string, string> : {})
      };

      framework = detectFramework(deps);

      const scripts = typeof pkg.scripts === "object" && pkg.scripts !== null ? pkg.scripts as Record<string, string> : {};
      if (scripts.start) entryPoint = resolveEntryPoint(rootDir, scripts.start);
      else if (scripts.dev) entryPoint = resolveEntryPoint(rootDir, scripts.dev);
    } catch { /* ignore parse errors */ }
  }

  const pyprojectPath = join(rootDir, "pyproject.toml");
  if (stack === "python" && existsSync(pyprojectPath)) {
    const content = readFileSync(pyprojectPath, "utf8");
    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
    const descMatch = content.match(/^description\s*=\s*"([^"]+)"/m);
    if (nameMatch) projectName = nameMatch[1];
    if (descMatch) description = descMatch[1];
    if (/fastapi/i.test(content)) framework = "fastapi";
    else if (/django/i.test(content)) framework = "django";
    else if (/flask/i.test(content)) framework = "flask";
  }

  return { projectName, description, framework, entryPoint, stack };
}

function detectFramework(deps: Record<string, string>): string | null {
  if (deps["next"]) return "Next.js";
  if (deps["nuxt"] || deps["nuxt3"]) return "Nuxt";
  if (deps["@remix-run/node"] || deps["@remix-run/react"]) return "Remix";
  if (deps["gatsby"]) return "Gatsby";
  if (deps["express"]) return "Express";
  if (deps["fastify"]) return "Fastify";
  if (deps["koa"]) return "Koa";
  if (deps["hono"]) return "Hono";
  if (deps["nestjs"] || deps["@nestjs/core"]) return "NestJS";
  if (deps["react"] && !deps["next"]) return "React";
  if (deps["vue"] && !deps["nuxt"]) return "Vue";
  if (deps["svelte"]) return "Svelte";
  if (deps["@angular/core"]) return "Angular";
  return null;
}

function resolveEntryPoint(rootDir: string, startScript: string): string | null {
  const match = startScript.match(/node\s+([^\s]+)/);
  if (match && existsSync(join(rootDir, match[1]))) return match[1];
  for (const candidate of ["src/index.ts", "src/index.js", "index.ts", "index.js", "app.ts", "app.js", "server.ts", "server.js"]) {
    if (existsSync(join(rootDir, candidate))) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Readiness score
// ---------------------------------------------------------------------------

function buildReadinessScore(
  steps: RunStep[],
  required: RequiredInput[],
  services: ServiceRequirement[],
  plan: { runtimeHints: Array<{ tool: string; value: string; source: string }>; installCommands: Array<unknown>; verificationCommands: Array<unknown> }
): ReadinessScore {
  const breakdown: Array<{ label: string; met: boolean }> = [];

  // Runtime version pinned
  const runtimePinned = plan.runtimeHints.length > 0;
  breakdown.push({ label: "Runtime version pinned (.nvmrc / .python-version / engines)", met: runtimePinned });

  // Dependencies installed
  const installSucceeded = steps.some((s) => s.id.startsWith("install") && (s.status === "success" || s.status === "recovered"));
  const installAttempted = steps.some((s) => s.id.startsWith("install"));
  breakdown.push({ label: "Dependencies installed", met: installAttempted ? installSucceeded : plan.installCommands.length === 0 });

  // All required env vars satisfied
  const secretsOk = required.filter((r) => r.type === "secret" || r.type === "env_var").length === 0;
  breakdown.push({ label: "All required env vars / secrets provided", met: secretsOk });

  // External services covered
  const servicesOk = services.every((s) => s.coveredByDockerCompose);
  breakdown.push({ label: "External services covered (docker-compose or provided)", met: servicesOk || services.length === 0 });

  // .env file exists
  const envInjected = steps.some((s) => (s.id === "env-copy" || s.id === "env-inject") && s.status === "success");
  const noEnvNeeded = required.filter((r) => r.type === "env_var" || r.type === "secret").length === 0;
  breakdown.push({ label: ".env file ready", met: envInjected || noEnvNeeded });

  // Verification passed
  const verifyPassed = steps.some((s) => s.id.startsWith("verify") && (s.status === "success" || s.status === "recovered"));
  const verifySkipped = steps.some((s) => s.id.startsWith("skip") && s.label.includes("test"));
  breakdown.push({ label: "Tests / verify passed", met: verifyPassed && !verifySkipped });

  const passed = breakdown.filter((c) => c.met).length;
  const total = breakdown.length;
  const score = Math.round((passed / total) * 100);

  return { score, passed, total, breakdown };
}

function buildProgressBar(score: number): string {
  const filled = Math.round(score / 10);
  return `[${"█".repeat(filled)}${"░".repeat(10 - filled)}]`;
}
