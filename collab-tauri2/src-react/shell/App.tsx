import { useState } from "react";
import TerminalTile from "@/tiles/TerminalTile";
import { TileManager, Tile, TileType } from "@/tiles/TileManager";
import { useTranslation, SupportedLocale } from "@/settings/translations";

const tileManager = new TileManager();

export default function App() {
  const [tiles, setTiles] = useState<Tile[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [locale, setLocale] = useState<SupportedLocale>("en");
  const [theme, setTheme] = useState<string>("system");
  const { t } = useTranslation(locale);

  const addTile = (type: TileType) => {
    const tile = tileManager.create(type);
    setTiles((prev) => [...prev, tile]);
  };

  const removeTile = (id: string) => {
    tileManager.remove(id);
    setTiles((prev) => prev.filter((t) => t.id !== id));
  };

  if (showSettings) {
    return (
      <div className="flex h-screen w-screen flex-col bg-gray-900 text-white">
        <header className="flex items-center gap-2 border-b border-gray-700 px-4 py-2">
          <button
            onClick={() => setShowSettings(false)}
            className="rounded bg-gray-700 px-3 py-1 text-sm hover:bg-gray-600"
          >
            &larr; Back
          </button>
          <h1 className="text-lg font-bold">{t("settings")}</h1>
        </header>
        <main className="flex-1 p-6">
          <section className="space-y-6">
            <div>
              <h2 className="text-lg font-semibold">{t("appearance")}</h2>
              <div className="mt-2 space-y-2">
                <label className="text-sm">{t("theme")}</label>
                <div className="flex gap-2">
                  {["light", "dark", "system"].map((t) => (
                    <button
                      key={t}
                      onClick={() => setTheme(t)}
                      className={`rounded px-3 py-1 text-sm ${
                        theme === t ? "bg-blue-600" : "bg-gray-700"
                      }`}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-4 space-y-2">
                <label className="text-sm">{t("language")}</label>
                <select
                  value={locale}
                  onChange={(e) => setLocale(e.target.value as SupportedLocale)}
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
    <div className="flex h-screen w-screen flex-col bg-gray-900 text-white">
      <header className="flex items-center gap-2 border-b border-gray-700 px-4 py-2">
        <button
          onClick={() => addTile("terminal")}
          className="rounded bg-blue-600 px-3 py-1 text-sm hover:bg-blue-700"
        >
          + Terminal
        </button>
        <button
          onClick={() => setShowSettings(true)}
          className="ml-auto rounded bg-gray-700 px-3 py-1 text-sm hover:bg-gray-600"
        >
          {t("settings")}
        </button>
      </header>
      <main className="flex flex-1 gap-2 p-2 overflow-hidden">
        {tiles.map((tile) => (
          <div
            key={tile.id}
            className="relative flex-1 min-w-0 rounded border border-gray-700"
          >
            <button
              onClick={() => removeTile(tile.id)}
              className="absolute right-2 top-2 z-10 rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600"
            >
              x
            </button>
            {tile.type === "terminal" && (
              <TerminalTile tileId={tile.id} cwd={tile.cwd} />
            )}
          </div>
        ))}
        {tiles.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-gray-500">
            <p>No tiles open. Click &quot;+ Terminal&quot; to start.</p>
          </div>
        )}
      </main>
    </div>
  );
}
