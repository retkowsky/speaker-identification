"use strict";

const $ = (id) => document.getElementById(id);
const state = {
  ready: false, busy: false, recording: false, blob: null, audioUrl: null,
  speakers: [], source: "mic", recorder: null, animation: null,
  engineStatus: "connecting", capture: "Idle", result: null, analyzing: false,
  audioName: null, error: null, success: null, enrollError: null, saving: false,
  backendStatus: null, testSamples: [], refreshing: false, initializing: false,
  configLoaded: false, configDirty: false, cloudPanelOpen: true,
  microphones: [], selectedMicrophone: "", microphoneRequest: 0,
};

function showError(error) {
  console.error(error);
  state.error = error;
  $("notice").textContent = errorText(error);
  $("notice").hidden = false;
}

function clearNotices() {
  state.error = null;
  state.success = null;
  $("notice").hidden = true;
  $("success").hidden = true;
}

function success(key, params = {}) {
  state.success = { key, params };
  $("success").textContent = successText();
  $("success").hidden = false;
}

function successText() {
  const { key, params } = state.success;
  return t(key, {
    ...params,
    name: params.expectedSpeaker ? speakerName(params.expectedSpeaker) : params.name,
    warnings: Array.isArray(params.warnings) ? params.warnings.map(translatedServerMessage).join(" ") : "",
  });
}

function initializeWelcome() {
  const dialog = $("welcome-dialog");
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault();
      dialog.close();
    }
  });
  dialog.addEventListener("close", () => {
    document.querySelector('[data-page="identify"]').focus();
  });
  dialog.showModal();
}

async function request(url, options = {}) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new LocalizedError("networkError");
  }
}

