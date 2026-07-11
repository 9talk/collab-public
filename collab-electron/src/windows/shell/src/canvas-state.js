/**
 * @typedef {'term' | 'note' | 'code' | 'image' | 'graph' | 'browser' | 'pdf'} TileType
 *
 * @typedef {Object} Tile
 * @property {string} id
 * @property {TileType} type
 * @property {number} x - Canvas X coordinate
 * @property {number} y - Canvas Y coordinate
 * @property {number} width - Canvas width
 * @property {number} height - Canvas height
 * @property {string} [filePath] - For file tiles
 * @property {string} [folderPath] - For graph tiles
 * @property {string} [url] - URL for browser tiles
 * @property {string} [cwd] - Working directory for terminal tiles
 * @property {string} [ptySessionId] - PTY session ID for terminal tiles
 * @property {string} [userTitle] - Manual title override set by user
 * @property {string} [autoTitle] - Auto-computed title from terminal session
 * @property {number} zIndex - Stacking order
 * @property {boolean} [locked] - Whether tile resize is locked (default true)
 */

/** @type {Tile[]} */
export const tiles = [];

let nextZIndex = 1;

const DEFAULT_TILE_SIZES = {
  term: { width: 1196, height: 739 },
  note: { width: 1180, height: 700 },
  code: { width: 1180, height: 700 },
  image: { width: 1180, height: 700 },
  graph: { width: 1180, height: 700 },
  browser: { width: 1180, height: 700 },
  pdf: { width: 1180, height: 700 },
};

/**
 * Pick the size for a new tile created directly on the canvas.
 * Uses the most recently created tile's dimensions as reference,
 * falling back to DEFAULT_TILE_SIZES when the canvas is empty.
 * @param {TileType} type
 * @returns {{ width: number, height: number }}
 */
export function pickCanvasTileSize(type) {
  if (tiles.length > 0) {
    const last = tiles[tiles.length - 1];
    return { width: last.width, height: last.height };
  }
  return defaultSize(type);
}

export function defaultSize(type) {
  return { ...DEFAULT_TILE_SIZES[type] };
}

let idCounter = 0;

export function generateId() {
  idCounter++;
  return `tile-${Date.now()}-${idCounter}`;
}

export function bringToFront(tile) {
  nextZIndex++;
  tile.zIndex = nextZIndex;
}

export function removeTile(id) {
  const idx = tiles.findIndex((t) => t.id === id);
  if (idx !== -1) tiles.splice(idx, 1);
}

export function addTile(tile) {
  if (!tile.zIndex) {
    nextZIndex++;
    tile.zIndex = nextZIndex;
  }
  tiles.push(tile);
  return tile;
}

export function getTile(id) {
  return tiles.find((t) => t.id === id) || null;
}

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
]);

const GRID_CELL = 20;

/** Snap tile position and size to the minor grid. */
export function snapToGrid(tile) {
  tile.x = Math.round(tile.x / GRID_CELL) * GRID_CELL;
  tile.y = Math.round(tile.y / GRID_CELL) * GRID_CELL;
  tile.width = Math.round(tile.width / GRID_CELL) * GRID_CELL;
  tile.height = Math.round(tile.height / GRID_CELL) * GRID_CELL;
}

// ── Selection state ──

/** @type {Set<string>} */
const selectedTileIds = new Set();

/** @param {string} id */
export function selectTile(id) {
  selectedTileIds.add(id);
}

/** @param {string} id */
export function deselectTile(id) {
  selectedTileIds.delete(id);
}

/** @param {string} id */
export function toggleTileSelection(id) {
  if (selectedTileIds.has(id)) {
    selectedTileIds.delete(id);
  } else {
    selectedTileIds.add(id);
  }
}

export function clearSelection() {
  selectedTileIds.clear();
}

/** @param {string} id */
export function isSelected(id) {
  return selectedTileIds.has(id);
}

/** @returns {Tile[]} */
export function getSelectedTiles() {
  return tiles.filter((t) => selectedTileIds.has(t.id));
}

/** @returns {{ x: number, y: number }} */
function tileCenter(tile) {
  return { x: tile.x + tile.width / 2, y: tile.y + tile.height / 2 };
}

