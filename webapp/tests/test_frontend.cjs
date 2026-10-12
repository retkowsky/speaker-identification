const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = (name) => fs.readFileSync(path.join(root, "static", name), "utf8");

function browser({ saved = {}, language = "en-US", query = "", dark = false, blocked = false } = {}) {
  const stored = new Map(Object.entries(saved).map(([key, value]) => [`voiceprint.${key}`, value]));
  const document = { documentElement: { dataset: {}, style: { setProperty(key, value) { this[key] = value; } }, setAttribute(key, value) { this[key] = value; } } };
  const location = new URL(`http://localhost:8765/${query}`);
  const warnings = [];
  const context = vm.createContext({
    document, location, URL, URLSearchParams, DOMException, navigator: { language },
    console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) },
    renderPresentation: () => {},
    matchMedia: () => ({ matches: dark }),
    localStorage: {
      getItem(key) { if (blocked) throw new DOMException("Blocked", "SecurityError"); return stored.get(key) ?? null; },
      setItem(key, value) { if (blocked) throw new DOMException("Blocked", "SecurityError"); stored.set(key, value); },
    },
    history: { replaceState(_state, _title, url) { location.href = url.href; } },
  });
  context.window = context;
  vm.runInContext(read("theme.js"), context);
  vm.runInContext(read("i18n.js"), context);
  return { context, stored, document, location, warnings, run: (code) => vm.runInContext(code, context) };
}

test("default language follows browser; unsupported languages use English", () => {
  assert.equal(browser({ language: "fr-FR" }).run("preferences.values.language"), "fr");
  assert.equal(browser({ language: "de-DE" }).run("preferences.values.language"), "en");
  assert.equal(browser({ dark: true }).run("preferences.values.mode"), "dark");
});

test("every runtime JavaScript file parses", () => {
  for (const name of fs.readdirSync(path.join(root, "static")).filter(name => name.endsWith(".js"))) {
    assert.doesNotThrow(() => new vm.Script(read(name), { filename: name }));
  }
});

test("WAV drops obey the same recording, refresh and unsaved-Azure locks as the upload controls", () => {
  const app = browser();
  const selected = [];
  app.context.state = { ready: true, busy: false, recording: false, refreshing: false, configDirty: false };
  app.context.clearNotices = () => {};
  app.context.setAudio = file => selected.push(file);
  app.context.showError = error => assert.fail(error.message);
  app.context.file = { name: "test.wav", size: 100 };
  app.run(read("app.js").match(/function chooseFile\(file\) \{[\s\S]*?\n\}/)[0]);
  for (const key of ["busy", "recording", "refreshing"]) {
    app.context.state[key] = true;
    app.run("chooseFile(file)");
    app.context.state[key] = false;
  }
  app.run("preferences.set('backend','azure')");
  app.context.state.configDirty = true;
  app.run("chooseFile(file)");
  assert.equal(selected.length, 0);
  app.context.state.configDirty = false;
  app.run("chooseFile(file)");
  assert.equal(selected.length, 1);
});

test("recorder worklet flushes the exact final partial buffer once before acknowledging stop", () => {
  const messages = [];
  const context = vm.createContext({
    AudioWorkletProcessor: class {
      constructor() { this.port = { postMessage: value => messages.push(structuredClone(value)) }; }
    },
    registerProcessor() {},
  });
  vm.runInContext(read("recorder-worklet.js") + "\nvar recorder = new VoiceRecorder();", context);
  vm.runInContext("for (let i=0; i<17; i++) recorder.process([[new Float32Array(128).fill(0.2), new Float32Array(128).fill(0.6)]]);", context);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].length, 2048);
  vm.runInContext("recorder.port.onmessage({data:{type:'stop'}})", context);
  assert.equal(messages.length, 3);
  assert.equal(messages[1].length, 128);
  assert.equal(messages[2].type, "stopped");
  assert.ok([...messages[0], ...messages[1]].every(value => Math.abs(value - 0.4) < 1e-6));
  assert.equal(vm.runInContext("recorder.process([[new Float32Array(128)]])", context), false);
  vm.runInContext("recorder.port.onmessage({data:{type:'stop'}})", context);
  assert.equal(messages.length, 3);
});

test("stop recording waits for buffered audio before encoding and always releases resources on timeout", async () => {
  for (const timeout of [false, true]) {
    const app = browser();
    let timer, disposed = false, encoded = false, capture;
    const errors = [];
    const recorder = { total: 31900, chunks: [], context: { sampleRate: 16000 }, node: { port: {
      postMessage(message) {
        assert.equal(message.type, "stop");
        if (!timeout) { recorder.total += 100; recorder.onStopped(); }
      },
    } } };
    app.context.state = { recording: true, busy: false, recorder };
    app.context.setTimeout = callback => { timer = callback; return 1; };
    app.context.clearTimeout = () => {};
    app.context.syncControls = () => {};
    app.context.drawWave = () => {};
    app.context.disposeRecorder = async () => { disposed = true; };
    app.context.encodeWav = (_chunks, total) => {
      assert.equal(disposed, true);
      assert.equal(total, 32000);
      encoded = true;
      return {};
    };
    app.context.setAudio = () => {};
    app.context.setCapture = value => { capture = value; };
    app.context.showError = error => errors.push(error);
    for (const name of ["finishRecorder", "stopRecording"]) {
      app.run(read("app.js").match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]);
    }
    const stopping = app.run("stopRecording()");
    if (timeout) timer();
    await stopping;
    assert.equal(disposed, true);
    assert.equal(encoded, !timeout);
    assert.equal(capture, timeout ? "Retry" : "Ready");
    assert.equal(app.context.state.busy, false);
    assert.equal(recorder.stopping, false);
    if (timeout) assert.equal(errors[0].key, "micStopError");
    else assert.equal(errors.length, 0);
  }
});

test("fresh and invalid appearance preferences use Ocean and Tahoma", () => {
  for (const saved of [{}, { palette: "invalid", font: "invalid" }]) {
    const app = browser({ saved });
    assert.equal(app.document.documentElement.dataset.palette, "ocean");
    assert.equal(app.document.documentElement.dataset.font, "tahoma");
  }
});

test("welcome opens once at startup and returns keyboard focus without changing application state", () => {
  const app = browser();
  let opened = 0, closed = 0, focused = false;
  const listeners = new Map();
  app.context.$ = id => {
    assert.equal(id, "welcome-dialog");
    return { showModal() { opened++; }, close() { closed++; },
      addEventListener(name, callback) { listeners.set(name, callback); } };
  };
  app.context.document.querySelector = selector => {
    assert.equal(selector, '[data-page="identify"]');
    return { focus() { focused = true; } };
  };
  app.context.state = { ready: false, result: null };
  app.run(read("app.js").match(/function initializeWelcome\(\) \{[\s\S]*?\n\}/)[0]);
  app.run("initializeWelcome()");
  assert.equal(opened, 1);
  assert.equal(focused, false);
  listeners.get("keydown")({ key: "Tab", preventDefault() { throw new Error("Must retain native tab navigation"); } });
  assert.equal(closed, 0);
  let prevented = false;
  listeners.get("keydown")({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(closed, 1);
  assert.equal(prevented, true);
  listeners.get("close")();
  assert.equal(focused, true);
  assert.deepEqual(app.context.state, { ready: false, result: null });
  assert.equal((read("app.js").match(/initializeWelcome\(\);/g) || []).length, 1);
  assert.match(read("app.js"), /renderLocale\(\);\s*initializeWelcome\(\);/);
});

test("welcome has the exact author, version and date with native accessible dismissal", () => {
  const welcome = read("index.html").match(/<dialog id="welcome-dialog"[\s\S]*?<\/dialog>/)[0];
  assert.match(welcome, /aria-labelledby="welcome-title"/);
  assert.match(welcome, /aria-describedby="welcome-description"/);
  assert.match(welcome, /Author :/);
  assert.match(welcome, /href="mailto:serge\.retkowsky@microsoft\.com">serge\.retkowsky@microsoft\.com<\/a>/);
  assert.match(welcome, />Version 1\.0</);
  assert.match(welcome, /<time datetime="2026-10-05">05-10-2026<\/time>/);
  assert.match(welcome, /<form method="dialog">/);
  assert.match(welcome, /id="welcome-start"[^>]*autofocus/);
  assert.equal(browser().run("t('welcomeStart')"), "Get started");
  assert.equal(browser({ language: "fr" }).run("t('welcomeStart')"), "Commencer");
});

test("Azure settings can close and reopen without changing backend, edits, consent or request state", async () => {
  const app = browser({ saved: { backend: "azure" } });
  const elements = new Map();
  let focused = null;
  app.context.$ = id => {
    if (!elements.has(id)) elements.set(id, {
      dataset: {}, attributes: {}, value: "", checked: false,
      setAttribute(key, value) { this.attributes[key] = value; },
      toggleAttribute() {}, focus() { focused = id; },
    });
    return elements.get(id);
  };
  app.context.document.querySelector = () => ({});
  app.context.syncControls = () => {};
  app.context.state = { cloudPanelOpen: true, configDirty: true, ready: true, busy: true, initializing: true };
  for (const name of ["renderCloudPanel", "setCloudPanelOpen", "renderBackend", "changeBackend"]) {
    app.run(read("app.js").match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]);
  }
  const panel = app.context.$("cloud-panel"), opener = app.context.$("azure-settings");
  const endpoint = app.context.$("azure-endpoint"), consent = app.context.$("cloud-consent");
  endpoint.value = "https://unsaved.example";
  consent.checked = true;
  app.run("renderBackend()");
  assert.equal(app.run("t('azureSettings')"), "Azure AI Search");
  assert.equal(panel.hidden, false);
  assert.equal(opener.attributes["aria-expanded"], "true");
  app.run("setCloudPanelOpen(false)");
  assert.equal(panel.hidden, true);
  assert.equal(opener.hidden, false);
  assert.equal(opener.attributes["aria-expanded"], "false");
  assert.equal(focused, "azure-settings");
  app.run("preferences.set('language', 'fr'); renderBackend()");
  assert.equal(app.run("t('azureSettings')"), "Azure AI Search");
  assert.equal(panel.hidden, true);
  assert.equal(app.run("preferences.values.backend"), "azure");
  assert.equal(endpoint.value, "https://unsaved.example");
  assert.equal(consent.checked, true);
  assert.equal(app.context.state.configDirty, true);
  assert.equal(app.context.state.busy, true);
  assert.equal(app.context.state.initializing, true);
  app.run("setCloudPanelOpen(true)");
  assert.equal(panel.hidden, false);
  assert.equal(opener.attributes["aria-expanded"], "true");
  assert.equal(focused, "close-cloud-panel");
  app.run("setCloudPanelOpen(false); preferences.set('backend', 'qdrant'); renderBackend()");
  assert.equal(panel.hidden, true);
  assert.equal(opener.hidden, true);
  app.context.state.busy = false;
  for (const name of ["resetResult", "clearNotices"]) app.context[name] = () => {};
  app.context.renderLocale = () => app.run("renderBackend()");
  app.context.refresh = async () => {};
  await app.run("changeBackend('azure')");
  assert.equal(panel.hidden, false);
  assert.equal(opener.hidden, false);
});

test("palette selection is restored after options are sorted and reinserted", () => {
  const app = browser();
  const elements = new Map();
  app.context.$ = (id) => {
    if (!elements.has(id)) elements.set(id, {
      value: "", options: [], setAttribute() {},
      replaceChildren(...options) { this.options = options; this.value = options.at(-1).value; },
    });
    return elements.get(id);
  };
  const select = app.context.$("palette-select");
  select.options = Array.from(read("index.html").matchAll(/<option value="((?:rose|ocean|forest|amber)-(?:light|dark))" data-i18n="([^"]+)"/g),
    match => ({ value: match[1], key: match[2], text: match[1] }));
  app.context.state = { engineStatus: "ready", capture: "Idle" };
  for (const name of ["translatePage", "setCapture", "renderAudioName", "renderLibrary",
    "renderTestSamples", "renderBackend", "renderAppearance", "renderMicrophones", "drawWave", "renderDemo", "renderConstellation"]) {
    app.context[name] = () => {};
  }
  app.run(read("app.js").match(/function renderLocale\(\) \{[\s\S]*?\n\}/)[0]);
  for (const language of ["en", "fr"]) {
    app.run(`preferences.set('language', '${language}')`);
    select.options.forEach(option => { option.text = app.run(`t('${option.key}')`); });
    for (const theme of select.options.map(option => option.value)) {
      const [palette, mode] = theme.split("-");
      app.run(`preferences.setTheme('${theme}'); renderLocale()`);
      assert.equal(select.value, theme);
      assert.equal(app.document.documentElement.dataset.palette, palette);
      assert.equal(app.document.documentElement.dataset.theme, mode);
      const names = select.options.map(option => option.text);
      assert.deepEqual(names, [...names].sort(new Intl.Collator(language).compare));
    }
  }
});

