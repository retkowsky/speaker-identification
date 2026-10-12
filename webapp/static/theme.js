(() => {
  const param = new URLSearchParams(window.location.search).get("scoutTheme");
  const theme =
    param || (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  document.documentElement.setAttribute("data-theme", theme);
})();
const preferences = (() => {
  const palettes = ["amber", "forest", "ocean", "rose"];
  const modes = ["light", "dark"];
  const languages = ["en", "fr"];
  const fonts = ["arial", "calibri", "consolas", "georgia", "segoe", "tahoma", "times", "verdana"];
  const backends = ["qdrant", "azure"];
  const errors = [];
  function read(key) {
    try {
      return localStorage.getItem(`voiceprint.${key}`);
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      console.warn("Browser preference storage is unavailable.", error);
      errors.push(error);
      return null;
    }
  }
  const queryMode = new URLSearchParams(location.search).get("scoutTheme");
  const savedMode = read("mode");
  const savedPalette = read("palette");
  const savedLanguage = read("language");
  const savedFont = read("font");
  const savedBackend = read("backend");
  const savedWidth = Number(read("sidebarWidth"));
  const validWidth = (value) => Number.isInteger(value) && value >= 160 && value <= 420;
  const values = {
    mode: modes.includes(queryMode) ? queryMode : modes.includes(savedMode) ? savedMode
      : matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light",
    palette: palettes.includes(savedPalette) ? savedPalette : "ocean",
    language: languages.includes(savedLanguage) ? savedLanguage
      : navigator.language.toLowerCase().startsWith("fr") ? "fr" : "en",
    font: fonts.includes(savedFont) ? savedFont : "tahoma",
    backend: backends.includes(savedBackend) ? savedBackend : "qdrant",
    sidebarWidth: validWidth(savedWidth) ? savedWidth : 220,
  };
  function apply() {
    document.documentElement.dataset.theme = values.mode;
    document.documentElement.dataset.palette = values.palette;
    document.documentElement.lang = values.language;
    document.documentElement.dataset.font = values.font;
    document.documentElement.style.setProperty("--sidebar-width", `${values.sidebarWidth}px`);
  }
  function set(key, value) {
    const allowed = { mode: modes, palette: palettes, language: languages, font: fonts, backend: backends };
    if (key === "sidebarWidth" ? !validWidth(value) : !allowed[key]?.includes(value)) {
      throw new RangeError(`Invalid preference: ${key}=${value}`);
    }
    values[key] = value;
    apply();
    if (key === "mode") {
      const url = new URL(location.href);
      if (url.searchParams.has("scoutTheme")) {
        url.searchParams.set("scoutTheme", value);
        history.replaceState(null, "", url);
      }
    }
    try {
      localStorage.setItem(`voiceprint.${key}`, value);
      return true;
    } catch (error) {
      if (!(error instanceof DOMException)) throw error;
      console.warn("Could not save browser preference.", error);
      return false;
    }
  }
  function setTheme(value) {
    const choice = /^([a-z]+)-(light|dark)$/.exec(value);
    if (!choice || !palettes.includes(choice[1])) throw new RangeError(`Invalid theme: ${value}`);
    const paletteSaved = set("palette", choice[1]);
    const modeSaved = set("mode", choice[2]);
    return paletteSaved && modeSaved;
  }
  apply();
  return { values, set, setTheme, storageUnavailable: errors.length > 0 };
})();
