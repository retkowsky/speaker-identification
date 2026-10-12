"use strict";

const demo = {
  selectedPoint: null, hoveredPoint: null,
  plot: null, view: { mode: "2d", zoom: 1, panX: 0, panY: 0, yaw: 30, pitch: 20 },
  spinning: false, spinFrame: null, spinTime: null,
  drag: null, suppressPlotClick: false, wheelDelta: 0, wheelTime: 0,
  reducedMotion: matchMedia("(prefers-reduced-motion: reduce)"), animations: [],
  spectrumTime: 0, waveformTime: 0,
};

function renderDemo() {
  $("demo-reset").disabled = state.busy || state.recording || state.refreshing;
  $("demo-stage").textContent = t(state.recording ? "stageListening" : state.analyzing ? "stageAnalyzing"
    : state.result ? "stageResult" : state.blob ? "stageAudioReady" : "stageReady");
  $("demo-stage").dataset.stage = state.recording ? "listening" : state.analyzing ? "analyzing" : state.result ? "result" : "ready";
  renderPresentation();
}

function resetDemo() {
  if (state.busy || state.recording || state.refreshing) return;
  document.querySelectorAll("audio").forEach(audio => { audio.pause(); if (audio.readyState) audio.currentTime = 0; });
  clearNotices();
  setAudio(null);
  clearAudioVisuals();
  showPage("identify");
  $("result-live").textContent = "";
  $("record-button").focus();
}

function cancelResultReveal() {
  demo.animations.forEach(animation => animation.cancel());
  demo.animations = [];
}

function revealResult() {
  cancelResultReveal();
  $("result-live").textContent = state.result.speaker
    ? t("resultAnnouncement", { name: speakerName(state.result.speaker), score: number(state.result.candidates[0].score, 3) })
    : t("unknown");
  if (demo.reducedMotion.matches) return;
  const summary = $("result-content").querySelector(".match-summary");
  demo.animations.push(summary.animate(
    [{ opacity: 0, transform: "translateY(12px)" }, { opacity: 1, transform: "translateY(0)" }],
    { duration: 450, easing: "ease-out" },
  ));
  const bars = [$("score-bar"), ...document.querySelectorAll(".similarity-track > span")];
  bars.forEach((bar, index) => {
    demo.animations.push(bar.animate(
      [{ transform: "scaleX(0)" }, { transform: "scaleX(1)" }],
      { duration: 600, delay: Math.min(index * 55, 330), easing: "cubic-bezier(.2,.7,.2,1)", fill: "backwards" },
    ));
  });
  const query = $("constellation-svg").querySelector(".query-point");
  if (query) demo.animations.push(query.animate(
    [{ opacity: 0 }, { opacity: 1 }], { duration: 850, easing: "ease-out" },
  ));
}

function addThresholdMarker(container, threshold) {
  const marker = document.createElement("i");
  marker.className = "threshold-marker";
  marker.style.left = `${threshold * 100}%`;
  marker.title = t("thresholdMarker", { value: number(threshold, 2) });
  marker.setAttribute("aria-hidden", "true");
  container.append(marker);
}

function clearAudioVisuals() {
  demo.spectrumTime = 0;
  demo.waveformTime = 0;
  const canvas = $("spectrogram");
  canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  $("mic-orb").style.removeProperty("--voice-level");
  $("input-level").value = 0;
  $("input-level").setAttribute("aria-valuetext", t("levelIdle"));
  $("input-level-label").textContent = t("levelIdle");
}

function audioEnergy(values) {
  if (!values.length) return 0;
  let sum = 0;
  for (const value of values) sum += (value / 128 - 1) ** 2;
  return Math.sqrt(sum / values.length);
}

function drawAudioVisuals(analyser, values, now) {
  const rms = audioEnergy(values);
  const level = Math.min(1, rms * 4);
  $("input-level").value = level;
  const label = t(rms >= 0.5 ? "levelLoud" : rms < 0.008 ? "levelQuiet" : "levelActive");
  $("input-level").setAttribute("aria-valuetext", label);
  $("input-level-label").textContent = label;
  $("mic-orb").style.setProperty("--voice-level", demo.reducedMotion.matches ? "0" : String(level));
  const interval = demo.reducedMotion.matches ? 250 : 50;
  if (now - demo.spectrumTime < interval) return;
  demo.spectrumTime = now;
  const canvas = $("spectrogram");
  const context = canvas.getContext("2d");
  const bins = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(bins);
  const width = canvas.width, height = canvas.height;
  const columnWidth = demo.reducedMotion.matches ? width : 3;
  if (!demo.reducedMotion.matches) context.drawImage(canvas, -columnWidth, 0);
  context.clearRect(width - columnWidth, 0, columnWidth, height);
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--cp-accent").trim();
  context.fillStyle = accent;
  for (let y = 0; y < height; y += 2) {
    const frequency = 8000 * (1 - y / height);
    const bin = Math.min(bins.length - 1, Math.round(frequency * analyser.fftSize / analyser.context.sampleRate));
    context.globalAlpha = bins[bin] / 255;
    context.fillRect(width - columnWidth, y, columnWidth, 2);
  }
  context.globalAlpha = 1;
}