async function api(url, options = {}) {
  const response = await request(url, options);
  if (!response.ok) {
    const text = await response.text();
    let error = new LocalizedError("requestFailed", { status: response.status });
    if (response.headers.get("content-type")?.includes("application/json")) {
      const data = JSON.parse(text);
      if (typeof data.code === "string" && Object.hasOwn(translations, data.code)) {
        error = new LocalizedError(data.code);
      } else if (typeof data.detail === "string") {
        const key = serverMessages.get(data.detail);
        error = key ? new LocalizedError(key) : new Error(data.detail);
      } else if (Array.isArray(data.detail)) {
        console.warn("API validation details:", data.detail);
        error = new LocalizedError("serverValidation");
      }
    }
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function syncControls() {
  const locked = state.busy || state.recording || state.refreshing;
  const usable = state.ready && !(preferences.values.backend === "azure" && state.configDirty);
  $("identify-button").disabled = !usable || !state.blob || locked;
  $("enroll-button").disabled = !usable || !state.blob || locked;
  $("record-button").disabled = state.busy || state.refreshing || !usable;
  $("microphone-select").disabled = locked || !navigator.mediaDevices?.enumerateDevices;
  $("refresh-microphones").disabled = locked || !navigator.mediaDevices?.getUserMedia || !navigator.mediaDevices?.enumerateDevices;
  if (!state.recording && state.selectedMicrophone && !state.microphones.some(device => device.deviceId === state.selectedMicrophone)) {
    $("record-button").disabled = true;
  }
  $("file-input").disabled = locked || !usable;
  $("browse-button").disabled = locked || !usable;
  $("clear-audio").disabled = locked;
  $("demo-button").disabled = locked || !usable;
  $("new-speaker").disabled = locked || !usable;
  $("refresh-button").disabled = locked;
  $("threshold").disabled = locked;
  $("min-gap").disabled = locked;
  $("top-n").disabled = locked;
  $("constellation-retry").disabled = locked;
  $("update-top-n").disabled = locked || !usable || !state.blob || !state.result;
  $("backend-select").disabled = locked;
  $("test-audio-select").disabled = locked;
  $("load-test-audio").disabled = locked || !usable || !state.testSamples.length;
  $("cloud-consent").disabled = locked || state.configDirty || !state.backendStatus?.configured;
  $("initialize-azure").disabled = locked || state.configDirty || !state.backendStatus?.configured || !$("cloud-consent").checked;
  for (const id of ["azure-endpoint", "azure-index", "save-azure-config"]) $(id).disabled = locked || !state.configLoaded;
  $("check-azure").disabled = locked || state.configDirty || !state.configLoaded || !$("azure-endpoint").value.trim();
  document.querySelectorAll("[data-source], .sample-button, .delete-button").forEach((button) => {
    button.disabled = locked || !usable;
  });
  $("record-label").textContent = t(state.recording ? "stopRecording" : "startRecording");
  $("mic-orb").classList.toggle("recording", state.recording);
  renderDemo();
}

function resetResult() {
  cancelResultReveal();
  state.result = null;
  state.analyzing = false;
  $("result-empty").hidden = false;
  $("result-content").hidden = true;
  $("result-busy").hidden = true;
  $("result-badge").textContent = t("awaiting");
  $("test-evaluation").hidden = true;
  $("result-live").textContent = "";
  renderConstellation();
  renderDemo();
}

function speakerName(speaker) {
  return speaker.id.startsWith("bundled-") ? t("bundledName", { id: speaker.id.slice(8) }) : speaker.name;
}

function renderAudioName() {
  const name = state.audioName;
  $("audio-name").textContent = !name ? "" : typeof name === "string" ? name
    : name.kind === "microphone" ? t("microphoneFilename")
    : name.kind === "test" ? name.sample.filename
    : t("referenceFilename", { name: speakerName(name.speaker) });
}

function setCapture(capture) {
  state.capture = capture;
  $("capture-title").textContent = t(`capture${capture}`);
  $("capture-subtitle").textContent = t(`capture${capture === "Retry" ? "Idle" : capture}Hint`);
}

function renderLocale() {
  translatePage();
  $("language-select").value = preferences.values.language;
  $("font-select").value = preferences.values.font;
  $("backend-select").value = preferences.values.backend;
  const collator = new Intl.Collator(preferences.values.language);
  const paletteOptions = Array.from($("palette-select").options).sort((a, b) => collator.compare(a.text, b.text));
  $("palette-select").replaceChildren(...paletteOptions);
  $("palette-select").value = `${preferences.values.palette}-${preferences.values.mode}`;
  $("engine-status").textContent = t(state.engineStatus);
  setCapture(state.capture);
  renderAudioName();
  if (state.result) renderResult(state.result);
  else $("result-badge").textContent = t(state.analyzing ? "analyzing" : "awaiting");
  if (state.error) $("notice").textContent = errorText(state.error);
  if (state.success) $("success").textContent = successText();
  if (state.enrollError) $("enroll-error").textContent = errorText(state.enrollError);
  $("save-speaker").textContent = t(state.saving ? "saving" : "save");
  renderLibrary();
  renderTestSamples();
  renderBackend();
  renderAppearance();
  renderMicrophones();
  renderConstellation();
  renderDemo();
  if (!state.recording) drawWave();
}

function renderCloudPanel() {
  const cloud = preferences.values.backend === "azure";
  const open = cloud && state.cloudPanelOpen;
  $("cloud-panel").hidden = !open;
  $("azure-settings").hidden = !cloud;
  $("azure-settings").setAttribute("aria-expanded", String(open));
}

function setCloudPanelOpen(open) {
  state.cloudPanelOpen = open;
  renderCloudPanel();
  if (preferences.values.backend === "azure") {
    $(open ? "close-cloud-panel" : "azure-settings").focus();
  }
}

function renderBackend() {
  const cloud = preferences.values.backend === "azure";
  $("processing-badge-label").textContent = cloud ? "CLOUD" : "LOCAL";
  $("processing-local-icon").toggleAttribute("hidden", cloud);
  $("processing-cloud-icon").toggleAttribute("hidden", !cloud);
  $("processing-badge").dataset.backend = preferences.values.backend;
  $("processing-badge").title = t(cloud ? "cloudBadgeHint" : "localBadgeHint");
  renderCloudPanel();
  const reason = state.backendStatus?.reason;
  $("cloud-status").textContent = t(state.configDirty ? "azureConfigUnsaved" : state.initializing ? "initializingAzure" : reason || (state.ready ? "azureIndexReady" : "backendConnecting"));
  $("cloud-setup-help").hidden = Boolean(state.backendStatus?.configured);
  $("cloud-consent-label").hidden = !state.backendStatus?.configured;
  $("initialize-azure").hidden = !state.backendStatus?.configured;
  $("initialize-azure").textContent = t(state.initializing ? "initializingAzure" : "initializeAzure");
  $("processing-footer").textContent = t(cloud ? "cloudFooter" : "offline");
  document.querySelector('[data-i18n="enrollHint"]').textContent = t(cloud ? "cloudEnrollHint" : "enrollHint");
  document.querySelector('[data-i18n="consent"]').textContent = t(cloud ? "cloudEnrollConsent" : "consent");
  syncControls();
}

function setAzureConfiguration(config) {
  $("azure-endpoint").value = config.endpoint;
  $("azure-index").value = config.index_name;
  state.configLoaded = true;
  syncControls();
}

async function saveAzureConfiguration(event) {
  event.preventDefault();
  if (state.busy || state.recording || state.refreshing || !state.configLoaded) return;
  if (!$("azure-config-form").reportValidity()) return;
  state.busy = true;
  clearNotices();
  syncControls();
  try {
    const config = await api("/api/backends/azure/configuration", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: $("azure-endpoint").value.trim(), index_name: $("azure-index").value.trim() }),
    });
    setAzureConfiguration(config);
    state.configDirty = false;
    state.ready = false;
    state.speakers = [];
    state.backendStatus = { configured: Boolean(config.endpoint), reason: config.endpoint ? "azureConnectionUnchecked" : "azureNotConfigured" };
    state.engineStatus = "cloudNotReady";
    $("engine-status").classList.remove("ready");
    $("cloud-consent").checked = false;
    for (const id of ["speaker-count", "sample-count", "nav-count"]) $(id).textContent = "--";
    resetResult();
    renderLocale();
    success("azureConfigSaved");
  } catch (error) { showError(error); }
  finally { state.busy = false; renderBackend(); }
}

