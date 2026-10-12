"use strict";

const presentation = { exporting: false, tourStep: null, highlighted: null, downloads: new Set() };
const tourSteps = [
  { title: "tourAudioTitle", description: "tourAudioText", target: "load-test-audio" },
  { title: "tourIdentifyTitle", description: "tourIdentifyText", target: "identify-button" },
  { title: "tourResultTitle", description: "tourResultText", target: "result-title" },
  { title: "tourMapTitle", description: "tourMapText", target: "map-3d" },
  { title: "tourExportTitle", description: "tourExportText", target: "export-html" },
  { title: "tourBackendTitle", description: "tourBackendText", target: "backend-select" },
];

function canExportAnalysis() {
  return Boolean(state.result && state.result.backend === preferences.values.backend
    && !state.busy && !state.recording && !state.refreshing && !presentation.exporting);
}

function analysisReport(result, context) {
  const name = speaker => ({ id: speaker.id, name: speaker.name, display_name: speakerName(speaker) });
  const map = result.constellation;
  return {
    schema_version: 1, application: "Speaker Identification", version: "1.0",
    completed_at: result.completed_at, exported_at: context.exportedAt,
    language: context.language, audio_name: context.audioName, backend: result.backend,
    model: "ECAPA-TDNN", embedding_dimensions: 192,
    outcome: result.speaker ? "matched" : "unknown", reason: result.reason,
    speaker: result.speaker ? name(result.speaker) : null,
    threshold: result.threshold, min_gap: result.min_gap, gap: result.gap,
    requested_top_n: result.top_n, displayed_top_n: context.topN,
    returned_candidates: result.candidates.length,
    candidates: result.candidates.slice(0, context.topN).map((candidate, index) => ({
      rank: index + 1, ...name(candidate), score: candidate.score,
    })),
    audio: { duration_seconds: result.audio.duration_seconds, warnings: [...result.audio.warnings] },
    elapsed_seconds: result.elapsed_seconds, elapsed_ms: result.elapsed_ms,
    expected_speaker: context.expectedSpeaker ? name(context.expectedSpeaker) : null,
    spotlight: {
      available: Boolean(context.snapshotAvailable),
      reason: context.snapshotAvailable ? null : (map?.reason || "reportSnapshotUnavailable"),
      projection: "PCA", reference_count: context.snapshotAvailable ? map.points.length : null,
      explained_variance_2d: context.snapshotAvailable ? map.explained_variance : null,
      explained_variance_3d: context.snapshotAvailable ? map.explained_variance_3d : null,
      view: context.snapshotAvailable ? { ...context.view } : null,
    },
    privacy: "Contains speaker names and similarity scores. No audio or raw embeddings. Not proof of identity.",
  };
}

function csvCell(value) {
  if (value === null || value === undefined) return '""';
  let text = String(value);
  // Prevent user-controlled names from becoming spreadsheet formulas; keep numeric scores numeric.
  if (typeof value === "string" && (/^\s*[=+\-@]/.test(text) || /^[\t\r\n]/.test(text))) text = "'" + text;
  return `"${text.replaceAll('"', '""')}"`;
}

