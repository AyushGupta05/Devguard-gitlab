import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { globSync } from "glob";
import YAML from "yaml";

import {
  createRunId,
  environmentMapSchema,
  type EnvironmentMap
} from "../contracts.js";

export type PreventionSignal = {
  category: typeof import("../contracts.js").riskTypes[number];
  severity: "LOW" | "MEDIUM" | "HIGH";
  confidence: number;
  title: string;
  claim: string;
  affectedFiles: string[];
  evidence: Array<{
    path: string;
    line?: number;
    excerpt?: string;
    source?: string;
  }>;
  expectedFailureMode: string;
  confirmatorySignal: string;
  weakeningSignal: string;
  suggestedMitigation: string;
};

type ScanOptions = {
  rootDir: string;
  projectPath: string;
  mrIid: number;
  changedFiles: string[];
  pipelineId?: number | null;
};

type GitLabCiConfig = {
  image?: string | { name?: string };
  variables?: Record<string, string>;
  [key: string]: unknown;
};

type PackageJsonShape = {
  engines?: { node?: string };
  packageManager?: string;
};

export function collectEnvironmentMap(options: ScanOptions): EnvironmentMap {
  const gitlabCiPath = join(options.rootDir, ".gitlab-ci.yml");
  const gitlabCiContents = existsSync(gitlabCiPath)
    ? readFileSync(gitlabCiPath, "utf8")
    : "";
  const gitlabCi = gitlabCiContents
    ? (YAML.parse(gitlabCiContents) as GitLabCiConfig)
    : {};

  const packageJsonPath = join(options.rootDir, "package.json");
  const packageJson = existsSync(packageJsonPath)
    ? JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJsonShape
    : {};

  const envExamplePath = join(options.rootDir, ".env.example");
  const envExample = existsSync(envExamplePath)
    ? readFileSync(envExamplePath, "utf8")
    : "";

  const sourceFiles = globSync("**/*.{js,jsx,ts,tsx}", {
    cwd: options.rootDir,
    ignore: [
      "node_modules/**",
      "dist/**",
      "coverage/**",
      "tests/**",
      "**/*.test.*",
      "**/*.spec.*"
    ]
  });

  const codeVariableReferences = sourceFiles.flatMap((filePath) => {
    const contents = readFileSync(join(options.rootDir, filePath), "utf8");
    return findProcessEnvReferences(contents).map((reference) => ({
      variable: reference.variable,
      path: filePath.replace(/\\/g, "/"),
      line: reference.line
    }));
  });

  return environmentMapSchema.parse({
    runId: createRunId("reproguard"),
    projectPath: options.projectPath,
    mrIid: options.mrIid,
    pipelineId: options.pipelineId ?? null,
    generatedAt: new Date().toISOString(),
    rootDir: options.rootDir,
    localRuntimes: {
      node: firstRuntimeValue(options.rootDir, [".nvmrc", ".node-version"]),
      python: runtimeValue(options.rootDir, ".python-version")
    },
    declaredRuntimeEngines: {
      node: packageJson.engines?.node
        ? {
            source: "package.json#engines.node",
            value: packageJson.engines.node
          }
        : undefined
    },
    ciRuntimes: {
      node: {
        source: ".gitlab-ci.yml",
        value: extractCiRuntime(gitlabCi)
      }
    },
    packageManager: packageJson.packageManager
      ? {
          source: "package.json#packageManager",
          value: packageJson.packageManager
        }
      : undefined,
    ciInstallCommands: parseCiInstallCommands(gitlabCiContents),
    lockfiles: detectLockfiles(options.rootDir),
    envExampleKeys: parseEnvKeys(envExample),
    ciVariableKeys: Object.keys(gitlabCi.variables ?? {}),
    codeVariableReferences,
    changedFiles: options.changedFiles,
    dockerfilePinned: detectDockerfilePinned(options.rootDir),
    lockfilePresent: detectLockfilePresence(options.rootDir)
  });
}

export function detectDeterministicSignals(environmentMap: EnvironmentMap): PreventionSignal[] {
  return [
    ...detectRuntimeMismatch(environmentMap),
    ...detectLockfileMismatch(environmentMap),
    ...detectGhostVariables(environmentMap),
    ...detectTimezoneAssumptions(environmentMap),
    ...detectDockerImageDrift(environmentMap),
    ...detectSecretLeaks(environmentMap)
  ];
}

