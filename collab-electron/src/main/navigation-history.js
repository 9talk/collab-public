const MAX_HISTORY = 100;

let history = [];
let currentIndex = -1;

/**
 * Record a tile focus event. Truncates forward history and caps size.
 */
export function pushToHistory(tileId) {
  // Deduplicate: if already at this tile, don't push again
  if (currentIndex >= 0 && history[currentIndex] === tileId) {
    return;
  }

  // Truncate forward history
  history = history.slice(0, currentIndex + 1);

  history.push(tileId);
  currentIndex = history.length - 1;

  // Cap size: remove oldest entries
  if (history.length > MAX_HISTORY) {
    const excess = history.length - MAX_HISTORY;
    history = history.slice(excess);
    currentIndex = Math.max(0, currentIndex - excess);
  }
}

/**
 * Navigate back in history. Returns the target tileId, or null if at boundary.
 */
export function goBack() {
  if (currentIndex <= 0) {
    return null;
  }
  currentIndex--;
  return history[currentIndex];
}

/**
 * Navigate forward in history. Returns the target tileId, or null if at boundary.
 */
export function goForward() {
  if (currentIndex < 0 || currentIndex >= history.length - 1) {
    return null;
  }
  currentIndex++;
  return history[currentIndex];
}

/**
 * Tile id at the current position (most recent navigation target), or null.
 */
export function getCurrent() {
  return currentIndex >= 0 && currentIndex < history.length
    ? history[currentIndex]
    : null;
}

/**
 * Snapshot of the full stack for persistence.
 */
export function getSnapshot() {
  return { history: history.slice(), currentIndex };
}

/**
 * Replace state with a persisted snapshot. Invalid input is ignored
 * (state stays empty), oversized stacks are trimmed to the newest entries.
 */
export function restoreSnapshot(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.history)) return;
  if (!snapshot.history.every((id) => typeof id === "string")) return;

  let ids = snapshot.history;
  let index = Number.isInteger(snapshot.currentIndex)
    ? snapshot.currentIndex
    : -1;
  if (ids.length > MAX_HISTORY) {
    const excess = ids.length - MAX_HISTORY;
    ids = ids.slice(excess);
    index = Math.max(0, index - excess);
  }
  history = ids.slice();
  currentIndex = Math.max(-1, Math.min(index, history.length - 1));
}

/**
 * Reset history state (tests only; app restart restores via restoreSnapshot).
 */
export function resetHistory() {
  history = [];
  currentIndex = -1;
}