function analysisCSV(report) {
  const metadata = {
    completed_at: report.completed_at, exported_at: report.exported_at, backend: report.backend,
    audio_name: report.audio_name, outcome: report.outcome, reason: report.reason,
    matched_speaker_id: report.speaker?.id, matched_speaker_name: report.speaker?.name,
    threshold: report.threshold, min_gap: report.min_gap, gap: report.gap,
    requested_top_n: report.requested_top_n, displayed_top_n: report.displayed_top_n,
    returned_candidates: report.returned_candidates,
    duration_seconds: report.audio.duration_seconds, elapsed_seconds: report.elapsed_seconds, elapsed_ms: report.elapsed_ms,
    expected_speaker_id: report.expected_speaker?.id, expected_speaker_name: report.expected_speaker?.name,
    warnings: report.audio.warnings.join("; "),
    spotlight_available: report.spotlight.available, spotlight_reason: report.spotlight.reason,
  };
  const columns = [...Object.keys(metadata), "rank", "speaker_id", "speaker_name", "display_name", "cosine_similarity"];
  const candidates = report.candidates.length ? report.candidates : [null];
  const rows = candidates.map(candidate => [...Object.values(metadata),
    candidate?.rank, candidate?.id, candidate?.name, candidate?.display_name, candidate?.score]);
  return "\uFEFF" + [columns, ...rows].map(row => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function escapeReportHTML(value) {
  return String(value ?? "").replace(/[&<>"']/g, character =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function spotlightSnapshot() {
  if (!demo.plot || $("constellation-content").hidden || $("identify-page").hidden) return null;
  stopConstellationSpin();
  const original = $("constellation-svg");
  if (!original.clientWidth || !original.clientHeight) throw new LocalizedError("reportSnapshotError");
  const copy = original.cloneNode(true);
  const sourceNodes = [original, ...original.querySelectorAll("*")];
  const copyNodes = [copy, ...copy.querySelectorAll("*")];
  const properties = ["fill", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap",
    "stroke-linejoin", "opacity", "visibility", "display", "font-family", "font-size",
    "font-weight", "paint-order", "text-anchor"];
  sourceNodes.forEach((node, index) => {
    const style = getComputedStyle(node);
    copyNodes[index].removeAttribute("style");
    for (const property of properties) copyNodes[index].setAttribute(property, style.getPropertyValue(property));
    for (const attribute of [...copyNodes[index].attributes]) {
      if (attribute.name.startsWith("on") || ["id", "tabindex", "role", "aria-pressed"].includes(attribute.name)) {
        copyNodes[index].removeAttribute(attribute.name);
      }
    }
  });
  copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  copy.setAttribute("width", String(original.clientWidth));
  copy.setAttribute("height", String(original.clientHeight));
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("width", "100%");
  background.setAttribute("height", "100%");
  background.setAttribute("fill", getComputedStyle(document.documentElement).getPropertyValue("--cp-surface").trim());
  background.setAttribute("stroke", "none");
  copy.prepend(background);
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(new XMLSerializer().serializeToString(copy));
}

function analysisReportBody(report, snapshot) {
  const e = escapeReportHTML;
  const field = (label, value) => `<dt>${e(label)}</dt><dd>${e(value ?? t("notApplicable"))}</dd>`;
  const candidates = report.candidates.map(candidate => `<tr><td>${candidate.rank}</td><td>${e(candidate.display_name)}</td><td>${e(candidate.score)}</td></tr>`).join("");
  const outcome = report.speaker?.display_name || t("unknown");
  const snapshotStatus = snapshot ? `<img class="report-snapshot" alt="${e(t("constellationTitle"))}" src="${e(snapshot)}">
    <p>${e(report.spotlight.view.mode.toUpperCase())} / PCA · ${e(t("reportSnapshotLegend"))}</p>`
    : `<p>${e(t("reportSnapshotUnavailable"))} ${report.spotlight.reason === "reportSnapshotUnavailable" ? "" : e(t(report.spotlight.reason))}</p>`;
  return `<header><p class="eyebrow">SPEAKER IDENTIFICATION / ${e(t("reportExport"))}</p><h1>${e(t("reportTitle"))}</h1>
    <p>Author : serge.retkowsky@microsoft.com · Version 1.0 · 05-10-2026</p>
    <p>${e(t("reportPrintHint"))}</p><p>${e(t("reportPrivacy"))}</p></header>
    <main class="report-main"><section><h2>${e(outcome)}</h2><dl>
    ${field(t("reportCompleted"), report.completed_at)}${field(t("reportExported"), report.exported_at)}
    ${field(t("backend"), report.backend === "azure" ? "Azure AI Search" : "Qdrant")}
    ${field(t("audioInput"), report.audio_name)}${field(t("reportOutcome"), report.outcome + " / " + report.reason)}
    ${field(t("threshold"), report.threshold)}${field(t("minGap"), report.min_gap)}${field(t("gap"), report.gap)}
    ${field(t("audioLength"), report.audio.duration_seconds + " s")}
    ${field(t("analysisTime"), report.elapsed_seconds + " s / " + report.elapsed_ms + " ms")}
    ${field(t("reportExpected"), report.expected_speaker?.display_name)}
    ${field(t("reportTopN"), `${report.requested_top_n} / ${report.displayed_top_n} / ${report.candidates.length}`)}
    </dl><p>${e(t("reportTimingHint"))}</p><p>${e(report.audio.warnings.map(translatedServerMessage).join(" "))}</p></section>
    <section><h2>${e(t("resultTitle"))}</h2><div class="table-wrap"><table><thead><tr><th>${e(t("rank"))}</th><th>${e(t("speaker"))}</th><th>${e(t("similarity"))}</th></tr></thead>
    <tbody>${candidates || `<tr><td colspan="3">${e(t("reportNoCandidates"))}</td></tr>`}</tbody></table></div>
    <p>${e(t("reportScoreHint"))}</p></section>
    <section><h2>${e(t("constellationTitle"))}</h2>${snapshotStatus}<p>${e(t("constellationExplanation"))}</p></section>
    <footer>${e(t("resultDisclaimer"))}</footer></main>`;
}

function analysisHTML(report, body, css) {
  return `<!doctype html><html lang="${escapeReportHTML(report.language)}"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1"><title>Speaker Identification - ${escapeReportHTML(report.completed_at)}</title>
    <script>(() => { const param = new URLSearchParams(window.location.search).get("scoutTheme"); const theme = param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"); document.documentElement.setAttribute("data-theme", theme); })();</script>
    <style>${css}
    .report-main { max-width: 1200px; margin: auto; padding: 32px; }
    .report-snapshot { display: block; width: 100%; height: auto; }
    @media print { .report-main { padding: 0; } }
    </style></head><body>${body}</body></html>`;
}

function downloadAnalysisFile(content, type, filename) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  presentation.downloads.add(url);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); presentation.downloads.delete(url); }, 60000);
  }
}

