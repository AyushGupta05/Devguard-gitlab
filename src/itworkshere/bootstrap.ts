import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  createRunId,
  localSetupPlanSchema,
  type LocalSetupPlan
} from "../contracts.js";
import { collectEnvironmentMap } from "../reproguard/scanners.js";

type BuildLocalSetupPlanOptions = {
  rootDir: string;
  projectPath: string;
};

type PackageJson = {
  scripts?: Record<string, string>;
  engines?: Record<string, string>;
};

export function buildLocalSetupPlan(options: BuildLocalSetupPlanOptions): LocalSetupPlan {
  const readmePath = resolveReadmePath(options.rootDir);
  const readme = readmePath ? readFileSync(join(options.rootDir, readmePath), "utf8") : "";
  const shellBlocks = extractShellBlocks(readme);
  const readmeCommands = shellBlocks.flatMap(extractCommandsFromBlock);
  const packageJson = readPackageJson(options.rootDir);
  const environmentMap = collectEnvironmentMap({
    rootDir: options.rootDir,
    projectPath: options.projectPath,
    mrIid: 0,
    changedFiles: []
  });

  const packageManager = detectPackageManager(options.rootDir);
  const detectedStack = detectStack(options.rootDir);
  const installCommands = detectInstallCommands(readmeCommands, packageManager);
  const startCommands = detectStartCommands(readmeCommands, packageJson);
  const verificationCommands = detectVerificationCommands(readmeCommands, packageJson);
  const environmentVariables = buildEnvironmentVariables(environmentMap);
  const environmentCommands = buildEnvironmentCommands(environmentVariables, options.rootDir);
  const blockers = buildBootstrapBlockers({
    readmePath,
    installCommands,
    startCommands,
    environmentVariables,
    environmentMap
  });
  const assumptions = buildAssumptions({
    readmeCommands,
    installCommands,
    startCommands,
    verificationCommands
  });

  return localSetupPlanSchema.parse({
    runId: createRunId("itworkshere-local"),
    projectPath: options.projectPath,
    readmePath,
    detectedStack,
    runtimeHints: buildRuntimeHints(options.rootDir, packageJson),
    installCommands,
    startCommands,
    verificationCommands,
    environmentCommands,
    environmentVariables,
    blockers,
    assumptions,
    confidence: calculateConfidence({
      readmePath,
      blockers,
      assumptions
    })
  });
}

export function formatLocalSetupGuide(plan: LocalSetupPlan) {
  const lines = [
    "## ItWorksHere - Local Setup Plan",
    "",
    `Detected stack: ${plan.detectedStack}`,
    `Confidence: ${(plan.confidence * 100).toFixed(0)}%`
  ];

  if (plan.runtimeHints.length > 0) {
    lines.push("");
    lines.push("Runtime hints:");

    for (const hint of plan.runtimeHints) {
      lines.push(`- ${hint.tool}: ${hint.value} (${hint.source})`);
    }
  }

  if (plan.installCommands.length > 0) {
    lines.push("");
    lines.push("Install:");

    for (const step of plan.installCommands) {
      lines.push(`- ${step.command}`);
    }
  }

  if (plan.environmentCommands.length > 0) {
    lines.push("");
    lines.push("Environment:");

    for (const step of plan.environmentCommands) {
      lines.push(`- ${step.command}`);
    }
  }

  if (plan.startCommands.length > 0) {
    lines.push("");
    lines.push("Run:");

    for (const step of plan.startCommands) {
      lines.push(`- ${step.command}`);
    }
  }

  if (plan.verificationCommands.length > 0) {
    lines.push("");
    lines.push("Verify:");

    for (const step of plan.verificationCommands) {
      lines.push(`- ${step.command}`);
    }
  }

  if (plan.blockers.length > 0) {
    lines.push("");
    lines.push("Blockers:");

    for (const blocker of plan.blockers) {
      lines.push(`- ${blocker}`);
    }
  }

  if (plan.assumptions.length > 0) {
    lines.push("");
    lines.push("Assumptions:");

    for (const assumption of plan.assumptions) {
      lines.push(`- ${assumption}`);
    }
  }

  return lines.join("\n");
}