function constellationLayout(points, query, view = { zoom: 1, panX: 0, panY: 0 }, width = 760, height = 450) {
  const positions = query ? [...points, query] : points;
  const threeD = view.mode === "3d";
  const yaw = view.yaw * Math.PI / 180, pitch = view.pitch * Math.PI / 180;
  let radius = 0.01;
  for (const point of positions) {
    radius = Math.max(radius, Math.hypot(point.x, point.y, threeD ? point.z : 0));
  }
  const scale = Math.max(20, Math.min(width, height) / 2 - 55) * view.zoom / radius;
  const project = point => {
    let x = point.x, y = point.y, depth = 0;
    if (threeD) {
      x = point.x * Math.cos(yaw) + point.z * Math.sin(yaw);
      const z = -point.x * Math.sin(yaw) + point.z * Math.cos(yaw);
      y = point.y * Math.cos(pitch) - z * Math.sin(pitch);
      depth = (point.y * Math.sin(pitch) + z * Math.cos(pitch)) / radius;
    }
    return {
      x: width * (0.5 + view.panX) + x * scale,
      y: height * (0.5 + view.panY) - y * scale,
      depth,
    };
  };
  return { points: points.map(project), query: query ? project(query) : null };
}

function renderMapControls() {
  const threeD = demo.view.mode === "3d";
  const badge = t(preferences.values.backend === "azure" ? "constellationAzureBadge" : "constellationBadge");
  $("constellation-badge").textContent = badge;
  $("map-2d").setAttribute("aria-pressed", String(!threeD));
  $("map-3d").setAttribute("aria-pressed", String(threeD));
  $("map-spin").hidden = !threeD;
  $("map-spin").disabled = !demo.plot || demo.reducedMotion.matches;
  $("map-spin").setAttribute("aria-pressed", String(demo.spinning));
  $("map-spin").textContent = t(demo.spinning ? "mapStopSpin" : "mapSpin");
  $("map-motion-hint").hidden = !threeD || !demo.reducedMotion.matches;
  $("map-mouse-hint").textContent = t(threeD ? "mapMouseHint3D" : "mapMouseHint");
  $("map-zoom").value = demo.view.zoom;
  $("map-zoom-value").textContent = `${number(demo.view.zoom * 100, 0)}%`;
  $("map-zoom").setAttribute("aria-valuetext", $("map-zoom-value").textContent);
  $("map-zoom-out").disabled = demo.view.zoom <= 0.5;
  $("map-zoom-in").disabled = demo.view.zoom >= 3;
  $("map-view-badge").textContent = `${demo.view.mode.toUpperCase()} / ${badge}`;
  if (demo.plot) {
    const { map } = demo.plot;
    $("constellation-stats").textContent = t("constellationStats", {
      count: map.points.length,
      variance: number((threeD ? map.explained_variance_3d : map.explained_variance) * 100, 1),
    });
    $("constellation-limited").hidden = map.rank >= (threeD ? 3 : 2);
  }
}

function setConstellationAngles(yaw, pitch) {
  demo.view.yaw = ((yaw % 360) + 360) % 360;
  demo.view.pitch = Math.max(-85, Math.min(85, pitch));
}

function stopConstellationSpin() {
  if (demo.spinFrame !== null) cancelAnimationFrame(demo.spinFrame);
  demo.spinFrame = null;
  demo.spinTime = null;
  demo.spinning = false;
  renderMapControls();
}

function spinConstellation(now) {
  demo.spinFrame = null;
  if (!demo.spinning || !demo.plot || !state.result || demo.view.mode !== "3d"
    || demo.plot.map.backend !== preferences.values.backend || document.hidden
    || $("identify-page").hidden || demo.reducedMotion.matches) {
    stopConstellationSpin();
    return;
  }
  if (demo.spinTime !== null) {
    setConstellationAngles(demo.view.yaw + Math.min(now - demo.spinTime, 100) * 0.018, demo.view.pitch);
  }
  demo.spinTime = now;
  updateConstellationView();
  demo.spinFrame = requestAnimationFrame(spinConstellation);
}