export function detectRuntimeMismatch(environmentMap: EnvironmentMap): PreventionSignal[] {
  const localNode = environmentMap.localRuntimes.node?.value ?? environmentMap.declaredRuntimeEngines.node?.value;
  const ciNode = environmentMap.ciRuntimes.node?.value;

  if (!localNode || !ciNode) {
    return [];
  }

  const localMajor = extractMajor(localNode);
  const ciMajor = extractMajor(ciNode);

  if (!localMajor || !ciMajor || localMajor === ciMajor) {
    return [];
  }

  return [
    {
      category: "RUNTIME_MISMATCH",
      severity: "HIGH",
      confidence: confidenceFromRuntimeEvidence(environmentMap),
      title: `Node runtime mismatch: local ${localNode} vs CI ${ciNode}`,
      claim: `The merge request is likely to fail in CI because the repository expects Node ${localNode} locally while the GitLab pipeline runs Node ${ciNode}.`,
      affectedFiles: environmentMap.changedFiles,
      evidence: [
        {
          path: environmentMap.localRuntimes.node?.source ?? environmentMap.declaredRuntimeEngines.node?.source ?? ".nvmrc",
          excerpt: localNode,
          source: "config"
        },
        {
          path: environmentMap.ciRuntimes.node?.source ?? ".gitlab-ci.yml",
          excerpt: ciNode,
          source: "config"
        }
      ],
      expectedFailureMode: "Install, build, or test steps fail because CI lacks the Node runtime expected by the changed code or dependency graph.",
      confirmatorySignal: "Job logs mention unsupported Node engines, missing newer runtime APIs, or package install failures under the current CI image.",
      weakeningSignal: "The pipeline completes successfully under the current CI image despite the version mismatch.",
      suggestedMitigation: `Update CI to a Node ${localMajor} image, such as node:${localMajor}-alpine.`
    }
  ];
}

export function detectLockfileMismatch(environmentMap: EnvironmentMap): PreventionSignal[] {
  const lockfiles = environmentMap.lockfiles;
  const packageManager = environmentMap.packageManager?.value ?? "";
  const nodeProject = Boolean(
    environmentMap.ciRuntimes.node?.value ||
    environmentMap.localRuntimes.node?.value ||
    environmentMap.packageManager?.value
  );

  if (!nodeProject) {
    return [];
  }

  const hasPackageLock = lockfiles.includes("package-lock.json");
  const hasYarnLock = lockfiles.includes("yarn.lock");
  const hasPnpmLock = lockfiles.includes("pnpm-lock.yaml");
  const npmCommand = environmentMap.ciInstallCommands.find((command) => /\bnpm\s+(ci|install)\b/i.test(command.command));

  if (packageManager.startsWith("pnpm@") && hasPackageLock && !hasPnpmLock) {
    return [
      buildLockfileSignal({
        confidence: 0.89,
        title: "Package manager says pnpm, but the repository only carries npm lockfile state",
        claim: "The project declares pnpm in package.json, but the repository does not contain pnpm-lock.yaml. CI is likely to install dependencies with a mismatched lockfile.",
        evidence: [
          {
            path: environmentMap.packageManager?.source ?? "package.json",
            excerpt: packageManager,
            source: "config"
          },
          {
            path: "package-lock.json",
            excerpt: "package-lock.json present",
            source: "config"
          }
        ],
        suggestedMitigation: "Commit pnpm-lock.yaml or align package.json and CI with the package manager you actually use."
      })
    ];
  }

  if (npmCommand && !hasPackageLock) {
    return [
      buildLockfileSignal({
        confidence: lockfiles.length === 0 ? 0.91 : 0.87,
        title: "CI runs npm, but the repository does not provide package-lock.json",
        claim: "The GitLab pipeline uses npm install commands without a matching npm lockfile, which makes dependency installation fail or drift between runs.",
        evidence: [
          {
            path: npmCommand.path,
            line: npmCommand.line,
            excerpt: npmCommand.command,
            source: "config"
          },
          {
            path: lockfiles[0] ?? "repository root",
            excerpt: lockfiles.length === 0 ? "No lockfile present" : `Present lockfiles: ${lockfiles.join(", ")}`,
            source: "config"
          }
        ],
        suggestedMitigation: hasYarnLock || hasPnpmLock
          ? "Either commit package-lock.json or update .gitlab-ci.yml to use the package manager that matches the committed lockfile."
          : "Commit a package-lock.json or switch CI to the package manager that matches the repository."
      })
    ];
  }

  if (lockfiles.length === 0) {
    return [
      buildLockfileSignal({
        confidence: 0.76,
        title: "Node project has no committed lockfile",
        claim: "The repository looks like a Node project, but no package lockfile is committed. CI dependency resolution is likely to drift or fail unexpectedly.",
        evidence: [
          {
            path: "repository root",
            excerpt: "No package-lock.json, yarn.lock, or pnpm-lock.yaml found",
            source: "config"
          }
        ],
        suggestedMitigation: "Commit the lockfile generated by your package manager before merging."
      })
    ];
  }

  return [];
}