function resolveReadmePath(rootDir: string) {
  const candidates = ["README.md", "Readme.md", "readme.md"];

  for (const candidate of candidates) {
    if (existsSync(join(rootDir, candidate))) {
      return candidate;
    }
  }

  return null;
}

function extractShellBlocks(readme: string) {
  const blocks: string[] = [];
  const pattern = /```(?:bash|sh|shell|zsh)?\r?\n([\s\S]*?)```/g;

  for (const match of readme.matchAll(pattern)) {
    blocks.push(match[1]);
  }

  return blocks;
}

function extractCommandsFromBlock(block: string) {
  return block
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.replace(/^\$\s*/, ""));
}

function readPackageJson(rootDir: string): PackageJson | null {
  const packageJsonPath = join(rootDir, "package.json");

  if (!existsSync(packageJsonPath)) {
    return null;
  }

  return JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
}

function detectPackageManager(rootDir: string) {
  if (existsSync(join(rootDir, "package-lock.json"))) {
    return "npm";
  }

  if (existsSync(join(rootDir, "pnpm-lock.yaml"))) {
    return "pnpm";
  }

  if (existsSync(join(rootDir, "yarn.lock"))) {
    return "yarn";
  }

  return null;
}

function detectStack(rootDir: string): "node" | "python" | "unknown" {
  if (existsSync(join(rootDir, "package.json"))) {
    return "node";
  }

  if (
    existsSync(join(rootDir, "requirements.txt")) ||
    existsSync(join(rootDir, "pyproject.toml"))
  ) {
    return "python";
  }

  return "unknown";
}

function detectInstallCommands(readmeCommands: string[], packageManager: string | null) {
  const fromReadme = readmeCommands
    .filter((command) => /\b(install|ci|pip install|poetry install|pnpm install|yarn install)\b/i.test(command))
    .map((command) => ({
      command,
      purpose: "install" as const,
      source: "README"
    }));

  if (fromReadme.length > 0) {
    return fromReadme;
  }

  if (packageManager === "npm") {
    return [{
      command: "npm install",
      purpose: "install" as const,
      source: "package-lock.json"
    }];
  }

  if (packageManager === "pnpm") {
    return [{
      command: "pnpm install",
      purpose: "install" as const,
      source: "pnpm-lock.yaml"
    }];
  }

  if (packageManager === "yarn") {
    return [{
      command: "yarn install",
      purpose: "install" as const,
      source: "yarn.lock"
    }];
  }

  return [];
}

function detectStartCommands(readmeCommands: string[], packageJson: PackageJson | null) {
  const fromReadme = readmeCommands
    .filter((command) => /\b(run dev|run start|npm start|yarn start|pnpm start|docker compose up|docker-compose up|python .*\.py|uvicorn)\b/i.test(command))
    .map((command) => ({
      command,
      purpose: "start" as const,
      source: "README"
    }));

  if (fromReadme.length > 0) {
    return fromReadme;
  }

  if (packageJson?.scripts?.dev) {
    return [{
      command: "npm run dev",
      purpose: "start" as const,
      source: "package.json scripts.dev"
    }];
  }

  if (packageJson?.scripts?.start) {
    return [{
      command: "npm start",
      purpose: "start" as const,
      source: "package.json scripts.start"
    }];
  }

  return [];
}

function detectVerificationCommands(readmeCommands: string[], packageJson: PackageJson | null) {
  const fromReadme = readmeCommands
    .filter((command) => /\b(npm test|pnpm test|yarn test|pytest|go test|cargo test)\b/i.test(command))
    .map((command) => ({
      command,
      purpose: "verify" as const,
      source: "README"
    }));

  if (fromReadme.length > 0) {
    return fromReadme;
  }

  if (packageJson?.scripts?.test) {
    return [{
      command: "npm test",
      purpose: "verify" as const,
      source: "package.json scripts.test"
    }];
  }

  return [];
}

function buildEnvironmentVariables(environmentMap: ReturnType<typeof collectEnvironmentMap>) {
  const templated = new Set(environmentMap.envExampleKeys);
  const referenced = new Set(environmentMap.codeVariableReferences.map((entry) => entry.variable));

  return [...new Set([...templated, ...referenced])].map((name) => ({
    name,
    required: referenced.has(name),
    source: referenced.has(name) ? "code" : ".env.example",
    hasTemplate: templated.has(name)
  }));
}