function toggleConstellationSpin() {
  if (demo.spinning) { stopConstellationSpin(); return; }
  if (!demo.plot || demo.view.mode !== "3d" || demo.reducedMotion.matches
    || document.hidden || $("identify-page").hidden) return;
  demo.hoveredPoint = null;
  demo.spinning = true;
  demo.spinTime = null;
  renderMapControls();
  demo.spinFrame = requestAnimationFrame(spinConstellation);
}

function setConstellationMode(mode) {
  demo.view.mode = mode;
  resetConstellationView();
}

function resetConstellationView() {
  cancelConstellationDrag();
  stopConstellationSpin();
  demo.wheelDelta = 0;
  demo.view.zoom = 1;
  demo.view.panX = 0;
  demo.view.panY = 0;
  demo.view.yaw = 30;
  demo.view.pitch = 20;
  updateConstellationView();
}

function setConstellationZoom(value) {
  stopConstellationSpin();
  demo.view.zoom = Math.min(3, Math.max(0.5, Math.round(value * 10) / 10));
  updateConstellationView();
}

function cancelConstellationDrag() {
  if (!demo.drag) return;
  const { pointerId } = demo.drag;
  demo.drag = null;
  const svg = $("constellation-svg");
  svg.classList.remove("dragging");
  if (svg.hasPointerCapture(pointerId)) svg.releasePointerCapture(pointerId);
}

