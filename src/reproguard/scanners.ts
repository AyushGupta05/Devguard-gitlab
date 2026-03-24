import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { globSync } from "glob";
import YAML from "yaml";

import {
  createRunId,
  environmentMapSchema,
  type EnvironmentMap,
  type Risk
} from "../contracts.js";

export type PreventionSignal = Omit<Risk, "riskId">;

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

export function collectEnvironmentMap(options: ScanOptions): EnvironmentMap {
  const gitlabCiPath = join(options.rootDir, ".gitlab-ci.yml");
  const gitlabCi = existsSync(gitlabCiPath)
    ? (YAML.parse(readFileSync(gitlabCiPath, "utf8")) as GitLabCiConfig)
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

  const environmentMap = environmentMapSchema.parse({
    runId: createRunId("reproguard"),
    projectPath: options.projectPath,
    mrIid: options.mrIid,
    pipelineId: options.pipelineId ?? null,
    generatedAt: new Date().toISOString(),
    rootDir: options.rootDir,
    localRuntimes: {
      node: runtimeValue(options.rootDir, ".nvmrc"),
      python: runtimeValue(options.rootDir, ".python-version")
    },
    ciRuntimes: {
      node: {
        source: ".gitlab-ci.yml",
        value: extractCiRuntime(gitlabCi)
      }
    },
    envExampleKeys: parseEnvKeys(envExample),
    ciVariableKeys: Object.keys(gitlabCi.variables ?? {}),
    codeVariableReferences,
    changedFiles: options.changedFiles,
    dockerfilePinned: detectDockerfilePinned(options.rootDir),
    lockfilePresent: detectLockfilePresence(options.rootDir)
  });

  return environmentMap;
}

export function detectDeterministicSignals(environmentMap: EnvironmentMap): PreventionSignal[] {
  return [
    ...detectRuntimeMismatch(environmentMap),
    ...detectGhostVariables(environmentMap),
    ...detectTimezoneAssumptions(environmentMap),
    ...detectDockerImageDrift(environmentMap),
    ...detectSecretLeaks(environmentMap)
  ];
}

export function detectRuntimeMismatch(environmentMap: EnvironmentMap): PreventionSignal[] {
  const localNode = environmentMap.localRuntimes.node?.value;
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
      type: "RUNTIME_MISMATCH",
      severity: "HIGH",
      confidence: 0.96,
      title: `Node runtime mismatch: local ${localNode} vs CI ${ciNode}`,
      description: `The repository declares Node ${localNode} locally, but CI runs ${ciNode}. Code that relies on newer Node APIs may pass locally and fail in CI.`,
      affectedFiles: environmentMap.changedFiles,
      evidence: [
        {
          path: environmentMap.localRuntimes.node?.source ?? ".nvmrc",
          excerpt: localNode
        },
        {
          path: environmentMap.ciRuntimes.node?.source ?? ".gitlab-ci.yml",
          excerpt: ciNode
        }
      ],
      suggestedFix: `Update CI to a Node ${localMajor} image, such as node:${localMajor}-alpine.`
    }
  ];
}

export function detectGhostVariables(environmentMap: EnvironmentMap): PreventionSignal[] {
  const declared = new Set([
    ...environmentMap.envExampleKeys,
    ...environmentMap.ciVariableKeys
  ]);

  return environmentMap.codeVariableReferences
    .filter((reference) => !declared.has(reference.variable))
    .map((reference) => ({
      type: "GHOST_VARIABLE" as const,
      severity: "HIGH" as const,
      confidence: 0.95,
      title: `Undeclared environment variable: ${reference.variable}`,
      description: `${reference.variable} is referenced in code but not declared in .env.example or GitLab CI variables.`,
      affectedFiles: [reference.path],
      evidence: [
        {
          path: reference.path,
          line: reference.line,
          excerpt: reference.variable
        }
      ],
      suggestedFix: `Declare ${reference.variable} in .env.example and in GitLab CI/CD variables if it is required at runtime.`
    }));
}

