const QUERY = "(prefers-color-scheme: dark)";

function sync(): void {
  const isDark = window.matchMedia(QUERY).matches;
  document.documentElement.classList.toggle("dark", isDark);
}

export function initDarkMode(): void {
  sync();
  window.matchMedia(QUERY).addEventListener("change", sync);
}