function startConstellationDrag(event) {
  if (!demo.plot || event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return;
  event.preventDefault();
  cancelConstellationDrag();
  stopConstellationSpin();
  demo.suppressPlotClick = false;
  demo.drag = {
    pointerId: event.pointerId, x: event.clientX, y: event.clientY,
    panX: demo.view.panX, panY: demo.view.panY, moved: false,
    yaw: demo.view.yaw, pitch: demo.view.pitch, pan: demo.view.mode === "2d" || event.shiftKey,
  };
}

function moveConstellationDrag(event) {
  const drag = demo.drag;
  if (!drag || event.pointerId !== drag.pointerId) return;
  if (!(event.buttons & 1) || !demo.plot) { cancelConstellationDrag(); return; }
  const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
  if (!drag.moved && Math.hypot(dx, dy) < 4) return;
  if (!drag.moved) {
    drag.moved = true;
    demo.suppressPlotClick = true;
    $("constellation-svg").setPointerCapture(event.pointerId);
    $("constellation-svg").classList.add("dragging");
  }
  event.preventDefault();
  const svg = $("constellation-svg");
  if (drag.pan) {
    demo.view.panX = drag.panX + dx / svg.clientWidth;
    demo.view.panY = drag.panY + dy / svg.clientHeight;
  } else {
    setConstellationAngles(drag.yaw + dx * 0.4, drag.pitch - dy * 0.4);
  }
  updateConstellationView();
}

function endConstellationDrag(event) {
  if (demo.drag?.pointerId === event.pointerId) cancelConstellationDrag();
}

function navigateConstellationWithKeyboard(event) {
  if (!demo.plot || event.target !== $("constellation-svg") || event.ctrlKey || event.metaKey || event.altKey) return;
  const directions = { ArrowLeft: [-0.05, 0], ArrowRight: [0.05, 0], ArrowUp: [0, -0.05], ArrowDown: [0, 0.05] };
  const direction = directions[event.key];
  if (!direction) return;
  event.preventDefault();
  stopConstellationSpin();
  if (demo.view.mode === "3d" && !event.shiftKey) {
    setConstellationAngles(demo.view.yaw + direction[0] * 100, demo.view.pitch - direction[1] * 100);
  } else {
    demo.view.panX += direction[0];
    demo.view.panY += direction[1];
  }
  updateConstellationView();
}

function zoomConstellationWithWheel(event) {
  if (!demo.plot || event.ctrlKey || event.metaKey || !event.deltaY) return;
  event.preventDefault();
  stopConstellationSpin();
  if (event.timeStamp - demo.wheelTime > 200) demo.wheelDelta = 0;
  demo.wheelTime = event.timeStamp;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? $("constellation-svg").clientHeight : 1;
  demo.wheelDelta += event.deltaY * unit;
  const steps = Math.trunc(demo.wheelDelta / 50);
  if (steps) {
    demo.wheelDelta -= steps * 50;
    setConstellationZoom(demo.view.zoom - steps * 0.1);
  }
}

function placeConstellationLabels(items, obstacles, width, height) {
  const occupied = [...obstacles];
  const placements = Array(items.length).fill(null);
  const overlaps = (a, b) => a.x < b.x + b.width + 3 && a.x + a.width + 3 > b.x
    && a.y < b.y + b.height + 3 && a.y + a.height + 3 > b.y;
  for (const item of [...items].sort((a, b) => a.priority - b.priority || a.index - b.index)) {
    if (item.x < 0 || item.y < 0 || item.x > width || item.y > height) continue;
    const w = item.width, h = item.height;
    for (const gap of [18, 34, 52]) {
      const offsets = [[gap, -h / 2], [-w - gap, -h / 2], [-w / 2, -h - gap], [-w / 2, gap],
        [gap, -h - gap], [-w - gap, -h - gap], [gap, gap], [-w - gap, gap]];
      const space = offsets.map(([x, y]) => ({ x: item.x + x, y: item.y + y, width: w, height: h }))
        .find(rect => rect.x >= 8 && rect.y >= 8 && rect.x + w <= width - 8 && rect.y + h <= height - 8
          && !occupied.some(other => overlaps(rect, other)));
      if (!space) continue;
      placements[item.index] = space;
      occupied.push(space);
      break;
    }
  }
  return placements;
}

function updateConstellationLabels(layout, width, height) {
  const { points, map, query } = demo.plot;
  const obstacles = layout.points.map(point => ({ x: point.x - 12, y: point.y - 12, width: 24, height: 24 }));
  obstacles.push({ x: layout.query.x - 24, y: layout.query.y - 24, width: 48, height: 48 },
    { x: 8, y: 6, width: 180, height: 24 });
  const queryLabel = query.querySelector("text").getBBox();
  obstacles.push({ x: layout.query.x + queryLabel.x, y: layout.query.y + queryLabel.y,
    width: queryLabel.width, height: queryLabel.height });
  const items = points.filter(point => point.nearest
    || map.points[point.index].sample_id === demo.selectedPoint
    || map.points[point.index].sample_id === demo.hoveredPoint).map(point => {
    if (!point.labelBounds) point.labelBounds = point.label.getBBox();
    return { ...layout.points[point.index], width: point.labelBounds.width, height: point.labelBounds.height,
      index: point.index, priority: map.points[point.index].sample_id === demo.selectedPoint ? 0 : point.nearest ? 1 : 2 };
  });
  const placements = placeConstellationLabels(items, obstacles, width, height);
  points.forEach(({ label, leader, labelBounds, index }) => {
    const box = placements[index], point = layout.points[index];
    label.style.visibility = leader.style.visibility = box ? "visible" : "hidden";
    if (!box) return;
    label.setAttribute("transform", `translate(${box.x - point.x - labelBounds.x} ${box.y - point.y - labelBounds.y})`);
    leader.setAttribute("x1", 0); leader.setAttribute("y1", 0);
    leader.setAttribute("x2", Math.min(box.x + box.width, Math.max(box.x, point.x)) - point.x);
    leader.setAttribute("y2", Math.min(box.y + box.height, Math.max(box.y, point.y)) - point.y);
  });
}

function updateConstellationView() {
  renderMapControls();
  if (!demo.plot) return;
  const { map, points, links, query } = demo.plot;
  const svg = $("constellation-svg");
  if (!svg.clientWidth || !svg.clientHeight) return;
  svg.setAttribute("viewBox", `0 0 ${svg.clientWidth} ${svg.clientHeight}`);
  const layout = constellationLayout(map.points, map.query, demo.view, svg.clientWidth, svg.clientHeight);
  const setLine = (node, start, end) => {
    node.setAttribute("x1", start.x); node.setAttribute("y1", start.y);
    node.setAttribute("x2", end.x); node.setAttribute("y2", end.y);
  };
  links.forEach(({ node, index }) => setLine(node, layout.query, layout.points[index]));
  points.forEach(({ node, core, nearest }, index) => {
    const point = layout.points[index];
    node.setAttribute("transform", `translate(${point.x} ${point.y})`);
    core.setAttribute("r", (nearest ? 4 : 2.5) * (1 + point.depth * 0.3));
  });
  query.setAttribute("transform", `translate(${layout.query.x} ${layout.query.y})`);
  updateConstellationLabels(layout, svg.clientWidth, svg.clientHeight);
}

function svgElement(tag, attributes = {}, text = null) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  if (text !== null) element.textContent = text;
  return element;
}

