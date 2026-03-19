import {
  buildRemoteBootstrapSession,
  executeApprovedCommands,
  formatRemoteBootstrapSession
} from "../itworkshere/remote-bootstrap.js";

const repoUrl = process.argv[2];

if (!repoUrl) {
  throw new Error("Usage: npm run demo:remote-bootstrap -- <repo-url> [workspace-root] [comma-separated-approvals]");
}

const workspaceRoot = process.argv[3];
const approvals = process.argv[4]
  ? process.argv[4].split(",").map((value) => value.trim()).filter(Boolean)
  : [];

const initialSession = buildRemoteBootstrapSession({
  repoUrl,
  workspaceRoot
});

const session = approvals.length > 0
  ? await executeApprovedCommands({
    session: initialSession,
    approvals
  })
  : initialSession;

console.log(formatRemoteBootstrapSession(session));
