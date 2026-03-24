import { buildRemoteBootstrapSession, executeApprovedCommands, formatRemoteBootstrapSession } from "../itworkshere/remote-bootstrap.js";

const repoUrl = process.argv[2];
const workspaceRoot = process.argv[3];
const approvals = process.argv.slice(4);

if (!repoUrl) {
  process.stderr.write("Usage: npm run demo:remote-bootstrap -- <repoUrl> [workspaceRoot] [approvalIds...]\n");
  process.exit(1);
}

const session = buildRemoteBootstrapSession({
  repoUrl,
  workspaceRoot
});

if (approvals.length === 0) {
  process.stdout.write(`${formatRemoteBootstrapSession(session)}\n`);
} else {
  const executed = await executeApprovedCommands({
    session,
    approvals
  });
  process.stdout.write(`${formatRemoteBootstrapSession(executed)}\n`);
}
