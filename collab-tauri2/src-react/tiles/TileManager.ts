export type TileType = "terminal" | "viewer" | "graph" | "browser";

export interface Tile {
  id: string;
  type: TileType;
  cwd?: string;
}

export class TileManager {
  private tiles: Map<string, Tile> = new Map();

  create(type: TileType, cwd?: string): Tile {
    const id = `tile_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const tile: Tile = { id, type, cwd };
    this.tiles.set(id, tile);
    return tile;
  }

  remove(id: string): void {
    this.tiles.delete(id);
  }

  get(id: string): Tile | undefined {
    return this.tiles.get(id);
  }

  getAll(): Tile[] {
    return Array.from(this.tiles.values());
  }
}
