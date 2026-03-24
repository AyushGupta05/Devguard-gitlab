import {
  failureContextSchema,
  normalizeLegacyRiskReport,
  type FailureContext,
  type FailureSignal,
  type RiskReport
} from "../contracts.js";

type FailureIntakeOptions = {
  projectPath: string;
  mrIid: number;
  pipelineId: number;
  jobId?: number | null;
  failedJobName: string;
  errorLog: string;
  changedFiles: string[];
  priorRiskReport: RiskReport | null;
  runner?: {
    executor?: string | null;
    os?: string | null;
    architecture?: string | null;
  };
};

type SignalMatcher = {
  category: FailureSignal["category"];
  pattern: RegExp;
  summary: string;
  confidence: number;
  keywords?: string[];
};

const SIGNAL_MATCHERS: SignalMatcher[] = [
  {
    category: "RUNTIME_MISMATCH",
    pattern: /TypeError:\s+.+toSorted.+is not a function/i,
    summary: "Node runtime API mismatch surfaced at runtime",
    confidence: 0.98,
    keywords: ["toSorted", "TypeError"]
  },
  {
    category: "RUNTIME_MISMATCH",
    pattern: /TypeError:\s+.+is not a function/i,
    summary: "Observed runtime TypeError is consistent with a runtime API mismatch",
    confidence: 0.76,
    keywords: ["TypeError"]
  },
  {
    category: "RUNTIME_MISMATCH",
    pattern: /(Unsupported engine|engine\s+"?node"?\s+is incompatible|requires Node)/i,
    summary: "Dependency or script requires a different Node runtime than CI provides",
    confidence: 0.95,
    keywords: ["engine", "node"]
  },
  {
    category: "GHOST_VARIABLE",
    pattern: /\b([A-Z][A-Z0-9_]+)\b is required/i,
    summary: "Required environment variable is missing at runtime",
    confidence: 0.93,
    keywords: ["required", "environment"]
  },
  {
    category: "GHOST_VARIABLE",
    pattern: /ReferenceError:\s+([A-Z][A-Z0-9_]+)\s+is not defined/i,
    summary: "Runtime references an undefined environment-style variable",
    confidence: 0.88,
    keywords: ["ReferenceError"]
  },
  {
    category: "LOCKFILE_MISMATCH",
    pattern: /(package-lock\.json|npm ci can only install packages with an existing package-lock\.json|lockfile)/i,
    summary: "Dependency installation failed because CI and lockfile state do not match",
    confidence: 0.9,
    keywords: ["lockfile", "npm ci"]
  },
  {
    category: "TIMEZONE_ASSUMPTION",
    pattern: /(snapshot|timezone|GMT|UTC|toLocale)/i,
    summary: "Observed failure may depend on timezone-specific formatting",
    confidence: 0.58,
    keywords: ["timezone", "snapshot"]
  },
  {
    category: "DOCKER_IMAGE_DRIFT",
    pattern: /(manifest unknown|pull access denied|no matching manifest)/i,
    summary: "Container image resolution failed in CI",
    confidence: 0.79,
    keywords: ["manifest", "image"]
  }
];

export function createFailureContext(options: FailureIntakeOptions): FailureContext {
  return failureContextSchema.parse({
    runId: options.priorRiskReport?.runId ?? `itworkshere-${options.pipelineId}`,
    projectPath: options.projectPath,
    mrIid: options.mrIid,
    pipelineId: options.pipelineId,
    jobId: options.jobId ?? null,
    failedJobName: options.failedJobName,
    errorLog: options.errorLog,
    runner: {
      executor: options.runner?.executor ?? "docker",
      os: options.runner?.os ?? "linux",
      architecture: options.runner?.architecture ?? "amd64"
    },
    changedFiles: options.changedFiles,
    priorRiskReport: options.priorRiskReport ? normalizeLegacyRiskReport(options.priorRiskReport) : null
  });
}

export function extractFailureSignature(errorLog: string) {
  const lines = errorLog.split(/\r?\n/);
  const patterns = [
    /TypeError: .+/,
    /ReferenceError: .+/,
    /SyntaxError: .+/,
    /Error: Cannot find module .+/,
    /Error: ENOENT: .+/,
    /Error: EACCES: .+/,
    /Error: .+/
  ];

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();

    if (!line) {
      continue;
    }

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        return match[0];
      }
    }
  }

  const firstMeaningfulLine = errorLog
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return firstMeaningfulLine ?? "Unknown failure";
}

export function extractFailureSignals(errorLog: string): FailureSignal[] {
  const lines = errorLog.split(/\r?\n/);
  const signals: FailureSignal[] = [];
  const seen = new Set<string>();

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();

    if (!line) {
      continue;
    }

    for (const matcher of SIGNAL_MATCHERS) {
      if (!matcher.pattern.test(line)) {
        continue;
      }

      const key = `${matcher.category}:${line}`;
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      signals.push({
        signalId: `S${signals.length + 1}`,
        category: matcher.category,
        summary: matcher.summary,
        source: "job_log",
        directEvidence: line,
        line: index + 1,
        confidence: matcher.confidence,
        keywords: matcher.keywords ?? []
      });
    }
  }

  if (signals.length > 0) {
    return signals;
  }

  const fallbackLine = lines
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!fallbackLine) {
    return [];
  }

  return [
    {
      signalId: "S1",
      category: "UNKNOWN",
      summary: "No direct failure pattern was recognized from the available log text",
      source: "job_log",
      directEvidence: fallbackLine,
      line: 1,
      confidence: 0.34,
      keywords: []
    }
  ];
}

export function logLooksPartial(errorLog: string) {
  const meaningfulLines = errorLog
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return meaningfulLines.length < 4 || errorLog.length < 180;
}

export function summarizeFailureContext(failureContext: FailureContext) {
  return `${failureContext.failedJobName} failed in pipeline ${failureContext.pipelineId} for MR !${failureContext.mrIid}: ${extractFailureSignature(failureContext.errorLog)}`;
}