export function detectGhostVariables(environmentMap: EnvironmentMap): PreventionSignal[] {
  const declared = new Set([
    ...environmentMap.envExampleKeys,
    ...environmentMap.ciVariableKeys
  ]);

  return environmentMap.codeVariableReferences
    .filter((reference) => !declared.has(reference.variable))
    .map((reference) => ({
      category: "GHOST_VARIABLE" as const,
      severity: isSensitiveVariable(reference.variable) ? "HIGH" as const : "MEDIUM" as const,
      confidence: isSensitiveVariable(reference.variable) ? 0.91 : 0.8,
      title: `Undeclared environment variable: ${reference.variable}`,
      claim: `${reference.variable} is referenced by the changed code path, but it is not declared in .env.example or GitLab CI variables.`,
      affectedFiles: [reference.path],
      evidence: [
        {
          path: reference.path,
          line: reference.line,
          excerpt: reference.variable,
          source: "code"
        }
      ],
      expectedFailureMode: "The pipeline reaches runtime and throws because a required environment variable is missing from the CI environment.",
      confirmatorySignal: `Job logs mention ${reference.variable} being missing, undefined, or required at runtime.`,
      weakeningSignal: `${reference.variable} is present in the effective CI variables and the failing job does not reference it.`,
      suggestedMitigation: `Declare ${reference.variable} in .env.example and in GitLab CI/CD variables if it is required at runtime.`
    }));
}

export function summarizeEnvironmentMap(environmentMap: EnvironmentMap) {
  const nodeSummary = [
    environmentMap.localRuntimes.node?.value
      ? `local Node ${environmentMap.localRuntimes.node.value}`
      : environmentMap.declaredRuntimeEngines.node?.value
        ? `declared Node ${environmentMap.declaredRuntimeEngines.node.value}`
        : "local Node unknown",
    environmentMap.ciRuntimes.node?.value
      ? `CI Node ${environmentMap.ciRuntimes.node.value}`
      : "CI Node unknown"
  ].join(", ");

  return `${environmentMap.projectPath} MR !${environmentMap.mrIid}: ${nodeSummary}; ${environmentMap.codeVariableReferences.length} env references scanned.`;
}

function runtimeValue(rootDir: string, relativePath: string) {
  const absolutePath = join(rootDir, relativePath);

  if (!existsSync(absolutePath)) {
    return undefined;
  }

  return {
    source: relativePath.replace(/\\/g, "/"),
    value: readFileSync(absolutePath, "utf8").trim() || null
  };
}

function firstRuntimeValue(rootDir: string, relativePaths: string[]) {
  for (const relativePath of relativePaths) {
    const runtime = runtimeValue(rootDir, relativePath);
    if (runtime) {
      return runtime;
    }
  }

  return undefined;
}

function extractCiRuntime(config: GitLabCiConfig) {
  if (typeof config.image === "string") {
    return config.image.replace(/^node:/, "");
  }

  if (typeof config.image === "object" && config.image?.name) {
    return config.image.name.replace(/^node:/, "");
  }

  return null;
}

function parseEnvKeys(contents: string) {
  return contents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .map((line) => line.slice(0, line.indexOf("=")));
}

function detectLockfilePresence(rootDir: string) {
  return detectLockfiles(rootDir).length > 0;
}

function detectLockfiles(rootDir: string) {
  return ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"].filter((name) =>
    existsSync(join(rootDir, name))
  );
}

