import { useState } from "react";
import TerminalTile from "@/tiles/TerminalTile";
import { TileManager, Tile, TileType } from "@/tiles/TileManager";

const tileManager = new TileManager();

export default function App() {
  const [tiles, setTiles] = useState<Tile[]>([]);

  const addTile = (type: TileType) => {
    const tile = tileManager.create(type);
    setTiles((prev) => [...prev, tile]);
  };

  const removeTile = (id: string) => {
    tileManager.remove(id);
    setTiles((prev) => prev.filter((t) => t.id !== id));
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-gray-900 text-white">
      <header className="flex items-center gap-2 border-b border-gray-700 px-4 py-2">
        <button
          onClick={() => addTile("terminal")}
          className="rounded bg-blue-600 px-3 py-1 text-sm hover:bg-blue-700"
        >
          + Terminal
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