/**
 * Returns the nearest tile in the given cardinal direction from fromId,
 * using a 120° forward cone filter (±60° from the axis).
 * @param {string|null} fromId - ID of focused tile, or null to use originX/Y
 * @param {'left'|'right'|'up'|'down'} direction
 * @param {number} [originX=0] - Canvas-space X when fromId is null
 * @param {number} [originY=0] - Canvas-space Y when fromId is null
 * @returns {Tile|null}
 */
export function getNearestTileInDirection(
  fromId,
  direction,
  originX = 0,
  originY = 0,
) {
  const from = fromId ? tiles.find((t) => t.id === fromId) : null;
  const fc = from ? tileCenter(from) : { x: originX, y: originY };

  const axisVec = {
    right: { dx: 1, dy: 0 },
    left: { dx: -1, dy: 0 },
    down: { dx: 0, dy: 1 },
    up: { dx: 0, dy: -1 },
  }[direction];

  const CONE_HALF = Math.PI / 3; // 60 degrees each side = 120° total cone

  const candidates = tiles
    .filter((t) => t.id !== fromId)
    .map((t) => {
      const tc = tileCenter(t);
      const dx = tc.x - fc.x;
      const dy = tc.y - fc.y;
      const dot = dx * axisVec.dx + dy * axisVec.dy;
      if (dot <= 0) return null;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (Math.acos(dot / dist) > CONE_HALF) return null;
      return { tile: t, dist };
    })
    .filter(Boolean);

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.dist - b.dist);
  return candidates[0].tile;
}

/**
 * Given a point (canvas coordinates) outside all tiles, find the closest
 * adjacent tile and the direction it sits relative to that point.
 * Returns { tile, direction } or null if no tiles exist.
 */
export function findNearestAdjacentTile(canvasX, canvasY) {
  const INFLUENCE = 60; // px perpendicular tolerance beyond tile edge
  let best = null;
  let bestDist = Infinity;

  for (const tile of tiles) {
    const checks = [
      // tile is to the LEFT of click → direction = "right" (place to right of tile)
      canvasX > tile.x + tile.width &&
      canvasY >= tile.y - INFLUENCE &&
      canvasY <= tile.y + tile.height + INFLUENCE
        ? { dir: "right", dist: canvasX - (tile.x + tile.width) }
        : null,
      // tile is to the RIGHT of click → direction = "left"
      canvasX < tile.x &&
      canvasY >= tile.y - INFLUENCE &&
      canvasY <= tile.y + tile.height + INFLUENCE
        ? { dir: "left", dist: tile.x - canvasX }
        : null,
      // tile is ABOVE the click → direction = "down"
      canvasY > tile.y + tile.height &&
      canvasX >= tile.x - INFLUENCE &&
      canvasX <= tile.x + tile.width + INFLUENCE
        ? { dir: "down", dist: canvasY - (tile.y + tile.height) }
        : null,
      // tile is BELOW the click → direction = "up"
      canvasY < tile.y &&
      canvasX >= tile.x - INFLUENCE &&
      canvasX <= tile.x + tile.width + INFLUENCE
        ? { dir: "up", dist: tile.y - canvasY }
        : null,
    ];

    for (const c of checks) {
      if (c && c.dist < bestDist) {
        bestDist = c.dist;
        best = { tile, direction: c.dir };
      }
    }
  }

  return best;
}

/** @returns {Tile | null} */
export function tileAtPoint(cx, cy) {
  const sorted = [...tiles].sort((a, b) => b.zIndex - a.zIndex);
  for (const tile of sorted) {
    if (
      cx >= tile.x &&
      cx < tile.x + tile.width &&
      cy >= tile.y &&
      cy < tile.y + tile.height
    ) {
      return tile;
    }
  }
  return null;
}

