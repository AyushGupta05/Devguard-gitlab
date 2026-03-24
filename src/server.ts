/**
 * DevGuard Bootstrap Server
 *
 * Exposes buildRemoteBootstrapSession and executeApprovedCommands over HTTP.
 * Serves a browser UI at http://localhost:3000 where you can:
 *   1. Paste a repo URL to create a session
 *   2. See every command DevGuard wants to run, blocked until you approve
 *   3. Click Approve on each command, then Execute
 *   4. Watch live output per command
 *
 * Used alongside the Bootstrap agent: the agent analyses the repo and
 * describes the plan; this server actually runs the approved commands locally.
 *
 * Start: npm run server
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  buildRemoteBootstrapSession,
  executeApprovedCommands,
  parseRepositorySource,
} from "./itworkshere/remote-bootstrap.js";
import {
  remoteBootstrapSessionSchema,
  terminalCommandRequestSchema,
  type RemoteBootstrapSession,
} from "./contracts.js";

// ---------------------------------------------------------------------------
// In-memory session store
// ---------------------------------------------------------------------------

const sessions = new Map<string, RemoteBootstrapSession>();

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(raw || "{}")); }
      catch { reject(new Error("Request body is not valid JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json") {
  const payload = contentType === "application/json" ? JSON.stringify(body, null, 2) : String(body);
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string) {
  send(res, status, { error: message });
}

// ---------------------------------------------------------------------------
// HTML dashboard (single-page, no external dependencies)
// ---------------------------------------------------------------------------

function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DevGuard Bootstrap</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; }
    header { background: #1a1d27; border-bottom: 1px solid #2d3149; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 18px; font-weight: 600; color: #fff; }
    header span { font-size: 12px; color: #7c85a2; background: #252837; padding: 2px 8px; border-radius: 4px; }
    main { max-width: 900px; margin: 32px auto; padding: 0 24px; }
    .card { background: #1a1d27; border: 1px solid #2d3149; border-radius: 8px; padding: 20px; margin-bottom: 20px; }
    label { display: block; font-size: 13px; color: #9ba3c0; margin-bottom: 6px; }
    input[type=text] { width: 100%; padding: 10px 12px; background: #252837; border: 1px solid #3a3f5c; border-radius: 6px; color: #e2e8f0; font-size: 14px; outline: none; }
    input[type=text]:focus { border-color: #5b6bde; }
    button { padding: 9px 18px; border-radius: 6px; border: none; font-size: 13px; font-weight: 500; cursor: pointer; transition: opacity .15s; }
    button:hover { opacity: .85; }
    button:disabled { opacity: .4; cursor: not-allowed; }
    .btn-primary { background: #5b6bde; color: #fff; }
    .btn-success { background: #22c55e; color: #fff; }
    .btn-danger { background: #ef4444; color: #fff; }
    .btn-ghost { background: #252837; color: #9ba3c0; }
    h2 { font-size: 15px; font-weight: 600; margin-bottom: 14px; color: #fff; }
    .status-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
    .status-pending   { background: #3a3f5c; color: #9ba3c0; }
    .status-blocked   { background: #7c3535; color: #fca5a5; }
    .status-approved  { background: #1e4d2b; color: #86efac; }
    .status-running   { background: #1e3a5f; color: #93c5fd; }
    .status-completed { background: #1e4d2b; color: #86efac; }
    .status-failed    { background: #7c3535; color: #fca5a5; }
    .cmd-row { display: flex; align-items: flex-start; gap: 12px; padding: 12px 0; border-bottom: 1px solid #252837; }
    .cmd-row:last-child { border-bottom: none; }
    .cmd-meta { flex: 1; min-width: 0; }
    .cmd-label { font-size: 13px; color: #9ba3c0; margin-bottom: 3px; }
    .cmd-code { font-family: monospace; font-size: 13px; color: #c4b5fd; word-break: break-all; }
    .cmd-purpose { font-size: 11px; color: #5b6070; margin-top: 3px; }
    .cmd-output { margin-top: 8px; background: #0f1117; border-radius: 4px; padding: 10px; font-family: monospace; font-size: 12px; color: #a0aec0; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
    .cmd-output.error { color: #fca5a5; }
    .section-actions { margin-top: 16px; display: flex; gap: 10px; }
    .blocker { background: #2a1a1a; border-left: 3px solid #ef4444; padding: 10px 14px; border-radius: 4px; font-size: 13px; color: #fca5a5; margin-bottom: 8px; }
    .guidance { background: #1a2a1a; border-left: 3px solid #22c55e; padding: 10px 14px; border-radius: 4px; font-size: 13px; color: #86efac; margin-bottom: 8px; }
    .empty { text-align: center; color: #5b6070; padding: 40px; font-size: 14px; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #5b6bde; border-top-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .session-header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
    .session-title { flex: 1; font-size: 15px; font-weight: 600; }
    .session-id { font-size: 11px; color: #5b6070; font-family: monospace; }
    #error-toast { display: none; position: fixed; bottom: 24px; right: 24px; background: #7c3535; color: #fca5a5; padding: 12px 18px; border-radius: 8px; font-size: 13px; z-index: 100; max-width: 360px; }
  </style>
</head>
<body>
<header>
  <h1>DevGuard Bootstrap</h1>
  <span>approval-gated command runner</span>
</header>
<main>

  <!-- New session form -->
  <div class="card" id="new-session-card">
    <h2>New Bootstrap Session</h2>
    <div style="margin-bottom:12px">
      <label for="repo-url">Repository URL or local path</label>
      <input type="text" id="repo-url" placeholder="https://github.com/owner/repo  or  /path/to/local/repo" />
    </div>
    <button class="btn-primary" id="create-btn" onclick="createSession()">Analyse Repository</button>
    <div style="margin-top:12px;font-size:12px;color:#5b6070">
      Or <a href="#" onclick="toggleImport(event)" style="color:#7c85a2">import from Duo Agent</a>
    </div>
  </div>

  <!-- Import from agent -->
  <div class="card" id="import-card" style="display:none">
    <h2>Import from DevGuard Bootstrap Agent</h2>
    <p style="font-size:13px;color:#7c85a2;margin-bottom:12px">
      Paste the full agent response (or just the JSON between the comment markers) from Duo Chat.
    </p>
    <label for="agent-output">Agent output</label>
    <textarea id="agent-output" rows="10" style="width:100%;padding:10px 12px;background:#252837;border:1px solid #3a3f5c;border-radius:6px;color:#e2e8f0;font-size:13px;font-family:monospace;resize:vertical;outline:none" placeholder="Paste the entire agent response here — the server will extract the JSON payload automatically"></textarea>
    <div style="margin-top:10px;display:flex;gap:10px">
      <button class="btn-primary" onclick="importSession()">Import &amp; Create Session</button>
      <button class="btn-ghost" onclick="toggleImport(null)">Cancel</button>
    </div>
  </div>

  <!-- Active session -->
  <div id="session-container"></div>

</main>
<div id="error-toast"></div>

<script>
  let currentSessionId = null;
  let pendingApprovals = new Set();

  function showError(msg) {
    const el = document.getElementById('error-toast');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(() => { el.style.display = 'none'; }, 5000);
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function toggleImport(e) {
    if (e) e.preventDefault();
    const card = document.getElementById('import-card');
    card.style.display = card.style.display === 'none' ? 'block' : 'none';
  }

  async function importSession() {
    const text = document.getElementById('agent-output').value.trim();
    if (!text) return showError('Paste the agent output first');
    const btn = event.target;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Importing…';
    try {
      const session = await api('POST', '/api/sessions/import-text', { text });
      currentSessionId = session.runId;
      pendingApprovals = new Set();
      document.getElementById('import-card').style.display = 'none';
      renderSession(session);
    } catch (e) {
      showError(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Import & Create Session';
    }
  }

  async function createSession() {
    const url = document.getElementById('repo-url').value.trim();
    if (!url) return showError('Please enter a repository URL or path');
    const btn = document.getElementById('create-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Analysing…';
    try {
      const session = await api('POST', '/api/sessions', { repoUrl: url });
      currentSessionId = session.runId;
      pendingApprovals = new Set();
      renderSession(session);
    } catch (e) {
      showError(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Analyse Repository';
    }
  }

  function toggleApproval(cmdId) {
    if (pendingApprovals.has(cmdId)) {
      pendingApprovals.delete(cmdId);
    } else {
      pendingApprovals.add(cmdId);
    }
    // re-render just the approve button row
    const row = document.getElementById('approve-btn-' + cmdId);
    if (row) {
      const approved = pendingApprovals.has(cmdId);
      row.className = approved ? 'status-badge status-approved' : 'status-badge status-blocked';
      row.textContent = approved ? 'Approved' : 'Approve';
    }
    document.getElementById('execute-btn').disabled = pendingApprovals.size === 0;
  }

  async function executeSession() {
    if (!currentSessionId) return;
    const btn = document.getElementById('execute-btn');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Running…';
    try {
      const session = await api('POST', '/api/sessions/' + currentSessionId + '/execute', {
        approvals: [...pendingApprovals],
      });
      currentSessionId = session.runId;
      pendingApprovals = new Set();
      renderSession(session);
    } catch (e) {
      showError(e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Execute Approved Commands';
    }
  }

  function purposeColor(purpose) {
    return { clone: '#c4b5fd', environment: '#fcd34d', install: '#93c5fd', start: '#86efac', verify: '#f9a8d4' }[purpose] || '#9ba3c0';
  }

  function renderSession(session) {
    const container = document.getElementById('session-container');

    const allDone = session.commandRequests.every(c => c.status === 'completed' || c.status === 'failed');
    const hasBlocked = session.commandRequests.some(c => c.status === 'blocked' || c.status === 'pending');

    const guidanceHtml = session.guidance.map(g => \`<div class="guidance">\${g}</div>\`).join('');
    const blockerHtml = session.blockers.map(b => \`<div class="blocker">⚠ \${b}</div>\`).join('');

    const commandsHtml = session.commandRequests.map(cmd => {
      const canApprove = cmd.status === 'blocked' || cmd.status === 'pending';
      const isApproved = pendingApprovals.has(cmd.id);
      const badgeClass = isApproved ? 'status-approved' : 'status-' + cmd.status;
      const badgeText = isApproved ? 'Approved' : cmd.status;

      const outputHtml = cmd.stdout || cmd.stderr ? \`
        <div class="cmd-output \${cmd.exitCode !== 0 && cmd.exitCode !== null ? 'error' : ''}">\${(cmd.stdout || '') + (cmd.stderr ? '\\n--- stderr ---\\n' + cmd.stderr : '')}</div>
      \` : '';

      return \`
        <div class="cmd-row">
          <div class="cmd-meta">
            <div class="cmd-label">\${cmd.label}</div>
            <div class="cmd-code">\$ \${cmd.command}</div>
            <div class="cmd-purpose" style="color:\${purposeColor(cmd.purpose)}">\${cmd.purpose} · \${cmd.source}</div>
            \${outputHtml}
          </div>
          <div style="display:flex;gap:8px;align-items:center;flex-shrink:0">
            \${canApprove
              ? \`<button id="approve-btn-\${cmd.id}" class="status-badge \${badgeClass}" onclick="toggleApproval('\${cmd.id}')">\${badgeText}</button>\`
              : \`<span class="status-badge \${badgeClass}">\${cmd.status}</span>\`
            }
          </div>
        </div>
      \`;
    }).join('');

    container.innerHTML = \`
      <div class="card">
        <div class="session-header">
          <div class="session-title">\${session.source.owner}/\${session.source.name}</div>
          <div class="session-id">\${session.runId}</div>
        </div>
        \${guidanceHtml}
        \${blockerHtml}
        <h2 style="margin-top:\${(guidanceHtml || blockerHtml) ? '16px' : '0'}">Commands</h2>
        \${commandsHtml || '<div class="empty">No commands detected.</div>'}
        \${hasBlocked ? \`
          <div class="section-actions">
            <button class="btn-success" id="execute-btn" onclick="executeSession()" \${pendingApprovals.size === 0 ? 'disabled' : ''}>Execute Approved Commands</button>
            <button class="btn-ghost" onclick="approveAll()">Approve All</button>
          </div>
        \` : allDone ? \`
          <div style="margin-top:16px;color:#86efac;font-size:13px">✅ All commands completed.</div>
        \` : ''}
      </div>
    \`;
  }

  function approveAll() {
    const session_container = document.getElementById('session-container');
    const buttons = session_container.querySelectorAll('[id^="approve-btn-"]');
    buttons.forEach(btn => {
      const cmdId = btn.id.replace('approve-btn-', '');
      if (!pendingApprovals.has(cmdId)) toggleApproval(cmdId);
    });
    document.getElementById('execute-btn').disabled = false;
  }
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Agent payload import
// ---------------------------------------------------------------------------

type AgentSessionPayload = {
  repo: string;
  repoUrl: string;
  commands: Array<{
    id: string;
    label: string;
    command: string;
    purpose: "clone" | "environment" | "install" | "start" | "verify";
  }>;
  requiredSecrets?: string[];
  requiredConfig?: string[];
};

/** Extract the JSON block from an agent chat message that contains the hidden payload */
export function extractAgentPayload(text: string): AgentSessionPayload | null {
  const start = text.indexOf("<!-- devguard:bootstrap-session:start");
  const end = text.indexOf("devguard:bootstrap-session:end -->");
  if (start === -1 || end === -1) return null;
  const inner = text.slice(text.indexOf("\n", start) + 1, end).trim();
  return JSON.parse(inner) as AgentSessionPayload;
}