test("background saves are quiet but storage failures are still reported", async () => {
  const app = browser();
  app.run(read("appearance.js"));
  const messages = [], errors = [];
  app.context.success = key => messages.push(key);
  app.context.showError = error => errors.push(error);
  for (const name of ["renderAppearance", "clearNotices", "applyBackground"]) app.context[name] = () => {};
  app.context.validateBackground = async () => {};
  app.context.backgroundStorage = async () => {};
  app.run("appearance.busy = false");
  await app.run("changeBackground({type: 'image/png', size: 100})");
  assert.deepEqual(messages, []);
  assert.deepEqual(errors, []);
  app.context.backgroundStorage = async () => { throw new DOMException("Full", "QuotaExceededError"); };
  await app.run("changeBackground({type: 'image/png', size: 100})");
  assert.equal(errors[0].key, "backgroundStorageError");
  assert.deepEqual(messages, []);
});

function microphoneBrowser() {
  const app = browser();
  const elements = new Map(), errors = [];
  app.context.$ = id => {
    if (!elements.has(id)) elements.set(id, {
      options: [], replaceChildren(...options) { this.options = options; },
      append(option) { this.options.push(option); },
    });
    return elements.get(id);
  };
  app.context.document.createElement = () => ({});
  app.context.state = {
    microphones: [], selectedMicrophone: "", microphoneRequest: 0,
    busy: false, recording: false, refreshing: false,
  };
  app.context.syncControls = () => {};
  app.context.clearNotices = () => {};
  app.context.showError = error => errors.push(error);
  for (const name of ["microphoneConstraints", "microphoneError", "renderMicrophones", "refreshMicrophones"]) {
    app.run(read("app.js").match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]);
  }
  return { ...app, errors, elements };
}

test("microphone constraints request the exact selected device, with no fallback", () => {
  const app = microphoneBrowser();
  const defaults = app.run("microphoneConstraints('')");
  assert.equal(defaults.audio.deviceId, undefined);
  assert.equal(defaults.audio.channelCount, 1);
  const chosen = app.run("microphoneConstraints('usb-device')");
  assert.equal(chosen.audio.deviceId.exact, "usb-device");
  assert.equal(chosen.audio.echoCancellation, false);
  assert.equal(chosen.audio.noiseSuppression, false);
  assert.equal(chosen.audio.autoGainControl, false);
});

test("microphone discovery is passive until permission is requested and releases the probe", async () => {
  const app = microphoneBrowser();
  let requests = 0, stopped = 0;
  app.context.navigator.mediaDevices = {
    getUserMedia: async () => { requests++; return { getTracks: () => [{ stop() { stopped++; } }] }; },
    enumerateDevices: async () => [
      { kind: "audioinput", deviceId: "default", label: "Default" },
      { kind: "audioinput", deviceId: "usb", label: "USB microphone" },
      { kind: "audioinput", deviceId: "built-in", label: "" },
      { kind: "videoinput", deviceId: "camera", label: "Camera" },
    ],
  };
  await app.run("refreshMicrophones()");
  assert.equal(requests, 0);
  assert.equal(app.context.state.microphones.length, 2);
  await app.run("refreshMicrophones(true)");
  assert.equal(requests, 1);
  assert.equal(stopped, 1);
  assert.equal(app.context.state.busy, false);
  assert.equal(app.elements.get("microphone-select").options[1].textContent, "USB microphone");
  app.run("preferences.set('language', 'fr'); renderMicrophones()");
  assert.equal(app.elements.get("microphone-select").options[0].textContent, "Microphone par défaut du système");
  app.context.navigator.mediaDevices.enumerateDevices = async () => { throw new Error("Device listing failed"); };
  await app.run("refreshMicrophones(true)");
  assert.equal(stopped, 2);
  assert.equal(app.errors.at(-1).key, "microphoneListError");
  assert.equal(app.context.state.busy, false);
});

test("a disconnected chosen microphone is retained as unavailable, never silently replaced", async () => {
  const app = microphoneBrowser();
  app.context.state.selectedMicrophone = "usb";
  app.context.state.microphones = [{ kind: "audioinput", deviceId: "usb", label: "USB microphone" }];
  app.context.navigator.mediaDevices = { enumerateDevices: async () => [] };
  await app.run("refreshMicrophones()");
  assert.equal(app.context.state.selectedMicrophone, "usb");
  const select = app.elements.get("microphone-select");
  assert.equal(select.value, "usb");
  assert.equal(select.options.at(-1).disabled, true);
  assert.equal(app.errors[0].key, "microphoneUnavailable");
  for (const [name, key] of [["NotAllowedError", "micDenied"], ["NotFoundError", "micMissing"],
    ["OverconstrainedError", "microphoneUnavailable"], ["NotReadableError", "microphoneBusy"]]) {
    assert.equal(app.run(`microphoneError({name:'${name}'}).key`), key);
  }
});

test("all saved preferences restore before the app renders", () => {
  const app = browser({ saved: { language: "fr", palette: "forest", mode: "dark", font: "georgia", backend: "azure" } });
  assert.equal(app.document.documentElement.lang, "fr");
  assert.equal(app.document.documentElement.dataset.palette, "forest");
  assert.equal(app.document.documentElement.dataset.theme, "dark");
  assert.equal(app.document.documentElement.dataset.font, "georgia");
  assert.equal(app.run("preferences.values.backend"), "azure");
});

test("light query is honored and mode changes update both storage and query", () => {
  const app = browser({ saved: { mode: "dark" }, query: "?scoutTheme=light" });
  assert.equal(app.run("preferences.values.mode"), "light");
  assert.equal(app.run("preferences.values.font"), "tahoma");
  assert.equal(app.run("preferences.values.palette"), "ocean");
  assert.equal(app.run("preferences.values.backend"), "qdrant");
  app.run("preferences.set('mode', 'dark')");
  assert.equal(app.stored.get("voiceprint.mode"), "dark");
  assert.equal(app.location.searchParams.get("scoutTheme"), "dark");
});

test("font and backend choices are allowlisted and persisted", () => {
  const app = browser();
  for (const font of ["arial", "calibri", "consolas", "georgia", "segoe", "tahoma", "times", "verdana"]) {
    app.run(`preferences.set('font', '${font}')`);
    assert.equal(app.document.documentElement.dataset.font, font);
    assert.equal(app.stored.get("voiceprint.font"), font);
  }
  app.run("preferences.set('backend', 'azure')");
  assert.equal(app.stored.get("voiceprint.backend"), "azure");
  assert.throws(() => app.run("preferences.set('font', 'unknown')"), /Invalid preference/);
  assert.throws(() => app.run("preferences.set('backend', 'unknown')"), /Invalid preference/);
});

test("branding and exactly eight combined themes are exposed without a mode toggle", () => {
  const app = browser();
  assert.match(app.run("t('title')"), /^Speaker Identification/);
  assert.equal(app.run("t('pageSubtitle')"), "Speaker identification with Azure or Qdrant using voice embeddings");
  assert.ok(!read("index.html").includes("Voiceprint"));
  const palette = read("index.html").match(/<select id="palette-select">(.+?)<\/select>/)[1];
  const keys = Array.from(palette.matchAll(/data-i18n="([^"]+)"/g), (match) => match[1]);
  assert.equal(keys.length, 8);
  assert.equal(new Set(keys).size, 8);
  assert.ok(!read("index.html").includes('id="theme-toggle"'));
  const choices = Array.from(palette.matchAll(/value="([^"]+)"/g), match => match[1]);
  assert.deepEqual(choices, ["amber-dark", "amber-light", "forest-dark", "forest-light",
    "ocean-dark", "ocean-light", "rose-dark", "rose-light"]);
  for (const locale of ["en", "fr"]) {
    app.run(`preferences.set('language', '${locale}')`);
    const names = keys.map(key => app.run(`t('${key}')`));
    assert.equal(new Set(names).size, 8);
  }
});

