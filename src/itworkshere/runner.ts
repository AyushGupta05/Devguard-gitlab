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
  type: "env_var" | "secret" | "service" | "manual";
  name: string;
  description: string;
  example?: string;
  source: string;
};

export type CodebaseContext = {
  projectName: string;
  description: string;
  framework: string | null;
  entryPoint: string | null;
  stack: string;
};

export type ReadinessScore = {
  score: number;
  passed: number;
  total: number;
  breakdown: Array<{ label: string; met: boolean }>;
};

export type RunReport = {
  runId: string;
  repoUrl: string;
  repositoryRoot: string;
  overallStatus: "ready" | "partial" | "blocked" | "failed";
  steps: RunStep[];
  requiredFromUser: RequiredInput[];
  services: ServiceRequirement[];
  context: CodebaseContext;
  readiness: ReadinessScore;
  summary: string;
};

export type RunOptions = {
  repoUrl: string;
  workspaceRoot?: string;
  providedEnv?: Record<string, string>;
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
  return SAFE_COMMAND_PATTERNS.some((pattern) => pattern.test(command.trim()));
}

export async function run(options: RunOptions): Promise<RunReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? "clones");
  const runVerify = options.runVerify !== false;
  const steps: RunStep[] = [];
  const requiredFromUser: RequiredInput[] = [];

  const source = parseRepositorySource(options.repoUrl);
  const repositoryRoot = join(workspaceRoot, source.provider, source.owner, source.name);
  const isLocal = source.provider === "unknown";
  const effectiveRoot = isLocal ? resolve(source.cloneUrl) : repositoryRoot;

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
      const failContext: CodebaseContext = {
        projectName: source.name,
        description: "Repository could not be cloned",
        framework: null,
        entryPoint: null,
        stack: "unknown"
      };
      const failReadiness: ReadinessScore = {
        score: 0,
        passed: 0,
        total: 1,
        breakdown: [{ label: "Repository accessible", met: false }]
      };
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

  const plan = buildLocalSetupPlan({
    rootDir: effectiveRoot,
    projectPath: `${source.owner}/${source.name}`
  });

  const services = detectServiceDependencies(effectiveRoot);
  const context = readCodebaseContext(effectiveRoot, plan.detectedStack);

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
    } catch (error) {
      steps.push({
        id: "env-copy",
        label: "Copy .env.example to .env",
        command: "(internal copy)",
        status: "failed",
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1
      });
    }
  }

  if (options.providedEnv && Object.keys(options.providedEnv).length > 0) {
    try {
      const existing = existsSync(envFilePath) ? readFileSync(envFilePath, "utf8") : "";
      const additions = Object.entries(options.providedEnv)
        .filter(([key]) => !existing.includes(`${key}=`))
        .map(([key, value]) => `${key}=${value}`)
        .join("\n");

      if (additions) {
        const prefix = existing.trimEnd();
        writeFileSync(envFilePath, prefix ? `${prefix}\n${additions}\n` : `${additions}\n`);
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
    } catch (error) {
      steps.push({
        id: "env-inject",
        label: "Inject provided env vars into .env",
        command: "(internal)",
        status: "failed",
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: 1
      });
    }
  }

  const missingVars = plan.environmentVariables.filter((variable) => {
    if (!variable.required) {
      return false;
    }

    if (options.providedEnv?.[variable.name]) {
      return false;
    }

    if (existsSync(envFilePath)) {
      const envContent = readFileSync(envFilePath, "utf8");
      const match = envContent.match(new RegExp(`^${variable.name}=(.*)$`, "m"));
      if (match && match[1].trim() !== "") {
        return false;
      }
    }

    return true;
  });

  for (const variable of missingVars) {
    requiredFromUser.push({
      type: guessVarType(variable.name),
      name: variable.name,
      description: `${variable.name} is referenced in code but has no value in .env.`,
      example: buildVarExample(variable.name),
      source: "code analysis"
    });
  }

  for (const service of services) {
    if (!service.coveredByDockerCompose) {
      requiredFromUser.push({
        type: "service",
        name: service.name,
        description: `The application requires a running ${service.type} instance (port ${service.defaultPort ?? "unknown"}).`,
        source: service.source,
        example: service.suggestion
      });
    }
  }

  for (const hint of plan.runtimeHints) {
    let runtimeCommand: string | null = null;
    if (hint.tool === "node") {
      runtimeCommand = `nvm use ${hint.value} 2>/dev/null || nvm use --lts 2>/dev/null || true`;
    } else if (hint.tool === "python") {
      runtimeCommand = `pyenv local ${hint.value} 2>/dev/null || true`;
    }

    if (runtimeCommand) {
      const runtimeStep = await execStep({
        id: `runtime-${hint.tool}`,
        label: `Switch ${hint.tool} to ${hint.value} (from ${hint.source})`,
        command: runtimeCommand,
        workdir: effectiveRoot
      });
      steps.push({
        ...runtimeStep,
        status: runtimeStep.exitCode === 0 ? "success" : "skipped"
      });
    }
  }

  for (const command of plan.installCommands) {
    if (!isSafeCommand(command.command)) {
      steps.push(makeSkippedStep(command.command, "not a recognized safe install command"));
      continue;
    }

    const installStep = await execStep({
      id: `install-${slugify(command.command)}`,
      label: command.command,
      command: command.command,
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

        if (recoveryStep.status === "success") {
          const retryStep = await execStep({
            id: `${installStep.id}-retry`,
            label: `Retry: ${command.command}`,
            command: command.command,
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
      }
    } else {
      steps.push(installStep);
    }
  }

  if (runVerify && missingVars.length === 0) {
    for (const command of plan.verificationCommands) {
      const verifyStep = await execStep({
        id: `verify-${slugify(command.command)}`,
        label: command.command,
        command: command.command,
        workdir: effectiveRoot
      });

      if (verifyStep.status === "failed") {
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
              label: `Retry: ${command.command}`,
              command: command.command,
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
    steps.push(
      makeSkippedStep(
        plan.verificationCommands[0]?.command ?? "npm test",
        `Skipped because required env vars are still missing: ${missingVars.map((variable) => variable.name).join(", ")}`
      )
    );
  }

  const failedSteps = steps.filter((step) => step.status === "failed");
  const needsInput = requiredFromUser.length > 0;

  const overallStatus = failedSteps.length > 0 && needsInput
    ? "blocked"
    : failedSteps.length > 0
      ? "failed"
      : needsInput
        ? "partial"
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

  lines.push(`Status: ${report.overallStatus.toUpperCase()}`);
  lines.push(`Repository: ${report.repoUrl}`);
  lines.push(`Local path: ${report.repositoryRoot}`);
  lines.push("");
  lines.push(report.summary);

  lines.push("");
  lines.push("### Project");
  lines.push(`Name: ${report.context.projectName}`);
  lines.push(`Description: ${report.context.description}`);
  lines.push(
    `Stack: ${report.context.stack}${report.context.framework ? ` | ${report.context.framework}` : ""}${report.context.entryPoint ? ` | entry: ${report.context.entryPoint}` : ""}`
  );

  lines.push("");
  lines.push("### Readiness");
  lines.push(`${buildProgressBar(report.readiness.score)} ${report.readiness.score}% (${report.readiness.passed}/${report.readiness.total} checks passed)`);
  for (const check of report.readiness.breakdown) {
    lines.push(`- ${check.met ? "PASS" : "FAIL"} ${check.label}`);
  }

  if (report.requiredFromUser.length > 0) {
    lines.push("");
    lines.push("### Required from you");
    for (const item of report.requiredFromUser) {
      lines.push(`- ${item.name} [${item.type}] ${item.description}`);
      if (item.example) {
        lines.push(`  Example: ${item.example}`);
      }
    }
  }

  if (report.services.length > 0) {
    lines.push("");
    lines.push("### Service dependencies detected");
    for (const service of report.services) {
      const status = service.coveredByDockerCompose ? "covered by docker-compose" : "start manually";
      lines.push(`- ${service.type} (port ${service.defaultPort ?? "unknown"}) | ${status} | ${service.source}`);
      if (!service.coveredByDockerCompose) {
        lines.push(`  ${service.suggestion}`);
      }
    }
  }

  if (report.steps.length > 0) {
    lines.push("");
    lines.push("### Steps");
    for (const step of report.steps) {
      lines.push(`- ${step.status.toUpperCase()} \`${step.command}\``);
      if (step.recoveryNote) {
        lines.push(`  Recovery: ${step.recoveryNote}`);
      }
      if (step.status === "failed" && step.stderr) {
        const shortError = step.stderr.split("\n").find((line) => line.trim()) ?? step.stderr.slice(0, 120);
        lines.push(`  Error: ${shortError}`);
      }
    }
  }

  return lines.join("\n");
}

type ExecOptions = {
  id: string;
  label: string;
  command: string;
  workdir: string;
};

async function execStep(options: ExecOptions): Promise<RunStep> {
  return new Promise((resolvePromise) => {
    const child = spawn(options.command, {
      cwd: options.workdir,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolvePromise({
        id: options.id,
        label: options.label,
        command: options.command,
        status: "failed",
        stdout,
        stderr: error.message,
        exitCode: 1
      });
    });

    child.on("close", (code) => {
      const exitCode = code ?? 1;
      resolvePromise({
        id: options.id,
        label: options.label,
        command: options.command,
        status: exitCode === 0 ? "success" : "failed",
        stdout,
        stderr,
        exitCode
      });
    });
  });
}

function makeSkippedStep(command: string, reason: string): RunStep {
  return {
    id: `skip-${slugify(command)}`,
    label: command,
    command,
    status: "skipped",
    stdout: "",
    stderr: reason,
    exitCode: null
  };
}

type RecoveryResult = {
  command: string;
  note: string;
} | null;

function attemptInstallRecovery(
  step: RunStep,
  runtimeHints: Array<{ tool: string; value: string; source: string }>
): RecoveryResult {
  const combined = `${step.stdout}\n${step.stderr}`;

  if (/cannot find module|module not found/i.test(combined)) {
    return { command: "npm install", note: "Retried install after module-not-found error" };
  }

  if (/unsupported engine|engine node/i.test(combined)) {
    const nodeHint = runtimeHints.find((hint) => hint.tool === "node");
    if (nodeHint) {
      return {
        command: `nvm use ${nodeHint.value} 2>/dev/null || true`,
        note: `Attempted to switch Node to ${nodeHint.value} per repository hints`
      };
    }
  }

  if (/EACCES/i.test(combined)) {
    return {
      command: "npm install --prefer-offline 2>/dev/null || npm install",
      note: "Permission error detected, retried with offline-preferred install"
    };
  }

  return null;
}

function attemptVerifyRecovery(step: RunStep): RecoveryResult {
  const combined = `${step.stdout}\n${step.stderr}`;

  if (/cannot find module|module not found/i.test(combined)) {
    return {
      command: "npm install",
      note: "Re-installed dependencies before retrying verification"
    };
  }

  return null;
}

function extractError(stderr: string): string {
  return stderr.split("\n").find((line) => line.trim().length > 0) ?? "unknown error";
}

function guessVarType(name: string): RequiredInput["type"] {
  if (/key|secret|token|password|pwd|credential|private/i.test(name)) {
    return "secret";
  }

  return "env_var";
}

function buildVarExample(name: string): string {
  if (/url/i.test(name)) {
    return `${name}=postgres://localhost:5432/mydb`;
  }

  if (/port/i.test(name)) {
    return `${name}=3000`;
  }

  if (/key|token/i.test(name)) {
    return `${name}=<your-key-here>`;
  }

  if (/secret|password/i.test(name)) {
    return `${name}=<your-secret-here>`;
  }

  return `${name}=`;
}

function buildSummary(
  status: RunReport["overallStatus"],
  steps: RunStep[],
  required: RequiredInput[],
  services: ServiceRequirement[],
  plan: { detectedStack: string }
): string {
  const succeeded = steps.filter((step) => step.status === "success" || step.status === "recovered").length;
  const failed = steps.filter((step) => step.status === "failed").length;
  const secrets = required.filter((item) => item.type === "secret").length;
  const envVars = required.filter((item) => item.type === "env_var").length;
  const manualServices = services.filter((service) => !service.coveredByDockerCompose).length;

  if (status === "ready") {
    return `All ${succeeded} setup steps completed. Stack: ${plan.detectedStack}. Repository is ready to use.`;
  }

  if (status === "partial") {
    return `${succeeded} setup steps completed. Waiting on ${required.length} user-provided input(s) before the environment is fully runnable.`;
  }

  if (status === "blocked") {
    return `${failed} setup step(s) failed and ${required.length} input(s) are still needed. Provide the missing values and rerun.`;
  }

  return [
    `${failed} setup step(s) failed.`,
    secrets > 0 ? `${secrets} secret(s) still needed.` : "",
    envVars > 0 ? `${envVars} environment variable(s) still needed.` : "",
    manualServices > 0 ? `${manualServices} service(s) must be started manually.` : ""
  ].filter(Boolean).join(" ");
}

function makeReport(report: RunReport): RunReport {
  return report;
}

function makeRunId() {
  return `devguard-run-${Date.now().toString(36)}`;
}

function slugify(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function readCodebaseContext(rootDir: string, stack: string): CodebaseContext {
  let projectName = "unknown";
  let description = "No description found";
  let framework: string | null = null;
  let entryPoint: string | null = null;

  const packageJsonPath = join(rootDir, "package.json");
  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as Record<string, unknown>;
      if (typeof packageJson.name === "string") {
        projectName = packageJson.name;
      }
      if (typeof packageJson.description === "string" && packageJson.description) {
        description = packageJson.description;
      }

      const dependencies: Record<string, string> = {
        ...(typeof packageJson.dependencies === "object" && packageJson.dependencies !== null
          ? packageJson.dependencies as Record<string, string>
          : {}),
        ...(typeof packageJson.devDependencies === "object" && packageJson.devDependencies !== null
          ? packageJson.devDependencies as Record<string, string>
          : {})
      };

      framework = detectFramework(dependencies);

      const scripts = typeof packageJson.scripts === "object" && packageJson.scripts !== null
        ? packageJson.scripts as Record<string, string>
        : {};

      if (scripts.start) {
        entryPoint = resolveEntryPoint(rootDir, scripts.start);
      } else if (scripts.dev) {
        entryPoint = resolveEntryPoint(rootDir, scripts.dev);
      }
    } catch {
      // Ignore package parsing errors in context formatting.
    }
  }

  const pyprojectPath = join(rootDir, "pyproject.toml");
  if (stack === "python" && existsSync(pyprojectPath)) {
    const content = readFileSync(pyprojectPath, "utf8");
    const nameMatch = content.match(/^name\s*=\s*"([^"]+)"/m);
    const descriptionMatch = content.match(/^description\s*=\s*"([^"]+)"/m);
    if (nameMatch) {
      projectName = nameMatch[1];
    }
    if (descriptionMatch) {
      description = descriptionMatch[1];
    }
    if (/fastapi/i.test(content)) {
      framework = "FastAPI";
    } else if (/django/i.test(content)) {
      framework = "Django";
    } else if (/flask/i.test(content)) {
      framework = "Flask";
    }
  }

  return { projectName, description, framework, entryPoint, stack };
}

function detectFramework(dependencies: Record<string, string>): string | null {
  if (dependencies.next) return "Next.js";
  if (dependencies.nuxt || dependencies.nuxt3) return "Nuxt";
  if (dependencies["@remix-run/node"] || dependencies["@remix-run/react"]) return "Remix";
  if (dependencies.gatsby) return "Gatsby";
  if (dependencies.express) return "Express";
  if (dependencies.fastify) return "Fastify";
  if (dependencies.koa) return "Koa";
  if (dependencies.hono) return "Hono";
  if (dependencies.nestjs || dependencies["@nestjs/core"]) return "NestJS";
  if (dependencies.react && !dependencies.next) return "React";
  if (dependencies.vue && !dependencies.nuxt) return "Vue";
  if (dependencies.svelte) return "Svelte";
  if (dependencies["@angular/core"]) return "Angular";
  return null;
}

function resolveEntryPoint(rootDir: string, startScript: string): string | null {
  const match = startScript.match(/node\s+([^\s]+)/);
  if (match && existsSync(join(rootDir, match[1]))) {
    return match[1];
  }

  for (const candidate of [
    "src/index.ts",
    "src/index.js",
    "index.ts",
    "index.js",
    "app.ts",
    "app.js",
    "server.ts",
    "server.js"
  ]) {
    if (existsSync(join(rootDir, candidate))) {
      return candidate;
    }
  }

  return null;
}

function buildReadinessScore(
  steps: RunStep[],
  required: RequiredInput[],
  services: ServiceRequirement[],
  plan: {
    runtimeHints: Array<{ tool: string; value: string; source: string }>;
    installCommands: Array<unknown>;
    verificationCommands: Array<unknown>;
  }
): ReadinessScore {
  const breakdown: Array<{ label: string; met: boolean }> = [];

  const runtimePinned = plan.runtimeHints.length > 0;
  breakdown.push({ label: "Runtime version pinned", met: runtimePinned });

  const installSucceeded = steps.some((step) => step.id.startsWith("install") && (step.status === "success" || step.status === "recovered"));
  const installAttempted = steps.some((step) => step.id.startsWith("install"));
  breakdown.push({
    label: "Dependencies installed",
    met: installAttempted ? installSucceeded : plan.installCommands.length === 0
  });

  const envSatisfied = required.filter((item) => item.type === "secret" || item.type === "env_var").length === 0;
  breakdown.push({ label: "All required env vars and secrets provided", met: envSatisfied });

  const servicesCovered = services.every((service) => service.coveredByDockerCompose);
  breakdown.push({
    label: "External services covered",
    met: servicesCovered || services.length === 0
  });

  const envPrepared = steps.some((step) => (step.id === "env-copy" || step.id === "env-inject") && step.status === "success");
  const noEnvNeeded = required.filter((item) => item.type === "env_var" || item.type === "secret").length === 0;
  breakdown.push({ label: ".env file ready", met: envPrepared || noEnvNeeded });

  const verifyPassed = steps.some((step) => step.id.startsWith("verify") && (step.status === "success" || step.status === "recovered"));
  const verifySkipped = steps.some((step) => step.id.startsWith("skip") && step.label.includes("test"));
  breakdown.push({ label: "Verification passed", met: verifyPassed && !verifySkipped });

  const passed = breakdown.filter((check) => check.met).length;
  const total = breakdown.length;
  const score = Math.round((passed / total) * 100);

  return { score, passed, total, breakdown };
}

function buildProgressBar(score: number): string {
  const filled = Math.round(score / 10);
  return `[${"#".repeat(filled)}${".".repeat(10 - filled)}]`;
}
