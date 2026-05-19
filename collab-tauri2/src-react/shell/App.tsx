import { useState, useEffect } from "react";
import TerminalTile from "@/tiles/TerminalTile";
import ViewerTile from "@/tiles/ViewerTile";
import BrowserTile from "@/tiles/BrowserTile";
import { TileManager, Tile, TileType } from "@/tiles/TileManager";
import { useTranslation, SupportedLocale } from "@/settings/translations";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const tileManager = new TileManager();

const TILE_LABELS: Record<TileType, string> = {
  terminal: "+ Terminal",
  viewer: "+ File",
  browser: "+ Browser",
  graph: "+ Graph",
  "agent-chat": "+ Agent",
};

export default function App() {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [locale, setLocale] = useState<SupportedLocale>("en");
  const [theme, setTheme] = useState<string>("system");
  const { t } = useTranslation(locale);

  // Load saved preferences on startup
  useEffect(() => {
    Promise.all([
      invoke("pref_get", { key: "locale" }),
      invoke("pref_get", { key: "theme" }),
    ]).then(([savedLocale, savedTheme]) => {
      if (savedLocale && typeof savedLocale === "string") {
        setLocale(savedLocale as SupportedLocale);
      }
      if (savedTheme && typeof savedTheme === "string") {
        setTheme(savedTheme);
      }
    }).catch((e) => console.error("[App] Failed to load prefs:", e));
  }, []);

  // Listen for menu actions
  useEffect(() => {
    const unlisten = listen("menu:action", (event) => {
      const action = event.payload as string;
      switch (action) {
        case "new-tile":
          addTile("terminal");
          break;
        case "close-tile":
          if (tiles.length > 0) removeTile(tiles[tiles.length - 1].id);
          break;
        case "toggle-files":
          addTile("viewer");
          break;
        case "toggle-agent":
          addTile("agent-chat");
          break;
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [tiles]);

  // Listen for preference changes
  useEffect(() => {
    const unlisten = listen("pref:changed", (event) => {
      const payload = event.payload as { key: string; value: unknown };
      if (payload.key === "theme" && typeof payload.value === "string") {
        setTheme(payload.value);
      } else if (payload.key === "locale" && typeof payload.value === "string") {
        setLocale(payload.value as SupportedLocale);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, []);

  const addTile = (type: TileType) => {
    const tile = tileManager.create(type);
    setTiles((prev) => [...prev, tile]);
  };

  const removeTile = (id: string) => {
    tileManager.remove(id);
    setTiles((prev) => prev.filter((t) => t.id !== id));
  };

  const handleThemeChange = async (newTheme: string) => {
    setTheme(newTheme);
    try {
      await invoke("pref_set", { key: "theme", value: newTheme });
    } catch (e) {
      console.error("[App] Failed to save theme:", e);
    }
  };

  const handleLocaleChange = async (newLocale: SupportedLocale) => {
    setLocale(newLocale);
    try {
      await invoke("pref_set", { key: "locale", value: newLocale });
    } catch (e) {
      console.error("[App] Failed to save locale:", e);
    }
  };

  // Compute theme-aware styles
  const bgStyle = theme === "light"
    ? { backgroundColor: "#f3f4f6", color: "#111827" }
    : { backgroundColor: "#111827", color: "#ffffff" };
  const headerBorder = theme === "light"
    ? "#d1d5db"
    : "#374151";
  const tileBorder = theme === "light"
    ? "#d1d5db"
    : "#374151";
  const emptyColor = theme === "light"
    ? "#9ca3af"
    : "#6b7280";
  const btnStyle = (active: boolean) => ({
    borderRadius: "4px",
    padding: "4px 10px",
    fontSize: "13px",
    backgroundColor: active ? "#2563eb" : (theme === "light" ? "#d1d5db" : "#374151"),
    color: active ? "#fff" : bgStyle.color,
  });

  if (showSettings) {
    const settingsBgStyle = theme === "light"
      ? { backgroundColor: "#f3f4f6", color: "#111827" }
      : { backgroundColor: "#111827", color: "#ffffff" };
    const settingsHeaderBorder = theme === "light" ? "#d1d5db" : "#374151";

    return (
      <div style={{ ...settingsBgStyle, height: "100vh", width: "100vw", display: "flex", flexDirection: "column" }}>
        <header style={{ display: "flex", alignItems: "center", gap: "8px", borderBottom: `1px solid ${settingsHeaderBorder}`, padding: "8px 16px" }}>
          <button
            onClick={() => setShowSettings(false)}
            style={{ borderRadius: "4px", padding: "4px 12px", fontSize: "14px", backgroundColor: theme === "light" ? "#d1d5db" : "#374151", color: settingsBgStyle.color }}
          >
            &larr; {t("settings")}
          </button>
        </header>
        <main style={{ flex: "1", padding: "24px" }}>
          <section className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">{t("appearance")}</h2>
              <div className="mt-2 space-y-2">
                <label className="text-sm">{t("theme")}</label>
                <div className="flex gap-2">
                  {["light", "dark", "system"].map((th) => (
                    <button
                      key={th}
                      onClick={() => handleThemeChange(th)}
                      style={{
                        borderRadius: "4px",
                        padding: "4px 12px",
                        fontSize: "14px",
                        backgroundColor: theme === th
                          ? (th === "light" ? "#e5e7eb" : "#2563eb")
                          : "#374151",
                        color: theme === th && th === "light" ? "#111827" : "#ffffff",
                      }}
                    >
                      {t(th as keyof typeof t)}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <label className="text-sm">{t("language")}</label>
                <select
                  value={locale}
                  onChange={(e) => handleLocaleChange(e.target.value as SupportedLocale)}
                  className="rounded bg-gray-700 px-3 py-1 text-sm"
                >
                  <option value="en">English</option>
                  <option value="zh">中文</option>
                </select>
              </div>
            </div>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div style={{ ...bgStyle, height: "100vh", width: "100vw", display: "flex", flexDirection: "column" }}>
      <header style={{ display: "flex", alignItems: "center", gap: "6px", borderBottom: `1px solid ${headerBorder}`, padding: "6px 16px" }}>
        {(["terminal", "viewer", "browser", "agent-chat"] as TileType[]).map((type) => (
          <button
            key={type}
            onClick={() => addTile(type)}
            style={btnStyle(false)}
          >
            {TILE_LABELS[type]}
          </button>
        ))}
        <button
          onClick={() => setShowSettings(true)}
          style={{ marginLeft: "auto", ...btnStyle(false) }}
        >
          {t("settings")}
        </button>
      </header>
      <main style={{ display: "flex", flex: "1", gap: "8px", padding: "8px", overflow: "hidden" }}>
        {tiles.map((tile) => (
          <div
            key={tile.id}
            style={{ position: "relative", flex: "1", minWidth: "0", borderRadius: "4px", border: `1px solid ${tileBorder}`, overflow: "hidden" }}
          >
            <button
              onClick={() => removeTile(tile.id)}
              style={{ position: "absolute", right: "8px", top: "8px", zIndex: "10", borderRadius: "4px", padding: "2px 8px", fontSize: "12px", backgroundColor: theme === "light" ? "#d1d5db" : "#374151", color: bgStyle.color }}
            >
              x
            </button>
            {tile.type === "terminal" && (
              <TerminalTile tileId={tile.id} cwd={tile.cwd} />
            )}
            {tile.type === "viewer" && (
              <ViewerTile tileId={tile.id} filePath={tile.filePath} />
            )}
            {tile.type === "browser" && (
              <BrowserTile tileId={tile.id} url={tile.url} />
            )}
            {tile.type === "agent-chat" && (
              <div className="flex h-full items-center justify-center text-sm opacity-50">
                Agent chat — coming soon
              </div>
            )}
            {tile.type === "graph" && (
              <div className="flex h-full items-center justify-center text-sm opacity-50">
                Graph tile — coming soon
              </div>
            )}
          </div>
        ))}
        {tiles.length === 0 && (
          <div style={{ display: "flex", flex: "1", alignItems: "center", justifyContent: "center", color: emptyColor }}>
            <p>No tiles open. Click a button above to start.</p>
          </div>
        )}
      </main>
    </div>
  );
}
