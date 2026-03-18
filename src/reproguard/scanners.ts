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
    ...detectGhostVariables(environmentMap)
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
  const lines = contents.split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const matcher = line.matchAll(/process\.env\.([A-Z0-9_]+)/g);

    for (const match of matcher) {
      references.push({
        variable: match[1],
        line: index + 1
      });
    }
  }

  return references;
}

export function fixtureRoot(...parts: string[]) {
  return relative(process.cwd(), join(process.cwd(), "fixtures", "billing-service", ...parts)) || ".";
}