async function exportAnalysis(format) {
  if (!["html", "csv", "json"].includes(format)) { showError(new LocalizedError("reportExportError")); return; }
  if (!canExportAnalysis()) { showError(new LocalizedError("reportUnavailable")); return; }
  if (!validTopN()) { showError(new LocalizedError("topNError")); return; }
  clearNotices();
  presentation.exporting = true;
  renderPresentation();
  try {
    const snapshot = format === "html" ? spotlightSnapshot() : null;
    const report = analysisReport(state.result, {
      exportedAt: new Date().toISOString(), language: preferences.values.language,
      audioName: $("audio-name").textContent, topN: $("top-n").valueAsNumber,
      expectedSpeaker: state.audioName?.kind === "test" ? state.audioName.sample.expected_speaker : null,
      snapshotAvailable: format === "html" ? Boolean(snapshot) : Boolean(demo.plot),
      view: demo.view,
    });
    const filename = `speaker-analysis-${report.backend}-${report.exported_at.replace(/[:.]/g, "-")}.${format}`;
    let content, type;
    if (format === "html") {
      const body = analysisReportBody(report, snapshot);
      const response = await request("/static/documentation.css");
      if (!response.ok) throw new LocalizedError("reportExportError");
      content = analysisHTML(report, body, await response.text());
      type = "text/html;charset=utf-8";
    } else if (format === "csv") {
      content = analysisCSV(report);
      type = "text/csv;charset=utf-8";
    } else {
      content = JSON.stringify(report, null, 2);
      type = "application/json;charset=utf-8";
    }
    downloadAnalysisFile(content, type, filename);
    success("reportDownloadRequested");
  } catch (error) { showError(error); }
  finally { presentation.exporting = false; renderPresentation(); }
}

function tourStepComplete(step) {
  if (step === 0) return Boolean(state.blob && state.audioName?.kind === "test");
  if ([1, 2, 4].includes(step)) return Boolean(state.result);
  if (step === 3) return Boolean(state.result && demo.plot && demo.view.mode === "3d");
  return step === 5;
}

function tourTarget() {
  const step = presentation.tourStep;
  if (step === 0 && state.source !== "test") return $("test-tab");
  if (step === 3 && !demo.plot) return $("constellation-title");
  if (step === 4 && !state.result) return $("result-title");
  return $(tourSteps[step].target);
}

function clearTourHighlight() {
  presentation.highlighted?.classList.remove("tour-target");
  presentation.highlighted = null;
}

