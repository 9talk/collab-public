import { createRoot } from "react-dom/client";
import { initDarkMode } from "@collab/shared/dark-mode";
import "./styles/Theme.css";
import "@collab/components/Markdown/MarkdownContent.css";
import { AnalyticsProvider } from "../../shared/PostHogProvider";

// BlockNote captures console.warn during module initialization, so install the
// filter before dynamically importing the editor-heavy viewer tree.
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => {
  if (typeof args[0] === "string" && args[0].startsWith("linkifyjs:")) {
    return;
  }
  originalWarn(...args);
};

// Buffer file-selected events that arrive before React mounts.
// Viewer is lazily created: dom-ready fires before dynamic import resolves,
// so the App's onFileSelected useEffect hasn't registered yet.
// Store the path and an unsubscribe handle so App can clean up on mount.
(window as any).__viewerPendingPath = undefined;
const bufferUnsub = window.api.onFileSelected((path) => {
  (window as any).__viewerPendingPath = path;
});
(window as any).__viewerBufferUnsub = bufferUnsub;

async function bootstrap(): Promise<void> {
  const { default: App } = await import("./App");

  initDarkMode();

  const isWindows = window.api.getPlatform() === "win32";
  document.documentElement.classList.toggle("platform-win", isWindows);
  document.body.classList.toggle("platform-win", isWindows);

  const root = document.getElementById("root");
  if (!root) throw new Error("Missing #root element");

  // BlockNote currently triggers React 19 dev-mode flushSync warnings under
  // StrictMode, so keep the viewer outside StrictMode until the dependency is fixed.
  createRoot(root).render(
    <AnalyticsProvider>
      <App />
    </AnalyticsProvider>,
  );
}

void bootstrap();