test("combined themes preserve storage compatibility and update mode URL overrides", () => {
  const app = browser({ query: "?scoutTheme=light" });
  for (const palette of ["amber", "forest", "ocean", "rose"]) {
    for (const mode of ["light", "dark"]) {
      assert.equal(app.run(`preferences.setTheme('${palette}-${mode}')`), true);
      assert.equal(app.stored.get("voiceprint.palette"), palette);
      assert.equal(app.stored.get("voiceprint.mode"), mode);
      assert.equal(app.location.searchParams.get("scoutTheme"), mode);
      const restored = browser({ saved: { palette, mode } });
      assert.equal(restored.document.documentElement.dataset.palette, palette);
      assert.equal(restored.document.documentElement.dataset.theme, mode);
    }
  }
  for (const theme of ["ocean", "invalid-dark", "rose-light-extra", "ocean-unknown"]) {
    assert.throws(() => app.run(`preferences.setTheme('${theme}')`), /Invalid theme/);
  }
  const blocked = browser({ blocked: true });
  assert.equal(blocked.run("preferences.setTheme('forest-dark')"), false);
  assert.equal(blocked.document.documentElement.dataset.palette, "forest");
  assert.equal(blocked.document.documentElement.dataset.theme, "dark");
});

test("invalid saved values and query cannot select nonexistent themes or locales", () => {
  const app = browser({ saved: { language: "xx", palette: "invalid", mode: "bad" }, query: "?scoutTheme=bad" });
  assert.equal(app.run("preferences.values.language"), "en");
  assert.equal(app.run("preferences.values.palette"), "ocean");
  assert.equal(app.run("preferences.values.mode"), "light");
  assert.throws(() => app.run("preferences.set('palette', 'invalid')"), /Invalid preference/);
});

test("blocked storage is reported while preferences still work in memory", () => {
  const app = browser({ blocked: true });
  assert.equal(app.run("preferences.storageUnavailable"), true);
  assert.equal(app.run("preferences.set('language', 'fr')"), false);
  assert.equal(app.document.documentElement.lang, "fr");
  assert.ok(app.warnings.length);
});

test("each translation has both languages and identical interpolation parameters", () => {
  const entries = browser().run("Object.entries(translations)");
  for (const [key, [en, fr]] of entries) {
    assert.ok(en?.trim() && fr?.trim(), key);
    const placeholders = (value) => Array.from(value.matchAll(/\{(\w+)\}/g), (match) => match[1]).sort();
    assert.deepEqual(placeholders(en), placeholders(fr), key);
  }
});

test("all HTML and literal application translation keys exist", () => {
  const app = browser();
  const keys = new Set(app.run("Object.keys(translations)"));
  const html = read("index.html");
  for (const match of html.matchAll(/data-i18n(?:-aria-label|-title|-placeholder)?="([^"]+)"/g)) {
    assert.ok(keys.has(match[1]), `Missing HTML key: ${match[1]}`);
  }
  for (const match of (read("app.js") + read("appearance.js") + read("demo.js") + read("presentation.js")).matchAll(/\b(?:t|LocalizedError|success)\(\s*["']([^"']+)["']/g)) {
    assert.ok(keys.has(match[1]), `Missing JS key: ${match[1]}`);
  }
  for (const capture of ["Idle", "Recording", "Ready", "Retry"]) {
    assert.ok(keys.has(`capture${capture}`));
    assert.ok(keys.has(`capture${capture === "Retry" ? "Idle" : capture}Hint`));
  }
});

test("sidebar width is validated, applied and persisted", () => {
  const app = browser({ saved: { sidebarWidth: "340" } });
  assert.equal(app.run("preferences.values.sidebarWidth"), 340);
  assert.equal(app.document.documentElement.style["--sidebar-width"], "340px");
  for (const width of [160, 220, 420]) {
    app.run(`preferences.set('sidebarWidth', ${width})`);
    assert.equal(app.document.documentElement.style["--sidebar-width"], `${width}px`);
    assert.equal(app.stored.get("voiceprint.sidebarWidth"), width);
  }
  for (const width of ["159", "421", "NaN", "Infinity", "200.5", "'220'"]) {
    assert.throws(() => app.run(`preferences.set('sidebarWidth', ${width})`), /Invalid preference/);
  }
  assert.equal(browser({ saved: { sidebarWidth: "900" } }).run("preferences.values.sidebarWidth"), 220);
});

test("rank bars use 0..1 and clamp negative similarities without taking absolute values", () => {
  const app = browser();
  app.run(read("app.js").match(/function similarityGeometry\(score\) \{[\s\S]*?\n\}/)[0]);
  for (const [score, start, width] of [[-1, 0, 0], [-0.5, 0, 0], [0, 0, 0], [0.5, 0, 50], [1, 0, 100]]) {
    const result = app.run(`similarityGeometry(${score})`);
    assert.equal(result.start, start);
    assert.equal(result.width, width);
  }
  for (const score of ["NaN", "Infinity", "-1.1", "1.1"]) {
    assert.throws(() => app.run(`similarityGeometry(${score})`), /Invalid cosine/);
  }
  assert.match(read("index.html"), /id="threshold"[^>]+value="0\.5"/);
});

test("similarity axes label quarter ticks at the correct positions in both languages", () => {
  const app = browser();
  app.context.document.createElement = () => ({
    style: {}, children: [], attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    append(child) { this.children.push(child); },
  });
  app.run(read("app.js").match(/function createSimilarityAxis\(\) \{[\s\S]*?\n\}/)[0]);
  for (const [language, labels] of [["en", ["0.25", "0.5", "0.75"]], ["fr", ["0,25", "0,5", "0,75"]]]) {
    app.run(`preferences.set('language', '${language}')`);
    const axis = app.run("createSimilarityAxis()");
    assert.deepEqual(axis.children.map(tick => tick.style.left), ["25%", "50%", "75%"]);
    assert.deepEqual(axis.children.map(tick => tick.textContent), labels);
    assert.equal(axis.attributes["aria-hidden"], "true");
  }
});

test("similarity descriptions mark strictly below-threshold scores without changing numbers", () => {
  const app = browser();
  app.run(read("app.js").match(/function similarityDescription\(score, threshold\) \{[\s\S]*?\n\}/)[0]);
  assert.match(app.run("similarityDescription(0.499, 0.5)"), /0\.499; below.*0\.50/);
  assert.equal(app.run("similarityDescription(0.5, 0.5)"), "0.500");
  assert.equal(app.run("similarityDescription(0.501, 0.5)"), "0.501");
  assert.equal(app.run("similarityDescription(0, 0)"), "0.000");
  assert.match(app.run("similarityDescription(-0.25, 0.5)"), /-0\.250.*below/);
  app.run("preferences.set('language', 'fr')");
  assert.match(app.run("similarityDescription(0.6, 0.75)"), /0,600.*en dessous.*0,75/);
});

test("Top N updates cached results immediately and fetches more only on commit", () => {
  const app = browser();
  const input = { valueAsNumber: 3, checkValidity() { return this.valueAsNumber >= 1; } };
  const button = { disabled: false };
  const errors = [];
  let rendered = 0, requested = 0;
  app.context.$ = id => id === "top-n" ? input : button;
  app.context.state = { result: { top_n: 5, candidates: Array(5).fill({ score: 0.5 }) } };
  app.context.renderResult = () => { rendered++; };
  app.context.identify = () => { requested++; };
  app.context.showError = error => errors.push(error);
  for (const name of ["validTopN", "updateTopN"]) {
    app.run(read("app.js").match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]);
  }
  app.run("updateTopN()");
  assert.equal(rendered, 1);
  assert.equal(requested, 0);
  input.valueAsNumber = 8;
  app.run("updateTopN()");
  assert.equal(requested, 0);
  app.run("updateTopN(true)");
  assert.equal(requested, 1);
  app.context.state.result = { top_n: 8, candidates: Array(3).fill({ score: 0.5 }) };
  input.valueAsNumber = 20;
  app.run("updateTopN(true)");
  assert.equal(requested, 1);
  input.valueAsNumber = 0;
  app.run("updateTopN(true)");
  assert.equal(errors.at(-1).key, "topNError");
  assert.equal(requested, 1);
});