function renderGuidedDemo() {
  const active = presentation.tourStep !== null;
  document.body.classList.toggle("tour-active", active);
  $("guided-demo-panel").hidden = !active;
  $("guided-demo-start").setAttribute("aria-expanded", String(active));
  clearTourHighlight();
  if (!active) return;
  const step = presentation.tourStep;
  const locked = state.busy || state.recording || state.refreshing;
  const complete = tourStepComplete(step);
  $("guided-demo-progress").textContent = t("tourProgress", { current: step + 1, total: tourSteps.length });
  $("guided-demo-step").textContent = t(tourSteps[step].title);
  $("guided-demo-description").textContent = t(tourSteps[step].description);
  $("guided-demo-hint").textContent = t(locked ? "tourBusy" : complete ? "tourReady" : "tourPending");
  $("guided-demo-back").disabled = locked || step === 0;
  $("guided-demo-next").disabled = locked || !complete;
  $("guided-demo-next").textContent = t(step === tourSteps.length - 1 ? "tourFinish" : "tourNext");
  $("guided-demo-skip").hidden = complete;
  $("guided-demo-skip").disabled = locked;
  $("guided-demo-show").disabled = locked;
  const target = tourTarget();
  target.classList.add("tour-target");
  presentation.highlighted = target;
}

function renderPresentation() {
  for (const id of ["export-html", "export-csv", "export-json"]) $(id).disabled = !canExportAnalysis();
  $("guided-demo-start").disabled = state.busy || state.recording || state.refreshing;
  if (presentation.tourStep !== null && $("identify-page").hidden) {
    presentation.tourStep = null;
  }
  renderGuidedDemo();
}

function startGuidedDemo() {
  if (state.busy || state.recording || state.refreshing) return;
  showPage("identify");
  for (const id of ["appearance-menu", "criteria-menu"]) $(id).open = false;
  presentation.tourStep = 0;
  renderGuidedDemo();
  $("guided-demo-title").focus({ preventScroll: true });
}

function closeGuidedDemo() {
  presentation.tourStep = null;
  renderGuidedDemo();
  const target = $("guided-demo-start").disabled
    ? document.querySelector('[data-page="identify"]') : $("guided-demo-start");
  target.focus({ preventScroll: true });
}

function moveGuidedDemo(direction, skip = false) {
  if (presentation.tourStep === null || state.busy || state.recording || state.refreshing) return;
  if (direction > 0 && !skip && !tourStepComplete(presentation.tourStep)) return;
  const next = presentation.tourStep + direction;
  if (next >= tourSteps.length) { closeGuidedDemo(); return; }
  presentation.tourStep = Math.max(0, next);
  renderGuidedDemo();
  $("guided-demo-title").focus({ preventScroll: true });
}

function showTourControl() {
  if (presentation.tourStep === null || state.busy || state.recording || state.refreshing) return;
  showPage("identify");
  if (presentation.tourStep === 0) switchSource("test");
  renderGuidedDemo();
  const target = tourTarget();
  target.scrollIntoView({ block: "start", behavior: "instant" });
  target.focus({ preventScroll: true });
}

function initializePresentation() {
  for (const format of ["html", "csv", "json"]) $(`export-${format}`).addEventListener("click", () => { void exportAnalysis(format); });
  $("guided-demo-start").addEventListener("click", startGuidedDemo);
  $("guided-demo-close").addEventListener("click", closeGuidedDemo);
  $("guided-demo-back").addEventListener("click", () => moveGuidedDemo(-1));
  $("guided-demo-next").addEventListener("click", () => moveGuidedDemo(1));
  $("guided-demo-skip").addEventListener("click", () => moveGuidedDemo(1, true));
  $("guided-demo-show").addEventListener("click", showTourControl);
  document.addEventListener("click", () => { if (presentation.tourStep !== null) renderPresentation(); });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && !event.defaultPrevented && presentation.tourStep !== null
      && !document.querySelector("dialog[open]")) {
      event.preventDefault();
      closeGuidedDemo();
    }
  });
  window.addEventListener("pagehide", () => {
    for (const url of presentation.downloads) URL.revokeObjectURL(url);
    presentation.downloads.clear();
  });
}