function renderTestSamples() {
  const selected = $("test-audio-select").value;
  $("test-audio-select").replaceChildren();
  for (const sample of state.testSamples) {
    const option = document.createElement("option");
    option.value = sample.id;
    option.textContent = sample.filename;
    $("test-audio-select").append(option);
  }
  $("test-audio-select").value = state.testSamples.some((sample) => sample.id === selected) ? selected : state.testSamples[0]?.id ?? "";
  $("test-file-count").textContent = t("testCount", { count: state.testSamples.length });
}

async function loadTestAudio() {
  if (state.busy || state.recording || state.refreshing || !state.ready) return;
  const sample = state.testSamples.find((sample) => sample.id === $("test-audio-select").value);
  if (!sample) { showError(new LocalizedError("noTestAudio")); return; }
  state.busy = true;
  clearNotices();
  syncControls();
  try {
    const response = await request(`/api/test-audio/${encodeURIComponent(sample.id)}`);
    if (!response.ok) throw new LocalizedError("testAudioError");
    setAudio(await response.blob(), { kind: "test", sample });
    success("testLoaded", { expectedSpeaker: sample.expected_speaker, name: speakerName(sample.expected_speaker) });
  } catch (error) { showError(error); }
  finally { state.busy = false; syncControls(); }
}

async function changeBackend(value) {
  if (state.busy || state.recording || state.refreshing) return;
  const saved = preferences.set("backend", value);
  state.cloudPanelOpen = true;
  state.backendStatus = null;
  state.ready = false;
  state.speakers = [];
  state.engineStatus = "backendConnecting";
  $("cloud-consent").checked = false;
  resetResult();
  clearNotices();
  renderLocale();
  await refresh();
  if (!saved) showError(new LocalizedError("storageError"));
}

async function initializeAzure() {
  if (state.busy || state.recording || state.refreshing) return;
  if (!$("cloud-consent").checked) { showError(new LocalizedError("cloudConsentRequired")); return; }
  state.busy = true;
  state.initializing = true;
  clearNotices();
  renderBackend();
  try {
    const result = await api("/api/backends/azure/initialize", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ consent: true }),
    });
    await refresh();
    success("azureInitialized", { count: result.references });
  } catch (error) { showError(error); }
  finally { state.busy = false; state.initializing = false; renderBackend(); }
}

function changePreference(key, value) {
  const saved = preferences.set(key, value);
  renderLocale();
  if (!saved) showError(new LocalizedError("storageError"));
}

function switchSource(source) {
  state.source = source;
  document.querySelectorAll("[data-source]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.source === source)));
  $("mic-input").hidden = source !== "mic";
  $("wav-input").hidden = source !== "wav";
  $("test-input").hidden = source !== "test";
}

function setAudio(blob, name) {
  if (name?.kind !== "microphone") clearAudioVisuals();
  $("audio-player").pause();
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
  state.blob = blob;
  state.audioName = name;
  state.audioUrl = blob ? URL.createObjectURL(blob) : null;
  if (state.audioUrl) $("audio-player").src = state.audioUrl;
  else { $("audio-player").removeAttribute("src"); $("audio-player").load(); }
  renderAudioName();
  $("audio-preview").hidden = !blob;
  if (!blob) {
    setCapture("Idle");
    $("timer").textContent = "00:00";
  }
  resetResult();
  syncControls();
}

function showPage(name) {
  if (name !== "identify") { cancelConstellationDrag(); stopConstellationSpin(); }
  $("identify-page").hidden = name !== "identify";
  $("library-page").hidden = name !== "library";
  document.querySelectorAll("[data-page]").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === name);
    if (button.dataset.page === name) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  renderPresentation();
}

async function refresh() {
  state.refreshing = true;
  syncControls();
  try {
    const backend = preferences.values.backend;
    const [status, testSamples] = await Promise.all([
      api(`/api/status?backend=${backend}`), api("/api/test-audio"),
      api("/api/backends/azure/configuration").then((config) => { if (!state.configDirty) setAzureConfiguration(config); }),
    ]);
    const speakers = status.ready ? status.library : [];
    state.backendStatus = status;
    state.testSamples = testSamples;
    state.ready = status.ready;
    state.speakers = speakers;
    $("speaker-count").textContent = status.ready ? status.speakers : "--";
    $("sample-count").textContent = status.ready ? status.samples : "--";
    $("nav-count").textContent = status.ready ? status.speakers : "--";
    state.engineStatus = status.ready ? (backend === "azure" ? "azureReady" : "ready") : "cloudNotReady";
    $("engine-status").textContent = t(state.engineStatus);
    $("engine-status").classList.toggle("ready", status.ready);
    renderLibrary();
    renderTestSamples();
  } catch (error) {
    state.ready = false;
    state.speakers = [];
    state.backendStatus = {
      configured: false,
      reason: error instanceof LocalizedError && Object.keys(error.params).length === 0 ? error.key : "unavailable",
    };
    for (const id of ["speaker-count", "sample-count", "nav-count"]) $(id).textContent = "--";
    renderLibrary();
    state.engineStatus = "unavailable";
    $("engine-status").textContent = t("unavailable");
    $("engine-status").classList.remove("ready");
    showError(new LocalizedError("connectionError", { message: error }));
  } finally {
    state.refreshing = false;
    renderBackend();
    renderConstellation();
  }
}