function constellationPointLabel(point) {
  return t("constellationPoint", { name: speakerName(point), sample: point.sample_id });
}

function constellationPointDescription(point, matched = false) {
  return constellationPointLabel(point)
    + (Number.isFinite(point.score) ? ` / ${t("similarity")}: ${number(point.score, 3)}` : "")
    + (matched ? ` / ${t("constellationMatched")}` : "");
}

function bestConstellationSample(points, speakerId) {
  let closest = -1;
  points.forEach((point, index) => {
    if (point.id === speakerId && (closest === -1 || point.score > points[closest].score)) closest = index;
  });
  return closest;
}

function selectConstellationPoint(sampleId, map) {
  stopConstellationSpin();
  demo.selectedPoint = sampleId;
  $("constellation-select").value = sampleId;
  const point = map.points.find(item => item.sample_id === sampleId);
  if (!point) return;
  $("constellation-detail").textContent = constellationPointDescription(point, map.points[demo.plot.matchedIndex] === point);
  $("constellation-svg").querySelectorAll("[data-sample]").forEach(node => {
    node.classList.toggle("selected", node.dataset.sample === sampleId);
    node.setAttribute("aria-pressed", String(node.dataset.sample === sampleId));
  });
  updateConstellationView();
}

function renderConstellation() {
  cancelConstellationDrag();
  stopConstellationSpin();
  demo.wheelDelta = 0;
  demo.hoveredPoint = null;
  const map = state.result?.constellation;
  const valid = map?.available && map.backend === preferences.values.backend
    && state.result.backend === preferences.values.backend && map.query && Array.isArray(map.points)
    && [map.query, ...map.points].every(point => ["x", "y", "z"].every(axis => Number.isFinite(point[axis])))
    && Number.isFinite(map.explained_variance) && Number.isFinite(map.explained_variance_3d);
  const usable = Boolean(state.result && valid && map.points.length);
  $("constellation-content").hidden = !usable;
  $("constellation-status").hidden = usable;
  $("constellation-retry").hidden = !state.result || usable || (valid && !map.points.length);
  if (!usable) {
    if (state.result && map?.available && !valid) console.error("Invalid constellation projection response.", map);
    $("constellation-status").textContent = t(!state.result ? "constellationAwaiting"
      : valid ? "constellationEmpty" : map?.reason || "constellationUnavailable");
    demo.plot = null;
    demo.selectedPoint = null;
    $("constellation-svg").replaceChildren();
    $("constellation-select").replaceChildren();
    $("constellation-detail").textContent = "";
    $("constellation-stats").textContent = "";
    resetConstellationView();
    return;
  }
  $("constellation-query-legend").hidden = false;
  const svg = $("constellation-svg");
  const candidates = state.result?.candidates.slice(0, validTopN() ? $("top-n").valueAsNumber : state.result.top_n) || [];
  const matchedIndex = state.result.speaker ? bestConstellationSample(map.points, state.result.speaker.id) : -1;
  const nearest = new Set();
  const fragment = document.createDocumentFragment();
  const links = [], points = [];
  for (const candidate of candidates) {
      const closest = bestConstellationSample(map.points, candidate.id);
      if (closest === -1) continue;
      nearest.add(map.points[closest].sample_id);
      const node = svgElement("line", {
        class: `map-connection${candidate.score < state.result.threshold ? " below" : ""}${closest === matchedIndex ? " matched" : ""}`,
      });
      fragment.append(node);
      links.push({ node, index: closest });
  }
  const selector = $("constellation-select");
  selector.replaceChildren();
  const pointLayer = svgElement("g");
  fragment.append(pointLayer);
  map.points.forEach((point, index) => {
    const matched = index === matchedIndex;
    const description = constellationPointDescription(point, matched);
    const group = svgElement("g", {
      class: `reference-point${nearest.has(point.sample_id) ? " nearest" : ""}${matched ? " matched" : ""}`,
      tabindex: "0", role: "button",
      "aria-label": description, "data-sample": point.sample_id,
    });
    const core = svgElement("circle", { class: "point-core" });
    const label = svgElement("text", { class: "point-label", "aria-hidden": "true" });
    label.append(svgElement("tspan", { x: 0, y: 0 }, speakerName(point)));
    if (Number.isFinite(point.score)) label.append(svgElement("tspan", {
      x: 0, dy: 14, class: point.score < state.result.threshold ? "point-score below" : "point-score",
    }, number(point.score, 3)));
    if (matched) label.append(svgElement("tspan", { x: 0, dy: 14, class: "point-match" }, t("constellationMatched")));
    const leader = svgElement("line", { class: "point-label-leader", "aria-hidden": "true" });
    group.append(leader, svgElement("circle", { r: 14, class: "point-hit" }),
      svgElement("circle", { r: 10, class: "point-ring" }), core, label);
    group.append(svgElement("title", {}, description));
    group.addEventListener("click", () => selectConstellationPoint(point.sample_id, map));
    group.addEventListener("focus", () => selectConstellationPoint(point.sample_id, map));
    group.addEventListener("pointerenter", () => {
      if (demo.drag || demo.spinning) return;
      demo.hoveredPoint = point.sample_id;
      updateConstellationView();
    });
    group.addEventListener("pointerleave", () => {
      demo.hoveredPoint = null;
      updateConstellationView();
    });
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); selectConstellationPoint(point.sample_id, map); }
    });
    pointLayer.append(group);
    points.push({ node: group, core, label, leader, labelBounds: null, index, nearest: nearest.has(point.sample_id) });
    const option = document.createElement("option");
    option.value = point.sample_id;
    option.textContent = constellationPointLabel(point);
    selector.append(option);
  });
  const query = svgElement("g", { class: "query-point", role: "img", "aria-label": t("constellationQuery") });
  query.append(svgElement("circle", { r: 15, class: "query-halo" }));
  query.append(svgElement("path", { d: "M0 -7 l7 7 -7 7 -7 -7 Z", class: "query-core" }));
  query.append(svgElement("text", { x: 0, y: -24, class: "query-label", "text-anchor": "middle" }, t("constellationQuery")));
  fragment.append(query);
  svg.replaceChildren(fragment);
  demo.plot = { map, points, links, query, matchedIndex };
  updateConstellationView();
  const selected = map.points.some(point => point.sample_id === demo.selectedPoint)
    ? demo.selectedPoint : nearest.values().next().value || map.points[0].sample_id;
  selectConstellationPoint(selected, map);
  selector.onchange = () => selectConstellationPoint(selector.value, map);
}

