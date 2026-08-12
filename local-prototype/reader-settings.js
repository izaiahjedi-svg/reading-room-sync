(function () {
  const root = document.documentElement;
  const content = document.getElementById("reader-content");
  const fontSize = document.getElementById("font-size");
  const lineHeight = document.getElementById("line-height");
  const fontFamily = document.getElementById("font-family");
  const themeSelect = document.getElementById("theme-select");
  const fontSizeValue = document.getElementById("font-size-value");
  const lineHeightValue = document.getElementById("line-height-value");
  const tapZone = document.getElementById("readerTapZone");
  const settingsToggle = document.getElementById("settingsToggle");
  const settingsPanel = document.getElementById("settingsPanel");
  const mobileHint = document.getElementById("mobileHint");
  const SETTINGS_KEY = "rrPrototypeReaderSettings";

  let lastTapAt = 0;

  function isMobile() {
    return window.matchMedia("(max-width: 920px)").matches;
  }

  function setControlsVisible(value) {
    if (value) {
      root.classList.add("controls-visible");
    } else {
      root.classList.remove("controls-visible");
    }
  }

  function hideHint() {
    if (!mobileHint) return;
    mobileHint.classList.add("is-hidden");
  }

  function initControlsState() {
    if (isMobile()) {
      setControlsVisible(false);
      settingsPanel.classList.add("collapsed");
    } else {
      setControlsVisible(true);
      settingsPanel.classList.add("collapsed");
      hideHint();
    }
  }

  function saveSettings() {
    const payload = {
      fontSize: fontSize.value,
      lineHeight: lineHeight.value,
      fontFamily: fontFamily.value,
      theme: themeSelect.value
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(payload));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved.fontSize) fontSize.value = saved.fontSize;
      if (saved.lineHeight) lineHeight.value = saved.lineHeight;
      if (saved.fontFamily) fontFamily.value = saved.fontFamily;
      if (saved.theme) themeSelect.value = saved.theme;
    } catch {
    }
  }

  function apply() {
    content.style.fontSize = fontSize.value + "px";
    content.style.lineHeight = lineHeight.value;
    content.style.fontFamily = fontFamily.value;
    fontSizeValue.textContent = fontSize.value + "px";
    lineHeightValue.textContent = lineHeight.value;
    document.body.setAttribute("data-reader-theme", themeSelect.value);
    saveSettings();
  }

  [fontSize, lineHeight, fontFamily, themeSelect].forEach((el) => {
    el.addEventListener("input", apply);
    el.addEventListener("change", apply);
  });

  tapZone.addEventListener("pointerdown", (event) => {
    if (!isMobile()) return;
    if (event.target.closest(".reader-v2-rail") || event.target.closest(".reader-v2-bottom") || event.target.closest(".reader-chapter-panel") || event.target.closest(".reader-settings-popup")) {
      return;
    }

    const now = Date.now();
    const delta = now - lastTapAt;
    lastTapAt = now;

    if (delta > 45 && delta < 360) {
      const nextVisible = !root.classList.contains("controls-visible");
      setControlsVisible(nextVisible);
      hideHint();
      if (!nextVisible) {
        settingsPanel.classList.add("collapsed");
      }
    }
  });

  settingsToggle.addEventListener("click", () => {
    settingsPanel.classList.toggle("collapsed");
  });

  document.addEventListener("pointerdown", (event) => {
    if (settingsPanel.classList.contains("collapsed")) return;
    if (event.target.closest("#settingsPanel") || event.target.closest("#settingsToggle")) return;
    settingsPanel.classList.add("collapsed");
  });

  window.addEventListener("resize", initControlsState);

  loadSettings();
  initControlsState();
  apply();
})();