function detectDockerfilePinned(rootDir: string) {
  const dockerfilePath = join(rootDir, "Dockerfile");

  if (!existsSync(dockerfilePath)) {
    return true;
  }

  const contents = readFileSync(dockerfilePath, "utf8");
  const fromLine = contents
    .split(/\r?\n/)
    .find((line) => line.trim().toUpperCase().startsWith("FROM "));

  if (!fromLine) {
    return true;
  }

  return !/:latest\b/i.test(fromLine);
}

function extractMajor(runtime: string) {
  const match = runtime.match(/(\d{1,2})/);
  return match ? Number(match[1]) : null;
}

function confidenceFromRuntimeEvidence(environmentMap: EnvironmentMap) {
  let confidence = 0.74;

  if (environmentMap.localRuntimes.node?.value) {
    confidence += 0.1;
  }

  if (environmentMap.declaredRuntimeEngines.node?.value) {
    confidence += 0.05;
  }

  if (environmentMap.changedFiles.length > 0) {
    confidence += 0.05;
  }

  return Math.min(0.97, confidence);
}

function buildLockfileSignal(input: {
  confidence: number;
  title: string;
  claim: string;
  evidence: PreventionSignal["evidence"];
  suggestedMitigation: string;
}): PreventionSignal {
  return {
    category: "LOCKFILE_MISMATCH",
    severity: "HIGH",
    confidence: input.confidence,
    title: input.title,
    claim: input.claim,
    affectedFiles: Array.from(new Set(input.evidence.map((item) => item.path))),
    evidence: input.evidence,
    expectedFailureMode: "Dependency installation fails or resolves a different dependency graph than developers tested locally.",
    confirmatorySignal: "Job logs contain npm, yarn, or pnpm install errors that reference missing or incompatible lockfiles.",
    weakeningSignal: "The pipeline uses the matching package manager and installs dependencies successfully with the committed lockfile.",
    suggestedMitigation: input.suggestedMitigation
  };
}

function parseCiInstallCommands(contents: string) {
  return contents
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, command: line.trim() }))
    .filter((entry) => /\b(npm\s+(ci|install)|yarn(\s+install)?|pnpm\s+(install|i))\b/i.test(entry.command))
    .map((entry) => ({
      path: ".gitlab-ci.yml",
      line: entry.line,
      command: entry.command.replace(/^-\s*/, "")
    }));
}

function isSensitiveVariable(variable: string) {
  return /(KEY|SECRET|TOKEN|PASSWORD)/i.test(variable);
}