function renderLibrary() {
  const query = $("speaker-search").value.trim().toLowerCase();
  const speakers = state.speakers.filter((speaker) => `${speaker.name} ${speakerName(speaker)}`.toLowerCase().includes(query));
  const existing = new Map(Array.from($("speaker-list").children, (card) => [card.dataset.speakerId, card]));
  const visible = new Set(speakers.map((speaker) => speaker.id));
  existing.forEach((card, id) => { if (!visible.has(id)) card.remove(); });
  $("library-summary").textContent = t("librarySummary", { shown: speakers.length, total: state.speakers.length });
  $("library-empty").hidden = speakers.length > 0;
  for (const [index, speaker] of speakers.entries()) {
    let card = existing.get(speaker.id);
    if (!card) {
      card = document.createElement("article");
      card.className = "speaker-card";
      card.dataset.speakerId = speaker.id;
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      card.append(avatar, document.createElement("h3"), document.createElement("p"));
      const action = document.createElement("button");
      if (speaker.reference_id) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "none";
        audio.src = `/api/references/${encodeURIComponent(speaker.reference_id)}`;
        card.append(audio);
        action.className = "text-button sample-button";
        action.addEventListener("click", () => loadReference(speaker));
      } else {
        action.className = "text-button delete-button";
        action.addEventListener("click", () => deleteSpeaker(speaker));
      }
      card.append(action);
    }
    card.querySelector(".avatar").textContent = speakerName(speaker).slice(0, 2).toUpperCase();
    card.querySelector("h3").textContent = speakerName(speaker);
    card.querySelector("p").textContent = `${t(speaker.bundled ? "bundledReference" : "yourVoice")} / ${t(speaker.samples === 1 ? "samplesOne" : "samplesMany", { count: speaker.samples })}`;
    card.querySelector("button").textContent = t(speaker.reference_id ? "useReference" : "deleteSpeaker");
    card.querySelector("audio")?.setAttribute("aria-label", t("referenceFor", { name: speakerName(speaker) }));
    if ($("speaker-list").children[index] !== card) {
      $("speaker-list").insertBefore(card, $("speaker-list").children[index] ?? null);
    }
  }
  syncControls();
}

async function loadReference(speaker) {
  if (state.busy || state.recording) return;
  state.busy = true;
  clearNotices();
  syncControls();
  try {
    const response = await request(`/api/references/${encodeURIComponent(speaker.reference_id)}`);
    if (!response.ok) throw new LocalizedError("referenceError");
    setAudio(await response.blob(), { kind: "reference", speaker });
    switchSource("wav");
    showPage("identify");
    success("referenceLoaded");
  } catch (error) { showError(error); }
  finally { state.busy = false; syncControls(); }
}

async function deleteSpeaker(speaker) {
  if (!confirm(t("deleteConfirm", { name: speakerName(speaker) }))) return;
  state.busy = true;
  clearNotices();
  syncControls();
  try {
    await api(`/api/speakers/${encodeURIComponent(speaker.id)}?backend=${preferences.values.backend}`, { method: "DELETE" });
    resetResult();
    await refresh();
    success("deleted", { name: speaker.name });
  } catch (error) { showError(error); }
  finally { state.busy = false; syncControls(); }
}

function chooseFile(file) {
  if (!file || state.busy || state.recording || state.refreshing || !state.ready
    || (preferences.values.backend === "azure" && state.configDirty)) return;
  clearNotices();
  if (!file.name.toLowerCase().endsWith(".wav")) {
    showError(new LocalizedError("wavOnly"));
    return;
  }
  if (!file.size || file.size > 20 * 1024 * 1024) {
    showError(new LocalizedError("fileSize"));
    return;
  }
  setAudio(file, file.name);
}

