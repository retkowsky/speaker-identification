"use strict";

const appearance = { url: null, busy: true };

function renderAppearance() {
  $("background-import").textContent = t(appearance.url ? "backgroundChange" : "backgroundImport");
  $("background-import").disabled = appearance.busy;
  $("background-remove").disabled = appearance.busy || !appearance.url;
}

function backgroundStorage(operation, file = null) {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new LocalizedError("backgroundStorageError")); return; }
    const open = indexedDB.open("speaker-identification-appearance", 1);
    let blocked = false;
    open.onupgradeneeded = () => open.result.createObjectStore("images");
    open.onerror = () => reject(open.error);
    open.onblocked = () => { blocked = true; reject(new LocalizedError("backgroundStorageError")); };
    open.onsuccess = () => {
      const db = open.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => db.close();
      const transaction = db.transaction("images", operation === "read" ? "readonly" : "readwrite");
      const store = transaction.objectStore("images");
      const request = operation === "read" ? store.get("background")
        : operation === "write" ? store.put(file, "background") : store.delete("background");
      transaction.oncomplete = () => { db.close(); resolve(request.result ?? null); };
      transaction.onabort = () => { db.close(); reject(transaction.error || request.error || new LocalizedError("backgroundStorageError")); };
      transaction.onerror = () => { console.error("Background image storage failed.", transaction.error); };
    };
  });
}

async function validateBackground(file) {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || !file.size || file.size > 8 * 1024 * 1024) {
    throw new LocalizedError("backgroundInvalid");
  }
  let image;
  try { image = await createImageBitmap(file); }
  catch (error) {
    console.error("Background image decoding failed.", error);
    throw new LocalizedError("backgroundInvalid");
  }
  const valid = image.width <= 8192 && image.height <= 8192 && image.width * image.height <= 20000000;
  image.close();
  if (!valid) throw new LocalizedError("backgroundInvalid");
}

function applyBackground(file) {
  const previous = appearance.url;
  appearance.url = file ? URL.createObjectURL(file) : null;
  if (appearance.url) {
    document.documentElement.style.setProperty("--app-background", `url("${appearance.url}")`);
    document.body.classList.add("has-background");
  } else {
    document.documentElement.style.removeProperty("--app-background");
    document.body.classList.remove("has-background");
  }
  if (previous) URL.revokeObjectURL(previous);
  renderAppearance();
}

async function changeBackground(file) {
  if (appearance.busy) return;
  appearance.busy = true;
  renderAppearance();
  clearNotices();
  try {
    if (file) await validateBackground(file);
    try { await backgroundStorage(file ? "write" : "delete", file); }
    catch (error) {
      console.error("Could not save the background image.", error);
      throw new LocalizedError("backgroundStorageError");
    }
    applyBackground(file);
    if (!file) success("backgroundRemoved");
  } catch (error) { showError(error); }
  finally { appearance.busy = false; renderAppearance(); }
}

function initializeSplitter() {
  const splitter = $("sidebar-resizer");
  let drag = null;
  function resize(width, persist = false) {
    width = Math.max(160, Math.min(420, Math.round(width)));
    document.documentElement.style.setProperty("--sidebar-width", `${width}px`);
    splitter.setAttribute("aria-valuenow", String(width));
    if (persist && !preferences.set("sidebarWidth", width)) showError(new LocalizedError("storageError"));
  }
  resize(preferences.values.sidebarWidth);
  splitter.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || matchMedia("(max-width: 950px)").matches) return;
    event.preventDefault();
    splitter.focus();
    drag = { x: event.clientX, width: $("sidebar").getBoundingClientRect().width };
    splitter.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-sidebar");
  });
  splitter.addEventListener("pointermove", (event) => {
    if (drag) resize(drag.width + event.clientX - drag.x);
  });
  function finish() {
    if (!drag) return;
    drag = null;
    document.body.classList.remove("resizing-sidebar");
    resize(Number(splitter.getAttribute("aria-valuenow")), true);
  }
  splitter.addEventListener("pointerup", finish);
  splitter.addEventListener("pointercancel", finish);
  splitter.addEventListener("lostpointercapture", finish);
  splitter.addEventListener("keydown", (event) => {
    const current = Number(splitter.getAttribute("aria-valuenow"));
    const widths = { ArrowLeft: current - 8, ArrowRight: current + 8, Home: 160, End: 420 };
    if (!Object.hasOwn(widths, event.key)) return;
    event.preventDefault();
    resize(widths[event.key], true);
  });
  splitter.addEventListener("dblclick", () => resize(220, true));
}

function initializeToolbarMenu(menuId, toggleId) {
  const menu = $(menuId);
  document.addEventListener("pointerdown", event => {
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape" && menu.open) {
      event.preventDefault();
      menu.open = false;
      $(toggleId).focus();
    }
  });
}

async function initializeAppearance() {
  initializeToolbarMenu("appearance-menu", "appearance-toggle");
  initializeToolbarMenu("criteria-menu", "criteria-toggle");
  initializeSplitter();
  $("background-import").addEventListener("click", () => $("background-input").click());
  $("background-input").addEventListener("change", (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (file) void changeBackground(file);
  });
  $("background-remove").addEventListener("click", () => { void changeBackground(null); });
  try {
    const file = await backgroundStorage("read");
    if (file) { await validateBackground(file); applyBackground(file); }
  } catch (error) {
    console.error("Could not restore the background image.", error);
    showError(error instanceof LocalizedError ? error : new LocalizedError("backgroundStorageError"));
  } finally { appearance.busy = false; renderAppearance(); }
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted && appearance.url) URL.revokeObjectURL(appearance.url);
  });
}
