import { existsSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { basename, join, resolve } from "node:path";

import {
  createRunId,
  remoteBootstrapSessionSchema,
  repositorySourceSchema,
  terminalCommandRequestSchema,
  type RemoteBootstrapSession,
  type RepositorySource,
  type TerminalCommandRequest
} from "../contracts.js";
import { buildLocalSetupPlan } from "./bootstrap.js";

type BuildRemoteBootstrapSessionOptions = {
  repoUrl: string;
  workspaceRoot?: string;
};

type ExecuteApprovedCommandsOptions = {
  session: RemoteBootstrapSession;
  approvals: string[];
};

export function buildRemoteBootstrapSession(
  options: BuildRemoteBootstrapSessionOptions
): RemoteBootstrapSession {
  const source = parseRepositorySource(options.repoUrl);
  const workspaceRoot = resolve(options.workspaceRoot ?? "clones");
  const repositoryRoot = join(workspaceRoot, source.provider, source.owner, source.name);
  const cloneRequired = !existsSync(join(repositoryRoot, ".git"));

  const commandRequests: TerminalCommandRequest[] = [];

  if (cloneRequired) {
    commandRequests.push(
      terminalCommandRequestSchema.parse({
        id: "clone",
        label: `Clone ${source.owner}/${source.name}`,
        command: `git clone ${source.cloneUrl} "${repositoryRoot}"`,
        workdir: workspaceRoot,
        purpose: "clone",
        source: "repo url",
        requiresApproval: true,
        approved: false,
        status: "pending",
        exitCode: null
      })
    );
  }

  const localSetupPlan = cloneRequired || !existsSync(repositoryRoot)
    ? null
    : buildLocalSetupPlan({
      rootDir: repositoryRoot,
      projectPath: `${source.owner}/${source.name}`
    });

  if (localSetupPlan) {
    commandRequests.push(...buildCommandRequestsFromPlan(localSetupPlan, repositoryRoot));
  }

  return remoteBootstrapSessionSchema.parse({
    runId: createRunId("itworkshere-remote"),
    source,
    workspaceRoot,
    repositoryRoot,
    cloneRequired,
    localSetupPlan,
    commandRequests,
    blockers: buildSessionBlockers(cloneRequired, localSetupPlan),
    guidance: buildSessionGuidance(cloneRequired, localSetupPlan)
  });
}

export async function executeApprovedCommands(
  options: ExecuteApprovedCommandsOptions
): Promise<RemoteBootstrapSession> {
  const session = structuredClone(options.session) as RemoteBootstrapSession;
  const approved = new Set(options.approvals);

  mkdirSync(session.workspaceRoot, { recursive: true });

  await executeCommandRequests(session.commandRequests, approved);

  const repositoryReady = existsSync(join(session.repositoryRoot, ".git"));
  session.cloneRequired = !repositoryReady;
  session.localSetupPlan = repositoryReady
    ? buildLocalSetupPlan({
      rootDir: session.repositoryRoot,
      projectPath: `${session.source.owner}/${session.source.name}`
    })
    : null;

  if (repositoryReady && session.localSetupPlan) {
    const existingIds = new Set(session.commandRequests.map((request) => request.id));
    const followUpRequests = buildCommandRequestsFromPlan(session.localSetupPlan, session.repositoryRoot)
      .filter((request) => !existingIds.has(request.id));
    session.commandRequests.push(...followUpRequests);

    await executeCommandRequests(followUpRequests, approved);
  }

  session.blockers = buildSessionBlockers(session.cloneRequired, session.localSetupPlan);
  session.guidance = buildSessionGuidance(session.cloneRequired, session.localSetupPlan);

  return remoteBootstrapSessionSchema.parse(session);
}

export function formatRemoteBootstrapSession(session: RemoteBootstrapSession) {
  const lines = [
    "## DevGuard Remote Bootstrap Session",
    "",
    `Repository: ${session.source.owner}/${session.source.name}`,
    `Provider: ${session.source.provider}`,
    `Clone target: ${session.repositoryRoot}`
  ];

  if (session.guidance.length > 0) {
    lines.push("");
    lines.push("Guidance:");

    for (const item of session.guidance) {
      lines.push(`- ${item}`);
    }
  }

  if (session.blockers.length > 0) {
    lines.push("");
    lines.push("Blockers:");

    for (const blocker of session.blockers) {
      lines.push(`- ${blocker}`);
    }
  }

  if (session.commandRequests.length > 0) {
    lines.push("");
    lines.push("Commands:");

    for (const request of session.commandRequests) {
      const approval = request.requiresApproval
        ? request.approved
          ? "approved"
          : "approval required"
        : "no approval needed";
      lines.push(`- [${request.status}] ${request.id}: ${request.command} (${approval})`);
    }
  }

  return lines.join("\n");
}

export function parseRepositorySource(repoUrl: string): RepositorySource {
  const normalized = repoUrl.trim();

  const httpMatch = normalized.match(/^https?:\/\/(github\.com|gitlab\.com)\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (httpMatch) {
    const provider = inferProvider(httpMatch[1]);
    return repositorySourceSchema.parse({
      url: normalized,
      provider,
      owner: httpMatch[2],
      name: httpMatch[3].replace(/\.git$/, ""),
      cloneUrl: `https://${httpMatch[1]}/${httpMatch[2]}/${httpMatch[3].replace(/\.git$/, "")}.git`
    });
  }

  const sshMatch = normalized.match(/^git@(github\.com|gitlab\.com):([^/]+)\/(.+?)(?:\.git)?$/i);
  if (sshMatch) {
    const provider = inferProvider(sshMatch[1]);
    return repositorySourceSchema.parse({
      url: normalized,
      provider,
      owner: sshMatch[2],
      name: sshMatch[3].replace(/\.git$/, ""),
      cloneUrl: normalized.endsWith(".git") ? normalized : `${normalized}.git`
    });
  }

  if (existsSync(normalized)) {
    const resolved = resolve(normalized);
    return repositorySourceSchema.parse({
      url: normalized,
      provider: "unknown",
      owner: "local",
      name: basename(resolved),
      cloneUrl: resolved
    });
  }

  throw new Error(`Unsupported repository URL or path: ${repoUrl}`);
}

function inferProvider(hostname: string): "github" | "gitlab" | "unknown" {
  if (/github\.com/i.test(hostname)) {
    return "github";
  }

  if (/gitlab\.com/i.test(hostname)) {
    return "gitlab";
  }

  return "unknown";
}

function buildCommandRequestsFromPlan(
  plan: NonNullable<RemoteBootstrapSession["localSetupPlan"]>,
  repositoryRoot: string
) {
  const requests: TerminalCommandRequest[] = [];
  const executableSteps = [
    ...plan.environmentCommands.filter((step) => isExecutableEnvironmentCommand(step.command)),
    ...plan.installCommands,
    ...plan.startCommands,
    ...plan.verificationCommands
  ];

  for (const step of executableSteps) {
    const id = `${step.purpose}-${slugify(step.command)}`;

    requests.push(
      terminalCommandRequestSchema.parse({
        id,
        label: step.command,
        command: step.command,
        workdir: repositoryRoot,
        purpose: step.purpose,
        source: step.source,
        requiresApproval: true,
        approved: false,
        status: "pending",
        exitCode: null
      })
    );
  }

  return requests;
}

function isExecutableEnvironmentCommand(command: string) {
  return !/^create\s+\.env\s+entries\s+for:/i.test(command.trim());
}

function buildSessionBlockers(
  cloneRequired: boolean,
  localSetupPlan: RemoteBootstrapSession["localSetupPlan"]
) {
  const blockers: string[] = [];

  if (cloneRequired) {
    blockers.push("Repository is not cloned yet. Approve the clone step to continue.");
  }

  if (localSetupPlan) {
    blockers.push(...localSetupPlan.blockers);
  }

  return blockers;
}

function buildSessionGuidance(
  cloneRequired: boolean,
  localSetupPlan: RemoteBootstrapSession["localSetupPlan"]
) {
  const guidance: string[] = [
    "Every terminal command is approval-gated and remains blocked until explicitly approved."
  ];

  if (cloneRequired) {
    guidance.push("Approve the clone step first so README and repository files can be inspected locally.");
  }

  if (localSetupPlan) {
    guidance.push(`Bootstrap confidence is ${(localSetupPlan.confidence * 100).toFixed(0)}%.`);

    const missingRequiredVariables = localSetupPlan.environmentVariables
      .filter((variable) => variable.required && !variable.hasTemplate)
      .map((variable) => variable.name);

    if (missingRequiredVariables.length > 0) {
      guidance.push(
        `Required environment values still need manual input: ${missingRequiredVariables.join(", ")}.`
      );
    }
  }

  return guidance;
}

function slugify(command: string) {
  return command
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function runCommand(command: string, workdir: string) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolvePromise, rejectPromise) => {
    const child = spawn(command, {
      cwd: workdir,
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

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      resolvePromise({
        stdout,
        stderr,
        exitCode: code ?? 1
      });
    });
  });
}

async function executeCommandRequests(
  requests: TerminalCommandRequest[],
  approved: Set<string>
) {
  for (const request of requests) {
    request.approved = approved.has(request.id);

    if (!request.approved) {
      request.status = request.status === "completed" ? "completed" : "blocked";
      continue;
    }

    if (request.status === "completed") {
      continue;
    }

    request.status = "running";

    try {
      const result = await runCommand(request.command, request.workdir);
      request.stdout = result.stdout;
      request.stderr = result.stderr;
      request.exitCode = result.exitCode;
      request.status = result.exitCode === 0 ? "completed" : "failed";
    } catch (error) {
      request.stderr = error instanceof Error ? error.message : String(error);
      request.exitCode = 1;
      request.status = "failed";
    }
  }
}