function encodeWav(chunks, total, sampleRate) {
  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  function text(offset, value) { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); }
  text(0, "RIFF"); view.setUint32(4, 36 + total * 2, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, total * 2, true);
  let offset = 44;
  for (const chunk of chunks) {
    for (const value of chunk) {
      const sample = Math.max(-1, Math.min(1, value));
      view.setInt16(offset, Math.round(sample * (sample < 0 ? 32768 : 32767)), true);
      offset += 2;
    }
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function drawWave(analyser, now = performance.now()) {
  if (analyser && now - demo.waveformTime < (demo.reducedMotion.matches ? 250 : 33)) {
    if (state.recording) state.animation = requestAnimationFrame(time => drawWave(analyser, time));
    return;
  }
  demo.waveformTime = now;
  const canvas = $("waveform");
  const context = canvas.getContext("2d");
  const values = new Uint8Array(analyser ? analyser.fftSize : 0);
  if (analyser) analyser.getByteTimeDomainData(values);
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--cp-accent").trim();
  context.lineWidth = 2;
  context.beginPath();
  for (let x = 0; x < canvas.width; x++) {
    const value = analyser ? values[Math.floor(x / canvas.width * values.length)] / 128 - 1 : 0;
    const y = canvas.height / 2 + value * canvas.height / 2;
    if (x === 0) context.moveTo(x, y); else context.lineTo(x, y);
  }
  context.stroke();
  if (analyser) drawAudioVisuals(analyser, values, now);
  if (state.recording) state.animation = requestAnimationFrame(time => drawWave(analyser, time));
}

async function disposeRecorder(recorder) {
  cancelAnimationFrame(state.animation);
  $("mic-orb").style.removeProperty("--voice-level");
  $("input-level").value = 0;
  $("input-level").setAttribute("aria-valuetext", t("levelIdle"));
  $("input-level-label").textContent = t("levelIdle");
  if (!recorder) return;
  recorder.stream?.getTracks().forEach((track) => track.stop());
  recorder.node?.disconnect();
  recorder.source?.disconnect();
  recorder.analyser?.disconnect();
  recorder.mute?.disconnect();
  if (recorder.context && recorder.context.state !== "closed") await recorder.context.close();
}

function microphoneConstraints(deviceId) {
  const audio = { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false };
  if (deviceId) audio.deviceId = { exact: deviceId };
  return { audio };
}

function microphoneError(error, fallback = "micStartError") {
  if (error instanceof LocalizedError) return error;
  const keys = {
    NotAllowedError: "micDenied", NotFoundError: "micMissing",
    OverconstrainedError: "microphoneUnavailable", NotReadableError: "microphoneBusy",
  };
  return keys[error.name] ? new LocalizedError(keys[error.name]) : new LocalizedError(fallback, { message: error });
}

function renderMicrophones() {
  const select = $("microphone-select");
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = t("microphoneDefault");
  select.replaceChildren(defaultOption);
  state.microphones.forEach((device, index) => {
    const option = document.createElement("option");
    option.value = device.deviceId;
    option.textContent = device.label || t("microphoneUnnamed", { number: index + 1 });
    select.append(option);
  });
  if (state.selectedMicrophone && !state.microphones.some(device => device.deviceId === state.selectedMicrophone)) {
    const unavailable = document.createElement("option");
    unavailable.value = state.selectedMicrophone;
    unavailable.textContent = t("microphoneUnavailableOption");
    unavailable.disabled = true;
    select.append(unavailable);
  }
  select.value = state.selectedMicrophone;
  $("microphone-hint").textContent = t(navigator.mediaDevices?.enumerateDevices ? "microphoneChoiceHint" : "micUnsupported");
}

async function refreshMicrophones(requestPermission = false) {
  if (!navigator.mediaDevices?.enumerateDevices) { renderMicrophones(); return; }
  if (requestPermission && (state.busy || state.recording || state.refreshing)) return;
  if (requestPermission) { state.busy = true; clearNotices(); syncControls(); }
  const generation = ++state.microphoneRequest;
  let stream;
  try {
    if (requestPermission) stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (generation !== state.microphoneRequest) return;
    const previous = state.microphones;
    state.microphones = devices.filter(device => device.kind === "audioinput" && device.deviceId && device.deviceId !== "default");
    if (state.selectedMicrophone && previous.some(device => device.deviceId === state.selectedMicrophone)
      && !state.microphones.some(device => device.deviceId === state.selectedMicrophone)) {
      showError(new LocalizedError("microphoneUnavailable"));
    }
    renderMicrophones();
  } catch (error) { showError(microphoneError(error, "microphoneListError")); }
  finally {
    stream?.getTracks().forEach(track => track.stop());
    if (requestPermission) state.busy = false;
    syncControls();
  }
}

async function startRecording() {
  if (state.busy || state.recording) return;
  clearNotices();
  state.busy = true;
  syncControls();
  const recorder = { chunks: [], total: 0 };
  try {
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
      throw new LocalizedError("micUnsupported");
    }
    recorder.stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(state.selectedMicrophone));
    await refreshMicrophones();
    recorder.context = new AudioContext();
    await recorder.context.audioWorklet.addModule("/static/recorder-worklet.js");
    await recorder.context.resume();
    recorder.source = recorder.context.createMediaStreamSource(recorder.stream);
    recorder.node = new AudioWorkletNode(recorder.context, "voice-recorder");
    recorder.analyser = recorder.context.createAnalyser();
    recorder.analyser.fftSize = 2048;
    recorder.mute = recorder.context.createGain();
    recorder.mute.gain.value = 0;
    recorder.source.connect(recorder.analyser);
    recorder.source.connect(recorder.node);
    recorder.node.connect(recorder.mute).connect(recorder.context.destination);
    recorder.node.port.onmessage = ({ data }) => {
      if (data?.type === "stopped") { recorder.onStopped?.(); return; }
      if (!state.recording && !recorder.stopping) return;
      const remaining = recorder.context.sampleRate * 30 - recorder.total;
      const chunk = data.length > remaining ? data.slice(0, remaining) : data;
      if (chunk.length) recorder.chunks.push(chunk);
      recorder.total += chunk.length;
      $("timer").textContent = `00:${String(Math.floor(recorder.total / recorder.context.sampleRate)).padStart(2, "0")}`;
      if (state.recording && recorder.total >= recorder.context.sampleRate * 30) void stopRecording();
    };
    recorder.node.onprocessorerror = () => {
      const error = new LocalizedError("micProcessing");
      if (recorder.stopping) recorder.onStopError(error);
      else void stopRecording(error);
    };
    const track = recorder.stream.getAudioTracks()[0];
    if (!track || track.readyState === "ended") throw new LocalizedError("micDisconnected");
    track.addEventListener("ended", () => {
      if (state.recording) void stopRecording(new LocalizedError("micDisconnected"));
    });
    setAudio(null);
    state.recorder = recorder;
    state.recording = true;
    $("timer").textContent = "00:00";
    setCapture("Recording");
    drawWave(recorder.analyser);
  } catch (error) {
    await disposeRecorder(recorder);
    showError(microphoneError(error));
  } finally { state.busy = false; syncControls(); }
}

