async function loadDemoRun() {
  const response = await fetch("./sample-run.json");

  if (!response.ok) {
    throw new Error("Unable to load sample run");
  }

  return response.json();
}

function renderMetrics(run) {
  const metrics = [
    ["Project", run.projectPath],
    ["Prediction status", run.predictionMatch.status],
    ["Risk count", String(run.riskReport.risks.length)],
    ["Fix artifacts", String(run.fixBundle.artifacts.length)]
  ];

  const container = document.querySelector("#metrics");
  container.innerHTML = metrics
    .map(
      ([label, value]) => `
        <article class="card">
          <span>${label}</span>
          <strong>${value}</strong>
        </article>
      `
    )
    .join("");
}

function renderTimeline(run) {
  const container = document.querySelector("#timeline");
  container.innerHTML = run.timeline
    .map(
      (stage) => `
        <article class="timeline-item">
          <small>${stage.status}</small>
          <h3>${stage.title}</h3>
          <p>${stage.detail}</p>
        </article>
      `
    )
    .join("");
}

function renderArtifacts(run) {
  const container = document.querySelector("#artifacts");
  container.innerHTML = run.fixBundle.artifacts
    .map(
      (artifact) => `
        <article class="artifact">
          <h3>${artifact.path}</h3>
          <pre>${artifact.content}</pre>
        </article>
      `
    )
    .join("");
}

function renderRootCause(run) {
  document.querySelector("#summary").textContent = run.riskReport.summary;
  document.querySelector("#root-cause-title").textContent = run.predictionMatch.rationale;
  document.querySelector("#root-cause-body").textContent = run.causalAnalysis.rootCause;
}

loadDemoRun()
  .then((run) => {
    renderMetrics(run);
    renderTimeline(run);
    renderArtifacts(run);
    renderRootCause(run);
  })
  .catch((error) => {
    document.querySelector("#summary").textContent = error.message;
  });