test("identification rejects stale APIs that ignore Top N instead of displaying extra rows", async () => {
  const app = browser();
  const elements = new Map();
  app.context.$ = id => {
    if (!elements.has(id)) elements.set(id, { value: "0.5", valueAsNumber: 3, checkValidity: () => true });
    return elements.get(id);
  };
  app.context.state = { blob: {}, busy: false, recording: false };
  const errors = [], results = [], queries = [];
  app.context.clearNotices = () => {};
  app.context.syncControls = () => {};
  app.context.resetResult = () => {};
  app.context.showError = error => errors.push(error);
  app.context.renderResult = result => results.push(result);
  app.context.cancelResultReveal = () => {};
  app.context.renderConstellation = () => {};
  app.context.revealResult = () => {};
  for (const name of ["validTopN", "identify"]) {
    app.run(read("app.js").match(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`))[0]);
  }
  for (const response of [{ candidates: Array(5).fill({}) }, { top_n: 5, candidates: Array(3).fill({}) },
    { top_n: 3, candidates: Array(5).fill({}) }, { top_n: 3, candidates: Array(3).fill({}) }]) {
    app.context.api = async url => { queries.push(new URL(url, "http://localhost").searchParams.get("top_n")); return response; };
    await app.run("identify()");
  }
  assert.deepEqual(queries, ["3", "3", "3", "3"]);
  assert.equal(errors.length, 3);
  assert.ok(errors.every(error => error.key === "topNServerMismatch"));
  assert.equal(results.length, 1);
  assert.equal(results[0].candidates.length, 3);
});

test("microphone visual energy is measured from real samples and is zero for silence", () => {
  const app = browser();
  app.run(read("demo.js").match(/function audioEnergy\(values\) \{[\s\S]*?\n\}/)[0]);
  assert.equal(app.run("audioEnergy(new Uint8Array(2048).fill(128))"), 0);
  assert.equal(app.run("audioEnergy(new Uint8Array())"), 0);
  assert.equal(app.run("audioEnergy(new Uint8Array([64,192]))"), 0.5);
  assert.equal(app.run("audioEnergy(new Uint8Array([0,0]))"), 1);
});

test("constellation fits actual coordinates uniformly without inventing point positions", () => {
  const app = browser();
  app.run(read("demo.js"));
  const layout = app.run("constellationLayout([{x:-1,y:0},{x:1,y:0},{x:0,y:1}],{x:0,y:0})");
  assert.equal(layout.points[0].y, layout.points[1].y);
  assert.equal(layout.query.x, (layout.points[0].x + layout.points[1].x) / 2);
  assert.equal(layout.query.y, layout.points[0].y);
  assert.equal(layout.points[1].x - layout.query.x, layout.query.y - layout.points[2].y);
  const identical = app.run("constellationLayout([{x:0,y:0},{x:0,y:0}],{x:0,y:0})");
  assert.equal(identical.points[0].x, identical.points[1].x);
  assert.equal(identical.points[0].x, identical.query.x);
  for (const point of [...layout.points, layout.query]) {
    assert.ok(point.x >= 60 && point.x <= 700 && point.y >= 40 && point.y <= 410);
  }
});

test("2D spotlight ignores depth; zoom is uniform and pan translates references and query equally", () => {
  const app = browser();
  app.run(read("demo.js"));
  const points = "[{x:1,y:0,z:1},{x:1,y:0,z:-1},{x:-1,y:0,z:9}]";
  const front = app.run(`constellationLayout(${points},{x:0,y:0},{zoom:1,panX:0,panY:0})`);
  const panned = app.run(`constellationLayout(${points},{x:0,y:0},{zoom:1,panX:.1,panY:-.2})`);
  const zoomed = app.run(`constellationLayout(${points},{x:0,y:0},{zoom:2,panX:0,panY:0})`);
  assert.equal(front.points[0].x, front.points[1].x);
  assert.equal(front.points[0].y, front.points[1].y);
  assert.equal(front.points[0].x - front.points[2].x, 340);
  assert.equal(zoomed.points[0].x - zoomed.points[2].x, 680);
  for (const [index, point] of [...front.points, front.query].entries()) {
    const translated = [...panned.points, panned.query][index];
    assert.equal(translated.x - point.x, 76);
    assert.equal(translated.y - point.y, -90);
  }
  app.context.updateConstellationView = () => {};
  app.context.renderMapControls = () => {};
  app.run("setConstellationZoom(9)");
  assert.equal(app.run("demo.view.zoom"), 3);
  app.run("setConstellationZoom(-1)");
  assert.equal(app.run("demo.view.zoom"), 0.5);
});

test("3D spotlight uses the real z coordinate with rigid rotation and uniform zoom", () => {
  const app = browser();
  app.run(read("demo.js"));
  const points = "[{x:0,y:0,z:1},{x:0,y:0,z:-1}]";
  const view = "{mode:'3d',zoom:1,panX:0,panY:0,yaw:0,pitch:0}";
  const front = app.run(`constellationLayout(${points},{x:0,y:0,z:1},${view})`);
  const turned = app.run(`constellationLayout(${points},null,{...${view},yaw:90})`);
  const zoomed = app.run(`constellationLayout(${points},null,{...${view},yaw:90,zoom:2})`);
  const tilted = app.run(`constellationLayout(${points},null,{...${view},pitch:90})`);
  assert.equal(front.points[0].x, front.points[1].x);
  assert.equal(front.points[0].depth, 1);
  assert.equal(front.points[1].depth, -1);
  assert.deepEqual(front.points[0], front.query);
  assert.equal(turned.points[0].x - turned.points[1].x, 340);
  assert.equal(zoomed.points[0].x - zoomed.points[1].x, 680);
  assert.equal(tilted.points[0].y - tilted.points[1].y, 340);
  const identical = app.run(`constellationLayout([{x:0,y:0,z:0},{x:0,y:0,z:0}],{x:0,y:0,z:0},${view})`);
  assert.deepEqual(identical.points[0], identical.points[1]);
  assert.ok(Number.isFinite(identical.points[0].depth));
});

test("empty results clear either backend's plot and reset pan without fetching references", () => {
  for (const cloud of [false, true]) {
    const app = browser();
    app.run(read("demo.js"));
    const elements = new Map();
    app.context.$ = id => {
      if (!elements.has(id)) elements.set(id, { children: ["old"], textContent: "old",
        replaceChildren(...children) { this.children = children; } });
      return elements.get(id);
    };
    app.context.renderMapControls = () => {};
    app.context.state = { result: null };
    const cancelled = [];
    app.context.cancelAnimationFrame = id => cancelled.push(id);
    app.context.api = () => { throw new Error("An empty plot must not fetch a reference map"); };
    app.run(`preferences.set('backend','${cloud ? "azure" : "qdrant"}'); demo.plot = {};
      demo.view.panX = .4; demo.view.panY = -.2; demo.view.zoom = 3;
      demo.spinning = true; demo.spinFrame = 42;
      demo.selectedPoint = 'old'; demo.hoveredPoint = 'hovered';
      renderConstellation()`);
    assert.equal(app.run("demo.plot"), null);
    assert.equal(app.run("demo.selectedPoint"), null);
    assert.equal(app.run("demo.hoveredPoint"), null);
    assert.equal(app.run("demo.view.panX"), 0);
    assert.equal(app.run("demo.view.panY"), 0);
    assert.equal(app.run("demo.view.zoom"), 1);
    assert.equal(app.run("demo.spinning"), false);
    assert.equal(app.run("demo.spinFrame"), null);
    assert.deepEqual(cancelled, [42]);
    for (const id of ["constellation-svg", "constellation-select"]) assert.equal(elements.get(id).children.length, 0);
    for (const id of ["constellation-stats", "constellation-detail"]) assert.equal(elements.get(id).textContent, "");
    assert.equal(elements.get("constellation-content").hidden, true);
    assert.equal(elements.get("constellation-retry").hidden, true);
  }
  assert.doesNotMatch(read("app.js") + read("demo.js"), /loadConstellation/);
});

function mousePlot() {
  const app = browser();
  app.run(read("demo.js"));
  const captured = new Set(), classes = new Set();
  const svg = {
    clientWidth: 800, clientHeight: 400,
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    setPointerCapture: id => captured.add(id), hasPointerCapture: id => captured.has(id),
    releasePointerCapture: id => captured.delete(id),
  };
  app.context.$ = () => svg;
  app.context.renderMapControls = () => {};
  app.context.updateConstellationView = () => {};
  app.run("demo.plot = {map:{backend:'qdrant'}}");
  const event = { pointerType: "mouse", pointerId: 1, button: 0, buttons: 1, isPrimary: true,
    clientX: 100, clientY: 100, preventDefault() { this.prevented = true; } };
  const send = (handler, changes = {}) => {
    app.context.event = { ...event, ...changes };
    app.run(`${handler}(event)`);
    return app.context.event;
  };
  return { app, captured, classes, send };
}

test("mouse drag has a click threshold, pans both axes, and releases capture", () => {
  const { app, captured, classes, send } = mousePlot();
  send("startConstellationDrag");
  send("moveConstellationDrag", { clientX: 102 });
  assert.equal(app.run("demo.view.panX"), 0);
  assert.equal(app.run("demo.suppressPlotClick"), false);
  assert.equal(captured.size, 0);
  send("moveConstellationDrag", { clientX: 50, clientY: -200 });
  assert.equal(app.run("demo.view.panX"), -50 / 800);
  assert.equal(app.run("demo.view.panY"), -300 / 400);
  assert.equal(app.run("demo.suppressPlotClick"), true);
  assert.ok(classes.has("dragging"));
  assert.ok(captured.has(1));
  send("moveConstellationDrag", { clientY: 1000 });
  assert.equal(app.run("demo.view.panY"), 900 / 400);
  send("endConstellationDrag");
  assert.equal(app.run("demo.drag"), null);
  assert.equal(captured.size, 0);
  assert.equal(classes.size, 0);
  send("startConstellationDrag");
  assert.equal(app.run("demo.suppressPlotClick"), false);
  app.run("demo.view.panX = 0; demo.view.panY = 0");
  send("startConstellationDrag");
  send("moveConstellationDrag", { clientX: 200, clientY: -500 });
  assert.equal(app.run("demo.view.panX"), 100 / 800);
  assert.equal(app.run("demo.view.panY"), -600 / 400);
  app.run("resetConstellationView()");
  assert.equal(app.run("demo.drag"), null);
  assert.equal(captured.size, 0);
  assert.equal(app.run("demo.view.panX"), 0);
  assert.equal(app.run("demo.view.panY"), 0);
});

test("mouse navigation ignores other buttons and stops on lost buttons or missing results", () => {
  const { app, send } = mousePlot();
  for (const changes of [{ button: 2 }, { pointerType: "touch" }, { isPrimary: false }]) {
    send("startConstellationDrag", changes);
    assert.equal(app.run("demo.drag"), null);
  }
  send("startConstellationDrag");
  send("moveConstellationDrag", { clientX: 200, pointerId: 2 });
  assert.equal(app.run("demo.view.panX"), 0);
  send("moveConstellationDrag", { buttons: 0 });
  assert.equal(app.run("demo.drag"), null);
  app.run("demo.plot = null");
  send("startConstellationDrag");
  assert.equal(app.run("demo.drag"), null);
});

test("3D mouse orbit wraps yaw, clamps tilt, preserves pan, and Shift-drag pans instead", () => {
  const { app, send, captured } = mousePlot();
  app.run("demo.view.mode = '3d'");
  send("startConstellationDrag");
  send("moveConstellationDrag", { clientX: 200, clientY: 50 });
  assert.equal(app.run("demo.view.yaw"), 70);
  assert.equal(app.run("demo.view.pitch"), 40);
  assert.equal(app.run("demo.view.panX"), 0);
  assert.equal(app.run("demo.view.panY"), 0);
  send("moveConstellationDrag", { clientX: -100, clientY: -1000 });
  assert.equal(app.run("demo.view.yaw"), 310);
  assert.equal(app.run("demo.view.pitch"), 85);
  send("moveConstellationDrag", { clientY: 1000 });
  assert.equal(app.run("demo.view.pitch"), -85);
  send("endConstellationDrag");
  assert.equal(captured.size, 0);
  const angles = app.run("JSON.stringify([demo.view.yaw, demo.view.pitch])");
  send("startConstellationDrag", { shiftKey: true });
  send("moveConstellationDrag", { clientX: 180, clientY: 140 });
  assert.equal(app.run("demo.view.panX"), .1);
  assert.equal(app.run("demo.view.panY"), .1);
  assert.equal(app.run("JSON.stringify([demo.view.yaw, demo.view.pitch])"), angles);
  app.run("resetConstellationView()");
  assert.equal(app.run("demo.view.mode"), "3d");
  assert.equal(app.run("demo.view.yaw"), 30);
  assert.equal(app.run("demo.view.pitch"), 20);
  assert.equal(app.run("demo.drag"), null);
});

test("mouse wheel accumulates small deltas, handles wheel units, honors zoom bounds and browser modifiers", () => {
  const { app, send } = mousePlot();
  const wheel = { deltaY: -10, deltaMode: 0, timeStamp: 1000 };
  for (let i = 0; i < 5; i++) assert.ok(send("zoomConstellationWithWheel", wheel).prevented);
  assert.equal(app.run("demo.view.zoom"), 1.1);
  send("zoomConstellationWithWheel", { ...wheel, deltaY: 4, deltaMode: 1 });
  assert.equal(app.run("demo.view.zoom"), 1);
  send("zoomConstellationWithWheel", { ...wheel, deltaY: 10, deltaMode: 2 });
  assert.equal(app.run("demo.view.zoom"), 0.5);
  send("zoomConstellationWithWheel", { ...wheel, deltaY: -5000 });
  assert.equal(app.run("demo.view.zoom"), 3);
  for (const modifiers of [{ ctrlKey: true }, { metaKey: true }]) {
    assert.equal(send("zoomConstellationWithWheel", { ...wheel, ...modifiers }).prevented, undefined);
  }
  app.run("demo.plot = null");
  assert.equal(send("zoomConstellationWithWheel", wheel).prevented, undefined);
});

test("reduced motion suppresses result animation while keeping the announcement", () => {
  const app = browser();
  app.run(read("demo.js"));
  const live = {};
  app.context.$ = () => live;
  app.context.state = { result: { speaker: null } };
  app.run("demo.reducedMotion = {matches:true}; revealResult()");
  assert.equal(live.textContent, app.run("t('unknown')"));
  assert.equal(app.run("demo.animations.length"), 0);
});

test("keyboard panning works with reduced motion and does not intercept point or modified keys", () => {
  const { app, send } = mousePlot();
  app.run("demo.reducedMotion.matches = true");
  const target = app.context.$("constellation-svg");
  assert.ok(send("navigateConstellationWithKeyboard", { target, key: "ArrowRight" }).prevented);
  assert.ok(send("navigateConstellationWithKeyboard", { target, key: "ArrowUp" }).prevented);
  assert.equal(app.run("demo.view.panX"), .05);
  assert.equal(app.run("demo.view.panY"), -.05);
  for (const changes of [{ target: {} }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { key: "Enter" }]) {
    assert.equal(send("navigateConstellationWithKeyboard", { target, key: "ArrowLeft", ...changes }).prevented, undefined);
  }
  app.run("demo.view.mode = '3d'");
  send("navigateConstellationWithKeyboard", { target, key: "ArrowRight" });
  send("navigateConstellationWithKeyboard", { target, key: "ArrowUp" });
  assert.equal(app.run("demo.view.yaw"), 35);
  assert.equal(app.run("demo.view.pitch"), 25);
  send("navigateConstellationWithKeyboard", { target, key: "ArrowRight", shiftKey: true });
  assert.equal(app.run("demo.view.panX"), .1);
  assert.equal(app.run("demo.view.yaw"), 35);
  app.run("demo.plot = null");
  assert.equal(send("navigateConstellationWithKeyboard", { target, key: "ArrowLeft" }).prevented, undefined);
  assert.doesNotMatch(read("demo.js"), /map-floor|map-grid|map-axis/);
});

test("dimension controls update retained variance and low-rank warnings without changing selection", () => {
  const app = browser();
  app.run(read("demo.js"));
  const elements = new Map();
  app.context.$ = id => {
    if (!elements.has(id)) elements.set(id, { attributes: {}, setAttribute(key, value) { this.attributes[key] = value; } });
    return elements.get(id);
  };
  app.context.updateConstellationView = () => app.run("renderMapControls()");
  app.run(`demo.plot = {map:{points:[{}],rank:2,explained_variance:.25,explained_variance_3d:.35}};
    demo.selectedPoint = 'chosen'; setConstellationMode('3d')`);
  assert.equal(elements.get("map-3d").attributes["aria-pressed"], "true");
  assert.equal(elements.get("map-2d").attributes["aria-pressed"], "false");
  assert.equal(elements.get("map-spin").hidden, false);
  assert.match(elements.get("constellation-stats").textContent, /35\.0%/);
  assert.equal(elements.get("constellation-limited").hidden, false);
  app.run("demo.reducedMotion.matches = true; renderMapControls()");
  assert.equal(elements.get("map-spin").disabled, true);
  assert.equal(elements.get("map-motion-hint").hidden, false);
  app.run("preferences.set('language','fr'); renderMapControls()");
  assert.equal(elements.get("map-spin").textContent, "Rotation automatique");
  assert.match(elements.get("map-mouse-hint").textContent, /pivoter/);
  app.run("setConstellationMode('2d')");
  assert.equal(elements.get("map-spin").hidden, true);
  assert.equal(elements.get("map-motion-hint").hidden, true);
  assert.equal(elements.get("constellation-limited").hidden, true);
  assert.equal(app.run("demo.selectedPoint"), "chosen");
});

test("automatic spin is frame-timed and stops for unavailable results, pages, modes, and reduced motion", () => {
  for (const reason of ["empty", "backend-changed", "hidden", "library", "reduced", "2d"]) {
    const { app } = mousePlot();
    let frames = 0;
    app.context.state = { result: {} };
    app.context.requestAnimationFrame = () => ++frames;
    app.context.cancelAnimationFrame = () => {};
    app.run("demo.view.mode = '3d'; toggleConstellationSpin(); spinConstellation(1000); spinConstellation(1100)");
    assert.equal(app.run("demo.spinning"), true);
    assert.ok(Math.abs(app.run("demo.view.yaw") - 31.8) < 1e-10);
    const scheduled = frames;
    if (reason === "empty") app.context.state.result = null;
    if (reason === "backend-changed") app.run("preferences.values.backend = 'azure'");
    if (reason === "hidden") app.context.document.hidden = true;
    if (reason === "library") app.context.$("identify-page").hidden = true;
    if (reason === "reduced") app.run("demo.reducedMotion.matches = true");
    if (reason === "2d") app.run("demo.view.mode = '2d'");
    app.run("spinConstellation(1200)");
    assert.equal(app.run("demo.spinning"), false);
    assert.equal(app.run("demo.spinFrame"), null);
    assert.equal(frames, scheduled);
  }
});

test("manual interactions and stop button cancel scheduled spin; reduced motion prevents starting it", () => {
  for (const interaction of ["toggleConstellationSpin()", "setConstellationZoom(2)", "resetConstellationView()",
    "setConstellationMode('2d')", "startConstellationDrag(event)", "zoomConstellationWithWheel(event)",
    "navigateConstellationWithKeyboard(event)"]) {
    const { app } = mousePlot();
    const cancelled = [];
    app.context.requestAnimationFrame = () => 42;
    app.context.cancelAnimationFrame = id => cancelled.push(id);
    app.context.event = { pointerType: "mouse", pointerId: 1, button: 0, isPrimary: true,
      target: app.context.$("constellation-svg"), key: "ArrowRight", deltaY: 1, deltaMode: 0,
      timeStamp: 1000, clientX: 100, clientY: 100, preventDefault() {} };
    app.run(`demo.view.mode = '3d'; toggleConstellationSpin(); ${interaction}`);
    assert.equal(app.run("demo.spinning"), false, interaction);
    assert.deepEqual(cancelled, [42], interaction);
  }
  const { app } = mousePlot();
  app.context.requestAnimationFrame = () => { throw new Error("Must not animate"); };
  app.run("toggleConstellationSpin(); demo.view.mode = '3d'; demo.reducedMotion.matches = true; toggleConstellationSpin()");
  assert.equal(app.run("demo.spinning"), false);
});

test("Azure spotlight can spin when its projection belongs to the selected backend", () => {
  const { app } = mousePlot();
  app.context.state = { result: { backend: "azure" } };
  app.context.requestAnimationFrame = () => 1;
  app.context.cancelAnimationFrame = () => {};
  app.run(`preferences.values.backend='azure'; demo.plot.map.backend='azure';
    demo.view.mode='3d'; toggleConstellationSpin(); spinConstellation(1000); spinConstellation(1100)`);
  assert.equal(app.run("demo.spinning"), true);
  assert.ok(Math.abs(app.run("demo.view.yaw") - 31.8) < 1e-10);
});

test("Azure projection errors are retryable and local projections cannot appear as cloud data", () => {
  const app = browser({ saved: { backend: "azure" } });
  app.run(read("demo.js"));
  const elements = new Map();
  app.context.$ = id => {
    if (!elements.has(id)) elements.set(id, { replaceChildren() {} });
    return elements.get(id);
  };
  app.context.renderMapControls = () => {};
  app.context.state = { result: { backend: "azure", constellation: {
    available: true, backend: "qdrant", query: { x: 0, y: 0, z: 0 },
    points: [{ x: 1, y: 0, z: 0 }], explained_variance: .1, explained_variance_3d: .2,
  } } };
  app.run("renderConstellation()");
  assert.equal(app.run("demo.plot"), null);
  assert.equal(elements.get("constellation-content").hidden, true);
  assert.equal(elements.get("constellation-retry").hidden, false);
  assert.equal(app.warnings.length, 1);
  app.context.state.result.constellation = { available: false, reason: "azureProjectionData" };
  app.run("renderConstellation()");
  assert.equal(elements.get("constellation-status").textContent, app.run("t('azureProjectionData')"));
  assert.equal(elements.get("constellation-retry").hidden, false);
  app.context.state.result.constellation = {
    available: true, backend: "azure", query: { x: 0, y: 0, z: 0 },
    points: [], explained_variance: 0, explained_variance_3d: 0,
  };
  app.run("renderConstellation()");
  assert.equal(elements.get("constellation-status").textContent, app.run("t('constellationEmpty')"));
  assert.equal(elements.get("constellation-retry").hidden, true);
});

test("match criteria does not show an experimental badge but keeps its calibration warning", () => {
  const section = read("index.html").match(/<section id="criteria-panel"[\s\S]*?<\/section>/)[0];
  assert.doesNotMatch(section, /data-i18n="experimental"|EXPERIMENTAL/);
  assert.match(section, /data-i18n="criteriaHint"/);
});

test("demo reset keeps settings and library untouched and clears only transient capture", () => {
  const app = browser();
  app.run(read("demo.js"));
  const elements = new Map();
  app.context.$ = id => {
    if (!elements.has(id)) elements.set(id, { focus() {} });
    return elements.get(id);
  };
  let paused = 0, cleared = 0, visualClears = 0;
  const audio = { pause() { paused++; }, readyState: 1, currentTime: 12 };
  app.context.document.querySelectorAll = () => [audio];
  app.context.state = { busy: false, recording: false, refreshing: false };
  app.context.clearNotices = () => {};
  app.context.setAudio = value => { assert.equal(value, null); cleared++; };
  app.context.clearAudioVisuals = () => { visualClears++; };
  app.context.showPage = name => assert.equal(name, "identify");
  const preferencesBefore = app.run("JSON.stringify(preferences.values)");
  app.run("resetDemo()");
  assert.equal(paused, 1);
  assert.equal(audio.currentTime, 0);
  assert.equal(cleared, 1);
  assert.equal(visualClears, 1);
  assert.equal(app.run("JSON.stringify(preferences.values)"), preferencesBefore);
  app.context.state.recording = true;
  app.run("resetDemo()");
  assert.equal(cleared, 1);
});

test("demo controls initialize once at startup, not during theme changes", () => {
  const source = read("app.js");
  assert.equal((source.match(/initializeDemo\(\);/g) || []).length, 1);
  assert.match(source, /renderLocale\(\);\s*initializeWelcome\(\);\s*initializeDemo\(\);\s*void initializeAppearance\(\);/);
});

test("Clear is translated and presenter controls, styles and handlers are removed", () => {
  const app = browser();
  assert.equal(app.run("t('resetDemo')"), "Clear");
  app.run("preferences.set('language','fr')");
  assert.equal(app.run("t('resetDemo')"), "Effacer");
  assert.match(read("index.html"), /id="demo-reset"[^>]*>[\s\S]*?<span data-i18n="resetDemo">Clear<\/span><\/button>/);
  assert.doesNotMatch(read("index.html") + read("demo.js") + read("demo.css"), /presenter|fullscreen/i);
});

test("compact toolbar groups appearance controls while keeping backend, language and Clear visible", () => {
  const html = read("index.html");
  const menu = html.match(/<details id="appearance-menu"[\s\S]*?<\/details>/)[0];
  for (const id of ["palette-select", "font-select", "background-import", "background-remove", "background-input"]) {
    assert.ok(menu.includes(`id="${id}"`));
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
  }
  for (const id of ["backend-select", "azure-settings", "language-select", "demo-reset"]) {
    assert.ok(!menu.includes(`id="${id}"`));
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
  }
  assert.match(menu, /<summary id="appearance-toggle"/);
  assert.equal(browser().run("t('appearance')"), "Appearance");
  assert.equal(browser({ language: "fr" }).run("t('appearance')"), "Apparence");
});

test("documentation is linked independently of app navigation with accessible new-tab labels", () => {
  const link = read("index.html").match(/<a id="documentation-link"[\s\S]*?<\/a>/)[0];
  assert.match(link, /href="\/static\/documentation.html"/);
  assert.match(link, /target="_blank"/);
  assert.match(link, /rel="noopener noreferrer"/);
  assert.match(link, /data-i18n-aria-label="documentationHint"/);
  assert.doesNotMatch(link, /data-page=/);
  assert.match(browser().run("t('documentationHint')"), /English, opens in a new tab/);
  assert.match(browser({ language: "fr" }).run("t('documentationHint')"), /en anglais, nouvel onglet/);
});

test("user guide has valid section links and local CSP-compatible assets", () => {
  const guide = read("documentation.html");
  const ids = [...guide.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const match of guide.matchAll(/href="#([^"]+)"/g)) assert.ok(ids.includes(match[1]), match[1]);
  for (const id of ["quick-start", "audio", "results", "spotlight", "library", "azure", "appearance", "privacy", "troubleshooting", "setup"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.match(guide, /<body lang="en">/);
  assert.match(guide, /Version 1\.0/);
  assert.match(guide, /datetime="2026-10-05">05-10-2026/);
  assert.match(guide, /<script src="theme.js"><\/script>/);
  assert.match(guide, /href="documentation.css"/);
  assert.doesNotMatch(guide, /<style|\bstyle=|<script(?! src=)|\bonclick=/);
  assert.match(read("documentation.css"), /@media print/);
});

for (const name of ["appearance", "criteria"]) test(`${name} menu keeps inside interactions open and dismisses outside or with Escape`, () => {
  const app = browser();
  const listeners = new Map();
  const inside = {};
  let focused = false;
  const menu = {
    open: true,
    contains: target => target === inside,
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  app.context.$ = id => id === `${name}-menu` ? menu : { focus() { focused = true; } };
  app.document.addEventListener = (name, callback) => listeners.set(name, callback);
  app.run(read("appearance.js").match(/function initializeToolbarMenu\([^]*?\n\}/)[0]);
  app.run(`initializeToolbarMenu("${name}-menu", "${name}-toggle")`);
  listeners.get("pointerdown")({ target: inside });
  assert.equal(menu.open, true);
  listeners.get("keydown")({ key: "Tab", preventDefault() { assert.fail("Tab must remain native"); } });
  assert.equal(menu.open, true);
  listeners.get("pointerdown")({ target: {} });
  assert.equal(menu.open, false);
  assert.equal(focused, false);
  menu.open = true;
  let prevented = false;
  listeners.get("keydown")({ key: "Escape", preventDefault() { prevented = true; } });
  assert.equal(menu.open, false);
  assert.equal(prevented, true);
  assert.equal(focused, true);
  assert.equal(read("appearance.js").split(`initializeToolbarMenu("${name}-menu", "${name}-toggle");`).length - 1, 1);
});

test("match criteria lives only in its accessible top-bar icon panel with unchanged defaults", () => {
  const html = read("index.html");
  const header = html.match(/<header class="topbar">[\s\S]*?<\/header>/)[0];
  const menu = header.match(/<details id="criteria-menu"[\s\S]*?<\/details>/)[0];
  assert.match(menu, /name="toolbar-settings"/);
  assert.match(menu, /id="criteria-toggle"[^>]*data-i18n-aria-label="criteria"/);
  assert.match(menu, /id="threshold"[^>]*min="0" max="1" step="0.01" value="0.5" required/);
  assert.match(menu, /id="min-gap"[^>]*min="0" max="1" step="0.01" value="0.05" required/);
  assert.match(menu, /data-i18n="criteriaNextAnalysis"/);
  for (const id of ["threshold", "min-gap", "tuning-title"]) {
    assert.equal(html.split(`id="${id}"`).length - 1, 1);
  }
  assert.doesNotMatch(html, /tuning-card/);
});

test("invalid criteria reopen the top-bar panel and focus the invalid field before any request", async () => {
  for (const invalid of ["threshold", "min-gap"]) {
    const app = browser();
    let focused = null;
    const menu = { open: false };
    const errors = [];
    const inputs = Object.fromEntries(["threshold", "min-gap"].map(id => [id, {
      checkValidity: () => id !== invalid, focus() { focused = id; },
    }]));
    app.context.$ = id => id === "criteria-menu" ? menu : inputs[id];
    app.context.state = { blob: {}, busy: false, recording: false };
    app.context.validTopN = () => true;
    app.context.showError = error => errors.push(error);
    app.context.request = () => assert.fail("Invalid criteria must not reach the API");
    app.run(read("app.js").match(/async function identify\(\) \{[\s\S]*?\n\}/)[0]);
    await app.run("identify()");
    assert.equal(menu.open, true);
    assert.equal(focused, invalid);
    assert.equal(errors.length, 1);
  }
});

function reportFixture() {
  return {
    completed_at: "2026-10-05T08:00:00.000Z", backend: "qdrant", top_n: 5,
    speaker: { id: "custom-1", name: "=HYPERLINK(\"bad\")" }, reason: "matched",
    threshold: 0.5, min_gap: 0.05, gap: 0.8, elapsed_ms: 1234, elapsed_seconds: 1.234,
    audio: { duration_seconds: 4.2, warnings: ["Test warning"] },
    candidates: [{ id: "custom-1", name: "=HYPERLINK(\"bad\")", score: 0.75 },
      { id: "custom-2", name: "Name, with \"quotes\"\nand newline", score: -0.05 }],
    constellation: { available: true, backend: "qdrant", points: [{ embedding: [1, 2, 3] }],
      explained_variance: 0.4, explained_variance_3d: 0.6 },
    secret: "must not export",
  };
}

function presentationBrowser() {
  const app = browser();
  const elements = new Map();
  let focused = null;
  app.context.$ = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, textContent: "", attributes: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute(key, value) { this.attributes[key] = value; },
      focus() { focused = id; }, scrollIntoView() {},
    });
    return elements.get(id);
  };
  app.document.body = { classList: { toggle() {} } };
  app.context.state = { result: null, busy: false, recording: false, refreshing: false, source: "mic" };
  app.context.demo = { plot: null, view: { mode: "2d", zoom: 1 } };
  app.context.speakerName = speaker => speaker.name;
  app.context.showPage = () => {};
  app.context.switchSource = source => { app.context.state.source = source; };
  app.run(read("presentation.js"));
  return { app, elements, focused: () => focused };
}

test("analysis exports use applied criteria, displayed candidates, original timestamp, and no raw data", () => {
  const { app } = presentationBrowser();
  app.context.result = reportFixture();
  app.context.context = { exportedAt: "2026-10-05T09:00:00.000Z", audioName: "clip.wav",
    language: "en", topN: 1, snapshotAvailable: true, view: { mode: "3d", zoom: 1.5 } };
  const report = app.run("analysisReport(result, context)");
  assert.equal(report.threshold, 0.5);
  assert.equal(report.min_gap, 0.05);
  assert.equal(report.elapsed_ms, 1234);
  assert.equal(report.completed_at, app.context.result.completed_at);
  assert.equal(report.candidates.length, 1);
  assert.equal(report.returned_candidates, 2);
  assert.equal(report.displayed_top_n, 1);
  assert.equal(report.spotlight.view.mode, "3d");
  assert.doesNotMatch(JSON.stringify(report), /must not export|"embedding"|"points"|"blob"/);
  app.context.result.audio.warnings.push("later");
  assert.equal(report.audio.warnings.length, 1);
  app.context.result.backend = "azure";
  app.context.result.speaker = null;
  app.context.result.reason = "empty_library";
  app.context.result.candidates = [];
  app.context.result.constellation = { available: false, reason: "azureProjectionStorage" };
  app.context.context.snapshotAvailable = false;
  const empty = app.run("analysisReport(result, context)");
  assert.equal(empty.backend, "azure");
  assert.equal(empty.outcome, "unknown");
  assert.equal(empty.spotlight.available, false);
  assert.equal(empty.spotlight.reason, "azureProjectionStorage");
  app.context.report = empty;
  assert.equal(app.run("analysisCSV(report)").split("\r\n").length, 3);
});

test("CSV exports quote delimiters and neutralize formula names without changing negative scores", () => {
  const { app } = presentationBrowser();
  for (const value of ['=CMD()', '+CMD()', '-CMD()', '@CMD()', '  =CMD()', '\tCMD()']) {
    app.context.cell = value;
    assert.match(app.run("csvCell(cell)"), /^"'/);
  }
  assert.equal(app.run("csvCell(-0.25)"), '"-0.25"');
  assert.equal(app.run('csvCell(\'a,"b"\\nc\')'), '"a,""b""\nc"');
  assert.equal(app.run("csvCell(null)"), '""');
  app.context.result = reportFixture();
  app.context.context = { language: "en", topN: 2, snapshotAvailable: false, audioName: "clip.wav" };
  const csv = app.run("analysisCSV(analysisReport(result, context))");
  assert.ok(csv.startsWith("\uFEFF"));
  assert.match(csv, /"cosine_similarity"/);
  assert.match(csv, /"'-?=HYPERLINK/);
  assert.match(csv, /"-0.05"/);
});

test("printable reports escape all user content and retain unavailable-map explanations", () => {
  const { app } = presentationBrowser();
  app.context.result = reportFixture();
  app.context.result.speaker.name = '<script>alert("speaker")</script>';
  app.context.result.candidates[0].name = '<img src=x onerror=alert(1)>';
  app.context.context = { language: "en", topN: 2, snapshotAvailable: false, audioName: "<svg/onload=alert(1)>" };
  app.run("var report = analysisReport(result, context)");
  const body = app.run("analysisReportBody(report, null)");
  assert.doesNotMatch(body, /<script|<img src=x|<svg\/onload/);
  assert.match(body, /&lt;script&gt;/);
  assert.match(body, /Spotlight snapshot unavailable/);
  assert.match(body, /1234 ms/);
  app.context.body = body;
  const html = app.run('analysisHTML(report, body, ":root { --cp-bg: white; }")');
  assert.match(html, /<!doctype html>/);
  assert.match(html, /lang="en"/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.doesNotMatch(html, /<script src=|<link[^>]*href=/);
});

test("export controls reject stale backends and lock during recording, requests, refresh, or export", () => {
  const { app } = presentationBrowser();
  assert.equal(app.run("canExportAnalysis()"), false);
  app.context.state.result = reportFixture();
  assert.equal(app.run("canExportAnalysis()"), true);
  for (const key of ["busy", "recording", "refreshing"]) {
    app.context.state[key] = true;
    assert.equal(app.run("canExportAnalysis()"), false);
    app.context.state[key] = false;
  }
  app.run("presentation.exporting = true");
  assert.equal(app.run("canExportAnalysis()"), false);
  app.run("presentation.exporting = false; preferences.set('backend', 'azure')");
  assert.equal(app.run("canExportAnalysis()"), false);
});

test("export failures are visible and unlock retry; asynchronous HTML keeps the captured analysis", async () => {
  const { app } = presentationBrowser();
  const failures = [], downloads = [], notices = [];
  app.context.state.result = reportFixture();
  app.context.$("audio-name").textContent = "original.wav";
  app.context.$("top-n").valueAsNumber = 1;
  app.context.validTopN = () => true;
  app.context.clearNotices = () => {};
  app.context.showError = error => failures.push(error);
  app.context.success = key => notices.push(key);
  app.context.spotlightSnapshot = () => null;
  app.context.downloadAnalysisFile = (content, type, filename) => downloads.push({ content, type, filename });
  app.context.request = async () => ({ ok: false });
  await app.run("exportAnalysis('html')");
  assert.equal(failures.at(-1).key, "reportExportError");
  assert.equal(downloads.length, 0);
  assert.equal(app.run("presentation.exporting"), false);
  assert.equal(app.context.$("export-html").disabled, false);
  app.context.request = async () => {
    app.context.state.result.threshold = 0.99;
    app.context.$("audio-name").textContent = "later.wav";
    app.context.state.result = null;
    app.run("preferences.set('language', 'fr')");
    return { ok: true, text: async () => read("documentation.css") };
  };
  await app.run("exportAnalysis('html')");
  assert.equal(downloads.length, 1);
  assert.match(downloads[0].content, /original\.wav/);
  assert.doesNotMatch(downloads[0].content, /later\.wav/);
  assert.match(downloads[0].content, /lang="en"/);
  assert.match(downloads[0].content, /<dd>0\.5<\/dd>/);
  assert.equal(app.context.$("export-html").disabled, true);
  assert.deepEqual(notices, ["reportDownloadRequested"]);
});

test("report download uses a named Blob attachment and releases its URL after the download starts", async () => {
  const { app } = presentationBrowser();
  let blob, clicked = false, removed = false, revoked = null;
  const timers = [];
  const anchor = { click() { clicked = true; }, remove() { removed = true; } };
  app.context.Blob = Blob;
  app.context.URL = class extends URL {
    static createObjectURL(value) { blob = value; return "blob:report"; }
    static revokeObjectURL(value) { revoked = value; }
  };
  app.context.setTimeout = (callback, delay) => { timers.push({ callback, delay }); };
  app.document.createElement = tag => { assert.equal(tag, "a"); return anchor; };
  app.document.body.append = element => assert.equal(element, anchor);
  app.run('downloadAnalysisFile("{\\"schema_version\\":1}", "application/json;charset=utf-8", "report.json")');
  assert.equal(clicked, true);
  assert.equal(removed, true);
  assert.equal(anchor.download, "report.json");
  assert.equal(anchor.href, "blob:report");
  assert.equal(JSON.parse(await blob.text()).schema_version, 1);
  assert.equal(blob.type, "application/json;charset=utf-8");
  assert.equal(revoked, null);
  assert.equal(timers[0].delay, 60000);
  timers[0].callback();
  assert.equal(revoked, "blob:report");
  assert.equal(app.run("presentation.downloads.size"), 0);
});

test("guided demo is explicit, skippable, reversible, localized and preserves session data", () => {
  const { app, focused } = presentationBrowser();
  const blob = {}, result = reportFixture();
  app.context.state.blob = blob;
  app.context.state.result = result;
  app.context.api = () => assert.fail("The guide must not call an API");
  app.context.identify = () => assert.fail("The guide must not analyze automatically");
  app.context.changeBackend = () => assert.fail("The guide must not switch backend automatically");
  app.run("startGuidedDemo()");
  assert.equal(app.run("presentation.tourStep"), 0);
  assert.equal(focused(), "guided-demo-title");
  app.run("moveGuidedDemo(1)");
  assert.equal(app.run("presentation.tourStep"), 0);
  app.run("showTourControl()");
  assert.equal(app.context.state.source, "test");
  assert.equal(focused(), "load-test-audio");
  assert.equal(app.context.state.blob, blob);
  assert.equal(app.context.state.result, result);
  app.run("moveGuidedDemo(1, true); moveGuidedDemo(1); moveGuidedDemo(1)");
  assert.equal(app.run("presentation.tourStep"), 3);
  assert.equal(app.run("tourStepComplete(3)"), false);
  app.context.demo.plot = {};
  app.context.demo.view.mode = "3d";
  assert.equal(app.run("tourStepComplete(3)"), true);
  app.run("preferences.set('language','fr'); renderGuidedDemo()");
  assert.match(app.context.$("guided-demo-step").textContent, /3D/);
  assert.equal(app.context.$("guided-demo-next").textContent, "Suivant");
  app.run("moveGuidedDemo(-1)");
  assert.equal(app.run("presentation.tourStep"), 2);
  app.context.state.busy = true;
  app.run("moveGuidedDemo(1); closeGuidedDemo()");
  assert.equal(app.run("presentation.tourStep"), null);
  assert.equal(app.context.state.busy, true);
  assert.equal(app.context.state.result, result);
  assert.equal(focused(), "guided-demo-start");
  for (const step of app.run("tourSteps")) {
    assert.ok(app.run(`Object.hasOwn(translations, '${step.title}')`));
    assert.ok(app.run(`Object.hasOwn(translations, '${step.description}')`));
  }
});

test("closing the guide during a request moves focus outside the hidden panel without cancelling work", () => {
  const { app, focused } = presentationBrowser();
  app.document.querySelector = selector => {
    assert.equal(selector, '[data-page="identify"]');
    return app.context.$("identification-navigation");
  };
  app.run("startGuidedDemo()");
  app.context.state.busy = true;
  app.run("renderPresentation(); closeGuidedDemo()");
  assert.equal(app.context.state.busy, true);
  assert.equal(app.context.$("guided-demo-panel").hidden, true);
  assert.equal(focused(), "identification-navigation");
});

test("constellation labels fit without overlapping and prioritize selected dots in crowded views", () => {
  const app = browser();
  app.run(read("demo.js"));
  const sparse = app.run(`placeConstellationLabels(
    [{x:100,y:100},{x:350,y:100},{x:100,y:300},{x:350,y:300}]
      .map((point,index)=>({...point,index,width:80,height:24,priority:2})), [], 500, 400)`);
  assert.equal(sparse.filter(Boolean).length, 4);
  const crowded = app.run(`placeConstellationLabels(
    Array.from({length:40},(_,index)=>({x:250,y:200,index,width:100,height:30,priority:index===39?0:2})),
    [{x:238,y:188,width:24,height:24}], 500,400)`);
  assert.ok(crowded[39]);
  assert.ok(crowded.filter(Boolean).length > 1 && crowded.filter(Boolean).length < 40);
  for (const boxes of [sparse, crowded]) {
    const visible = boxes.filter(Boolean);
    for (const [index, box] of visible.entries()) {
      assert.ok(box.x >= 8 && box.y >= 8 && box.x + box.width <= 492 && box.y + box.height <= 392);
      for (const other of visible.slice(index + 1)) {
        assert.ok(box.x + box.width <= other.x || other.x + other.width <= box.x
          || box.y + box.height <= other.y || other.y + other.height <= box.y);
      }
    }
  }
  assert.equal(app.run(`placeConstellationLabels(
    [{x:-10,y:100,index:0,width:80,height:24,priority:0}],[],500,400)[0]`), null);
});

test("the matched dot uses the accepted speaker's best sample rather than projected proximity or global score", () => {
  const app = browser();
  app.run(read("demo.js"));
  app.context.points = [
    { id: "accepted", sample_id: "near", x: 0, y: 0, score: .6 },
    { id: "accepted", sample_id: "best", x: 1, y: 1, score: .8 },
    { id: "another", sample_id: "higher", x: 0, y: 0, score: .9 },
    { id: "accepted", sample_id: "tied", x: -1, y: -1, score: .8 },
  ];
  assert.equal(app.run("bestConstellationSample(points, 'accepted')"), 1);
  assert.equal(app.run("bestConstellationSample(points, 'another')"), 2);
  assert.equal(app.run("bestConstellationSample(points, 'missing')"), -1);
  assert.equal(app.run("bestConstellationSample([], 'accepted')"), -1);
});

test("dot descriptions preserve signed cosine scores and omit unavailable values", () => {
  const app = browser();
  app.run(read("demo.js"));
  app.context.speakerName = point => point.name;
  assert.match(app.run("constellationPointDescription({name:'Alice',sample_id:'a',score:-0.123})"), /Alice.*-0.123/);
  app.run("preferences.set('language','fr')");
  assert.match(app.run("constellationPointDescription({name:'Alice',sample_id:'a',score:0.761})"), /Alice.*0,761/);
  assert.equal(app.run("constellationPointDescription({name:'Alice',sample_id:'a'})"),
    app.run("constellationPointLabel({name:'Alice',sample_id:'a'})"));
  assert.match(app.run("constellationPointDescription({name:'Alice',sample_id:'a',score:.761}, true)"),
    /Échantillon correspondant/);
  app.run("preferences.set('language', 'en')");
  assert.match(app.run("constellationPointDescription({name:'Alice',sample_id:'a',score:.761}, true)"),
    /Matched sample/);
  assert.doesNotMatch(app.run("constellationPointDescription({name:'Alice',sample_id:'a',score:.761}, false)"),
    /Matched sample/);
});

test("spotlight labels only top candidates and selected or hovered samples, including sparse indices", () => {
  const app = browser();
  app.run(read("demo.js"));
  const label = () => ({
    style: {}, setAttribute() {},
    getBBox: () => ({ x: 0, y: -10, width: 64, height: 24 }),
  });
  const points = Array.from({ length: 5 }, (_, index) => ({
    index, nearest: index === 4, label: label(), leader: label(), labelBounds: null,
  }));
  const layout = {
    points: [{ x: 70, y: 100 }, { x: 280, y: 100 }, { x: 490, y: 100 }, { x: 70, y: 330 }, { x: 490, y: 330 }],
    query: { x: 310, y: 260 },
  };
  app.context.plot = { points, map: { points: points.map(point => ({ sample_id: `sample-${point.index}` })) },
    query: { querySelector: label } };
  app.context.layout = layout;
  app.run("demo.plot = plot; updateConstellationLabels(layout, 760, 450)");
  const visible = () => points.filter(point => point.label.style.visibility === "visible").map(point => point.index);
  assert.deepEqual(visible(), [4]);
  app.run("demo.selectedPoint = 'sample-1'; demo.hoveredPoint = 'sample-2'; updateConstellationLabels(layout, 760, 450)");
  assert.deepEqual(visible(), [1, 2, 4]);
  app.run("demo.hoveredPoint = null; updateConstellationLabels(layout, 760, 450)");
  assert.deepEqual(visible(), [1, 4]);
  app.run("demo.selectedPoint = 'sample-4'; updateConstellationLabels(layout, 760, 450)");
  assert.deepEqual(visible(), [4]);
});

test("invalid coordinates or 3D variance are reported explicitly instead of inventing depth", () => {
  for (const invalid of ["x", "z", "variance3d"]) {
    const app = browser();
    app.run(read("demo.js"));
    const elements = new Map();
    app.context.$ = id => {
      if (!elements.has(id)) elements.set(id, { replaceChildren() {} });
      return elements.get(id);
    };
    app.context.renderMapControls = () => {};
    const map = {
      available: true, query: { x: 0, y: 0, z: 0 }, points: [{ x: 1, y: 1, z: 1 }],
      explained_variance: .1, explained_variance_3d: .2,
    };
    if (invalid === "variance3d") map.explained_variance_3d = NaN;
    else map.points[0][invalid] = NaN;
    map.backend = "qdrant";
    app.context.state = { result: { backend: "qdrant", constellation: map } };
    app.run("renderConstellation()");
    assert.equal(app.run("demo.plot"), null);
    assert.equal(elements.get("constellation-content").hidden, true);
    assert.equal(elements.get("constellation-retry").hidden, false);
    assert.equal(app.warnings.length, 1);
    assert.match(elements.get("constellation-status").textContent, /could not be computed/);
  }
});

test("background validation rejects unsupported, oversized and undecodable images", async () => {
  const app = browser();
  app.run(read("appearance.js"));
  app.context.createImageBitmap = async () => ({ width: 1920, height: 1080, close() {} });
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    await app.run(`validateBackground({ type: '${type}', size: 1000 })`);
  }
  for (const file of [{ type: "image/svg+xml", size: 100 }, { type: "image/png", size: 0 },
    { type: "image/jpeg", size: 8388609 }]) {
    await assert.rejects(app.run(`validateBackground(${JSON.stringify(file)})`), { key: "backgroundInvalid" });
  }
  let closed = false;
  app.context.createImageBitmap = async () => ({ width: 5000, height: 5000, close() { closed = true; } });
  await assert.rejects(app.run("validateBackground({ type: 'image/png', size: 100 })"), { key: "backgroundInvalid" });
  assert.ok(closed);
  app.context.createImageBitmap = async () => { throw new DOMException("Bad image", "InvalidStateError"); };
  await assert.rejects(app.run("validateBackground({ type: 'image/png', size: 100 })"), { key: "backgroundInvalid" });
  assert.ok(app.warnings.length);
  await assert.rejects(app.run("backgroundStorage('read')"), { key: "backgroundStorageError" });
});

test("all public backend audio and profile errors and warnings have translations", () => {
  const keys = browser().run("new Set(Object.values(translations).map(values => values[0]))");
  const engine = fs.readFileSync(path.join(root, "engine.py"), "utf8");
  for (const match of engine.matchAll(/raise (?:AudioError|KeyError)\("([^"]+)"\)/g)) {
    assert.ok(keys.has(match[1]), match[1]);
  }
  for (const message of [
    "That speaker name already exists. Choose a different name.",
    "Enter a speaker name of 1-60 characters without control characters.",
    "Bundled reference speakers cannot be deleted from the app.",
    "Audio may be clipped. Try a lower recording level.",
  ]) assert.ok(keys.has(message), message);
});

test("switching languages updates errors and locale-aware numbers", () => {
  const app = browser();
  app.run("var error = new LocalizedError('connectionError', { message: new LocalizedError('networkError') })");
  assert.match(app.run("errorText(error)"), /Cannot load/);
  app.run("preferences.set('language', 'fr')");
  assert.match(app.run("errorText(error)"), /Impossible de charger.*Impossible de joindre/);
  assert.equal(app.run("number(0.761, 3)"), "0,761");
  assert.match(app.run("translatedServerMessage('That speaker name already exists. Choose a different name.')"), /Ce nom existe/);
  assert.throws(() => app.run("t('missing')"), /Missing translation/);
  assert.throws(() => app.run("t('bundledName')"), /Missing translation parameter/);
});

function colorsFor(palette, mode) {
  const variables = {};
  const selectors = new Set([":root", `html[data-theme="${mode}"]`, `html[data-palette="${palette}"]`,
    `html[data-theme="${mode}"][data-palette="${palette}"]`]);
  for (const [, selector, body] of read("styles.css").matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!selectors.has(selector.trim())) continue;
    for (const [, key, value] of body.matchAll(/(--cp-[\w-]+):\s*(#[0-9a-f]{6})/g)) variables[key] = value;
  }
  return variables;
}

function contrast(a, b) {
  const luminance = (hex) => {
    const [r, g, b] = hex.slice(1).match(/../g).map((pair) => {
      const value = parseInt(pair, 16) / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

test("all eight palette/mode combinations meet 4.5:1 primary and body text contrast", () => {
  for (const palette of ["rose", "ocean", "forest", "amber"]) {
    for (const mode of ["light", "dark"]) {
      const colors = colorsFor(palette, mode);
      for (const [foreground, background] of [
        ["--cp-accent-fg", "--cp-accent"], ["--cp-accent", "--cp-surface"], ["--cp-text", "--cp-bg"],
      ]) {
        assert.ok(contrast(colors[foreground], colors[background]) >= 4.5, `${palette}/${mode}: ${foreground}/${background}`);
      }
    }
  }
});