function sessionFromAgentPayload(payload: AgentSessionPayload): RemoteBootstrapSession {
  const source = parseRepositorySource(payload.repoUrl);
  const runId = `devguard-import-${Date.now().toString(36)}`;

  const commandRequests = payload.commands.map((cmd) =>
    terminalCommandRequestSchema.parse({
      id: cmd.id,
      label: cmd.label,
      command: cmd.command,
      workdir: source.provider === "unknown" ? source.cloneUrl : `clones/${source.provider}/${source.owner}/${source.name}`,
      purpose: cmd.purpose,
      source: "agent",
      requiresApproval: true,
      approved: false,
      status: "pending",
      exitCode: null,
    })
  );

  const blockers: string[] = [];
  if (payload.requiredSecrets && payload.requiredSecrets.length > 0) {
    blockers.push(`Secrets needed before running: ${payload.requiredSecrets.join(", ")}`);
  }
  if (payload.requiredConfig && payload.requiredConfig.length > 0) {
    blockers.push(`Config vars needed: ${payload.requiredConfig.join(", ")}`);
  }

  return remoteBootstrapSessionSchema.parse({
    runId,
    source,
    workspaceRoot: "clones",
    repositoryRoot: `clones/${source.provider}/${source.owner}/${source.name}`,
    cloneRequired: commandRequests.some((c) => c.purpose === "clone"),
    localSetupPlan: null,
    commandRequests,
    blockers,
    guidance: [
      "Session imported from DevGuard Bootstrap agent.",
      "Every command is blocked until you approve it. Approve each step, then click Execute.",
    ],
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function router(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://localhost`);
  const method = req.method ?? "GET";

  // CORS preflight
  if (method === "OPTIONS") {
    send(res, 204, "");
    return;
  }

  // GET / — HTML dashboard
  if (method === "GET" && url.pathname === "/") {
    send(res, 200, renderDashboard(), "text/html; charset=utf-8");
    return;
  }

  // POST /api/sessions/import — create a session from the agent's structured JSON payload
  if (method === "POST" && url.pathname === "/api/sessions/import") {
    try {
      const body = await readJsonBody(req) as AgentSessionPayload;
      const session = sessionFromAgentPayload(body);
      sessions.set(session.runId, session);
      send(res, 201, session);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // POST /api/sessions/import-text — extract payload from raw agent chat text, then create session
  if (method === "POST" && url.pathname === "/api/sessions/import-text") {
    try {
      const body = await readJsonBody(req) as { text?: string };
      if (!body.text) { sendError(res, 400, "text is required"); return; }
      const payload = extractAgentPayload(body.text);
      if (!payload) { sendError(res, 422, "No devguard:bootstrap-session payload found. Make sure you copied the full agent response."); return; }
      const session = sessionFromAgentPayload(payload);
      sessions.set(session.runId, session);
      send(res, 201, session);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // POST /api/sessions — create a new bootstrap session
  if (method === "POST" && url.pathname === "/api/sessions") {
    try {
      const body = await readJsonBody(req) as { repoUrl?: string; workspaceRoot?: string };
      if (!body.repoUrl) {
        sendError(res, 400, "repoUrl is required");
        return;
      }
      const session = buildRemoteBootstrapSession({
        repoUrl: body.repoUrl,
        workspaceRoot: body.workspaceRoot,
      });
      sessions.set(session.runId, session);
      send(res, 201, session);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // GET /api/sessions — list all sessions (summaries)
  if (method === "GET" && url.pathname === "/api/sessions") {
    const list = [...sessions.values()].map((s) => ({
      runId: s.runId,
      repo: `${s.source.owner}/${s.source.name}`,
      provider: s.source.provider,
      total: s.commandRequests.length,
      completed: s.commandRequests.filter((c) => c.status === "completed").length,
      failed: s.commandRequests.filter((c) => c.status === "failed").length,
      blocked: s.commandRequests.filter((c) => c.status === "blocked" || c.status === "pending").length,
    }));
    send(res, 200, list);
    return;
  }

  // Session-scoped routes
  const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
  if (sessionMatch) {
    const runId = sessionMatch[1];
    const subpath = sessionMatch[2] ?? "";
    const session = sessions.get(runId);

    if (!session) {
      sendError(res, 404, `Session ${runId} not found`);
      return;
    }

    // GET /api/sessions/:runId
    if (method === "GET" && subpath === "") {
      send(res, 200, session);
      return;
    }

    // POST /api/sessions/:runId/execute — run approved commands
    if (method === "POST" && subpath === "/execute") {
      try {
        const body = await readJsonBody(req) as { approvals?: string[] };
        const approvals = Array.isArray(body.approvals) ? body.approvals : [];
        const updated = await executeApprovedCommands({ session, approvals });
        sessions.set(updated.runId, updated);
        send(res, 200, updated);
      } catch (err) {
        sendError(res, 500, err instanceof Error ? err.message : String(err));
      }
      return;
    }

    // POST /api/sessions/:runId/approve — mark commands as approved without executing
    if (method === "POST" && subpath === "/approve") {
      try {
        const body = await readJsonBody(req) as { commandIds?: string[] };
        const ids = new Set(Array.isArray(body.commandIds) ? body.commandIds : []);
        for (const cmd of session.commandRequests) {
          if (ids.has(cmd.id)) cmd.approved = true;
        }
        sessions.set(runId, session);
        send(res, 200, session);
      } catch (err) {
        sendError(res, 400, err instanceof Error ? err.message : String(err));
      }
      return;
    }
  }

  sendError(res, 404, "Not found");
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = Number(process.env.PORT ?? 3000);

const server = createServer((req, res) => {
  router(req, res).catch((err) => {
    console.error("Unhandled server error:", err);
    sendError(res, 500, "Internal server error");
  });
});

server.listen(PORT, () => {
  console.log(`\nDevGuard Bootstrap Server`);
  console.log(`  UI:  http://localhost:${PORT}`);
  console.log(`  API: http://localhost:${PORT}/api/sessions`);
  console.log(`\nPaste a repo URL in the browser to start a session.\n`);
});