export function summarizeEnvironmentMap(environmentMap: EnvironmentMap) {
  const nodeSummary = [
    environmentMap.localRuntimes.node?.value
      ? `local Node ${environmentMap.localRuntimes.node.value}`
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
  return ["package-lock.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb"].some((name) =>
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

  return !fromLine.includes(":latest");
}

function extractMajor(runtime: string) {
  const match = runtime.match(/(\d{1,2})/);
  return match ? Number(match[1]) : null;
}

function findProcessEnvReferences(contents: string) {
  const references: Array<{ variable: string; line: number }> = [];
  const seen = new Set<string>(); // deduplicate per-line
  const lines = contents.split(/\r?\n/);

  const patterns = [
    // process.env.VAR_NAME (dot notation)
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    // process.env["VAR_NAME"] or process.env['VAR_NAME'] (bracket notation)
    /process\.env\[["']([A-Z][A-Z0-9_]*)["']\]/g,
    // import.meta.env.VAR_NAME (Vite / ESM)
    /import\.meta\.env\.([A-Z][A-Z0-9_]*)/g,
    // os.environ["VAR_NAME"] or os.environ['VAR_NAME'] (Python)
    /os\.environ\[["']([A-Z][A-Z0-9_]*)["']\]/g,
    // os.environ.get("VAR_NAME") (Python)
    /os\.environ\.get\(["']([A-Z][A-Z0-9_]*)["']/g,
    // process.env[variable] dynamic — skip (cannot know variable name statically)
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

  // Patterns that assume the local system timezone — safe in local dev, broken in CI/Docker.
  // Each entry: pattern matches a potentially unsafe call; safePattern matches when a timezone
  // option is explicitly provided on the same line (safe). Flag only when unsafe matches AND
  // safe does not match.
  const timezoneUnsafePatterns: Array<{ pattern: RegExp; safePattern?: RegExp; note: string }> = [
    {
      // Intl.DateTimeFormat constructor call — flag unless timeZone: is on the same line
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

  // Only scan changed files to keep signal relevant to this MR
  const filesToScan = environmentMap.changedFiles.filter((f) =>
    /\.(js|jsx|ts|tsx|py)$/.test(f)
  );

  for (const filePath of filesToScan) {
    const absPath = join(baseDir, filePath);
    if (!existsSync(absPath)) continue;
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
            type: "TIMEZONE_ASSUMPTION",
            severity: "MEDIUM",
            confidence: 0.82,
            title: `Timezone assumption detected: ${note}`,
            description: `${filePath} line ${index + 1} uses a date/time API without an explicit timezone. This produces different output depending on the server's TZ setting, which differs between local machines and CI/Docker containers.`,
            affectedFiles: [filePath],
            evidence: [
              {
                path: filePath,
                line: index + 1,
                excerpt: line.trim().slice(0, 120)
              }
            ],
            suggestedFix: "Pass an explicit { timeZone: 'UTC' } option or use a UTC-based date library to ensure consistent output across environments."
          });
          break; // one signal per line is enough
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

  if (!existsSync(ciFilePath)) return signals;

  let ciContents: string;
  try {
    ciContents = readFileSync(ciFilePath, "utf8");
  } catch {
    return signals;
  }

  const lines = ciContents.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    // Match "image: something:latest" or "image: something" with no tag (implicitly latest)
    const latestMatch = line.match(/^\s*image:\s*["']?([^"'\s]+):latest["']?/i);
    if (latestMatch) {
      signals.push({
        type: "DOCKER_IMAGE_DRIFT",
        severity: "MEDIUM",
        confidence: 0.90,
        title: `CI uses unpinned :latest image: ${latestMatch[1]}`,
        description: `The CI config at ${ciPath} line ${index + 1} pulls ${latestMatch[1]}:latest. Unpinned images change without warning, causing builds that pass today to silently break tomorrow when the upstream image updates.`,
        affectedFiles: [ciPath],
        evidence: [
          {
            path: ciPath,
            line: index + 1,
            excerpt: line.trim()
          }
        ],
        suggestedFix: `Pin the image to a specific digest or version tag, e.g. ${latestMatch[1]}:1.2.3 or ${latestMatch[1]}@sha256:<digest>.`
      });
    }
  }

  // Also warn if Dockerfile exists and uses :latest
  const dockerfilePath = join(baseDir, "Dockerfile");
  if (existsSync(dockerfilePath)) {
    let dockerContents: string;
    try {
      dockerContents = readFileSync(dockerfilePath, "utf8");
    } catch {
      return signals;
    }
    const dockerLines = dockerContents.split(/\r?\n/);
    for (const [index, line] of dockerLines.entries()) {
      if (/^\s*FROM\s+\S+:latest\b/i.test(line)) {
        signals.push({
          type: "DOCKER_IMAGE_DRIFT",
          severity: "MEDIUM",
          confidence: 0.88,
          title: "Dockerfile uses :latest base image",
          description: `Dockerfile line ${index + 1} uses a :latest base image. This makes builds non-reproducible across machines and over time.`,
          affectedFiles: ["Dockerfile"],
          evidence: [{ path: "Dockerfile", line: index + 1, excerpt: line.trim() }],
          suggestedFix: "Pin the Dockerfile FROM instruction to a specific version digest."
        });
      }
    }
  }

  return signals;
}

// Known secret patterns: value + a note for the warning message
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string; severity: "HIGH" | "MEDIUM" }> = [
  { pattern: /\bsk_live_[a-zA-Z0-9]{20,}\b/, label: "Stripe live secret key", severity: "HIGH" },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: "AWS Access Key ID", severity: "HIGH" },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/, label: "Google API key", severity: "HIGH" },
  { pattern: /\bghp_[a-zA-Z0-9]{36}\b/, label: "GitHub Personal Access Token", severity: "HIGH" },
  { pattern: /\bglpat-[a-zA-Z0-9_-]{20,}\b/, label: "GitLab Personal Access Token", severity: "HIGH" },
  { pattern: /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/, label: "Slack token", severity: "HIGH" },
  { pattern: /-----BEGIN (RSA |DSA |EC |OPENSSH )?PRIVATE KEY-----/, label: "Private key material", severity: "HIGH" },
  // Generic: assignment of a long hex/base64 string to a name that looks credential-like
  {
    pattern: /(?:api[_-]?key|secret|password|passwd|token|credential)\s*[=:]\s*["'][a-zA-Z0-9+/=_-]{20,}["']/i,
    label: "Potential hardcoded credential",
    severity: "MEDIUM"
  }
];

// Files that are allowed to contain credential-like patterns (templates, examples, docs)
const SECRET_ALLOWLIST = [".env.example", ".env.sample", ".env.template", "README.md", "CHANGELOG.md"];

export function detectSecretLeaks(environmentMap: EnvironmentMap): PreventionSignal[] {
  const signals: PreventionSignal[] = [];
  const baseDir = environmentMap.rootDir ?? process.cwd();

  const filesToScan = environmentMap.changedFiles.filter((f) => {
    const lower = f.toLowerCase();
    return !SECRET_ALLOWLIST.some((allowed) => lower.endsWith(allowed)) &&
      /\.(js|jsx|ts|tsx|py|rb|go|java|json|yml|yaml|sh|env)$/.test(lower);
  });

  for (const filePath of filesToScan) {
    const absPath = join(baseDir, filePath);
    if (!existsSync(absPath)) continue;

    let contents: string;
    try {
      contents = readFileSync(absPath, "utf8");
    } catch {
      continue;
    }

    const lines = contents.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      // Skip commented-out lines
      if (/^\s*(#|\/\/)/.test(line)) continue;

      for (const { pattern, label, severity } of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          signals.push({
            type: "SECURITY_LEAK",
            severity,
            confidence: 0.88,
            title: `Potential secret leak: ${label}`,
            description: `${filePath} line ${index + 1} appears to contain a hardcoded ${label.toLowerCase()}. Committing credentials exposes them to anyone with repository access and to CI logs.`,
            affectedFiles: [filePath],
            evidence: [
              {
                path: filePath,
                line: index + 1,
                // Redact the actual value — show the label only
                excerpt: `[${label} detected — value redacted]`
              }
            ],
            suggestedFix: `Remove the hardcoded value, store it in an environment variable, and rotate the credential immediately if it has already been pushed.`
          });
          break; // one signal per line
        }
      }
    }
  }

  return signals;
}

export function fixtureRoot(...parts: string[]) {
  return relative(process.cwd(), join(process.cwd(), "fixtures", "billing-service", ...parts)) || ".";
}
