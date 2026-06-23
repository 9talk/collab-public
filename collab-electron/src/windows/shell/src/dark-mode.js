/**
 * Dark mode detection and canvas opacity management.
 */

export function initDarkMode(onThemeChange) {
  const query = "(prefers-color-scheme: dark)";
  function sync() {
    document.documentElement.classList.toggle(
      "dark",
      window.matchMedia(query).matches,
    );
  }
  sync();
  window.matchMedia(query).addEventListener("change", () => {
    sync();
    onThemeChange();
  });
}

export function applyCanvasOpacity(percent) {
  const clamped = Math.max(0, Math.min(100, Number(percent) || 0));
  document.documentElement.style.setProperty(
    "--canvas-opacity",
    String(clamped / 100),
  );
}
