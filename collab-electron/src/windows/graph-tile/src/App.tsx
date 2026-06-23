import { useEffect, useState } from "react";
import { WorkspaceGraph } from "@collab/components/WorkspaceGraph";

function App() {
  const [params] = useState(() => {
    const p = new URLSearchParams(window.location.search);
    return {
      folderPath: p.get("folder") ?? "",
      workspacePath: p.get("workspace") ?? "",
    };
  });
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light",
  );
  const [scopePath, setScopePath] = useState(params.folderPath);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) =>
      setTheme(e.matches ? "dark" : "light");
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    if (typeof window.api.onScopeChanged !== "function") return;
    return window.api.onScopeChanged((newPath: string) => {
      setScopePath(newPath);
    });
  }, []);

  if (!params.workspacePath) {
    return (
      <div style={{ color: "var(--muted-foreground)", padding: 16 }}>
        No workspace
      </div>
    );
  }

  return (
    <WorkspaceGraph
      workspacePath={params.workspacePath}
      scopePath={scopePath}
      theme={theme}
      onSelectFile={(path) => window.api.selectFile(path)}
    />
  );
}

export default App;
