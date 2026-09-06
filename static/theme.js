// Apply before the stylesheet loads to avoid flashing the wrong theme.
window.appTheme = (() => {
  const storageKey = "diskuse.theme";
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  const normalize = (value) => ["auto", "dark", "light"].includes(value) ? value : "auto";
  let preference = "auto";
  try {
    preference = normalize(localStorage.getItem(storageKey));
  } catch (_) {
    // Appearance still works when browser storage is unavailable.
  }

  function apply() {
    document.documentElement.dataset.theme =
      preference === "auto" ? (systemTheme.matches ? "dark" : "light") : preference;
    window.dispatchEvent(new Event("themechange"));
  }

  systemTheme.addEventListener("change", () => {
    if (preference === "auto") apply();
  });
  window.addEventListener("storage", (event) => {
    if (event.key === storageKey || event.key === null) {
      preference = normalize(event.newValue);
      apply();
    }
  });
  apply();

  return {
    get preference() { return preference; },
    set(value) {
      preference = normalize(value);
      let saved = true;
      try {
        localStorage.setItem(storageKey, preference);
      } catch (_) {
        saved = false;
      }
      apply();
      return saved;
    },
  };
})();