function finishRecorder(recorder) {
  return new Promise((resolve, reject) => {
    recorder.stopping = true;
    const finish = error => {
      clearTimeout(timeout);
      recorder.stopping = false;
      recorder.onStopped = null;
      recorder.onStopError = null;
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => finish(new LocalizedError("micStopError")), 2000);
    recorder.onStopped = () => finish();
    recorder.onStopError = finish;
    try { recorder.node.port.postMessage({ type: "stop" }); }
    catch (error) { finish(error); }
  });
}

async function stopRecording(failure = null) {
  if (!state.recording) return;
  state.recording = false;
  state.busy = true;
  const recorder = state.recorder;
  state.recorder = null;
  syncControls();
  try {
    try {
      if (!failure) await finishRecorder(recorder);
    } finally { await disposeRecorder(recorder); }
    if (failure) throw failure;
    if (recorder.total / recorder.context.sampleRate < 2) throw new LocalizedError("tooShort");
    setAudio(encodeWav(recorder.chunks, recorder.total, recorder.context.sampleRate), { kind: "microphone" });
    setCapture("Ready");
  } catch (error) {
    setCapture("Retry");
    showError(error);
  } finally { state.busy = false; drawWave(); syncControls(); }
}

function similarityGeometry(score) {
  if (!Number.isFinite(score) || score < -1 || score > 1) throw new RangeError("Invalid cosine similarity");
  return { start: 0, width: Math.max(0, score) * 100 };
}

function createSimilarityAxis() {
  const axis = document.createElement("div");
  axis.className = "similarity-axis";
  axis.setAttribute("aria-hidden", "true");
  for (const value of [0.25, 0.5, 0.75]) {
    const tick = document.createElement("span");
    tick.style.left = `${value * 100}%`;
    tick.textContent = number(value, value === 0.5 ? 1 : 2);
    axis.append(tick);
  }
  return axis;
}

function similarityDescription(score, threshold) {
  const value = score < 0 ? t("negativeSimilarityBar", { score: number(score, 3) }) : number(score, 3);
  return score < threshold ? t("belowSimilarityThreshold", { value, threshold: number(threshold, 2) }) : value;
}

function validTopN() {
  return $("top-n").checkValidity() && Number.isSafeInteger($("top-n").valueAsNumber);
}

function updateTopN(fetchMissing = false) {
  if (!state.result || state.busy || state.recording || state.refreshing) return;
  if (!validTopN()) {
    if (fetchMissing) showError(new LocalizedError("topNError"));
    return;
  }
  renderResult(state.result);
  if (fetchMissing && !$("update-top-n").disabled && $("top-n").valueAsNumber > state.result.top_n
    && state.result.candidates.length >= state.result.top_n) {
    void identify();
  }
}