export function inferTileType(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  if (ext === ".md") return "note";
  if (ext === ".pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "code";
}

// ── Auto-placement for terminals ──

export const TERM_GAP = 40;

/**
 * Group terminal tiles by their exact cwd.
 * Returns a map: cwd → [tiles that share it]
 */
function groupTerminalsByWorkspace() {
  const groups = new Map();
  const termTiles = tiles.filter((t) => t.type === "term");
  for (const tile of termTiles) {
    const cwd = tile.cwd || "~";
    console.log(`[groupTerminalsByWorkspace] tile ${tile.id} cwd="${cwd}"`);
    if (!groups.has(cwd)) {
      groups.set(cwd, []);
    }
    groups.get(cwd).push(tile);
  }
  return groups;
}

/**
 * Return the set of terminal tile IDs that are the first (by insertion
 * order) in their cwd group. Used at save time to dedupe terminal tiles
 * so only one tile per workspace is persisted.
 */
export function getFirstTerminalIds() {
  const firstIds = new Set();
  const seenCwds = new Set();
  for (const tile of tiles) {
    if (tile.type !== "term") continue;
    const cwd = tile.cwd || "~";
    if (!seenCwds.has(cwd)) {
      seenCwds.add(cwd);
      firstIds.add(tile.id);
    }
  }
  return firstIds;
}

/**
 * Find an auto-layout position for a new terminal tile.
 * - If terminals for the same workspace already exist, place to the right
 *   of the rightmost one (horizontal insertion).
 * - If no terminals exist or the workspace is new, place below all
 *   existing tiles (vertical insertion).
 */
export function findAutoPlacementForTerminal(cwd, size) {
  const groups = groupTerminalsByWorkspace();
  const allTermTiles = tiles.filter((t) => t.type === "term");

  // Find the matching cwd group
  const normalizedCwd = cwd || "~";
  console.log(
    `[findAutoPlacement] cwd="${normalizedCwd}" groups=[${[...groups.keys()].join(", ")}]`,
  );
  const matchedGroup = groups.get(normalizedCwd);

  if (matchedGroup && matchedGroup.length > 0) {
    // Horizontal: place to the right of the rightmost tile in the group
    const rightmost = matchedGroup.reduce((a, b) =>
      a.x + a.width > b.x + b.width ? a : b,
    );
    return {
      x: rightmost.x + rightmost.width + TERM_GAP,
      y: rightmost.y,
    };
  }

  // Vertical: place below all existing tiles (all types, not just terminals)
  if (allTermTiles.length === 0) {
    return { x: 40, y: 40 };
  }

  const maxYBottom = tiles.reduce((max, t) => Math.max(max, t.y + t.height), 0);
  // Align with the leftmost terminal's x, or default to 40
  const minX = allTermTiles.reduce((min, t) => Math.min(min, t.x), 40);
  return {
    x: minX,
    y: maxYBottom + TERM_GAP,
  };
}

/**
 * Compute new positions for all terminal tiles, grouped by cwd.
 * Each cwd group forms a row, tiles sorted left-to-right by x position.
 * Returns [tileId, newX, newY] tuples.
 */
export function computeTerminalLayout() {
  const groups = groupTerminalsByWorkspace();
  const positions = [];
  const START_X = 40;
  const START_Y = 40;
  let rowY = START_Y;

  for (const [, groupTiles] of [...groups.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    // Sort tiles left-to-right by current x position
    const sorted = [...groupTiles].sort((a, b) => a.x - b.x);
    let rowX = START_X;
    for (const tile of sorted) {
      positions.push([tile.id, rowX, rowY]);
      rowX += tile.width + TERM_GAP;
    }
    rowY +=
      groupTiles.reduce((max, t) => Math.max(max, t.height), 0) + TERM_GAP;
  }

  return positions;
}

/**
 * Swap the x positions of two terminal tiles within the same cwd group.
 * Tiles in the group are sorted by x, then the two specified tiles
 * exchange their x positions.
 */
export function swapTerminalPositions(tileIdA, tileIdB) {
  const tileA = tiles.find((t) => t.id === tileIdA);
  const tileB = tiles.find((t) => t.id === tileIdB);
  if (!tileA || !tileB || tileA.type !== "term" || tileB.type !== "term")
    return;

  const tmpX = tileA.x;
  tileA.x = tileB.x;
  tileB.x = tmpX;

  // Re-sort the cwd group so the layout stays consistent
  const cwd = tileA.cwd;
  const groupTiles = tiles
    .filter((t) => t.type === "term" && t.cwd === cwd)
    .sort((a, b) => a.x - b.x);
  let rowX = 40;
  for (const tile of groupTiles) {
    tile.x = rowX;
    rowX += tile.width + TERM_GAP;
  }
}