function findProcessEnvReferences(contents: string) {
  const references: Array<{ variable: string; line: number }> = [];
  const seen = new Set<string>();
  const lines = contents.split(/\r?\n/);

  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
    /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
    /os\.environ\[["']([A-Z][A-Z0-9_]*)["']\]/g,
    /os\.environ\.get\(["']([A-Z][A-Z0-9_]*)["']/g
  ];

  for (const [index, line] of lines.entries()) {
    seen.clear();
    for (const pattern of patterns) {
      for (const match of line.matchAll(pattern)) {
        const variable = match[1];
        if (!seen.has(variable)) {
          seen.add(variable);
          references.push({ variable, line: index + 1 });
        }
      }
    }
  }

  return references;
}

export function detectTimezoneAssumptions(environmentMap: EnvironmentMap): PreventionSignal[] {
  const signals: PreventionSignal[] = [];
  const timezoneUnsafePatterns: Array<{ pattern: RegExp; safePattern?: RegExp; note: string }> = [
    {
      pattern: /new\s+Intl\.DateTimeFormat\s*\(/,
      safePattern: /timeZone\s*:/,
      note: "Intl.DateTimeFormat without explicit timeZone option"
    },
    {
      pattern: /\.toLocaleString\s*\(\s*\)/,
      note: "Date.toLocaleString() without locale or timezone argument"
    },
    {
      pattern: /\.toLocaleDateString\s*\(\s*\)/,
      note: "Date.toLocaleDateString() without locale or timezone argument"
    },
    {
      pattern: /\.toLocaleTimeString\s*\(\s*\)/,
      note: "Date.toLocaleTimeString() without locale or timezone argument"
    }
  ];

  const baseDir = environmentMap.rootDir ?? process.cwd();
  const filesToScan = environmentMap.changedFiles.filter((filePath) => /\.(js|jsx|ts|tsx|py)$/.test(filePath));

  for (const filePath of filesToScan) {
    const absPath = join(baseDir, filePath);
    if (!existsSync(absPath)) {
      continue;
    }

    let contents: string;
    try {
      contents = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const lines = contents.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      for (const { pattern, safePattern, note } of timezoneUnsafePatterns) {
        if (pattern.test(line) && !(safePattern?.test(line))) {
          signals.push({
            category: "TIMEZONE_ASSUMPTION",
            severity: "MEDIUM",
            confidence: 0.82,
            title: `Timezone assumption detected: ${note}`,
            claim: `${filePath} line ${index + 1} uses a date/time API without an explicit timezone. The result can change between local machines and CI containers.`,
            affectedFiles: [filePath],
            evidence: [
              {
                path: filePath,
                line: index + 1,
                excerpt: line.trim().slice(0, 120),
                source: "code"
              }
            ],
            expectedFailureMode: "Tests or snapshots fail because formatted dates differ between developer machines and CI timezone settings.",
            confirmatorySignal: "The failing test output differs only by formatted date or timezone-dependent strings.",
            weakeningSignal: "The affected code path already supplies an explicit timezone or does not participate in the failing test.",
            suggestedMitigation: "Pass an explicit { timeZone: 'UTC' } option or use a UTC-based date library to ensure consistent output across environments."
          });
          break;
        }
      }
    }
  }

  return signals;
}

export function detectDockerImageDrift(environmentMap: EnvironmentMap): PreventionSignal[] {
  const signals: PreventionSignal[] = [];
  const ciPath = environmentMap.ciRuntimes.node?.source ?? ".gitlab-ci.yml";
  const baseDir = environmentMap.rootDir ?? process.cwd();
  const ciFilePath = join(baseDir, ciPath);

  if (!existsSync(ciFilePath)) {
    return signals;
  }

  let ciContents: string;
  try {
    ciContents = readFileSync(ciFilePath, "utf8");
  } catch {
    return signals;
  }

  const lines = ciContents.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    const latestMatch = line.match(/^\s*image:\s*["']?([^"'\s]+):latest["']?/i);
    const untaggedMatch = line.match(/^\s*image:\s*["']?([A-Za-z0-9/_-]+)["']?\s*$/);

    if (latestMatch) {
      signals.push(buildImageDriftSignal(ciPath, index + 1, line, latestMatch[1], "latest"));
      continue;
    }

    if (untaggedMatch && !untaggedMatch[1].includes("@") && !untaggedMatch[1].includes(":")) {
      signals.push(buildImageDriftSignal(ciPath, index + 1, line, untaggedMatch[1], "untagged"));
    }
  }

  const dockerfilePath = join(baseDir, "Dockerfile");
  if (!existsSync(dockerfilePath)) {
    return signals;
  }

  let dockerContents: string;
  try {
    dockerContents = readFileSync(dockerfilePath, "utf8");
  } catch {
    return signals;
  }

  const dockerLines = dockerContents.split(/\r?\n/);
  for (const [index, line] of dockerLines.entries()) {
    const latestBase = line.match(/^\s*FROM\s+(\S+):latest\b/i);
    const untaggedBase = line.match(/^\s*FROM\s+([A-Za-z0-9/_-]+)\s*$/i);

    if (latestBase) {
      signals.push(buildDockerfileDriftSignal(index + 1, line, "latest base image"));
      continue;
    }

    if (untaggedBase && !untaggedBase[1].includes("@") && !untaggedBase[1].includes(":")) {
      signals.push(buildDockerfileDriftSignal(index + 1, line, "untagged base image"));
    }
  }

  return signals;
}

const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string; severity: "HIGH" | "MEDIUM" }> = [
  { pattern: /\bsk_live_[a-zA-Z0-9]{20,}\b/, label: "Stripe live secret key", severity: "HIGH" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS Access Key ID", severity: "HIGH" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, label: "Google API key", severity: "HIGH" },
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/, label: "GitHub Personal Access Token", severity: "HIGH" },
  { pattern: /\bglpat-[a-zA-Z0-9_-]{20,}\b/, label: "GitLab Personal Access Token", severity: "HIGH" },
  { pattern: /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/, label: "Slack token", severity: "HIGH" },
  { pattern: /-----BEGIN (RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "Private key material", severity: "HIGH" },
  {
    pattern: /(?:api[_-]?key|secret|password|passwd|token|credential)\s*[=:]\s*["'][a-zA-Z0-9+/=_-]{20,}["']/i,
    label: "Potential hardcoded credential",
    severity: "MEDIUM"
  }
];

const SECRET_ALLOWLIST = [".env.example", ".env.sample", ".env.template", "README.md", "CHANGELOG.md"];

export function detectSecretLeaks(environmentMap: EnvironmentMap): PreventionSignal[] {
  const signals: PreventionSignal[] = [];
  const baseDir = environmentMap.rootDir ?? process.cwd();

  const filesToScan = environmentMap.changedFiles.filter((filePath) => {
    const lower = filePath.toLowerCase();
    return !SECRET_ALLOWLIST.some((allowed) => lower.endsWith(allowed)) &&
      /\.(js|jsx|ts|tsx|py|rb|go|java|json|yml|yaml|sh|env)$/.test(lower);
  });

  for (const filePath of filesToScan) {
    const absPath = join(baseDir, filePath);
    if (!existsSync(absPath)) {
      continue;
    }

    let contents: string;
    try {
      contents = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const lines = contents.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (/^\s*(#|\/\/)/.test(line)) {
        continue;
      }

      for (const { pattern, label, severity } of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          signals.push({
            category: "SECURITY_LEAK",
            severity,
            confidence: 0.88,
            title: `Potential secret leak: ${label}`,
            claim: `${filePath} line ${index + 1} appears to contain a hardcoded ${label.toLowerCase()}. Committing credentials exposes them to repository readers and CI logs.`,
            affectedFiles: [filePath],
            evidence: [
              {
                path: filePath,
                line: index + 1,
                excerpt: `[${label} detected - value redacted]`,
                source: "code"
              }
            ],
            expectedFailureMode: "The pipeline or deployed application leaks live credentials, creating an immediate security and reliability incident.",
            confirmatorySignal: "The committed value is valid and appears in repository history, logs, or downstream environments.",
            weakeningSignal: "The detected string is a template value, example credential, or other non-secret placeholder.",
            suggestedMitigation: "Remove the hardcoded value, store it in an environment variable, and rotate the credential immediately if it has already been pushed."
          });
          break;
        }
      }
    }
  }

  return signals;
}

export function fixtureRoot(...parts: string[]) {
  return relative(process.cwd(), join(process.cwd(), "fixtures", "billing-service", ...parts)) || ".";
}

function buildImageDriftSignal(
  path: string,
  line: number,
  excerpt: string,
  imageName: string,
  mode: "latest" | "untagged"
): PreventionSignal {
  const sourceText = mode === "latest"
    ? `${imageName}:latest`
    : imageName;

  return {
    category: "DOCKER_IMAGE_DRIFT",
    severity: "MEDIUM",
    confidence: mode === "latest" ? 0.9 : 0.84,
    title: `CI uses ${mode === "latest" ? "unpinned :latest" : "an untagged"} image: ${sourceText}`,
    claim: `The CI config at ${path} line ${line} uses ${sourceText}. Unpinned images can change underneath the pipeline and break reproducibility.`,
    affectedFiles: [path],
    evidence: [
      {
        path,
        line,
        excerpt: excerpt.trim(),
        source: "config"
      }
    ],
    expectedFailureMode: "A later pipeline run uses a different base image than the one developers tested, causing non-deterministic failures.",
    confirmatorySignal: "The failing job started after an upstream image change or behaves differently without repository changes.",
    weakeningSignal: "The image is pinned to a stable version or digest.",
    suggestedMitigation: `Pin the image to a specific digest or version tag instead of ${sourceText}.`
  };
}

function buildDockerfileDriftSignal(line: number, excerpt: string, label: string): PreventionSignal {
  return {
    category: "DOCKER_IMAGE_DRIFT",
    severity: "MEDIUM",
    confidence: 0.86,
    title: `Dockerfile uses ${label}`,
    claim: `Dockerfile line ${line} uses ${label}. This makes builds non-reproducible across machines and over time.`,
    affectedFiles: ["Dockerfile"],
    evidence: [
      {
        path: "Dockerfile",
        line,
        excerpt: excerpt.trim(),
        source: "config"
      }
    ],
    expectedFailureMode: "Container builds diverge over time because the underlying base image changes without a repository change.",
    confirmatorySignal: "The same Docker build behaves differently on successive runs without code changes.",
    weakeningSignal: "The base image is pinned to a stable version or digest.",
    suggestedMitigation: "Pin the Dockerfile FROM instruction to a specific version digest."
  };
}