function renderResult(result) {
  cancelResultReveal();
  state.result = result;
  state.analyzing = false;
  $("result-empty").hidden = true;
  $("result-busy").hidden = true;
  $("result-content").hidden = false;
  $("result-content").dataset.outcome = result.speaker ? "matched" : "rejected";
  const matched = Boolean(result.speaker);
  $("result-badge").textContent = t(matched ? "matched" : "unmatched");
  $("result-overline").textContent = t(matched ? "closest" : "outsideCriteria");
  $("match-name").textContent = matched ? speakerName(result.speaker) : t("unknown");
  $("result-avatar").textContent = matched ? speakerName(result.speaker).slice(0, 2).toUpperCase() : "?";
  const reasons = {
    matched: "matchedReason", ambiguous: "ambiguousReason",
    below_threshold: "belowReason", empty_library: "emptyReason",
  };
  $("match-description").textContent = t(reasons[result.reason], { threshold: number(result.threshold, 2), gap: number(result.min_gap, 2) });
  const best = result.candidates[0]?.score;
  $("best-score").textContent = best === undefined ? "--" : number(best, 3);
  $("best-score").classList.toggle("below-threshold", best !== undefined && best < result.threshold);
  $("score-bar").classList.toggle("below-threshold", best !== undefined && best < result.threshold);
  $("score-bar").value = Math.max(0, best ?? 0);
  $("score-bar").setAttribute("aria-valuetext", best === undefined ? t("notApplicable")
    : similarityDescription(best, result.threshold));
  $("best-score-axis").replaceChildren(createSimilarityAxis());
  $("best-threshold-marker").replaceChildren();
  addThresholdMarker($("best-threshold-marker"), result.threshold);
  $("similarity-threshold-hint").textContent = t("similarityThresholdHint", { threshold: number(result.threshold, 2) });
  const topN = validTopN() ? $("top-n").valueAsNumber : result.top_n;
  const visibleCandidates = result.candidates.slice(0, topN);
  $("top-n-summary").textContent = t("topNSummary", { count: visibleCandidates.length, requested: topN });
  $("candidates").replaceChildren();
  visibleCandidates.forEach((candidate, index) => {
    const row = document.createElement("tr");
    [String(index + 1).padStart(2, "0"), speakerName(candidate), number(candidate.score, 3)].forEach((value, column) => {
      const cell = document.createElement("td");
      cell.textContent = value;
      if (column !== 1) cell.className = "mono";
      if (column === 2) {
        cell.classList.add("rank-score-cell");
        cell.classList.toggle("below-threshold", candidate.score < result.threshold);
        const track = document.createElement("div");
        track.className = "similarity-track";
        track.setAttribute("role", "meter");
        track.setAttribute("aria-label", t("rankSimilarity", { name: speakerName(candidate) }));
        track.setAttribute("aria-valuemin", "0");
        track.setAttribute("aria-valuemax", "1");
        track.setAttribute("aria-valuenow", String(Math.max(0, candidate.score)));
        track.setAttribute("aria-valuetext", similarityDescription(candidate.score, result.threshold));
        const fill = document.createElement("span");
        const geometry = similarityGeometry(candidate.score);
        fill.style.left = `${geometry.start}%`;
        fill.style.width = `${geometry.width}%`;
        track.append(fill);
        addThresholdMarker(track, result.threshold);
        cell.append(track, createSimilarityAxis());
      }
      row.append(cell);
    });
    $("candidates").append(row);
  });
  $("result-gap").textContent = result.gap === null ? t("notApplicable") : number(result.gap, 3);
  $("result-duration").textContent = `${number(result.audio.duration_seconds, 1)} s`;
  $("result-time").textContent = t("analysisDuration", { seconds: number(result.elapsed_seconds, 3), milliseconds: number(result.elapsed_ms, 1) });
  $("result-warnings").textContent = result.audio.warnings.map(translatedServerMessage).join(" ");
  const test = state.audioName?.kind === "test" ? state.audioName.sample : null;
  $("test-evaluation").hidden = !test;
  if (test) {
    const key = !matched ? "expectedUnknown" : result.speaker.id === test.expected_speaker.id ? "expectedMatch" : "expectedMismatch";
    $("test-evaluation").textContent = t(key, { name: speakerName(test.expected_speaker) });
  }
  renderConstellation();
  renderDemo();
}

async function identify() {
  if (!state.blob || state.busy || state.recording) return;
  if (!validTopN()) {
    showError(new LocalizedError("topNError"));
    return;
  }
  if (!$("threshold").checkValidity() || !$("min-gap").checkValidity()) {
    showError(new LocalizedError("criteriaError"));
    $("criteria-menu").open = true;
    (!$("threshold").checkValidity() ? $("threshold") : $("min-gap")).focus();
    return;
  }
  clearNotices();
  state.busy = true;
  state.result = null;
  state.analyzing = true;
  cancelResultReveal();
  renderConstellation();
  syncControls();
  $("result-empty").hidden = true;
  $("result-content").hidden = true;
  $("result-busy").hidden = false;
  $("result-badge").textContent = t("analyzing");
  try {
    const topN = $("top-n").valueAsNumber;
    const params = new URLSearchParams({
      threshold: $("threshold").value, min_gap: $("min-gap").value,
      backend: preferences.values.backend, top_n: String(topN),
    });
    const result = await api(`/api/identify?${params}`, {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body: state.blob,
    });
    if (result.top_n !== topN || result.candidates.length > topN) throw new LocalizedError("topNServerMismatch");
    result.completed_at = new Date().toISOString();
    renderResult(result);
    revealResult();
  } catch (error) { resetResult(); showError(error); }
  finally { state.busy = false; syncControls(); }
}

function openEnroll() {
  if (!state.blob || state.busy || state.recording) return;
  $("enroll-form").reset();
  state.enrollError = null;
  $("enroll-error").hidden = true;
  $("enroll-dialog").showModal();
  renderDemo();
  $("speaker-name").focus();
}