function initializeDemo() {
  const plot = $("constellation-svg");
  plot.addEventListener("pointerdown", startConstellationDrag);
  window.addEventListener("pointermove", moveConstellationDrag, { passive: false });
  window.addEventListener("pointerup", endConstellationDrag);
  window.addEventListener("pointercancel", endConstellationDrag);
  plot.addEventListener("lostpointercapture", endConstellationDrag);
  plot.addEventListener("wheel", zoomConstellationWithWheel, { passive: false });
  plot.addEventListener("keydown", navigateConstellationWithKeyboard);
  plot.addEventListener("click", event => {
    if (demo.suppressPlotClick && event.detail > 0) {
      event.preventDefault();
      event.stopImmediatePropagation();
      demo.suppressPlotClick = false;
    }
  }, true);
  window.addEventListener("blur", () => { cancelConstellationDrag(); stopConstellationSpin(); });
  $("demo-reset").addEventListener("click", resetDemo);
  $("constellation-retry").addEventListener("click", () => {
    if (state.result && state.blob && state.ready) void identify();
  });
  $("map-zoom").addEventListener("input", event => setConstellationZoom(event.target.valueAsNumber));
  $("map-zoom-in").addEventListener("click", () => setConstellationZoom(demo.view.zoom + 0.1));
  $("map-zoom-out").addEventListener("click", () => setConstellationZoom(demo.view.zoom - 0.1));
  $("map-reset").addEventListener("click", resetConstellationView);
  $("map-2d").addEventListener("click", () => setConstellationMode("2d"));
  $("map-3d").addEventListener("click", () => setConstellationMode("3d"));
  $("map-spin").addEventListener("click", toggleConstellationSpin);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { cancelConstellationDrag(); stopConstellationSpin(); }
  });
  window.addEventListener("pagehide", () => { cancelConstellationDrag(); stopConstellationSpin(); });
  new ResizeObserver(() => updateConstellationView()).observe($("constellation-svg"));
  demo.reducedMotion.addEventListener("change", () => {
    stopConstellationSpin();
    cancelResultReveal();
    clearAudioVisuals();
    renderMapControls();
  });
  clearAudioVisuals();
  renderDemo();
}