function buildEnvironmentCommands(environmentVariables: LocalSetupPlan["environmentVariables"], rootDir: string) {
  const commands: LocalSetupPlan["environmentCommands"] = [];

  if (existsSync(join(rootDir, ".env.example"))) {
    commands.push({
      command: "cp .env.example .env",
      purpose: "environment",
      source: ".env.example"
    });
  }

  const missingTemplate = environmentVariables.filter((variable) => variable.required && !variable.hasTemplate);
  if (missingTemplate.length > 0) {
    commands.push({
      command: `Create .env entries for: ${missingTemplate.map((variable) => variable.name).join(", ")}`,
      purpose: "environment",
      source: "code analysis"
    });
  }

  return commands;
}

function buildBootstrapBlockers(input: {
  readmePath: string | null;
  installCommands: LocalSetupPlan["installCommands"];
  startCommands: LocalSetupPlan["startCommands"];
  environmentVariables: LocalSetupPlan["environmentVariables"];
  environmentMap: ReturnType<typeof collectEnvironmentMap>;
}) {
  const blockers: string[] = [];

  if (!input.readmePath) {
    blockers.push("No README.md found for local setup guidance.");
  }

  if (input.installCommands.length === 0) {
    blockers.push("No install command could be determined from the repository or README.");
  }

  if (input.startCommands.length === 0) {
    blockers.push("No start or dev command could be determined from the repository or README.");
  }

  if (
    input.environmentMap.codeVariableReferences.length > 0 &&
    input.environmentMap.envExampleKeys.length === 0
  ) {
    blockers.push("Code references environment variables but the repository does not provide a .env.example template.");
  }

  const missingTemplate = input.environmentVariables.filter((variable) => variable.required && !variable.hasTemplate);
  if (missingTemplate.length > 0) {
    blockers.push(`Required runtime variables are missing from .env.example: ${missingTemplate.map((variable) => variable.name).join(", ")}.`);
  }

  return blockers;
}

function buildAssumptions(input: {
  readmeCommands: string[];
  installCommands: LocalSetupPlan["installCommands"];
  startCommands: LocalSetupPlan["startCommands"];
  verificationCommands: LocalSetupPlan["verificationCommands"];
}) {
  const assumptions: string[] = [];

  if (input.readmeCommands.length === 0) {
    assumptions.push("No shell commands were found in README.md, so setup steps were inferred from repository files.");
  }

  if (input.startCommands.some((command) => command.source !== "README")) {
    assumptions.push("Start command was inferred from package metadata rather than an explicit README instruction.");
  }

  if (input.installCommands.some((command) => command.source !== "README")) {
    assumptions.push("Install command was inferred from lockfiles rather than an explicit README instruction.");
  }

  if (input.verificationCommands.length === 0) {
    assumptions.push("No verification command was found, so local startup can be planned but not automatically checked.");
  }

  return assumptions;
}

function calculateConfidence(input: {
  readmePath: string | null;
  blockers: string[];
  assumptions: string[];
}) {
  let confidence = input.readmePath ? 0.85 : 0.55;
  confidence -= input.blockers.length * 0.1;
  confidence -= input.assumptions.length * 0.03;

  return Math.max(0.2, Math.min(0.98, Number(confidence.toFixed(2))));
}

function buildRuntimeHints(rootDir: string, packageJson: PackageJson | null) {
  const hints: LocalSetupPlan["runtimeHints"] = [];

  if (existsSync(join(rootDir, ".nvmrc"))) {
    hints.push({
      tool: "node",
      value: readFileSync(join(rootDir, ".nvmrc"), "utf8").trim(),
      source: ".nvmrc"
    });
  }

  if (existsSync(join(rootDir, ".python-version"))) {
    hints.push({
      tool: "python",
      value: readFileSync(join(rootDir, ".python-version"), "utf8").trim(),
      source: ".python-version"
    });
  }

  if (packageJson?.engines?.node) {
    hints.push({
      tool: "node",
      value: packageJson.engines.node,
      source: "package.json engines.node"
    });
  }

  return hints;
}