async function saveSpeaker(event) {
  event.preventDefault();
  if (state.busy || !state.blob) return;
  const name = $("speaker-name").value.trim();
  if (!name || name.length > 60 || /[\x00-\x1f]/.test(name) || !$("consent").checked) {
    state.enrollError = new LocalizedError(!name || name.length > 60 || /[\x00-\x1f]/.test(name) ? "nameRequired" : "consentRequired");
    $("enroll-error").textContent = errorText(state.enrollError);
    $("enroll-error").hidden = false;
    return;
  }
  state.busy = true;
  state.saving = true;
  syncControls();
  $("save-speaker").disabled = true;
  $("save-speaker").textContent = t("saving");
  $("cancel-enroll").disabled = true;
  $("close-dialog").disabled = true;
  $("enroll-error").hidden = true;
  state.enrollError = null;
  try {
    const result = await api(`/api/speakers?${new URLSearchParams({ name, backend: preferences.values.backend })}`, {
      method: "POST", headers: { "Content-Type": "audio/wav" }, body: state.blob,
    });
    $("enroll-dialog").close();
    resetResult();
    await refresh();
    success("enrolled", { name: result.name, warnings: result.audio.warnings });
  } catch (error) {
    console.error(error);
    state.enrollError = error;
    $("enroll-error").textContent = errorText(error);
    $("enroll-error").hidden = false;
  } finally {
    state.busy = false;
    state.saving = false;
    $("save-speaker").disabled = false;
    $("save-speaker").textContent = t("save");
    $("cancel-enroll").disabled = false;
    $("close-dialog").disabled = false;
    syncControls();
  }
}

$("palette-select").addEventListener("change", (event) => {
  const saved = preferences.setTheme(event.target.value);
  renderLocale();
  if (!saved) showError(new LocalizedError("storageError"));
});
$("language-select").addEventListener("change", (event) => changePreference("language", event.target.value));
$("font-select").addEventListener("change", (event) => changePreference("font", event.target.value));
$("backend-select").addEventListener("change", (event) => { void changeBackend(event.target.value); });
$("azure-settings").addEventListener("click", () => setCloudPanelOpen(true));
$("close-cloud-panel").addEventListener("click", () => setCloudPanelOpen(false));
$("cloud-consent").addEventListener("change", syncControls);
$("initialize-azure").addEventListener("click", initializeAzure);
$("azure-config-form").addEventListener("submit", saveAzureConfiguration);
$("check-azure").addEventListener("click", () => { clearNotices(); void refresh(); });
for (const id of ["azure-endpoint", "azure-index"]) {
  $(id).addEventListener("input", () => {
    state.configDirty = true;
    $("cloud-consent").checked = false;
    renderBackend();
  });
}
$("load-test-audio").addEventListener("click", loadTestAudio);
document.querySelectorAll("[data-page]").forEach((button) => button.addEventListener("click", () => showPage(button.dataset.page)));
document.querySelectorAll("[data-source]").forEach((button) => button.addEventListener("click", () => switchSource(button.dataset.source)));
$("view-library").addEventListener("click", () => showPage("library"));
$("new-speaker").addEventListener("click", () => {
  showPage("identify");
  if (state.blob) openEnroll();
  else { success("enrollInstructions"); $("record-button").focus(); }
});
$("speaker-search").addEventListener("input", renderLibrary);
$("file-input").addEventListener("change", (event) => { chooseFile(event.target.files[0]); event.target.value = ""; });
$("browse-button").addEventListener("click", () => $("file-input").click());
$("dropzone").addEventListener("dragover", (event) => { event.preventDefault(); $("dropzone").classList.add("drag"); });
$("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("drag"));
$("dropzone").addEventListener("drop", (event) => {
  event.preventDefault(); $("dropzone").classList.remove("drag");
  if (event.dataTransfer.files.length !== 1) { showError(new LocalizedError("oneFile")); return; }
  chooseFile(event.dataTransfer.files[0]);
});
$("clear-audio").addEventListener("click", () => { setAudio(null); $("timer").textContent = "00:00"; });
$("record-button").addEventListener("click", () => state.recording ? stopRecording() : startRecording());
$("microphone-select").addEventListener("change", (event) => {
  if (state.busy || state.recording || state.refreshing) return;
  state.selectedMicrophone = event.target.value;
  clearNotices();
  syncControls();
});
$("refresh-microphones").addEventListener("click", () => { void refreshMicrophones(true); });
navigator.mediaDevices?.addEventListener("devicechange", () => { void refreshMicrophones(); });
$("identify-button").addEventListener("click", identify);
$("top-n").addEventListener("input", () => updateTopN());
$("top-n").addEventListener("change", () => updateTopN(true));
$("top-n-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!$("update-top-n").disabled) void identify();
});
$("enroll-button").addEventListener("click", openEnroll);
$("enroll-form").addEventListener("submit", saveSpeaker);
$("cancel-enroll").addEventListener("click", () => $("enroll-dialog").close());
$("close-dialog").addEventListener("click", () => $("enroll-dialog").close());
$("enroll-dialog").addEventListener("cancel", (event) => { if (state.busy) event.preventDefault(); });
$("demo-button").addEventListener("click", () => {
  const speaker = state.speakers.find((item) => item.reference_id);
  if (speaker) void loadReference(speaker);
  else showError(new LocalizedError("noReference"));
});
$("refresh-button").addEventListener("click", () => { clearNotices(); void refresh(); });
window.addEventListener("pagehide", () => {
  state.recording = false;
  if (state.recorder) void disposeRecorder(state.recorder);
  if (state.audioUrl) URL.revokeObjectURL(state.audioUrl);
});
renderLocale();
initializeWelcome();
initializeDemo();
void initializeAppearance();
initializePresentation();
void refreshMicrophones();
if (preferences.storageUnavailable) showError(new LocalizedError("storageError"));
void refresh();
